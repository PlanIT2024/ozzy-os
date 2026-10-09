#!/usr/bin/python3
"""Resident RemoteDesktop portal client: private JSON IPC, metadata-only stderr."""
import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path
from gi.repository import Gio, GLib
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'screen'))
import portal as screen
sys.path.insert(0, str(Path(__file__).resolve().parent))
from focus import snapshot, search_snapshot, focus_search
screen.CAPTURE = True
DEST, PATH, APP = screen.DEST, screen.PATH, screen.APP
RD = 'org.freedesktop.portal.RemoteDesktop'
SC = 'org.freedesktop.portal.ScreenCast'


def emit(value):
    print(json.dumps(value), flush=True)


class Input:
    def __init__(self, bus):
        self.bus = bus
        self.session = None
        self.streams = []
        self.held_keys = set()
        self.held_buttons = set()
        self.closed = False
        self.pending = None
        self.wait = None
        self.delivery = None
        self.token_file = Path(__file__).resolve().parents[3] / 'data/control-restore.json'

    def request(self, interface, method, prefix=(), options=None):
        screen.stage(method)
        token = 'bit_' + uuid.uuid4().hex
        expected = f'{PATH}/request/{self.bus.get_unique_name()[1:].replace(".", "_")}/{token}'
        values = {}
        loop = GLib.MainLoop()
        self.pending, self.wait = expected, loop
        def response(*args):
            if args[2] == expected:
                values['response'] = args[5].unpack()
                screen.diagnostic('portal_response', responseCode=values['response'][0])
                loop.quit()
        subscription = self.bus.signal_subscribe(DEST, 'org.freedesktop.portal.Request', 'Response', expected, None, Gio.DBusSignalFlags.NONE, response, None)
        def expired():
            values['error'] = 'portal_consent_timeout'
            try: screen.call(self.bus,DEST,expected,'org.freedesktop.portal.Request','Close',None,None)
            except Exception: pass
            loop.quit()
            return GLib.SOURCE_REMOVE
        timer = GLib.timeout_add_seconds(105,expired)
        try:
            options = {**(options or {}), 'handle_token': GLib.Variant('s', token)}
            signature = '(' + ('os' if len(prefix)==2 else 'o' if prefix else '') + 'a{sv})'
            handle = screen.call(self.bus,DEST,PATH,interface,method,signature,(*prefix,options))[0]
            if handle != expected: raise RuntimeError('unexpected_portal_handle')
            loop.run()
            if self.closed: raise RuntimeError('control_closed')
            if 'error' in values: raise RuntimeError(values['error'])
            code, result = values['response']
            if code != 0: raise RuntimeError('portal_cancelled' if code==1 else 'portal_failed')
            return result
        finally:
            self.pending = self.wait = None
            self.bus.signal_unsubscribe(subscription)
            if 'error' not in values: GLib.source_remove(timer)

    def session_closed(self,*_):
        self.closed = True
        self.release()
        if self.wait: self.wait.quit()
        self.session=None
        emit({'event':'closed'})

    def start(self):
        screen.availability(self.bus)
        result=self.request(RD,'CreateSession',options={'session_handle_token':GLib.Variant('s','bit_'+uuid.uuid4().hex)})
        self.session=result['session_handle']
        self.bus.signal_subscribe(DEST,'org.freedesktop.portal.Session','Closed',self.session,None,Gio.DBusSignalFlags.NONE,self.session_closed,None)
        options={'types':GLib.Variant('u',3),'persist_mode':GLib.Variant('u',2)}
        if self.token_file.exists():
            token=json.loads(self.token_file.read_text()).get('restore_token')
            if token:
                options['restore_token']=GLib.Variant('s',token)
                # Restore tokens are single-use; clear before submitting.
                self.token_file.unlink()
        self.request(RD,'SelectDevices',(self.session,),options)
        self.request(SC,'SelectSources',(self.session,),{'types':GLib.Variant('u',1),'multiple':GLib.Variant('b',True)})
        def start_portal(): return self.request(RD,'Start',(self.session,''))
        result = start_portal() if 'restore_token' in options else self.focused_start(start_portal)
        if result.get('devices',0)&3 != 3: raise RuntimeError('required_devices_denied')
        self.streams=result.get('streams',[])
        if not self.streams: raise RuntimeError('no_monitor_streams')
        token=result.get('restore_token')
        if token:
            self.token_file.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            temp=self.token_file.with_suffix('.tmp')
            fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
            with os.fdopen(fd,'w') as target: json.dump({'restore_token':token},target)
            os.replace(temp,self.token_file)
        screen.stage('ready')
        return {'started':True,'appId':APP,'restorable':bool(token),'streams':[{'node':node,'position':props.get('position'),'size':props.get('size')} for node,props in self.streams]}

    def focused_start(self,operation):
        import gi
        gi.require_version('Gtk','4.0')
        from gi.repository import Gtk
        app=Gtk.Application(application_id=APP,flags=Gio.ApplicationFlags.NON_UNIQUE)
        result={}
        def activate(application):
            window=Gtk.ApplicationWindow(application=application,title='bIT control permission')
            box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=16)
            for side in ('top','bottom','start','end'):getattr(box,'set_margin_'+side)(24)
            box.append(Gtk.Label(label='Continue to GNOME’s screen and keyboard/mouse permission dialog.\nSelect your monitors and allow restoring this permission if offered.'))
            button=Gtk.Button(label='Continue');box.append(button);window.set_child(box)
            def request(_):
                button.set_sensitive(False)
                try:screen.availability(self.bus);result['value']=operation()
                except Exception as error:result['error']=error
                finally:window.destroy();application.quit()
            button.connect('clicked',request)
            window.connect('close-request',lambda _:application.quit() or False)
            window.present()
        def expired():result['error']=RuntimeError('portal_consent_timeout');self.shutdown();app.quit();return GLib.SOURCE_REMOVE
        app.connect('activate',activate);timer=GLib.timeout_add_seconds(110,expired);app.run([])
        if str(result.get('error'))!='portal_consent_timeout':GLib.source_remove(timer)
        if 'error' in result:raise result['error']
        if 'value' not in result:raise RuntimeError('portal_cancelled')
        return result['value']

    def notify(self,method,signature,values):
        if self.closed or not self.session:raise RuntimeError('control_closed')
        result=screen.call(self.bus,DEST,PATH,RD,method,'(oa{sv}'+signature+')',(self.session,{},*values),2000)
        while GLib.MainContext.default().pending():GLib.MainContext.default().iteration(False)
        return result

    def key(self,sym,state):
        if state:self.held_keys.add(sym)
        self.notify('NotifyKeyboardKeysym','iu',(sym,state))
        if not state:self.held_keys.discard(sym)

    def button(self,button,state):
        if state:self.held_buttons.add(button)
        self.notify('NotifyPointerButton','iu',(button,state))
        if not state:self.held_buttons.discard(button)

    def release(self):
        for sym in list(self.held_keys):
            try:self.notify('NotifyKeyboardKeysym','iu',(sym,0))
            except Exception:pass
        for button in list(self.held_buttons):
            try:self.notify('NotifyPointerButton','iu',(button,0))
            except Exception:pass
        self.held_keys.clear();self.held_buttons.clear()

    def move(self,point):
        monitor=point['monitor']
        match=next(((node,props) for node,props in self.streams if list(props.get('position',[]))==[monitor['x'],monitor['y']] and list(props.get('size',[]))==[monitor['width'],monitor['height']]),None)
        if not match:raise RuntimeError('monitor_not_shared_or_layout_changed')
        node,_=match
        x,y=point['x']-monitor['x'],point['y']-monitor['y']
        if not (0<=x<monitor['width'] and 0<=y<monitor['height']):raise RuntimeError('coordinate_out_of_bounds')
        self.notify('NotifyPointerMotionAbsolute','udd',(node,x,y))

    def check_focus(self, action, point=None):
        observed = search_snapshot() if action.get('action')=='focus_search' else snapshot(point)
        focused = observed['focused']
        if not focused: raise RuntimeError('control_accessibility_unavailable')
        actual='gnome-shell-search' if focused.get('focusKind')=='shell-search' and observed.get('overviewActive') is True else focused['app'].lower()
        if action.get('expected_app','').lower()!=actual:raise RuntimeError('expected_app_mismatch')
        if action.get('action')=='focus_search' and (actual!='gnome-shell' or observed.get('overviewActive') is not True or focused.get('focusKind')!='shell-search-target'):raise RuntimeError('shell_search_not_focused')
        if focused['app'].lower()=='gnome-shell' and actual!='gnome-shell-search' and action.get('keys')!='super' and action.get('action')!='focus_search':raise RuntimeError('shell_search_not_focused')
        if action.get('action')=='key' and action.get('keys')=='super':
            if any(key in action for key in ('text','point','destination','coordinate','end','direction','amount')):raise RuntimeError('invalid_standalone_super')
            return observed
        blocked = [name.strip().lower() for name in os.environ.get('CONTROL_BLOCKED_APPS', 'discord').split(',') if name.strip()]
        for record in (focused, observed['target'], *observed.get('candidates', [])):
            if record and any(name in (record['app'] + ' ' + record['window']).lower() for name in blocked):
                raise RuntimeError('blocked_application')
        if point and not observed['targetKnown']: raise RuntimeError({'overlapping-windows':'control_overlapping_windows','focus-mismatch':'control_target_focus_mismatch'}.get(observed.get('targetReason'),'control_accessibility_unavailable'))
        if focused != action.get('expectedFocus'):
            raise RuntimeError('control_focus_changed')
        return observed

    def action(self,action):
        if action.get('action')=='focus_search':
            self.delivery=None;screen.stage('focus_search');screen.availability(self.bus)
            if self.closed or not self.session:raise RuntimeError('control_closed')
            if action.get('expected_app')!='gnome-shell' or any(key in action for key in ('keys','text','point','destination','coordinate','end')):raise RuntimeError('unsupported_action')
            self.check_focus(action)
            def allowed():
                # AT-SPI focus must stop with the portal too: unlike key sends,
                # GrabFocus does not itself reference the portal session handle.
                while GLib.MainContext.default().pending():GLib.MainContext.default().iteration(False)
                if self.closed or not self.session:return False
                screen.availability(self.bus)
                return True
            try:return focus_search(action.get('expectedFocus'),allowed)
            finally:self.release()
        self.delivery={'state':'none','count':0,'total':len(action.get('text','')) if action.get('action')=='type' else len(action.get('keys','').split('+')) if action.get('action')=='key' else 0,'unit':'characters' if action.get('action')=='type' else 'key presses'}
        self.progress()
        screen.stage('action')
        layout=screen.availability(self.bus)
        for field in ('point','destination'):
            if field in action:
                expected=action[field]['monitor']
                if not any(all(monitor.get(key)==expected.get(key) for key in ('x','y','width','height')) for monitor in layout['monitors']):raise RuntimeError('monitor_layout_changed')
        self.check_focus(action, action.get('point'))
        if action.get('destination'): self.check_focus(action, action['destination'])
        # Independent defense in the helper, in addition to the node validator.
        if action.get('action')=='key':
            keys=action['keys'].split('+')
            if 'ctrl' in keys and 'alt' in keys and ('delete' in keys or any(key in ['f'+str(i) for i in range(1,13)] for key in keys)):raise RuntimeError('blocked_key_combo')
        if action.get('action')=='type' and (len(action['text'])>500 or any(ord(c)<32 and c not in '\n\t' or ord(c)==127 for c in action['text'])):raise RuntimeError('invalid_typed_text')
        try:
            kind=action['action']
            if 'point' in action:self.move(action['point'])
            if kind in ('left_click','right_click','double_click'):
                button=273 if kind=='right_click' else 272
                for i in range(2 if kind=='double_click' else 1):
                    self.check_focus(action, action.get('point'))
                    self.button(button,1);self.button(button,0)
                    if kind=='double_click' and i==0:time.sleep(0.08)
            elif kind=='drag':
                self.button(272,1)
                self.move(action['destination'])
                self.button(272,0)
            elif kind=='scroll':
                horizontal=action['direction'] in ('left','right')
                steps=action['amount']*(-1 if action['direction'] in ('up','left') else 1)
                self.notify('NotifyPointerAxisDiscrete','ui',(1 if horizontal else 0,steps))
            elif kind=='key':
                symbols={'ctrl':0xffe3,'alt':0xffe9,'shift':0xffe1,'super':0xffeb,'enter':0xff0d,'escape':0xff1b,'tab':0xff09,'backspace':0xff08,'delete':0xffff,'space':32,'up':0xff52,'down':0xff54,'left':0xff51,'right':0xff53,'home':0xff50,'end':0xff57,'pageup':0xff55,'pagedown':0xff56,'insert':0xff63,**{'f'+str(i):0xffbd+i for i in range(1,13)}}
                self.check_focus(action)
                for key in action['keys'].split('+'):
                    self.before_delivery();self.key(symbols[key] if key in symbols else ord(key),1);self.after_delivery()
            elif kind=='type':
                for char in action['text']:
                    while GLib.MainContext.default().pending():GLib.MainContext.default().iteration(False)
                    self.check_focus(action)
                    code=0xff0d if char=='\n' else 0xff09 if char=='\t' else ord(char) if ord(char)<256 else 0x01000000+ord(char)
                    self.before_delivery();self.key(code,1);self.after_delivery();self.key(code,0)
            elif kind!='mouse_move':raise RuntimeError('unsupported_action')
            return {'done':True,'delivery':self.delivery}
        finally:self.release()

    def progress(self):
        if getattr(self,'request_id',None):emit({'event':'progress','id':self.request_id,'delivery':self.delivery})

    def before_delivery(self):
        self.delivery['state']='uncertain';self.progress()

    def after_delivery(self):
        self.delivery['count']+=1
        self.delivery['state']='all' if self.delivery['count']==self.delivery['total'] else 'partial'
        self.progress()

    def shutdown(self):
        self.release()
        if self.pending:
            try:screen.call(self.bus,DEST,self.pending,'org.freedesktop.portal.Request','Close',None,None)
            except Exception:pass
        session=self.session
        self.session=None
        if session:
            try:screen.call(self.bus,DEST,session,'org.freedesktop.portal.Session','Close',None,None)
            except Exception:pass
        self.closed=True
        if self.wait:self.wait.quit()


