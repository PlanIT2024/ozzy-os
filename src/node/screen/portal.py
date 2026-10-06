#!/usr/bin/python3
"""One-shot Screenshot portal client. stdout is private IPC, never a log."""
import base64
import datetime
import json
import os
import stat
import subprocess
import sys
import uuid
from urllib.parse import urlparse, unquote
from gi.repository import Gio, GLib

DEST = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'
APP = 'com.ozzy.bit-node'
MAX_RAW = 32 * 1024 * 1024


def call(bus, destination, path, interface, method, signature, arguments, timeout=5000):
    parameters = GLib.Variant(signature, arguments) if signature else None
    result = bus.call_sync(destination, path, interface, method, parameters, None,
                           Gio.DBusCallFlags.NONE, timeout, None)
    return result.unpack() if result else None


def connect():
    if not os.environ.get('DBUS_SESSION_BUS_ADDRESS') or not os.environ.get('WAYLAND_DISPLAY'):
        raise RuntimeError('graphical_session_unavailable')
    runtime = os.environ.get('XDG_RUNTIME_DIR', '')
    display = os.environ['WAYLAND_DISPLAY']
    socket = display if os.path.isabs(display) else os.path.join(runtime, display)
    if not runtime or not stat.S_ISSOCK(os.stat(socket).st_mode):
        raise RuntimeError('wayland_socket_unavailable')
    if os.environ.get('XDG_SESSION_TYPE', 'wayland') != 'wayland':
        raise RuntimeError('wayland_required')
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    # A stable named host app avoids the shared empty-id screenshot permission.
    call(bus, DEST, PATH, 'org.freedesktop.host.portal.Registry', 'Register', '(sa{sv})', (APP, {}))
    return bus


def availability(bus):
    version = call(bus, DEST, PATH, 'org.freedesktop.DBus.Properties', 'Get', '(ss)',
                   ('org.freedesktop.portal.Screenshot', 'version'))[0]
    if isinstance(version, GLib.Variant):
        version = version.unpack()
    locked = call(bus, 'org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver', 'GetActive', None, None)[0]
    if locked:
        raise RuntimeError('desktop_locked')
    state = call(bus, 'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                 'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None)
    monitors = []
    physical, logical = state[1], state[2]
    for x, y, scale, transform, primary, specs, properties in logical:
        for spec in specs:
            monitor = next((m for m in physical if m[0][0] == spec[0]), None)
            mode = next((mode for mode in monitor[1] if mode[-1].get('is-current')), None) if monitor else None
            w, h = (mode[1], mode[2]) if mode else (0, 0)
            if transform % 2:
                w, h = h, w
            monitors.append({'connector': spec[0], 'x': x, 'y': y, 'width': round(w / scale),
                             'height': round(h / scale), 'scale': scale, 'primary': primary,
                             'coordinateSpace': 'logical'})
    if not monitors:
        raise RuntimeError('graphical_session_unavailable')
    return {'available': True, 'portalVersion': version, 'monitors': monitors}


def take_screenshot(bus):
    token = 'bit_' + uuid.uuid4().hex
    sender = bus.get_unique_name()[1:].replace('.', '_')
    expected = f'{PATH}/request/{sender}/{token}'
    response = {}
    loop = GLib.MainLoop()

    def received(connection, sender_name, object_path, interface, signal, parameters, user_data):
        if object_path == expected:
            response['value'] = parameters.unpack()
            loop.quit()

    subscription = bus.signal_subscribe(DEST, 'org.freedesktop.portal.Request', 'Response', None, None,
                                        Gio.DBusSignalFlags.NONE, received, None)

    def expired():
        response['error'] = 'portal_consent_timeout'
        try:
            call(bus, DEST, expected, 'org.freedesktop.portal.Request', 'Close', None, None, 2000)
        except Exception:
            pass
        loop.quit()
        return GLib.SOURCE_REMOVE

    timer = GLib.timeout_add_seconds(110, expired)
    try:
        options = {'handle_token': GLib.Variant('s', token), 'interactive': GLib.Variant('b', False),
                   'modal': GLib.Variant('b', False)}
        handle = call(bus, DEST, PATH, 'org.freedesktop.portal.Screenshot', 'Screenshot', '(sa{sv})', ('', options))[0]
        if handle != expected:
            raise RuntimeError('unexpected_portal_handle')
        loop.run()
    finally:
        bus.signal_unsubscribe(subscription)
        if 'error' not in response:
            GLib.source_remove(timer)
    if 'error' in response:
        raise RuntimeError(response['error'])
    code, result = response['value']
    if code != 0:
        raise RuntimeError('portal_consent_denied' if code == 1 else 'portal_capture_failed')
    return result['uri']


def consume_uri(uri):
    parsed = urlparse(uri)
    if parsed.scheme != 'file' or parsed.netloc or not parsed.path.lower().endswith('.png'):
        raise RuntimeError('invalid_portal_image_uri')
    filename = unquote(parsed.path)
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise RuntimeError('invalid_portal_image_file')
        # Unlink immediately after opening, before reading/encoding. No retained image path.
        os.unlink(filename)
        if info.st_size > MAX_RAW:
            raise RuntimeError('portal_image_too_large')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            image = source.read(MAX_RAW + 1)
        if len(image) > MAX_RAW or not image.startswith(b'\x89PNG\r\n\x1a\n'):
            raise RuntimeError('invalid_portal_image')
        return image
    finally:
        os.close(fd)


def notify(bus):
    try:
        call(bus, DEST, PATH, 'org.freedesktop.portal.Notification', 'AddNotification', '(sa{sv})',
             ('bit-screenshot-' + uuid.uuid4().hex, {'title': GLib.Variant('s', 'bIT took a screenshot'),
                                                  'body': GLib.Variant('s', 'Read-only, owner-authorized screen capture.')}))
    except Exception:
        completed = subprocess.run(['/usr/bin/notify-send', '--app-name=bIT', '--icon=camera-photo',
                                    'bIT took a screenshot'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if completed.returncode:
            raise RuntimeError('notification_failed')


def main():
    bus = connect()
    info = availability(bus)
    if sys.argv[1] == 'probe':
        return info
    if sys.argv[1] != 'capture':
        raise RuntimeError('invalid_operation')
    image = consume_uri(take_screenshot(bus))
    captured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    info = availability(bus)  # Recheck locking/session loss and layout after consent.
    notify(bus)
    return {'data': base64.b64encode(image).decode('ascii'), 'monitors': info['monitors'],
            'capturedAt': captured_at}


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        # No exception values, URIs or image bytes may enter systemd logs.
        allowed = {'graphical_session_unavailable', 'wayland_socket_unavailable', 'wayland_required',
                   'desktop_locked', 'portal_consent_timeout', 'unexpected_portal_handle',
                   'portal_consent_denied', 'portal_capture_failed', 'invalid_portal_image_uri',
                   'invalid_portal_image_file', 'portal_image_too_large', 'invalid_portal_image',
                   'notification_failed', 'invalid_operation'}
        code = str(error) if str(error) in allowed else 'portal_unavailable'
        print(json.dumps({'available': False, 'error': code}))
        sys.exit(1)
