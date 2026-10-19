import test from 'node:test';
import assert from 'node:assert/strict';
import { computePresence, PresenceHub, PRIORITY, REACTION_MS, createPresencePublisher, observeSync } from '../src/brain/presence.js';
import { faceFor, detailFor } from '../shared/bit-orb/src/face.js';
import { createExpress } from '../src/brain/tools.js';
import { createPermissions, EXPRESS_TOOL } from '../src/brain/permissions.js';
import { noSync } from '../src/bitos/sync.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const now=Date.parse('2026-10-19T16:00:00Z');
const flag = state => ({idle:{},listen:{listening:1},think:{thinking:1},agent:{agents:{a:{node:'MacBook'}}},screen:{nodes:{'OZZY-AI':{capture:{screen:true}}}},lease:{leases:{a:{node:'MacBook',endsAt:now+300000,totalSec:300}}},approve:{approvals:{a:{expiresAt:now+300000}}}}[state]);
test('every state pair uses the higher priority',()=>{for(let i=0;i<PRIORITY.length;i++)for(let j=0;j<PRIORITY.length;j++)assert.equal(computePresence({...flag(PRIORITY[i]),...flag(PRIORITY[j])},now).state,PRIORITY[Math.max(i,j)]);});
test('sage boundaries across spring and fall DST transitions',()=>{
 for(const [date,offset] of [['2026-03-07','-05:00'],['2026-03-08','-04:00'],['2026-10-31','-04:00'],['2026-11-01','-05:00']])for(const [hour,mood]of [['21:59','hype'],['22:00','sage'],['04:59','sage'],['05:00','hype']])assert.equal(computePresence({mood:'hype'},Date.parse(`${date}T${hour}:00${offset}`)).mood,mood);
});
test('node truth alone determines watching; missing capture is false',()=>{
 assert.deepEqual(computePresence({screen:false,nodes:{MacBook:{},'OZZY-AI':{capture:{screen:true,input:false}}}},now).watching,['OZZY-AI']);
 assert.equal(computePresence(flag('screen'),now).state,'screen');
 assert.equal(computePresence({nodes:{MacBook:{}}},now).state,'idle');
});
test('only approval and a lease under two minutes interrupt',()=>{
 for(const state of PRIORITY)assert.equal(computePresence(flag(state),now).attention,state==='approve'?'interrupt':'ambient');
 for(const [left,want]of [[120000,'ambient'],[119999,'interrupt'],[0,'ambient']])assert.equal(computePresence({leases:{a:{endsAt:now+left}}},now).attention,want);
});
test('reaction expiry and replacement',()=>{
 let clock=now;const hub=new PresenceHub({now:()=>clock});
 for(const [kind,length]of Object.entries(REACTION_MS)){hub.react(kind);assert.equal(hub.value.reaction.kind,kind);clock+=length-1;hub.recompute();assert.equal(hub.value.reaction.kind,kind);clock++;hub.recompute();assert.equal(hub.value.reaction,null);}
 hub.react('curious');hub.react('unsure');assert.equal(hub.value.reaction.kind,'unsure');hub.close();
});
test('express rate limit, exact permission scope even when tainted',async()=>{
 let clock=now;const reactions=[];const express=createExpress({react:kind=>reactions.push(kind)},()=>clock);
 express({face:'unsure'});clock+=9999;assert.deepEqual(express({face:'celebrate'}),{ignored:true});clock++;express({face:'curious'});assert.deepEqual(reactions,['unsure','curious']);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-presence-'));const permissions=createPermissions({root,web:{session:()=>({tainted:true})},approve:()=>{throw Error('Must not request approval');}});
 assert.equal((await permissions.canUseTool(EXPRESS_TOOL,{face:'unsure'})).behavior,'allow');
 for(const name of ['express','mcp__presence__execute','mcp__presence__express_extra','Bash'])assert.equal((await permissions.canUseTool(name,{})).behavior,'deny');
});
test('approve and offline override reactions; detail thresholds and static motion',()=>{
 for(const state of ['approve','offline'])for(const reaction of Object.keys(REACTION_MS))assert.deepEqual(faceFor({state,reaction,t:1}),faceFor({state,t:1}));
 for(const [size,detail]of [[28,'min'],[39,'min'],[40,'simple'],[95,'simple'],[96,'full']])assert.equal(detailFor(size),detail);
 assert.equal(faceFor({state:'think',reducedMotion:true}).attrs.body.transform,'translate(0 0)');
});
test('publisher only writes on change or 60s heartbeat',async()=>{
 let clock=now,scheduled,beat;const writes=[];const hub=new PresenceHub({now:()=>clock});
 const publisher=createPresencePublisher({hub,now:()=>clock,write:async p=>writes.push(p),schedule:fn=>{scheduled=fn;return undefined;},interval:fn=>{beat=fn;return undefined;}});
 await scheduled();assert.equal(writes.length,1);await publisher.flush();assert.equal(writes.length,1);
 clock+=59999;await beat();assert.equal(writes.length,1);clock++;await publisher.flush();assert.equal(writes.length,2);
 hub.set({thinking:1});await scheduled();assert.equal(writes.length,3);hub.set({thinking:1});await publisher.flush();assert.equal(writes.length,3);publisher.close();hub.close();
});
test('local sync observer works with disabled frozen mirror',()=>{const hub=new PresenceHub({now:()=>now});const sync=observeSync(noSync,hub);sync.leaseStarted({id:'a',machine:'MacBook',issuedAt:now,expiresAt:now+600000,level:'control'});assert.equal(hub.value.state,'lease');sync.leaseEnded({id:'a'});assert.equal(hub.value.state,'idle');hub.close();});

