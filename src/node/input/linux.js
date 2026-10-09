import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {safeEvaluation,evaluationText} from './escalation.js';
import { validDelivery } from './delivery.js';
import { focusRefusal } from './focus.js';
import { sessionEnvironment } from '../screen/linux.js';
const exec = promisify(execFile);
const focusHelper = fileURLToPath(new URL('./focus.py', import.meta.url));
const appsHelper = fileURLToPath(new URL('./apps.py', import.meta.url));
const helper = fileURLToPath(new URL('./portal.py', import.meta.url));
export class LinuxInput extends EventEmitter {
  constructor({ env = process.env, log = console.log, spawnFn = spawn, run = exec, getEnvironment = sessionEnvironment } = {}) {
    super(); Object.assign(this,{env,log,spawnFn,run,getEnvironment}); this.pending = new Map();
  }
  async available() {
    try {
      const env = await this.getEnvironment(this.env,this.run);
      const { stdout } = await this.run('/usr/bin/python3',['-B',helper,'probe'],{env,timeout:10000,maxBuffer:65536});
      return JSON.parse(stdout).available === true;
    } catch { return false; }
  }
  async start() {
    await this.stop();
    const env = await this.getEnvironment(this.env,this.run);
    const child = this.child = this.spawnFn('/usr/bin/python3',['-B',helper],{env,stdio:['pipe','pipe','pipe']});
    let out='', err='';
    const fail = () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('RemoteDesktop helper closed'),{delivery:p.delivery})); } this.pending.clear(); };
    child.stdout.on('data', chunk => {
      out += chunk.toString(); if (out.length > 65536) { child.kill(); return; }
      let end; while ((end=out.indexOf('\n'))>=0) {
        const line=out.slice(0,end); out=out.slice(end+1);
        try {
          const message=JSON.parse(line);
          if(message.event==='progress'){const p=this.pending.get(message.id);if(p&&validDelivery(message.delivery))p.delivery=message.delivery;}
          else if (message.event==='closed') { this.log('input portal session closed'); this.emit('closed', { source:'portal', reason:'GNOME Stop' }); }
          else { const p=this.pending.get(message.id);if(p){clearTimeout(p.timer);this.pending.delete(message.id);
            if(message.ok)p.resolve(message.result);
            else {const messages={task_escalation:'Control task escalation required: sensitive screen, terminal, sending target or unexpected dialog. Stop and ask.',expected_app_mismatch:'Control expected-app mismatch; no further input sent. Stop and explain.',shell_search_not_focused:'Control focus mismatch: GNOME overview search is not active and focused.',focus_changed:'Control focus changed since approval; stop and explain.',blocked_application:'Blocked application; stop and explain.'};
              const evaluation=safeEvaluation(message.evaluation);
              const reason=evaluation?evaluationText(evaluation):messages[message.errorCode]||(['overlapping_windows','accessibility_unavailable','target_focus_mismatch'].includes(message.errorCode)?focusRefusal({'overlapping_windows':'overlapping-windows','target_focus_mismatch':'focus-mismatch'}[message.errorCode]):'RemoteDesktop operation failed');
              p.reject(Object.assign(new Error(reason),{delivery:validDelivery(message.delivery)?message.delivery:p.delivery,evaluation}));
            }
          }}
        } catch { this.log('input helper invalid response (omitted)'); child.kill(); }
      }
    });
    child.stderr.on('data',chunk=>{
      err+=chunk.toString(); if(err.length>65536){err='';this.log('input helper stderr overflow (omitted)');}
      let end;while((end=err.indexOf('\n'))>=0){const line=err.slice(0,end);err=err.slice(end+1);
        try { const source=JSON.parse(line), record={};
          for(const key of ['event','stage','responseCode','dbusError','message','errorType','errorCode','appId','sender','locked','interface','method','rule','step','app','window','windowId']) if(['string','number','boolean'].includes(typeof source[key]))record[key]=typeof source[key]==='string'?source[key].replace(/(?:data:image\/|file:\/\/)\S+|[A-Za-z0-9+/=]{256,}/g,'[redacted]').slice(0,1500):source[key];
          this.log(`input portal ${JSON.stringify(record)}`);
        }catch{this.log('input helper stderr (unstructured output omitted)');}
      }
    });
    child.on('error',()=>{this.log('input helper spawn failed');fail();});
    child.on('exit',(code,signal)=>{this.log(`input helper exit ${JSON.stringify({code,signal})}`);fail();if(this.child===child){this.child=null;this.emit('closed', { source:'helper', reason:'portal helper exited' });}});
    return this.request('start',{},120000);
  }
  request(method,params={},timeout=10000){
    const child=this.child;if(!child || child.killed)return Promise.reject(new Error('RemoteDesktop session unavailable'));
    return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{const receipt=this.pending.get(id)?.delivery;this.pending.delete(id);reject(Object.assign(new Error('RemoteDesktop operation timed out'),{delivery:receipt}));child.kill('SIGTERM');},timeout);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('RemoteDesktop pipe failed'));}});});
  }
  async inspect(point, { searchFocus = false } = {}) {
    const env = await this.getEnvironment(this.env,this.run);
    const {stdout} = await this.run('/usr/bin/python3',['-B',focusHelper,...(searchFocus?['--search-focus']:point?[JSON.stringify(point)]:[])],{env,timeout:10000,maxBuffer:16384});
    return JSON.parse(stdout);
  }
  async appOperation(operation,value){
    const session=await this.getEnvironment(this.env,this.run);
    // Desktop apps need session/locale vars, never bIT/Discord/API credentials.
    const env=Object.fromEntries(Object.entries(session).filter(([key])=>/^(?:PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_.*|TZ|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_.*|CONTROL_BLOCKED_APPS)$/.test(key)));
    const maxBuffer=operation==='list'?1024*1024:65536, label=operation==='list'?'app listing':operation==='resolve'?'app resolution':'launch';
    let packet,exitCode=0,signal;
    try{const {stdout}=await this.run('/usr/bin/python3',['-B',appsHelper,operation,JSON.stringify(value)],{env,timeout:10000,maxBuffer});packet=JSON.parse(stdout);}
    catch(error){exitCode=typeof error.code==='number'?error.code:undefined;signal=error.signal;try{packet=JSON.parse(error.stdout);}catch{
      const reason=error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'helper output exceeded '+maxBuffer+'-byte limit':error.killed?'helper timed out':error.code==='ENOENT'?'helper executable not found':error instanceof SyntaxError?'invalid helper response':'helper failed'+(exitCode!==undefined?' (exit '+exitCode+')':'');
      this.log(`input launch failure ${JSON.stringify({stage:operation,code:'helper_protocol',nativeCode:error.code,exitCode,signal,reason})}`);
      throw Object.assign(new Error('Control '+label+' failed at '+operation+': '+reason),{launchFailure:true});
    }}
    if(!packet?.ok){
      const detail=packet?.error,known=['blocked_application','invalid_app','app_not_installed_or_ambiguous','desktop_app_changed_since_approval','app_launch_failed','app_exit','gio_error','helper_error','unsupported_operation','activation_timeout','descriptor_read_failed'];
      const code=known.includes(detail?.code)?detail.code:'helper_error';
      const message=typeof detail?.message==='string'?detail.message.replace(/https?:\/\/\S+|(?:token|password|secret|authorization)\s*[:=]\s*\S+|[A-Za-z0-9+/=]{80,}/ig,'[redacted]').slice(0,500):'launch helper failed';
      const safety=['blocked_application','invalid_app','desktop_app_changed_since_approval'].includes(code);
      this.log(`input launch failure ${JSON.stringify({stage:operation,code,message,domain:detail?.domain,nativeCode:detail?.nativeCode,exitCode,signal})}`);
      throw Object.assign(new Error((safety?'Control launch safety refusal at '+operation+': ':'Control '+label+' failed at '+operation+': ')+message),{launchFailure:!safety});
    }
    this.log(`input launch ${JSON.stringify({stage:operation,app:packet.result?.launched?.id??packet.result?.id,startup:packet.result?.startup,exitCode})}`);
    return packet.result;
  }
  listApps(){return this.appOperation('list',null);}
  cancel(){this.child?.kill('SIGTERM');}
  resolveApp(app){return this.appOperation('resolve',app);}
  launchApp(approved){return this.appOperation('launch',approved);}
  act(action){return this.request('action',action);}
  async releaseAll(){if(this.child && !this.child.killed)await this.request('release',{},2000);}
  async stop(){const child=this.child;if(!child)return;this.child=null;
    child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
}
