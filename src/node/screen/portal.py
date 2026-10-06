#!/usr/bin/python3
"""One-shot Screenshot portal client. stdout is private IPC, never a log."""
import re
import time
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
STAGE = 'startup'
CAPTURE = (len(sys.argv) > 1 and sys.argv[1] == 'capture') or os.environ.get('BIT_SCREEN_DIAGNOSTICS') == '1'
DEADLINE = time.monotonic() + 110


def diagnostic(event, **fields):
    if CAPTURE:
        record = {'event': event, 'stage': STAGE, **fields}
        print(json.dumps(record), file=sys.stderr, flush=True)


def stage(value):
    global STAGE
    STAGE = value
    diagnostic('stage')


def error_details(error):
    # Only D-Bus errors have diagnostic messages; arbitrary exceptions may hold pixels.
    if isinstance(error, GLib.Error):
        message = re.sub(r'(?:data:image/|file://)\S+|[A-Za-z0-9+/=]{256,}', '[redacted]', error.message)
        return {'dbusError': Gio.DBusError.get_remote_error(error), 'message': message[:1500]}
    return {'errorType': type(error).__name__}



def call(bus, destination, path, interface, method, signature, arguments, timeout=5000):
    parameters = GLib.Variant(signature, arguments) if signature else None
    try:
        result = bus.call_sync(destination, path, interface, method, parameters, None,
                               Gio.DBusCallFlags.NONE, timeout, None)
    except GLib.Error as error:
        diagnostic('dbus_failure', interface=interface, method=method, **error_details(error))
        raise
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
    stage('connect')
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    # A stable named host app avoids the shared empty-id screenshot permission.
    stage('register_identity')
    call(bus, DEST, PATH, 'org.freedesktop.host.portal.Registry', 'Register', '(sa{sv})', (APP, {}))
    diagnostic('identity_registered', appId=APP, sender=bus.get_unique_name())
    return bus


def availability(bus):
    stage('availability')
    version = call(bus, DEST, PATH, 'org.freedesktop.DBus.Properties', 'Get', '(ss)',
                   ('org.freedesktop.portal.Screenshot', 'version'))[0]
    if isinstance(version, GLib.Variant):
        version = version.unpack()
    locked = call(bus, 'org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver', 'GetActive', None, None)[0]
    diagnostic('session_state', locked=locked)
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
    stage('screenshot_request')
    token = 'bit_' + uuid.uuid4().hex
    sender = bus.get_unique_name()[1:].replace('.', '_')
    expected = f'{PATH}/request/{sender}/{token}'
    response = {}
    loop = GLib.MainLoop()

    def received(connection, sender_name, object_path, interface, signal, parameters, user_data):
        if object_path == expected:
            response['value'] = parameters.unpack()
            diagnostic('portal_response', responseCode=response['value'][0])
            loop.quit()

    subscription = bus.signal_subscribe(DEST, 'org.freedesktop.portal.Request', 'Response', None, None,
                                        Gio.DBusSignalFlags.NONE, received, None)

    def expired():
        diagnostic('portal_timeout')
        response['error'] = 'portal_consent_timeout'
        try:
            call(bus, DEST, expected, 'org.freedesktop.portal.Request', 'Close', None, None, 2000)
        except Exception:
            pass
        loop.quit()
        return GLib.SOURCE_REMOVE

    timer = GLib.timeout_add(max(1, int((DEADLINE - time.monotonic()) * 1000)), expired)
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
    return screenshot_uri(response['value'])


def screenshot_uri(response):
    code, result = response
    if code != 0:
        raise RuntimeError('portal_consent_denied' if code == 1 else 'portal_capture_failed')
    return result['uri']



def screenshot_permission(bus):
    stage('permission_lookup')
    try:
        permissions, _ = call(bus, 'org.freedesktop.impl.portal.PermissionStore',
                              '/org/freedesktop/impl/portal/PermissionStore',
                              'org.freedesktop.impl.portal.PermissionStore', 'Lookup',
                              '(ss)', ('screenshot', 'screenshot'))
        return permissions.get(APP, ['unset'])[0]
    except GLib.Error as error:
        if Gio.DBusError.get_remote_error(error) == 'org.freedesktop.portal.Error.NotFound':
            return 'unset'
        raise


def consented_screenshot(bus):
    permission = screenshot_permission(bus)
    diagnostic('permission', appId=APP, permission=permission)
    if permission in ('yes', 'no'):
        return take_screenshot(bus)
    # GNOME rejects AccessDialog for an unfocused app. Present our registered
    # application's own Wayland window and require an owner click for focus.
    # The portal remains responsible for granting/storing screenshot permission.
    stage('consent_window')
    import gi
    gi.require_version('Gtk', '4.0')
    from gi.repository import Gtk
    app = Gtk.Application(application_id=APP, flags=Gio.ApplicationFlags.NON_UNIQUE)
    outcome = {}

    def activate(application):
        window = Gtk.ApplicationWindow(application=application, title='bIT screenshot permission')
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        for margin in ('top', 'bottom', 'start', 'end'):
            getattr(box, 'set_margin_' + margin)(24)
        box.append(Gtk.Label(label='Click Continue, then Allow in the GNOME permission dialog.'))
        button = Gtk.Button(label='Continue')
        box.append(button)
        window.set_child(box)

        def request(_):
            button.set_sensitive(False)
            try:
                availability(bus)
                outcome['uri'] = take_screenshot(bus)
            except Exception as error:
                outcome['error'] = error
            finally:
                window.destroy()
                application.quit()

        button.connect('clicked', request)
        window.connect('close-request', lambda _: application.quit() or False)
        window.present()

    def expired():
        outcome['error'] = RuntimeError('portal_consent_timeout')
        app.quit()
        return GLib.SOURCE_REMOVE

    app.connect('activate', activate)
    timer = GLib.timeout_add(max(1, int((DEADLINE - time.monotonic()) * 1000)), expired)
    app.run([])
    if 'error' not in outcome or str(outcome['error']) != 'portal_consent_timeout':
        GLib.source_remove(timer)
    if 'error' in outcome:
        if 'uri' in outcome:
            consume_uri(outcome['uri'])  # Discard a late result after consent expiry.
        raise outcome['error']
    if 'uri' not in outcome:
        raise RuntimeError('portal_consent_denied')
    return outcome['uri']

def consume_uri(uri):
    stage('consume_image')
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
        diagnostic('portal_image_deleted')
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
    stage('notification')
    try:
        call(bus, DEST, PATH, 'org.freedesktop.portal.Notification', 'AddNotification', '(sa{sv})',
             ('bit-screenshot-' + uuid.uuid4().hex, {'title': GLib.Variant('s', 'bIT took a screenshot'),
                                                  'body': GLib.Variant('s', 'Read-only, owner-authorized screen capture.')}))
    except Exception as error:
        diagnostic('notification_fallback', **error_details(error))
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
    image = consume_uri(consented_screenshot(bus))
    captured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    info = availability(bus)  # Recheck locking/session loss and layout after consent.
    notify(bus)
    stage('complete')
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
        diagnostic('failure', errorCode=code, **error_details(error))
        print(json.dumps({'available': False, 'error': code}))
        sys.exit(1)