test('node heartbeat feeds actual capture, and legacy heartbeats clear it', async () => {
 const { NodeHub } = await import('../src/brain/nodeHub.js');
 const hub = new PresenceHub({now:()=>now}), peer = {};
 const nodeHub = { nodes:new Map([['ozzy-ai',{machine:'OZZY-AI',online:true,peer}]]), sync:observeSync(noSync,hub), emit(){} };
 NodeHub.prototype.message.call(nodeHub,'ozzy-ai',peer,{type:'heartbeat',capture:{screen:true,input:true}});
 assert.equal(hub.value.state,'screen');assert.deepEqual(hub.value.watching,['OZZY-AI']);
 NodeHub.prototype.message.call(nodeHub,'ozzy-ai',peer,{type:'heartbeat'});
 assert.equal(hub.value.state,'idle');assert.deepEqual(hub.value.watching,[]);hub.close();
});

test('runner lifecycle exposes think, restores idle and registers the in-process expression tool', async t => {
 const { Runner } = await import('../src/brain/runner.js');
 const { Budget } = await import('../src/brain/budget.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-presence-runner-'));
 for(const dir of ['memory','skills','persona','schedules'])fs.mkdirSync(path.join(root,'bit',dir),{recursive:true});
 fs.writeFileSync(path.join(root,'bit/persona/persona.md'),'bIT');
 fs.writeFileSync(path.join(root,'bit/persona/personalities.json'),'{}');
 const presence=new PresenceHub();t.after(()=>presence.close());
 const runner=new Runner({root,presence,hub:{list:()=>[]},budget:new Budget({file:path.join(root,'data/budget.json'),cap:1}),queryFn:async function*({options}){
  assert.equal(presence.value.state,'think');assert.ok(options.mcpServers.presence);
  assert.equal((await options.canUseTool(EXPRESS_TOOL,{face:'unsure'})).behavior,'allow');
  runner.express({face:'unsure'});assert.equal(presence.value.reaction.kind,'unsure');
  yield {type:'result',subtype:'success',result:"I'm unsure; I can't know that.",total_cost_usd:0,session_id:'presence-proof'};
 }});t.after(()=>runner.close());
 assert.match(await runner.run('thread','Something unknowable'),/unsure/);
 assert.equal(presence.value.state,'idle');
});
