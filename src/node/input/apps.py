#!/usr/bin/python3
"""Resolve and launch installed desktop applications; never accept shell commands."""
import hashlib
import json
import os
import sys
import time
import re
from pathlib import Path
import gi
gi.require_version('GioUnix','2.0')
from gi.repository import Gio, GioUnix, GLib


def blocked(values):
    names = [s.strip().lower() for s in os.environ.get('CONTROL_BLOCKED_APPS', 'discord').split(',') if s.strip()]
    return any(name in str(value).lower() for name in names for value in values if value)


def description(info):
    values = (info.get_id(), info.get_name(), info.get_executable(), info.get_startup_wm_class(), info.get_commandline())
    if blocked(values): raise RuntimeError('blocked_application')
    return {'id': info.get_id(), 'name': info.get_name(),
            'focusNames': sorted({str(value).lower() for value in
                (info.get_name(), info.get_id().removesuffix('.desktop'),
                 info.get_startup_wm_class(), Path(info.get_executable() or '').name) if value}),
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


def launch(approved, context=None):
    info, current = resolve(approved.get('id'))
    if current != approved: raise RuntimeError('desktop_app_changed_since_approval')
    context = context or Gio.AppLaunchContext()
    if info.get_boolean('DBusActivatable'):
        loop=GLib.MainLoop();result={};cancellable=Gio.Cancellable()
        def finished(app,reply,*_):
            try:
                if not app.launch_uris_finish(reply):raise RuntimeError('app_launch_failed')
                result['ok']=True
            except Exception as error:result['error']=error
            loop.quit()
        def timeout():
            result['error']=RuntimeError('activation_timeout');cancellable.cancel();loop.quit();return GLib.SOURCE_REMOVE
        timer=GLib.timeout_add_seconds(8,timeout)
        info.launch_uris_async([],context,cancellable,finished,None)
        loop.run()
        if str(result.get('error'))!='activation_timeout':GLib.source_remove(timer)
        if 'error' in result:raise result['error']
        return {'launched':current,'startup':{'state':'activation-completed'}}
    pids=[]
    def child_started(_info,pid,*_):pids.append(pid)
    # Child apps must never inherit the helper's JSON stdout or retain its pipe.
    # Gio's desktop-manager API preserves desktop/snap activation semantics.
    with open(os.devnull,'rb') as input_stream, open(os.devnull,'wb') as output_stream:
        started=info.launch_uris_as_manager_with_fds([],context,GLib.SpawnFlags.SEARCH_PATH|GLib.SpawnFlags.DO_NOT_REAP_CHILD,
            None,None,child_started,None,input_stream.fileno(),output_stream.fileno(),output_stream.fileno())
    if not started:raise RuntimeError('app_launch_failed')
    startup={'state':'activation-requested'}
    if pids:
        deadline=time.monotonic()+0.7
        startup={'state':'running','pid':pids[0]}
        while time.monotonic()<deadline:
            try:pid,status=os.waitpid(pids[0],os.WNOHANG)
            except ChildProcessError:break
            if pid:
                code=os.waitstatus_to_exitcode(status)
                if code:raise RuntimeError('app_exit:'+str(code))
                startup={'state':'launcher-exited','exitCode':0};break
            time.sleep(0.025)
    return {'launched':current,'startup':startup}


def failure(error):
    code=str(error)
    safety=code in {'blocked_application','invalid_app','desktop_app_changed_since_approval'}
    known={'blocked_application','invalid_app','app_not_installed_or_ambiguous','desktop_app_changed_since_approval','app_launch_failed','unsupported_operation','activation_timeout'}
    if code.startswith('app_exit:'):return {'code':'app_exit','message':'Application launcher exited with status '+code.split(':',1)[1],'safety':False}
    if code in known:return {'code':code,'message':code.replace('_',' '),'safety':safety}
    if isinstance(error,GLib.Error):
        # Gio launch errors identify OS/D-Bus failure; app stdout is never exposed.
        message=re.sub(r'https?://\S+|(?:token|password|secret|authorization)\s*[:=]\s*\S+','[redacted]',error.message,flags=re.I)
        message=re.sub(r'[A-Za-z0-9+/=]{80,}','[redacted]',message)
        return {'code':'gio_error','domain':error.domain,'nativeCode':error.code,'message':message[:500],'safety':False}
    return {'code':'helper_error','message':'Launch helper '+type(error).__name__,'safety':False}



if __name__ == '__main__':
    try:
        value = json.loads(sys.argv[2])
        result = resolve(value)[1] if sys.argv[1] == 'resolve' else launch(value) if sys.argv[1] == 'launch' else None
        if result is None: raise RuntimeError('unsupported_operation')
        print(json.dumps({'ok': True, 'result': result}))
    except Exception as error:
        print(json.dumps({'ok':False,'error':failure(error)}))
        sys.exit(1)
