import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { NodeGrants } from '../src/node/grants/index.js';
import { writeRemotePolicy,readRemotePolicy } from '../src/node/grants/policy.js';
import { InputControl } from '../src/node/input/index.js';
function setup(t,extra={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-access-node-')),file=path.join(root,'policy.json'),notices=[];writeRemotePolicy(file,{screen:true,control:true,screenMinutes:5,controlMinutes:3,generation:1});const grants=new NodeGrants({root,file,notify:async s=>notices.push(s),serve:false,...extra});t.after(()=>{grants.close();fs.rmSync(root,{recursive:true,force:true});});return {root,file,grants,notices};}
function grant(extra={}){return {policyGeneration:1,grantId:'grant',conversationKey:'dash:conversation',expiresAt:new Date(Date.now()+60000).toISOString(),...extra};}
test('no local opt-in refuses remote screen and control, while Discord remains local-enabled',async t=>{
 const f=setup(t);writeRemotePolicy(f.file,{...readRemotePolicy(f.file),screen:false,control:false,generation:2});
 for(const kind of ['screen','control'])await assert.rejects(f.grants.start(grant({kind})),/not enabled/);
 await f.grants.start(grant({conversationKey:'discord-thread'}));assert.ok(f.grants.validate({grantId:'grant',conversationKey:'discord-thread'}));
});
test('screen authority rejects missing, wrong-scope, expired and revoked grants without a brain',async t=>{
 let clock=Date.now();const f=setup(t,{now:()=>clock});await f.grants.start(grant({expiresAt:new Date(clock+100).toISOString()}));
 for(const v of [{},{grantId:'grant',conversationKey:'dash:another'},{grantId:'grant',conversationKey:'discord-thread'}])assert.throws(()=>f.grants.validate(v));
 assert.ok(f.grants.validate({grantId:'grant',conversationKey:'dash:conversation'}));clock+=101;assert.throws(()=>f.grants.validate({grantId:'grant',conversationKey:'dash:conversation'}));
 f.grants.revoke('grant');await assert.rejects(f.grants.start(grant()),/revoked/);
});
test('screen/control local duration limits and notification failure deny grants',async t=>{
 const f=setup(t);await assert.rejects(f.grants.start(grant({expiresAt:new Date(Date.now()+6*60000).toISOString()})),/cap/);await assert.rejects(f.grants.start(grant({kind:'control',expiresAt:new Date(Date.now()+4*60000).toISOString()})),/cap/);
 const other=setup(t,{notify:async()=>{throw Error('no notification');}});await assert.rejects(other.grants.start(grant()),/notification/);assert.throws(()=>other.grants.validate({grantId:'grant',conversationKey:'dash:conversation'}));
});
test('local disable revokes immediately, notifies, and prevents replay',async t=>{
 const f=setup(t);await f.grants.start(grant());writeRemotePolicy(f.file,{...readRemotePolicy(f.file),screen:false,control:false,generation:2});f.grants.refresh();assert.equal(f.grants.entries.size,0);await assert.rejects(f.grants.start(grant()),/not enabled/);assert.ok(f.notices.some(s=>s.includes('ended')));
});
test('node restart tombstones old grants instead of restoring authorization',async t=>{
 const f=setup(t);await f.grants.start(grant());const next=new NodeGrants({root:f.root,file:f.file,serve:false,notify:async()=>{}});t.after(()=>next.close());await assert.rejects(next.start(grant()),/revoked/);
});
test('control is bound to exact screen scope and dies at screen expiry without the brain',async t=>{
 const f=setup(t);const backend=Object.assign(new EventEmitter(),{available:async()=>true,start:async()=>{},releaseAll:async()=>{},stop:async()=>{}});
 const input=new InputControl({root:f.root,enabled:true,screen:{available:async()=>true},backend,log(){}});input.grants=f.grants;f.grants.on('revoked',g=>{if(input.session?.screenGrantId===g.grantId)void input.stop('screen ended',true);});t.after(()=>input.close());
 await f.grants.start(grant({kind:'control',expiresAt:new Date(Date.now()+250).toISOString()}));
 await assert.rejects(input.start({grantId:'control',screenGrantId:'grant',conversationKey:'dash:wrong',expiresAt:new Date(Date.now()+150).toISOString(),maxActions:40}),/scope/);
 await input.start({grantId:'control',screenGrantId:'grant',conversationKey:'dash:conversation',expiresAt:new Date(Date.now()+150).toISOString(),maxActions:40});
 await assert.rejects(input.inspect({grantId:'control',conversationKey:'dash:wrong',action:'screenshot'}),/scope/);
 f.grants.revoke('grant','screen stopped');assert.equal(input.session,null);
 await assert.rejects(input.start({grantId:'other',screenGrantId:'grant',conversationKey:'dash:conversation',expiresAt:new Date(Date.now()+100).toISOString(),maxActions:40}));
});
test('local socket kill switch stops all authority in under two seconds',async t=>{
 const f=setup(t,{serve:true});await new Promise(resolve=>f.grants.server.once('listening',resolve));await f.grants.start(grant());const start=Date.now();
 await new Promise((resolve,reject)=>{const client=net.connect(path.join(f.root,'data/grants.sock'));client.on('error',reject);client.on('connect',()=>client.write('stop'));client.on('data',()=>{client.end();resolve();});});
 assert.equal(f.grants.entries.size,0);assert.ok(Date.now()-start<2000);
});
test('node timers end screen and control at expiry with no brain connection',async t=>{
 const f=setup(t),backend=Object.assign(new EventEmitter(),{available:async()=>true,start:async()=>{},releaseAll:async()=>{},stop:async()=>{}}),input=new InputControl({root:f.root,enabled:true,screen:{available:async()=>true},backend,log(){}});input.grants=f.grants;t.after(()=>input.close());
 f.grants.on('revoked',g=>{if(input.session?.screenGrantId===g.grantId)void input.stop('screen expired',true);});
 await f.grants.start(grant({kind:'control',expiresAt:new Date(Date.now()+500).toISOString()}));await input.start({grantId:'expires',screenGrantId:'grant',conversationKey:'dash:conversation',expiresAt:new Date(Date.now()+400).toISOString(),maxActions:40});
 await new Promise(resolve=>setTimeout(resolve,650));assert.equal(input.session,null);assert.equal(f.grants.entries.size,0);assert.equal(f.grants.ledger.grant.revoked,true);
});
test('local CLI enable/status/disable writes 0600 policy and disables active grants',async t=>{
 const {runGrants}=await import('../scripts/grants.mjs');const f=setup(t,{serve:true});await new Promise(resolve=>f.grants.server.once('listening',resolve));const opts={root:f.root,file:f.file,print(){}};
 await runGrants(['disable'],opts);assert.equal((await runGrants(['status'],opts)).screen,false);
 await runGrants(['enable','--screen','--screen-minutes=5'],opts);assert.equal(fs.statSync(f.file).mode&0o777,0o600);assert.equal(readRemotePolicy(f.file).control,false);
 await f.grants.start(grant({policyGeneration:readRemotePolicy(f.file).generation}));await runGrants(['stop'],opts);assert.equal(f.grants.entries.size,0);
 await runGrants(['enable','--control','--control-minutes=3'],opts);assert.equal(readRemotePolicy(f.file).screen,true);
 await f.grants.start(grant({grantId:'second',policyGeneration:readRemotePolicy(f.file).generation}));await runGrants(['disable'],opts);assert.equal(f.grants.entries.size,0);await assert.rejects(f.grants.start(grant({grantId:'third'})),/not enabled/);
 await assert.rejects(runGrants(['enable','--screen','--screen-minutes=16'],opts),/cap/);assert.equal(readRemotePolicy(f.file).screen,false);
});
test('local stop wins during an in-flight grant start and stale policy cannot restore it',async t=>{
 const f=setup(t);let release;const pending=f.grants.start(grant(),()=>new Promise(resolve=>{release=resolve;}));
 f.grants.stopAll('local kill');release(true);await assert.rejects(pending);assert.equal(f.grants.entries.size,0);
 writeRemotePolicy(f.file,{...readRemotePolicy(f.file),generation:2});await assert.rejects(f.grants.start(grant({grantId:'stale'})),/generation/);
});
