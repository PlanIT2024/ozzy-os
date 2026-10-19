import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTaskActions } from '../src/brain/chatTasks.js';
import { startDashboardChat, replyWriter, replyId } from '../src/brain/dashboardChat.js';
import { createPermissions } from '../src/brain/permissions.js';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
import { saveJSON } from '../src/shared.js';
function database() {
 const tables={workspace_members:[{workspace_id:'ws',user_id:'owner',role:'owner'}],tasks:[],projects:[],nodes:[],node_shares:[],task_events:[],conversations:[{id:'convo',workspace_id:'ws',owner_id:'owner',updated_at:new Date().toISOString()}],chat_messages:[],approvals:[]},calls=[],events=[];
 return {tables,calls,events,async rpc(name,p){assert.equal(name,'chat_apply_task');const membership=tables.workspace_members.find(m=>m.workspace_id===p.p_workspace&&m.user_id===p.p_owner);if(!membership||membership.role==='viewer')return {error:{message:'denied'}};let task=tables.tasks.find(t=>t.id===p.p_task&&t.workspace_id===p.p_workspace);const before=task?Object.fromEntries(Object.keys(p.p_fields).map(k=>[k,task[k]??null])):{};if(p.p_create){task={id:p.p_task,workspace_id:p.p_workspace,status:'inbox',source:'bit',created_by:p.p_owner,updated_at:new Date().toISOString(),...p.p_fields};tables.tasks.push(task);}else {if(!task||task.updated_at!==p.p_expected)return {data:[],error:null};Object.assign(task,p.p_fields,{updated_at:new Date().toISOString()});}tables.task_events.push({task_id:task.id,payload:{conversation_id:p.p_conversation,source:'bit_chat',before,changed:p.p_fields}});return {data:[structuredClone(task)],error:null};},removeChannel(){},channel(){const c={on(_event,config,fn){events.push({config,fn});return c;},subscribe(){return c;}};return c;},from(table){const filters=[];let op='select',value,one=false,sorts=[],max=Infinity;
  const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},is(k,v){filters.push(r=>(r[k]??null)===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},gt(k,v){filters.push(r=>r[k]>v);return q;},gte(k,v){filters.push(r=>r[k]>=v);return q;},order(k,opts={}){sorts.push([k,opts.ascending!==false]);return q;},limit(n){max=n;return q;},single(){one=true;return q;},insert(v){op='insert';value=v;return q;},update(v){op='update';value=v;return q;},then(resolve,reject){try{
   calls.push({table,op,value:structuredClone(value)});let rows=tables[table].filter(r=>filters.every(f=>f(r)));
   if(op==='insert'){const items=(Array.isArray(value)?value:[value]).map(v=>({id:randomUUID(),created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...structuredClone(v)}));for(const item of items){if(tables[table].some(r=>r.id===item.id))return Promise.resolve({data:null,error:{code:'23505'}}).then(resolve,reject);tables[table].push(item);}rows=items;}
   if(op==='update')rows.forEach(r=>Object.assign(r,structuredClone(value),{updated_at:new Date().toISOString()}));
   for(const [k,asc] of sorts.toReversed())rows.sort((a,b)=>(a[k]>b[k]?1:a[k]<b[k]?-1:0)*(asc?1:-1));rows=rows.slice(0,max);
   return Promise.resolve({data:structuredClone(one?rows[0]:rows),error:null}).then(resolve,reject);
  }catch(error){return Promise.reject(error).then(resolve,reject);}}};return q;}};
}
function root(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-chat-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('task tools enforce role, workspace, batch limit, owner attribution and audit',async()=>{
 const db=database(),cards=[],actions=createTaskActions({db,owner:'owner',workspace:'ws',conversation:'convo',onCard:c=>cards.push(c)});
 await actions.create_task({tasks:[{title:'First'},{title:'Second'}]});assert.equal(db.tables.tasks.length,2);assert.equal(cards.length,2);
 assert.ok(db.tables.tasks.every(t=>t.workspace_id==='ws'&&t.created_by==='owner'&&t.status==='inbox'));
 assert.ok(db.tables.task_events.every(e=>e.payload.conversation_id==='convo'&&e.payload.source==='bit_chat'));
 const id=db.tables.tasks[0].id;await actions.update_task({taskId:id,fields:{title:'Changed'}});assert.equal(cards[2].before.title,'First');assert.equal(cards[2].changed.title,'Changed');
 db.tables.tasks.push({id:randomUUID(),workspace_id:'other',title:'Private'});assert.equal((await actions.list_tasks({})).length,2);
 await assert.rejects(actions.update_task({taskId:db.tables.tasks[2].id,fields:{title:'Bad'}}),/not found/);
 await assert.rejects(actions.create_task({tasks:Array.from({length:21},()=>({title:'x'}))}));
 await assert.rejects(actions.update_task({taskId:id,fields:{decided_by:'owner'}}));
 db.tables.workspace_members[0].role='viewer';assert.equal((await actions.list_tasks()).length,2);
 await assert.rejects(actions.create_task({title:'No'}),/permission/);await assert.rejects(actions.update_task({taskId:id,fields:{status:'done'}}),/permission/);
 db.tables.workspace_members=[];await assert.rejects(actions.list_tasks(),/permission/);
});
test('member, admin and owner can write; foreign projects/machines and extra input rejected',async()=>{
 for(const role of ['member','admin','owner']){const db=database();db.tables.workspace_members[0].role=role;const actions=createTaskActions({db,owner:'owner',workspace:'ws',conversation:'c'});await actions.create_task({title:role});assert.equal(db.tables.tasks.length,1);
 db.tables.projects.push({id:'private',workspace_id:'other',name:'Secret'});await assert.rejects(actions.create_task({title:'No',project:'Secret'}));await assert.rejects(actions.create_task({title:'No',node:'Other'}));await assert.rejects(actions.create_task({title:'No',workspace_id:'other'}));}
});
test('reply updates are at least 750ms apart including final status',async()=>{
 let time=0;const writes=[];const writer=replyWriter({now:()=>time,sleep:async ms=>{time+=ms;},write:async row=>writes.push({time,...row})});
 for(time=0;time<=3000;time+=100)await writer.publish(String(time));await writer.finish('done');
 for(let i=1;i<writes.length;i++)assert.ok(writes[i].time-writes[i-1].time>=750);assert.equal(writes.at(-1).status,'done');assert.equal(writes.at(-1).body,'3000');
});
function chatFixture(t,db,options={}){const stateRoot=options.root||root(t);let calls=0;const service=startDashboardChat({root:stateRoot,env:{BITOS_SUPABASE:'1',BITOS_DASHBOARD_CHAT:'1',BITOS_OWNER_USER_ID:'owner'},makeClient:async()=>db,runner:{async run(key,text,args){calls++;assert.equal(key,'dash:convo');assert.equal(await args.approve({}),false);await args.output('Partial');return 'Done';}},sleep:async()=>{},log:()=>{},...options});return {service,root:stateRoot,get calls(){return calls;}};}
function ownerMessage(db,extra={}){const m={id:randomUUID(),conversation_id:'convo',workspace_id:'ws',owner_id:'owner',author:'owner',body:'Hello',created_at:new Date().toISOString(),...extra};db.tables.chat_messages.push(m);return m;}
test('wrong owner ignored, duplicate realtime and restart never rerun, old backlog ignored',async t=>{
 const db=database();ownerMessage(db,{owner_id:'other'});ownerMessage(db,{created_at:new Date(Date.now()-700000).toISOString()});const m=ownerMessage(db);const f=chatFixture(t,db);await f.service.ready;assert.equal(f.calls,1);await f.service.scan();assert.equal(f.calls,1);f.service.close();
 const next=chatFixture(t,db,{root:f.root});await next.service.ready;assert.equal(next.calls,0);assert.equal(db.tables.chat_messages.filter(r=>r.author==='bit').length,1);assert.equal(db.tables.chat_messages.find(r=>r.id===replyId(m.id)).status,'done');next.service.close();
});
test('interrupted durable claim is repaired once without re-executing tools',async t=>{
 const db=database(),m=ownerMessage(db,{created_at:new Date(Date.now()-700000).toISOString()}),r=root(t);saveJSON(path.join(r,'data/dashboard-chat-processed.json'),{[m.id]:{status:'working'}});
 const f=chatFixture(t,db,{root:r});await f.service.ready;assert.equal(f.calls,0);assert.equal(db.tables.chat_messages.filter(r=>r.author==='bit').length,1);assert.equal(db.tables.chat_messages.at(-1).status,'error');await f.service.scan();assert.equal(db.tables.chat_messages.filter(r=>r.author==='bit').length,1);f.service.close();
});
for(const body of ['approve','yes','do it'])test(`chat text ${body} never decides approvals`,async t=>{
 const db=database();db.tables.tasks.push({id:'task',workspace_id:'ws'});db.tables.approvals.push({id:randomUUID(),task_id:'task',status:'pending',expires_at:new Date(Date.now()+60000).toISOString()});ownerMessage(db,{body});const f=chatFixture(t,db);await f.service.ready;
 assert.equal(f.calls,0);assert.equal(db.tables.approvals[0].status,'pending');assert.ok(db.tables.chat_messages.some(m=>m.body.includes('Chat words never decide')&&m.cards[0].kind==='approval'));assert.equal(db.calls.filter(c=>c.table==='approvals'&&c.op!=='select').length,0);f.service.close();
});
test('all tool approval names/fields denied; task allowance is dashboard-only',async t=>{
 const r=root(t);const options={root:r,context:'dash:convo',tasks:{}};
 const p=createPermissions(options);for(const name of ['mcp__approvals__approve','mcp__tasks__approve','approve','mcp__db__update_approvals'])assert.equal((await p.canUseTool(name,{})).behavior,'deny');
 assert.equal((await p.canUseTool('mcp__tasks__create_task',{title:'Safe'})).behavior,'allow');assert.equal((await p.canUseTool('mcp__tasks__create_task',{title:'Bad',approvals:{status:'approved'}})).behavior,'deny');
 assert.equal((await createPermissions({...options,context:'123'}).canUseTool('mcp__tasks__create_task',{title:'Safe'})).behavior,'deny');
});
test('raw Discord resumes existing session; output callback opt-in; dash taint/grants isolated',async t=>{
 const r=root(t);for(const folder of ['memory','skills','persona','schedules'])fs.mkdirSync(path.join(r,'bit',folder),{recursive:true});fs.writeFileSync(path.join(r,'bit/persona/persona.md'),'bIT');fs.writeFileSync(path.join(r,'bit/persona/personalities.json'),'{}');
 saveJSON(path.join(r,'data/sessions.json'),{'123':'old-discord-session'});const seen=[],out=[];
 const runner=new Runner({root:r,hub:{list:()=>[],request:async()=>{}},budget:new Budget({file:path.join(r,'data/budget.json'),cap:10}),queryFn:async function*({options}){seen.push(options);yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}};yield {type:'result',subtype:'success',session_id:options.resume||'dash-session',total_cost_usd:.01,result:'final'};}});t.after(()=>runner.close());
 assert.equal(await runner.run('123','Hello'),'final');assert.equal(seen[0].resume,'old-discord-session');assert.equal(seen[0].includePartialMessages,undefined);
 runner.screens.on('123','MacBook');assert.equal(runner.screens.active('dash:123'),null);
 runner.controls.state.grants['123']={id:'old-control',machine:'MacBook',expiresAt:new Date(Date.now()+60000).toISOString(),count:0,maxActions:10,actions:[]};
 const discordTranscript=runner.transcript.file('123');assert.ok(fs.existsSync(discordTranscript));
 runner.web.session(runner.webKeys['123']).tainted=true;
 await runner.run('dash:123','Hello',{output:async text=>out.push(text)});assert.equal(seen[1].resume,undefined);assert.equal(seen[1].includePartialMessages,true);assert.deepEqual(out,['partial']);assert.notEqual(runner.webKeys['123'],runner.webKeys['dash:123']);assert.equal(runner.web.session(runner.webKeys['dash:123']).tainted,false);assert.equal(runner.controls.active('dash:123'),null);assert.ok(runner.controls.active('123'));assert.equal(runner.web.session(runner.webKeys['123']).tainted,true);assert.notEqual(discordTranscript,runner.transcript.file('dash:123'));assert.equal(runner.sessions['123'],'old-discord-session');assert.ok(runner.screens.active('123'));
});