def main():
    bus=screen.connect();screen.availability(bus)
    version=screen.call(bus,DEST,PATH,'org.freedesktop.DBus.Properties','Get','(ss)',(RD,'version'))[0]
    if isinstance(version,GLib.Variant):version=version.unpack()
    if version<2:raise RuntimeError('remotedesktop_version_unsupported')
    if len(sys.argv)>1 and sys.argv[1]=='probe':emit({'available':True,'version':version});return
    controller=Input(bus);loop=GLib.MainLoop()
    def stop():controller.shutdown();loop.quit();return GLib.SOURCE_REMOVE
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT,signal.SIGTERM,stop)
    fd=sys.stdin.fileno()
    os.set_blocking(fd,False)
    buffer=b''
    def received(source,condition):
        nonlocal buffer
        eof=False
        # Read raw FD data, not TextIO.readline: buffered read-ahead can hide a
        # queued release from GLib's next readiness notification.
        try:
            while True:
                chunk=os.read(fd,8192)
                if not chunk:eof=True;break
                buffer+=chunk
                if len(buffer)>65536:raise RuntimeError('input_too_large')
        except BlockingIOError:pass
        except Exception:stop();return GLib.SOURCE_REMOVE
        while b'\n' in buffer:
            line,buffer=buffer.split(b'\n',1)
            message={}
            try:
                if len(line)>12000:raise RuntimeError('input_too_large')
                message=json.loads(line);method=message['method']
                if method=='start':result=controller.start()
                elif method=='action':
                    controller.request_id=message['id'];result=controller.action(message['params'])
                elif method=='release':controller.release();result={'released':True}
                else:raise RuntimeError('unsupported_method')
                emit({'id':message['id'],'ok':True,'result':result})
            except Exception as error:
                controller.release()
                screen.diagnostic('failure',**screen.error_details(error))
                emit({'id':message.get('id'),'ok':False,'errorCode':{'control_focus_changed':'focus_changed','control_overlapping_windows':'overlapping_windows','control_accessibility_unavailable':'accessibility_unavailable','control_target_focus_mismatch':'target_focus_mismatch','blocked_application':'blocked_application','expected_app_mismatch':'expected_app_mismatch','shell_search_not_focused':'shell_search_not_focused'}.get(str(error),'operation_failed'),'delivery':controller.delivery if message.get('method')=='action' else None})
                if str(error)=='control_focus_changed': continue
                stop();return GLib.SOURCE_REMOVE
        if eof or condition&GLib.IO_ERR:stop();return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE
    GLib.io_add_watch(fd,GLib.PRIORITY_DEFAULT,GLib.IO_IN|GLib.IO_HUP|GLib.IO_ERR,received)
    try:loop.run()
    finally:controller.shutdown()


if __name__=='__main__':
    try:main()
    except Exception as error:
        screen.diagnostic('failure',**screen.error_details(error));sys.exit(1)
