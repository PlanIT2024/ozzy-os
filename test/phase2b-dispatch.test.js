import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDispatcher } from '../src/bitos/dispatch.js';

function fixture(options={}) {
 let time=1000000;const tables={nodes:[{id:'n',name:options.name||'MACBOOK',owner_id:'owner'}],tasks:[{id:'t',workspace_id:'ws'}],workspace_members:[{workspace_id:'ws',user_id:'owner'}],agent_runs:[{id:'r',task_id:'t',node_id:'n',executor:'codex',folder_alias:'sandbox',prompt:'test',lease_minutes:5,status:'requested',stop_requested:false,...options.run}],approvals:[],task_events:[]};
 const callbacks=[], subscriptions=[], logs=[], ticks=[];let reads=0, fault=options.fault;
 const db={from(table){let filters=[],op='select',payload;const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},update(v){op='update';payload=v;return q;},insert(v){op='insert';payload=v;return q;},then(resolve,reject){reads++;try{const failure=fault?.({table,op,payload});if(failure){if(failure.thrown)throw failure.thrown;return Promise.resolve({data:null,error:failure}).then(resolve,reject);}let rows=tables[table].filter(r=>filters.every(f=>f(r)));if(op==='update')rows.forEach(r=>Object.assign(r,structuredClone(payload)));if(op==='insert'){const r={status:'pending',...structuredClone(payload)};tables[table].push(r);rows=[r];}return Promise.resolve({data:structuredClone(rows)}).then(resolve,reject);}catch(e){return Promise.reject(e).then(resolve,reject);}}};return q;},channel(){const c={on(_a,_b,fn){callbacks.push(fn);return c;},subscribe(fn){subscriptions.push(fn);return c;}};return c;},removeChannel(){}};
 const hub=new EventEmitter(),calls=[];hub.list=()=>[{machine:tables.nodes[0].name,online:true}];hub.request=async(machine,method,params)=>{calls.push({method,params});if(method==='agent.capabilities')return {executors:['codex'],folders:['sandbox'],maxLeaseMinutes:30,maxConcurrent:2};return {};};
 const d=createDispatcher({env:{BITOS_DISPATCH:options.off?'0':'1',BITOS_OWNER_USER_ID:'owner',BITOS_AGENT_NODES:options.allow??'MACBOOK',SUPABASE_SERVICE_ROLE_KEY:'fake-service-role-value'},hub,makeClient:async()=>{if(options.clientError)throw options.clientError;return db;},now:()=>time,interval:(fn,ms)=>{ticks.push(fn);assert.equal(ms,5000);return {unref(){}};},info:line=>logs.push(line),log:line=>logs.push(line)});
 return {d,tables,hub,calls,callbacks,subscriptions,logs,ticks,setFault(fn){fault=fn;},get reads(){return reads;},advance(ms=120001){time+=ms;},approve(a=tables.approvals[0]){Object.assign(a,{status:'approved',decided_by:'owner',decided_at:new Date(time).toISOString()});}};
}
test('flag off performs zero reads and subscriptions',async()=>{const f=fixture({off:true});await f.d.ready;assert.equal(f.reads,0);assert.equal(f.callbacks.length,0);});
for(const [label,options] of Object.entries({unlisted:{allow:''},'OZZY-AI default':{name:'OZZY-AI',allow:''},alias:{run:{folder_alias:'elsewhere'}},executor:{run:{executor:'cowork'}},lease:{run:{lease_minutes:31}}}))test(`denies ${label}`,async()=>{const f=fixture(options);await f.d.ready;assert.equal(f.tables.agent_runs[0].status,'denied');f.d.close();});
for(const type of ['wrong owner','expired','mismatch','other run','payload only'])test(`no dispatch: ${type}`,async()=>{const f=fixture();await f.d.ready;f.approve();const a=f.tables.approvals[0];if(type==='wrong owner')a.decided_by='attacker';if(type==='expired')a.expires_at=new Date(0).toISOString();if(type==='mismatch')a.action_detail.run_id='bogus';if(type==='other run'){f.tables.agent_runs.push({...f.tables.agent_runs[0],id:'r2',task_id:'different'});a.action_detail.run_id='r2';}if(type==='payload only'){a.status='pending';f.callbacks[1]({new:{...a,status:'approved'}});}await f.d.scan();assert.equal(f.calls.filter(c=>c.method==='agent.run').length,0);f.d.close();});
test('happy path, nested approval, redacted event, finished',async()=>{const f=fixture();await f.d.ready;f.approve();await f.d.scan();assert.equal(f.tables.agent_runs[0].status,'running');assert.equal(f.calls.find(c=>c.method==='agent.run').params.runId,'r');f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.approval_request',runId:'r',requestId:'q',action:'tool'}});await f.d.scan();f.approve(f.tables.approvals[1]);await f.d.scan();assert.equal(f.calls.find(c=>c.method==='agent.decide').params.decision,'allow');f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.event',runId:'r',summary:'progress',prompt:'secret'}});f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.finished',runId:'r',status:'done',branch:'agent/test',summary:'done'}});await f.d.scan();assert.equal(f.tables.tasks[0].status,'done');assert.equal(f.tables.agent_runs[0].branch,'agent/test');assert.ok(!JSON.stringify(f.tables.task_events).includes('secret'));f.d.close();});
test('stop sends agent.stop',async()=>{const f=fixture();await f.d.ready;f.approve();await f.d.scan();f.tables.agent_runs[0].stop_requested=true;await f.d.scan();assert.ok(f.calls.some(c=>c.method==='agent.stop'));f.d.close();});
test('restart without node confirmation fails after two minutes',async()=>{const f=fixture({run:{status:'running'}});await f.d.ready;f.advance();await f.d.scan();assert.equal(f.tables.agent_runs[0].summary,'brain restarted');f.d.close();});
test('nested denied and expired approvals send deny',async()=>{
 for(const expired of [false,true]){const f=fixture();await f.d.ready;f.approve();await f.d.scan();f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.approval_request',runId:'r',requestId:'q',action:'tool'}});await f.d.scan();const a=f.tables.approvals[1];if(expired)a.expires_at=new Date(0).toISOString();else a.status='denied';await f.d.scan();assert.equal(f.calls.find(c=>c.method==='agent.decide').params.decision,'deny');f.d.close();}
});
test('node confirmation prevents restart cleanup and wrong node cannot finish',async()=>{const f=fixture({run:{status:'running'}});await f.d.ready;f.hub.emit('agent',{machine:'OTHER',message:{type:'agent.finished',runId:'r',status:'done'}});f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.event',runId:'r',summary:'alive'}});await f.d.scan();f.advance();await f.d.scan();assert.equal(f.tables.agent_runs[0].status,'running');f.d.close();});
for(const status of ['failed','stopped','expired'])test(`finished ${status} updates task`,async()=>{const f=fixture({run:{status:'running'}});await f.d.ready;f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.finished',runId:'r',status,summary:status}});await f.d.scan();assert.equal(f.tables.tasks[0].status,status==='failed'?'waiting_on_you':'cancelled');f.d.close();});

function diagnostic(line) {
 assert.ok(line.startsWith('bIT dispatcher failure '));
 return JSON.parse(line.slice('bIT dispatcher failure '.length));
}
const dbError = {code:'42501',message:'Permission denied',hint:'Check grants',details:'PRIVATE ROW CONTENTS'};
test('startup query failure preserves Supabase diagnostics and table',async()=>{
 const f=fixture({fault:({table})=>table==='agent_runs'?dbError:null});
 await assert.rejects(f.d.ready);
 assert.deepEqual(f.logs.map(diagnostic),[{operation:'select',table:'agent_runs',code:'42501',message:'Permission denied',hint:'Check grants'}]);
 f.d.close();
});
test('client initialization failure is reported with operation and nullable table',async()=>{
 const f=fixture({clientError:Object.assign(new Error('Unavailable'),{code:'CLIENT',hint:'Try later'})});
 await assert.rejects(f.d.ready);
 assert.deepEqual(diagnostic(f.logs[0]),{operation:'create_client',table:null,code:'CLIENT',message:'Unavailable',hint:'Try later'});
 f.d.close();
});
test('poll failures preserve context repeatedly, including thrown transport errors',async()=>{
 const f=fixture();await f.d.ready;
 f.setFault(({table})=>table==='workspace_members'?dbError:null);
 for(let i=0;i<2;i++){f.ticks[0]();await f.d.scan();}
 assert.equal(f.logs.length,4);
 assert.ok(f.logs.map(diagnostic).every(d=>d.operation==='select'&&d.table==='workspace_members'&&d.code==='42501'&&d.hint==='Check grants'));
 f.setFault(({table})=>table==='tasks'?{thrown:Object.assign(new Error('Fetch failed'),{code:'NETWORK',hint:'Check connection'})}:null);
 await f.d.scan();assert.equal(diagnostic(f.logs.at(-1)).code,'NETWORK');f.d.close();
});
test('per-run insert errors redact keys and prompt text from message/hint and omit row details',async()=>{
 const prompt='Private instruction unique to this run';
 const f=fixture({run:{prompt},fault:({table,op})=>table==='approvals'&&op==='insert'?{...dbError,message:`Insert rejected: ${prompt} fake-service-role-value`,hint:`Review ${prompt} fake-service-role-value`,details:prompt}:null});
 await f.d.ready;assert.equal(f.logs.length,1);
 const d=diagnostic(f.logs[0]);assert.equal(d.operation,'insert');assert.equal(d.table,'approvals');assert.equal(d.code,'42501');
 for(const text of [prompt,'fake-service-role-value','PRIVATE ROW CONTENTS'])assert.ok(!f.logs[0].includes(text));
 assert.match(d.message,/\[prompt omitted\]/);assert.match(d.hint,/\[redacted\]/);f.d.close();
});
test('approval processing, dispatch catch and event persistence failures retain query context',async()=>{
 const f=fixture();await f.d.ready;f.approve();
 f.setFault(({table,op})=>table==='agent_runs'&&op==='update'?dbError:null);
 await f.d.scan();assert.equal(diagnostic(f.logs.at(-1)).table,'agent_runs');assert.equal(diagnostic(f.logs.at(-1)).operation,'update');
 f.setFault(({table,op})=>table==='tasks'&&op==='update'?dbError:null);
 await f.d.scan();assert.ok(f.logs.map(diagnostic).some(d=>d.table==='tasks'&&d.operation==='update'&&d.hint==='Check grants'));
 f.tables.agent_runs[0].status='running';f.setFault(({table})=>table==='task_events'?dbError:null);
 f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.event',runId:'r',summary:'progress'}});
 await f.d.scan();assert.equal(diagnostic(f.logs.at(-1)).table,'task_events');assert.equal(diagnostic(f.logs.at(-1)).operation,'insert');f.d.close();
});
test('RPC failures report method and node table without request parameters',async()=>{
 const prompt='Private instruction unique to RPC';const f=fixture({run:{prompt}});await f.d.ready;f.approve();
 f.hub.request=async()=>{throw new Error(`Node rejected ${prompt} fake-service-role-value`);};
 await f.d.scan();const d=diagnostic(f.logs[0]);assert.equal(d.operation,'agent.run');assert.equal(d.table,'nodes');assert.equal(d.code,null);assert.equal(d.hint,null);
 assert.ok(!f.logs[0].includes(prompt));assert.ok(!f.logs[0].includes('fake-service-role-value'));f.d.close();
});
test('Realtime errors include subscription context and redacted diagnostics',async()=>{
 const f=fixture();await f.d.ready;f.subscriptions[0]('CHANNEL_ERROR',dbError);
 assert.deepEqual(diagnostic(f.logs[0]),{operation:'subscribe',table:'agent_runs,approvals',code:'42501',message:'Permission denied',hint:'Check grants'});
 f.subscriptions[0]('TIMED_OUT');assert.equal(diagnostic(f.logs[1]).message,'TIMED_OUT');f.d.close();
});

async function offlineFixture(method) {
 const f=fixture();await f.d.ready;f.approve();
 if(method!=='agent.run') await f.d.scan();
 if(method==='agent.decide') {
  f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.approval_request',runId:'r',requestId:'q',action:'tool'}});
  await f.d.scan();f.approve(f.tables.approvals[1]);
 }
 if(method==='agent.stop') f.tables.agent_runs[0].stop_requested=true;
 let online=false,attempts=0,deliveries=0;
 const request=f.hub.request;
 f.hub.request=async(machine,rpc,params)=>{
  if(rpc===method){attempts++;if(!online)throw new Error(`Machine ${machine} is offline`);deliveries++;}
  return request(machine,rpc,params);
 };
 return Object.assign(f,{online(){online=true;},getAttempts:()=>attempts,getDeliveries:()=>deliveries});
}
for(const method of ['agent.run','agent.decide','agent.stop']) {
 test(`${method}: node returns within retry window, no duplicate dispatch`,async()=>{
  const f=await offlineFixture(method);await f.d.scan();
  const state=method==='agent.run'?'dispatched':'running';assert.equal(f.tables.agent_runs[0].status,state);
  assert.equal(f.getAttempts(),1);assert.equal(f.logs.length,1);assert.match(f.logs[0],/retrying every 5 s for up to 90 s/);
  f.advance(4999);await f.d.scan();assert.equal(f.getAttempts(),1);
  f.advance(1);await f.d.scan();assert.equal(f.getAttempts(),2);assert.equal(f.logs.length,1);
  f.online();await f.d.scan();assert.equal(f.getDeliveries(),0);
  f.advance(5000);await f.d.scan();assert.equal(f.getDeliveries(),1);assert.equal(f.tables.agent_runs[0].status,'running');
  if(method==='agent.stop')f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.finished',runId:'r',status:'stopped',summary:'Stopped'}});
  await f.d.scan();await f.d.scan();assert.equal(f.getDeliveries(),1);assert.equal(f.logs.length,1);
  if(method==='agent.run')assert.equal(f.calls.filter(c=>c.method==='agent.run').length,1);
  f.d.close();
 });
 test(`${method}: node never returns, fails after 90 seconds with one window log`,async()=>{
  const f=await offlineFixture(method);await f.d.scan();
  for(let elapsed=5000;elapsed<90000;elapsed+=5000){f.advance(5000);await f.d.scan();assert.notEqual(f.tables.agent_runs[0].status,'failed');}
  assert.equal(f.getAttempts(),18);assert.equal(f.logs.length,1);
  f.advance(5000);await f.d.scan();assert.equal(f.tables.agent_runs[0].status,'failed');assert.equal(f.tables.agent_runs[0].summary,'node offline for 90 s');
  f.online();await f.d.scan();assert.equal(f.getDeliveries(),0);assert.equal(f.logs.length,1);f.d.close();
 });
}
for(const method of ['agent.run','agent.decide'])test(`${method}: expired approval ends retries without sending`,async()=>{
 const f=await offlineFixture(method);const a=f.tables.approvals.at(-1);a.expires_at=new Date(1000000+7000).toISOString();
 await f.d.scan();f.advance(5000);await f.d.scan();assert.equal(f.getAttempts(),2);
 f.advance(2000);f.online();await f.d.scan();assert.equal(f.getDeliveries(),0);assert.equal(f.tables.agent_runs[0].status,'failed');assert.equal(f.tables.agent_runs[0].summary,'Approval expired while node offline');f.d.close();
});
test('disconnect during RPC also opens a single retry window',async()=>{
 const f=fixture();await f.d.ready;f.approve();f.hub.request=async()=>{throw new Error('Machine disconnected');};
 await f.d.scan();f.advance(5000);await f.d.scan();assert.equal(f.tables.agent_runs[0].status,'dispatched');assert.equal(f.logs.length,1);f.d.close();
});
test('non-offline dispatch failure still fails immediately',async()=>{
 const f=fixture();await f.d.ready;f.approve();f.hub.request=async()=>{throw new Error('Agent rejected request');};
 await f.d.scan();assert.equal(f.tables.agent_runs[0].status,'failed');assert.equal(f.tables.agent_runs[0].summary,'Node dispatch failed');assert.equal(diagnostic(f.logs[0]).operation,'agent.run');f.d.close();
});

test('owner stop supersedes a pending run dispatch without cancelling its offline stop retries',async()=>{
 const f=await offlineFixture('agent.run');await f.d.scan();f.tables.agent_runs[0].stop_requested=true;
 const request=f.hub.request;let stops=0;
 f.hub.request=async(machine,method,params)=>{if(method==='agent.stop'){stops++;throw new Error(`Machine ${machine} is offline`);}return request(machine,method,params);};
 await f.d.scan();assert.equal(f.tables.agent_runs[0].status,'dispatched');assert.equal(stops,1);
 f.advance(5000);await f.d.scan();assert.equal(stops,2);assert.equal(f.getAttempts(),1);
 f.advance(85000);await f.d.scan();assert.equal(f.tables.agent_runs[0].summary,'node offline for 90 s');f.d.close();
});
test('relay offline also retries without logging each attempt',async()=>{
 const f=fixture();await f.d.ready;f.approve();f.hub.request=async()=>{throw new Error('Relay offline');};
 await f.d.scan();f.advance(5000);await f.d.scan();assert.equal(f.tables.agent_runs[0].status,'dispatched');assert.equal(f.logs.length,1);f.d.close();
});

test('agent approvals retain redacted command and relative write paths', async () => {
 const f=fixture({run:{status:'running'}}); await f.d.ready;
 for (const [requestId,action,detail] of [
  ['bash','Bash',{command:'sleep 120'}],
  ['write','Write',{file_path:'dashboard-proof.txt',content:'PRIVATE'}],
  ['codex','item/commandExecution/requestApproval',{command:'cat /etc/passwd; echo fake-service-role-value'}],
  ['long','Bash',{command:'echo hello; '.repeat(60)}],
  ['paths','Write',{paths:['/etc/passwd','../escape','C:\\secret','safe.txt'],password:'PRIVATE'}]
 ]) f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.approval_request',runId:'r',requestId,executor:'codex',action,detail:JSON.stringify(detail)}});
 await f.d.scan();
 assert.equal(f.tables.approvals[0].action_summary,'Bash: sleep 120');
 assert.deepEqual(f.tables.approvals[0].action_detail,{run_id:'r',request_id:'bash',kind:'agent',executor:'codex',tool:'Bash',command:'sleep 120',paths:[]});
 assert.equal(f.tables.approvals[1].action_summary,'Write: dashboard-proof.txt');
 assert.deepEqual(f.tables.approvals[4].action_detail.paths,['safe.txt']);
 assert.equal(f.tables.approvals[3].action_detail.command.length,500);
 const json=JSON.stringify(f.tables.approvals); for(const text of ['PRIVATE','/etc/passwd','fake-service-role-value','../escape','C:\\secret']) assert.ok(!json.includes(text));
 f.d.close();
});
for (const reason of ['user_stop','lease_expired','policy_disabled','node_shutdown','relay_loss_2m','coordinator_lost']) test(`persists finished reason ${reason}`,async()=>{
 const f=fixture({run:{status:'running'}}); await f.d.ready;
 f.hub.emit('agent',{machine:'MACBOOK',message:{type:'agent.finished',runId:'r',status:'stopped',reason,summary:'stopped No tracked changes'}});
 await f.d.scan(); assert.match(f.tables.agent_runs[0].summary,new RegExp(reason)); f.d.close();
});
test('disabled capabilities log once at info without dispatcher failures',async()=>{
 const f=fixture();await f.d.ready;
 f.hub.request=async()=>{throw new Error('Agent execution is disabled');};
 f.hub.emit('node_connected',{machine:'MACBOOK'});await f.d.scan();
 f.hub.emit('node_connected',{machine:'MACBOOK'});await f.d.scan();
 assert.equal(f.logs.length,1);assert.match(f.logs[0],/execution is disabled/);assert.ok(!f.logs[0].includes('failure'));f.d.close();
});
