import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startDashboardChat } from '../src/brain/dashboardChat.js';
import { startAccess } from '../src/brain/access.js';
import { ScreenGrants } from '../src/brain/screens.js';
import { ControlGrants } from '../src/brain/controls.js';
import { NodeGrants } from '../src/node/grants/index.js';
import { writeRemotePolicy } from '../src/node/grants/policy.js';
import { accessDB } from '../scripts/test-fixtures/access-db.js';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
async function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'access-brain-'));const file=path.join(root,'remote.json');writeRemotePolicy(file,{screen:true,control:true,screenMinutes:5,controlMinutes:3,generation:1});const node=new NodeGrants({root,file,serve:false,notify:async()=>{}}),db=accessDB(),hub=new EventEmitter(),calls=[];
 hub.list=()=>[{machine:'OZZY-AI',online:true,capabilities:['status','screen','input']}];hub.request=async(machine,method,p)=>{calls.push({machine,method,p});if(method==='grants.capabilities')return node.capabilities();if(method==='grants.start')return node.start(p);if(method==='grants.check')return {active:true,...node.validate(p)};if(method==='grants.stop'){node.revoke(p.grantId);return {stopped:true};}return {started:true};};
 const screens=new ScreenGrants({root,hub}),controls=new ControlGrants({root,hub,screens}),runner={screens,controls};
 const access=startAccess({root,env:{BITOS_SUPABASE:'1',BITOS_DASHBOARD_CHAT:'1',BITOS_OWNER_USER_ID:'owner'},hub,runner,makeClient:async()=>db,pollMs:60000,log(){}});await access.ready;
 t.after(async()=>{access.close();await controls.close();node.close();fs.rmSync(root,{recursive:true,force:true});});
 const scope={channel:'dash:conversation',workspace:'workspace',tainted:()=>false};
 async function request(kind='screen',minutes=2){await access.request(scope,{machine:'OZZY-AI',kind,minutes,reason:'Open an editor and type the approved sentence'});return db.tables.access_requests.at(-1);}
 async function approve(r){Object.assign(r,{status:'approved',decided_by:'owner',decided_at:new Date().toISOString(),granted_minutes:r.requested_minutes});await access.scan();}
 return {root,db,hub,node,runner,access,calls,scope,request,approve};}
