import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessionEnvironment } from '../screen/linux.js';
import { ROOT, readJSON, saveJSON } from '../../shared.js';
import { readRemotePolicy, policyPath } from './policy.js';
const exec=promisify(execFile);
export async function grantNotification(text) {
 await exec('/usr/bin/notify-send',['--app-name=bIT','--expire-time=5000','bIT access',text],{timeout:1000,env:await sessionEnvironment()});
}
export class NodeGrants extends EventEmitter {
 constructor({root=ROOT,file=policyPath,now=Date.now,notify=grantNotification,pollMs=100,serve=true}={}) {
  super();Object.assign(this,{root,file,now,notify});this.policy=readRemotePolicy(file);this.entries=new Map();this.fileLedger=path.join(root,'data/node-screen-grants.json');
  // A node restart never resumes authority. Persist tombstones to prevent replay.
  this.ledger=readJSON(this.fileLedger,{});for(const id of Object.keys(this.ledger))this.ledger[id].revoked=true;
  this.timers=new Map();this.poll=setInterval(()=>this.refresh(),pollMs);this.poll.unref();
  if(serve){const socket=path.join(root,'data/grants.sock');fs.mkdirSync(path.dirname(socket),{recursive:true,mode:0o700});
   this.server=net.createServer(client=>{client.once('data',()=>{this.stopAll('local kill switch');client.end('stopped\n');});});
   // Never remove a live socket: a second node must fail closed.
   if(fs.existsSync(socket)){const probe=net.connect(socket);probe.on('error',()=>{try{fs.unlinkSync(socket);}catch{}this.listen(socket);});probe.on('connect',()=>{probe.destroy();this.faulted=true;this.stopAll('another node owns local stop socket');});}
   else this.listen(socket);
  }
 }
 listen(socket){this.server.on('error',()=>{this.stopAll('local stop socket unavailable');this.faulted=true;});this.server.listen(socket,()=>fs.chmodSync(socket,0o600));this.server.unref();}
 capabilities(){this.refresh();return {...this.policy,screen:this.policy.screen&&!this.faulted,control:this.policy.control&&this.policy.screen&&!this.faulted};}
 audit(g,decision){fs.mkdirSync(path.join(this.root,'data'),{recursive:true,mode:0o700});fs.appendFileSync(path.join(this.root,'data/node-access-audit.jsonl'),JSON.stringify({time:new Date(this.now()).toISOString(),grantId:g.grantId,conversationKey:g.conversationKey,kind:g.kind,expiresAt:g.expiresAt,decision})+'\n',{mode:0o600});}
 used(scope){this.audit(this.validate(scope),'capture');}
 persist(){saveJSON(this.fileLedger,this.ledger);}
 refresh(){const next=readRemotePolicy(this.file);if(JSON.stringify(next)!==JSON.stringify(this.policy)){this.policy=next;this.stopAll('local policy changed');}}
 validate({grantId,conversationKey},control=false){
  this.refresh();const g=this.entries.get(grantId);
  if(this.faulted||!g||g.conversationKey!==conversationKey||g.revoked||this.now()>=Date.parse(g.expiresAt))throw Error('Access grant missing, expired, revoked or wrong scope');
  if(control&&g.kind!=='control')throw Error('Control requires its approved screen grant');
  if(g.conversationKey.startsWith('dash:')&&(!this.policy.screen||(control&&!this.policy.control)))throw Error('Remote access not enabled on this machine');
  return g;
 }
 async start(v,isAvailable=async()=>true){
  this.refresh();const {grantId,conversationKey,expiresAt,kind='screen'}=v;
  if(typeof grantId!=='string'||!/^[\w-]{1,80}$/.test(grantId)||typeof conversationKey!=='string'||!conversationKey||conversationKey.length>160||!['screen','control'].includes(kind))throw Error('Invalid screen grant');
  const remote=conversationKey.startsWith('dash:'),minutes=remote&&kind==='control'?10:15;
  const limit=remote?Math.min(minutes,this.policy.screenMinutes,kind==='control'?this.policy.controlMinutes:15):minutes;
  if(remote&&(!this.policy.screen||(kind==='control'&&!this.policy.control)))throw Error('Remote access not enabled on this machine; turn it on at that machine');
  if(remote&&v.policyGeneration!==this.policy.generation)throw Error('Remote policy generation changed; request access again');
  if(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=this.now()||Date.parse(expiresAt)>this.now()+limit*60000)throw Error('Screen grant exceeds local duration cap');
  const prior=this.ledger[grantId];if(prior?.revoked)throw Error('Screen grant was revoked');
  if(this.entries.has(grantId)) {const g=this.validate(v);if((g.kind!==kind&&!(g.kind==='control'&&kind==='screen')&&!(g.kind==='screen'&&kind==='control'&&!remote))||Date.parse(expiresAt)>Date.parse(g.expiresAt))throw Error('Grant widening denied');if(kind==='control'&&!remote){g.kind='control';this.ledger[grantId].kind='control';this.persist();}return {active:true,...g};}
  if(prior)throw Error('Grant start already pending or spent');
  const g={grantId,conversationKey,expiresAt,kind};this.ledger[grantId]={...g,revoked:false};this.persist();
  // Notification failure denies the grant rather than silently enabling access.
  try{if(!await isAvailable())throw Error('Screen capture unavailable');if(this.ledger[grantId].revoked)throw Error('Grant stopped during start');const seconds=Math.max(0,Math.ceil((Date.parse(expiresAt)-this.now())/1000));await this.notify(`bIT can ${kind==='control'?'control and see':'see'} this screen for ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`);}catch{this.ledger[grantId].revoked=true;this.persist();throw Error('Grant notification unavailable');}
  this.refresh();if(this.faulted||remote&&(!this.policy.screen||(kind==='control'&&!this.policy.control))||this.ledger[grantId].revoked||this.now()>=Date.parse(expiresAt))throw Error('Grant revoked during start');
  this.audit(g,'started');this.entries.set(grantId,g);const timer=setTimeout(()=>this.revoke(grantId,'expired'),Date.parse(expiresAt)-this.now());timer.unref();this.timers.set(grantId,timer);return {active:true,...g};
 }
 revoke(id,reason='owner stop'){
  const g=this.entries.get(id);if(typeof id==='string'&&/^[\w-]{1,80}$/.test(id)){this.ledger[id] ||= {};this.ledger[id].revoked=true;try{this.persist();}catch{this.faulted=true;}}
  this.entries.delete(id);clearTimeout(this.timers.get(id));this.timers.delete(id);
  if(g){try{this.audit(g,reason);}catch{this.faulted=true;}this.emit('revoked',{...g,reason});void this.notify(`bIT screen access ended: ${reason}`).catch(()=>{});}
 }
 stopAll(reason){for(const id of Object.keys(this.ledger))this.revoke(id,reason);this.emit('stop',reason);}
 close(){this.faulted=true;clearInterval(this.poll);this.stopAll('node stopped');this.server?.close();}
}