test('concurrent stream publishers cannot exceed the 750ms write limit',async()=>{
 let time=1000;const times=[];const writer=replyWriter({now:()=>time,sleep:async ms=>{time+=ms;},write:async()=>{times.push(time);await Promise.resolve();}});time+=750;
 await Promise.all([writer.publish('one'),writer.publish('two'),writer.publish('three')]);await writer.finish('done','final');assert.equal(times.length,2);assert.ok(times[1]-times[0]>=750);
});

test('reconnect accepts a new recent owner row, ignores spoofed notifications and keeps one approval notice',async t=>{
 const db=database();db.tables.tasks.push({id:'task',workspace_id:'ws'});db.tables.approvals.push({id:randomUUID(),task_id:'task',status:'pending',expires_at:new Date(Date.now()+60000).toISOString()});
 const f=chatFixture(t,db);await f.service.ready;assert.equal(db.tables.chat_messages.length,1);
 const handler=db.events.find(e=>e.config.table==='chat_messages').fn;handler({new:{id:'forged',author:'owner',owner_id:'other'}});await f.service.drain();assert.equal(f.calls,0);
 ownerMessage(db);await f.service.scan();assert.equal(f.calls,1);await f.service.scan();assert.equal(db.tables.chat_messages.filter(m=>m.id===replyId(db.tables.approvals[0].id,'approval')).length,1);f.service.close();
});
test('lost local ledger still detects an existing deterministic reply',async t=>{
 const db=database(),m=ownerMessage(db);db.tables.chat_messages.push({id:replyId(m.id),author:'bit',status:'done',conversation_id:'convo',workspace_id:'ws',owner_id:'owner'});const f=chatFixture(t,db);await f.service.ready;assert.equal(f.calls,0);assert.equal(db.tables.chat_messages.length,2);f.service.close();
});
