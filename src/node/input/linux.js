import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sessionEnvironment } from '../screen/linux.js';
const exec = promisify(execFile);
const focusHelper = fileURLToPath(new URL('./focus.py', import.meta.url));
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
    const fail = () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('RemoteDesktop helper closed')); } this.pending.clear(); };
    child.stdout.on('data', chunk => {
      out += chunk.toString(); if (out.length > 65536) { child.kill(); return; }
      let end; while ((end=out.indexOf('\n'))>=0) {
        const line=out.slice(0,end); out=out.slice(end+1);
        try {
          const message=JSON.parse(line);
          if (message.event==='closed') { this.log('input portal session closed'); this.emit('closed', { source:'portal', reason:'GNOME Stop' }); }
          else { const p=this.pending.get(message.id); if(p){clearTimeout(p.timer);this.pending.delete(message.id);message.ok ? p.resolve(message.result) : p.reject(new Error(message.errorCode==='focus_changed'?'Control focus changed since approval; no further input sent. Inspect focus and request a new approval.':'RemoteDesktop operation failed'));} }
        } catch { this.log('input helper invalid response (omitted)'); child.kill(); }
      }
    });
    child.stderr.on('data',chunk=>{
      err+=chunk.toString(); if(err.length>65536){err='';this.log('input helper stderr overflow (omitted)');}
      let end;while((end=err.indexOf('\n'))>=0){const line=err.slice(0,end);err=err.slice(end+1);
        try { const source=JSON.parse(line), record={};
          for(const key of ['event','stage','responseCode','dbusError','message','errorType','errorCode','appId','sender','locked','interface','method']) if(['string','number','boolean'].includes(typeof source[key]))record[key]=typeof source[key]==='string'?source[key].replace(/(?:data:image\/|file:\/\/)\S+|[A-Za-z0-9+/=]{256,}/g,'[redacted]').slice(0,1500):source[key];
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
    return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('RemoteDesktop operation timed out'));child.kill('SIGTERM');},timeout);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('RemoteDesktop pipe failed'));}});});
  }
  async inspect(point) {
    const env = await this.getEnvironment(this.env,this.run);
    const {stdout} = await this.run('/usr/bin/python3',['-B',focusHelper,...(point?[JSON.stringify(point)]:[])],{env,timeout:10000,maxBuffer:16384});
    return JSON.parse(stdout);
  }
  act(action){return this.request('action',action);}
  async releaseAll(){if(this.child && !this.child.killed)await this.request('release',{},2000);}
  async stop(){const child=this.child;if(!child)return;this.child=null;
    child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
}