test('request_access and chat words never grant; another owner cannot activate',async t=>{
 const f=await fixture(t),r=await f.request();assert.equal(r.status,'pending');assert.equal(f.node.entries.size,0);assert.equal(await f.access.confirm(f.scope.channel),null);
 Object.assign(r,{status:'approved',decided_by:'other',decided_at:new Date().toISOString(),granted_minutes:2});await f.access.scan();assert.equal(f.node.entries.size,0);
});
test('approved exact-scope access activates only after node confirmation and Stop ends it within two seconds',async t=>{
 const f=await fixture(t),r=await f.request();await f.approve(r);assert.ok(await f.access.confirm(f.scope.channel));assert.equal(await f.access.confirm('dash:other'),null);assert.equal(await f.access.confirm('discord-conversation'),null);
 const g=f.db.tables.access_grants[0],start=Date.now();g.stop_requested=true;await f.access.scan();assert.equal(await f.access.confirm(f.scope.channel),null);assert.equal(f.node.entries.size,0);assert.ok(Date.now()-start<2000);assert.ok(f.db.tables.task_events.some(e=>e.payload.decision==='owner stop'));
});
test('taint ends screen and control for only that conversation and prevents future requests',async t=>{
 const f=await fixture(t),r=await f.request('control');await f.approve(r);assert.ok(f.runner.controls.active(f.scope.channel));
 await f.access.taint(f.scope.channel);assert.equal(f.runner.screens.active(f.scope.channel),null);assert.equal(f.runner.controls.active(f.scope.channel),null);assert.equal(f.node.entries.size,0);
 const count=f.db.tables.access_requests.length;await f.request();assert.equal(f.db.tables.access_requests.length,count);
});
test('tainted/scheduled requests and duration widening cannot activate',async t=>{
 const f=await fixture(t);
 for(const scope of [{...f.scope,scheduled:true},{...f.scope,tainted:()=>true},{...f.scope,channel:'discord'}]){const result=await f.access.request(scope,{machine:'OZZY-AI',kind:'screen',minutes:1,reason:'see'});assert.equal(result.isError,true);}
 assert.equal(f.db.tables.access_requests.length,0);await f.request('control',4);assert.equal(f.db.tables.access_requests.length,0);
 const r=await f.request('control',2);Object.assign(r,{status:'approved',decided_by:'owner',decided_at:new Date().toISOString(),granted_minutes:4});await f.access.scan();assert.equal(f.node.entries.size,0);
});
test('a seeded grant row and local JSON cannot expose screenshot/input tools',async t=>{
 const f=await fixture(t),key=f.scope.channel;f.db.tables.access_grants.push({id:'seed',request_id:'seed',owner_id:'owner',node_id:'node',conversation_id:'conversation',workspace_id:'workspace',kind:'control',status:'active',stop_requested:false,expires_at:new Date(Date.now()+60000).toISOString()});
 f.runner.screens.on(key,'OZZY-AI',{id:'seed'});f.runner.controls.state.grants[key]={id:'seed-control',machine:'ozzy-ai',expiresAt:new Date(Date.now()+60000).toISOString(),count:0,maxActions:40,screenId:'seed'};
 for(const area of ['skills','persona','schedules','memory'])fs.mkdirSync(path.join(f.root,'bit',area),{recursive:true});fs.writeFileSync(path.join(f.root,'bit/persona/persona.md'),'bIT');fs.writeFileSync(path.join(f.root,'bit/persona/personalities.json'),'{}');
 let options;const runner=new Runner({root:f.root,hub:f.hub,screens:f.runner.screens,controls:f.runner.controls,budget:new Budget({file:path.join(f.root,'budget.json'),cap:10}),queryFn:async function*({options:o}){options=o;yield {type:'result',subtype:'success',session_id:'test-session',total_cost_usd:0,result:'No access'};}});runner.access=f.access;t.after(()=>runner.close());
 await runner.run(key,'what is on my screen',{workspace:'workspace',tasks:{}});assert.equal(options.mcpServers.screens,undefined);assert.equal(options.mcpServers.computer,undefined);assert.ok(options.mcpServers.access);
});
test('input plan grant does not authorize a step; exact step needs its own owner card',async t=>{
 const f=await fixture(t),r=await f.request('control');await f.approve(r);let resolved=false;
 const pending=f.access.approve(f.scope.channel,{tool:'computer',description:'Type exact text',input:{action:'type',text:'hello',machine:'ozzy-ai'}}).then(v=>{resolved=true;return v;});
 for(let i=0;i<30&&f.db.tables.access_requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(resolved,false);const step=f.db.tables.access_requests.at(-1);assert.equal(step.kind,'input');assert.equal(step.action_detail.input.text,'hello');
 await f.approve(step);assert.equal(await pending,true);
});
test('a persisted tainted conversation cannot activate an approved request after restart',async t=>{
 const f=await fixture(t),r=await f.request();f.runner.web={session:()=>({tainted:true})};f.runner.webKeys={'dash:conversation':'tainted-session'};await f.approve(r);assert.equal(f.node.entries.size,0);assert.equal(await f.access.confirm(f.scope.channel),null);
});
test('taint in one conversation does not revoke a different conversation',async t=>{
 const f=await fixture(t);f.db.tables.conversations.push({id:'another',workspace_id:'workspace',owner_id:'owner'});
 const first=await f.request();await f.approve(first);
 await f.access.request({...f.scope,channel:'dash:another'},{machine:'OZZY-AI',kind:'screen',minutes:1,reason:'Look at a different conversation'});const second=f.db.tables.access_requests.at(-1);await f.approve(second);
 await f.access.taint(f.scope.channel);assert.equal(await f.access.confirm(f.scope.channel),null);assert.ok(await f.access.confirm('dash:another'));
});
test('a local stop generation invalidates an older approved request',async t=>{
 const f=await fixture(t),r=await f.request();writeRemotePolicy(f.node.file,{...f.node.capabilities(),generation:2});await f.approve(r);assert.equal(f.node.entries.size,0);
});
test('dashboard grants do not create legacy Discord tasks/leases or publish unconfirmed presence',async t=>{
 const f=await fixture(t),mirrors=[],presence=[];const screens=new ScreenGrants({root:f.root,hub:f.hub,sync:{leaseStarted:e=>mirrors.push(e),leaseEnded:e=>mirrors.push(e)},presence:{observe:(...e)=>presence.push(e)}});
 screens.on('dash:conversation','OZZY-AI');assert.deepEqual(mirrors,[]);assert.deepEqual(presence,[]);screens.off('dash:conversation');assert.equal(presence[0][0],'leaseEnded');
 screens.on('discord-thread','OZZY-AI');assert.equal(mirrors.length,1);
});

test('node-confirmed grant resumes only the approved plan in that dashboard conversation',async t=>{
 const f=await fixture(t),runs=[];f.runner.access=f.access;f.runner.run=async(key,prompt,args)=>{runs.push({key,prompt});assert.equal(await args.approve({tool:'Write'}),false);await args.output('Inspecting');return 'The approved access task is complete';};
 const chat=startDashboardChat({root:f.root,env:{BITOS_SUPABASE:'1',BITOS_DASHBOARD_CHAT:'1',BITOS_OWNER_USER_ID:'owner'},runner:f.runner,makeClient:async()=>f.db,sleep:async()=>{},log(){}});t.after(()=>chat.close());await chat.ready;
 const r=await f.request();assert.equal(runs.length,0);await f.approve(r);await Promise.resolve();await chat.drain();
 assert.equal(runs.length,1);assert.equal(runs[0].key,'dash:conversation');assert.ok(runs[0].prompt.includes(r.reason));assert.ok(runs[0].prompt.includes('Each input still needs its own owner approval'));
 assert.ok(f.db.tables.chat_messages.some(m=>m.author==='bit'&&m.body==='The approved access task is complete'&&m.status==='done'));
 await f.access.scan();await chat.drain();assert.equal(runs.length,1);
});
test('Realtime Stop bypasses the polling queue and revokes the confirmed node grant',async t=>{
 const f=await fixture(t),r=await f.request();await f.approve(r);const g=f.db.tables.access_grants[0];g.stop_requested=true;
 const handler=f.db.events.find(e=>e.filter.table==='access_grants').handler,start=Date.now();await handler({new:structuredClone(g)});
 assert.equal(f.node.entries.size,0);assert.ok(Date.now()-start<2000);assert.equal(g.status,'ended');
});
