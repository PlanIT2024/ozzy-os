#!/usr/bin/python3
"""Resolve and launch installed desktop applications; never accept shell commands."""
import hashlib
import json
import os
import sys
from pathlib import Path
import gi
gi.require_version('GioUnix','2.0')
from gi.repository import Gio, GioUnix


def blocked(values):
    names = [s.strip().lower() for s in os.environ.get('CONTROL_BLOCKED_APPS', 'discord').split(',') if s.strip()]
    return any(name in str(value).lower() for name in names for value in values if value)


def description(info):
    values = (info.get_id(), info.get_name(), info.get_executable(), info.get_startup_wm_class())
    if blocked(values): raise RuntimeError('blocked_application')
    return {'id': info.get_id(), 'name': info.get_name(),
            'fingerprint': hashlib.sha256(Path(info.get_filename()).read_bytes()).hexdigest()}


def resolve(request):
    if not isinstance(request, str) or not request.strip() or len(request) > 160 or '/' in request or '\\' in request:
        raise RuntimeError('invalid_app')
    value = request.strip().casefold()
    choices = [info for info in Gio.AppInfo.get_all() if isinstance(info, GioUnix.DesktopAppInfo) and
               value in {str(s).casefold() for s in (info.get_id(), info.get_name(), info.get_startup_wm_class(),
                         Path(info.get_executable() or '').name)}]
    choices = {info.get_id(): info for info in choices}
    if len(choices) != 1: raise RuntimeError('app_not_installed_or_ambiguous')
    info = next(iter(choices.values()))
    return info, description(info)


def launch(approved):
    info, current = resolve(approved.get('id'))
    if current != approved: raise RuntimeError('desktop_app_changed_since_approval')
    context = Gio.AppLaunchContext()
    # Inherit the graphical user's environment; no arbitrary CLI arguments or URLs.
    if not info.launch([], context): raise RuntimeError('app_launch_failed')
    return {'launched': current}


if __name__ == '__main__':
    try:
        value = json.loads(sys.argv[2])
        result = resolve(value)[1] if sys.argv[1] == 'resolve' else launch(value) if sys.argv[1] == 'launch' else None
        if result is None: raise RuntimeError('unsupported_operation')
        print(json.dumps({'ok': True, 'result': result}))
    except Exception as error:
        allowed = {'blocked_application','invalid_app','app_not_installed_or_ambiguous','desktop_app_changed_since_approval','app_launch_failed'}
        print(json.dumps({'ok': False, 'error': str(error) if str(error) in allowed else 'app_operation_failed'}))
        sys.exit(1)
