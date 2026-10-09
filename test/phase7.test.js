import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { InputControl } from '../src/node/input/index.js';
import { ControlGrants } from '../src/brain/controls.js';
import { ScreenGrants } from '../src/brain/screens.js';
import { WebLedger } from '../src/brain/web.js';
import { TaskProgressRelay, ApprovalRelay, commands, createDiscord } from '../src/brain/discord.js';
import { createPermissions } from '../src/brain/permissions.js';
import { normalizePlan } from '../src/node/input/taskPolicy.js';
import { encodeCapture } from '../src/node/screen/image.js';
const app={id:'obsidian_obsidian.desktop',name:'Obsidian',focusNames:['obsidian'],fingerprint:'a'.repeat(64)};
const browser={id:'firefox.desktop',name:'Firefox',focusNames:['firefox'],fingerprint:'b'.repeat(64),browser:true};
const terminal={id:'org.gnome.Terminal.desktop',name:'Terminal',focusNames:['org.gnome.terminal'],fingerprint:'c'.repeat(64),terminal:true};
const chat={id:'slack.desktop',name:'Slack',focusNames:['slack'],fingerprint:'d'.repeat(64),messaging:true};
const plan={goal:'Open Obsidian and type hello',allowed_apps:[app.id],texts:['hello from bIT'],allowed_actions:['raise_app','type','key','left_click','screenshot']};
const focus=(name='obsidian')=>({app:name,window:'Note',pid:1,windowId:2});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(check())return;await pause(5);}throw new Error('Timed out');}
async function setup(t,{startFocus='obsidian',mode='task'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-autonomy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let now=Date.now();
 const frames=await encodeCapture(await sharp({create:{width:200,height:100,channels:3,background:'#123456'}}).png().toBuffer(),{monitors:[{x:0,y:0,width:200,height:100,coordinateSpace:'logical'}]});
 class Backend extends EventEmitter {
  constructor(){super();this.focus=focus(startFocus);this.actions=[];this.releases=0;this.overview=false;this.entry=false;this.hazards=[];}
  async available(){return true;}async start(){}async stop(){}async releaseAll(){this.releases++;}cancel(){this.cancelled=true;}
  async listApps(){return [app,browser,terminal,chat];}
  async searchResult(){return this.topResult||{name:app.name,kind:'application',desktopId:app.id};}
  async resolveApp(id){const found=[app,browser,terminal,chat].find(a=>a.id===id);if(!found||id==='discord.desktop')throw new Error('Blocked application');return found;}
  async inspect(_point,{searchFocus=false,focusOnly=false}={}){
   if(this.pendingActivation&&focusOnly){this.pendingActivation--;if(!this.pendingActivation){this.overview=false;this.focus=focus('obsidian');}}
   const shell={app:'gnome-shell',window:'Main stage',pid:5,windowId:0,elementId:0,elementPath:'/search'};
   return {focused:searchFocus?{...shell,focusKind:'shell-search-target'}:this.overview?(this.entry?{...shell,focusKind:'shell-search'}:null):this.focus,overviewActive:this.overview,hazards:this.overview?(this.shellHazards||[]):this.focus.app==='Discord'?(this.startHazards||this.hazards):this.hazards,target:_point?this.focus:null,targetKnown:true};
  }
  async launchApp(a){this.actions.push({action:'launch_app',app:a.id});if(this.raiseLaunch)this.focus=focus(a.focusNames[0]);return{};}
  async act(action){this.actions.push(action);if(action.keys==='super'){this.overview=true;this.entry=false;}if(action.action==='focus_search')this.entry=true;if(action.expected_app==='gnome-shell-search'&&action.keys==='enter'){this.overview=false;this.focus=focus(this.failRaise?'Discord':'obsidian');if(this.delayFocus){this.pendingActivation=this.delayFocus;this.overview=true;}}if(this.block){await this.block;}
   const total=action.action==='type'?[...action.text].length:1;return {delivery:{state:'all',count:total,total,unit:action.action==='type'?'characters':'key presses'}};
  }
 }
 const backend=new Backend(),screen={available:async()=>true,capture:async()=>({...frames,capturedAt:new Date(now).toISOString()})};
 const input=new InputControl({root,enabled:true,screen,backend,now:()=>now,log:()=>{}});input.tasks.wait=async task=>{input.tasks.check(task.id);now+=1100;};t.after(()=>input.close());
 const hub=new EventEmitter(),calls=[];hub.list=()=>[{machine:'OZZY-AI',online:true,capabilities:['status','screen','input']}];
 hub.request=async(machine,method,params)=>{calls.push({method,params});switch(method){case'input_start':return input.start(params);case'input_stop':return input.stop('owner off',true);case'input_task_prepare':return input.tasks.prepare(params);case'input_task_start':return input.tasks.start(params);case'input_task_check':return input.tasks.inspect(params);case'input_task_action':return input.tasks.action(params);case'input_task_finish':if(input.tasks.busy)return input.stop('task cancelled',true);return input.tasks.end('finished');case'input_list_apps':return backend.listApps();default:throw new Error('Unsupported mock method');}};
 input.on('task_progress',event=>hub.emit('control_task_progress',{machine:'OZZY-AI',...event}));input.on('task_ended',event=>hub.emit('control_task_ended',{machine:'OZZY-AI',...event}));input.on('closed',event=>hub.emit('control_closed',{machine:'OZZY-AI',...event}));
 const screens=new ScreenGrants({root,cap:100,now:()=>new Date(now)}),controls=new ControlGrants({root,hub,screens,now:()=>now});t.after(()=>controls.close());await controls.on('A','OZZY-AI',{withScreen:true,mode});input.observe(frames);
 const web=new WebLedger({root}),cards=[],updates=[];
 const context=extra=>controls.context({thread:'A',tainted:()=>web.session('A').tainted,taintTask:()=>web.session('A').browserTask,markBrowser:id=>web.taintBrowser('A',id),approve:async card=>{cards.push(card);return true;},startProgress:async(task,stop)=>{updates.push({task,stop});return{update:async value=>updates.push(value),finish:async value=>updates.push(value)};},...extra});
 const propose=async(value=plan,ctx=context())=>{const result=await ctx.propose({machine:'OZZY-AI',...value});assert.ok(!result.isError,result.content[0].text);return ctx;};
 return{root,input,backend,controls,screens,web,cards,updates,calls,context,propose,advance:ms=>now+=ms};
}
test('one owner plan approval gates all input; chat text cannot approve; scope execution creates no step cards',async t=>{
 const b=await setup(t),relay=new ApprovalRelay('owner');t.after(()=>relay.close());const sent=[];
 const channel={id:'A',send:async packet=>{sent.push(packet);return{id:'card',edit:async()=>{}};}};
 const ctx=b.context({approve:request=>relay.request(channel,request)}),permissions=createPermissions({root:b.root,control:ctx});
 const pending=permissions.canUseTool('mcp__computer__propose_task',{machine:'OZZY-AI',...plan});await until(()=>sent.length);
 await relay.handle({user:{id:'owner'},customId:'approved'});assert.equal(b.backend.actions.length,0);
 await relay.handle({user:{id:'other'},customId:sent[0].components[0].components[0].data.custom_id});assert.equal(b.backend.actions.length,0);
 await relay.handle({user:{id:'owner'},channelId:'A',message:{id:'card'},customId:sent[0].components[0].components[0].data.custom_id,deferUpdate:async()=>{}});
 assert.equal((await pending).behavior,'allow');assert.ok(!(await ctx.propose({machine:'OZZY-AI',...plan})).isError);
 const result=await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'hello from bIT'});assert.ok(!result.isError,result.content[0].text);assert.equal(sent.length,1);assert.equal(b.backend.actions.length,1);
 const disk=fs.readFileSync(b.input.file,'utf8');assert.ok(!disk.includes('hello from bIT'));assert.ok(!disk.includes(result.content[1].data));await ctx.finish();
});
test('node scope refuses unapproved text, apps, actions and keys without a card; step path cannot bypass task mode',async t=>{
 for(const raw of [{action:'type',expected_app:'obsidian',text:'different'},{action:'type',expected_app:'firefox',text:'hello from bIT'},{action:'scroll',expected_app:'obsidian',direction:'down',amount:1},{action:'key',expected_app:'obsidian',keys:'ctrl+n'},{action:'type',expected_app:'gnome-shell-search',text:'hello from bIT'}]){
  const b=await setup(t),ctx=await b.propose();const result=await ctx.execute({machine:'OZZY-AI',...raw});assert.ok(result.isError);assert.equal(b.backend.actions.length,0);assert.equal(b.cards.length,1);assert.equal(b.input.tasks.active,null);
 }
 const b=await setup(t);await b.propose();await assert.rejects(b.input.act({grantId:b.input.session.grantId,action:'type',expected_app:'obsidian',expectedFocus:focus(),text:'hello from bIT'}),/Control/);assert.equal(b.backend.actions.length,0);
});
test('free text is separately flagged, accepts only its app, and never permits a terminal',async t=>{
 const b=await setup(t),ctx=await b.propose({...plan,free_text_apps:[app.id]});assert.match(b.cards[0].description,/FREE TEXT IN obsidian_obsidian.desktop/);
 assert.ok(!(await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'other text'})).isError);
 assert.ok((await b.context().propose({machine:'OZZY-AI',...plan,allowed_apps:[terminal.id],free_text_apps:[terminal.id]})).isError);
});
test('raise_app starting in Discord uses only fixed Shell sequence, counts five steps and verifies allowed target',async t=>{
 const b=await setup(t,{startFocus:'Discord'}),ctx=await b.propose();
 const result=await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id});assert.ok(!result.isError,result.content[0].text);
 assert.deepEqual(b.backend.actions.map(a=>a.action),['launch_app','key','focus_search','type','key']);assert.equal(b.backend.actions[3].text,'Obsidian');assert.equal(b.input.tasks.active.steps,5);assert.equal(b.backend.focus.app,'obsidian');assert.equal(b.cards.length,1);assert.equal(b.screens.status().captures,5);
 const denied=await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'gnome-shell-search',text:'Obsidian'});assert.ok(denied.isError);assert.equal(b.backend.actions.length,5);
});
test('raise_app launch-only success and fallback failure stop without improvising',async t=>{
 const b=await setup(t);b.backend.raiseLaunch=true;const ctx=await b.propose();assert.ok(!(await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id})).isError);assert.equal(b.backend.actions.length,1);
 const c=await setup(t,{startFocus:'Discord'});c.backend.failRaise=true;const other=await c.propose();assert.ok((await other.execute({machine:'OZZY-AI',action:'raise_app',app:app.id})).isError);assert.equal(c.backend.actions.length,5);assert.equal(c.input.tasks.active,null);
});
test('dangerous and sending keys always escalate, even if an app or text is approved',async t=>{
 for(const keys of ['ctrl+w','ctrl+q','alt+f4','delete','shift+delete','ctrl+enter','ctrl+v']){
  const b=await setup(t),ctx=await b.propose();assert.ok((await ctx.execute({machine:'OZZY-AI',action:'key',expected_app:'obsidian',keys})).isError);assert.equal(b.backend.actions.length,0);
 }
 const b=await setup(t,{startFocus:'slack'}),ctx=await b.propose({...plan,allowed_apps:[chat.id]});assert.ok((await ctx.execute({machine:'OZZY-AI',action:'key',expected_app:'slack',keys:'enter'})).isError);
 assert.throws(()=>normalizePlan({...plan,key_combos:['ctrl+w']}),/step mode/);
});
test('sensitive screens, unexpected dialogs and sending/closing targets refuse node actions',async t=>{
 for(const hazard of ['credentials','sensitive-screen','unexpected-dialog','sending-closing-or-paste']){const b=await setup(t),ctx=await b.propose();b.backend.hazards=[hazard];assert.ok((await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'hello from bIT'})).isError);assert.equal(b.backend.actions.length,0);}
});
test('browser plans warn, taint memory policy, permit only the approved browser task and stop on new web results',async t=>{
 const b=await setup(t,{startFocus:'firefox'}),ctx=await b.propose({...plan,allowed_apps:[browser.id]});assert.match(b.cards[0].description,/page content could steer bIT/);assert.equal(b.web.session('A').tainted,true);
 assert.ok(!(await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'firefox',text:'hello from bIT'})).isError);
 assert.ok((await b.context().propose({machine:'OZZY-AI',...plan})).isError);
 const permissions=createPermissions({root:b.root,web:b.web,sessionKey:'A',control:ctx});await permissions.hooks.PostToolUse[0].hooks[0]({tool_name:'WebSearch',tool_input:{query:'x'},tool_response:{}});assert.equal(b.input.tasks.active,null);assert.equal(b.web.session('A').tainted,true);
});
test('owner-only Stop is bound to task, channel and message; stops mid-task and cancels before more input',async t=>{
 const b=await setup(t),relay=new TaskProgressRelay('owner'),sent=[];const channel={id:'A',send:async packet=>{sent.push(packet);return{id:'progress',edit:async packet=>sent.push(packet)};}};
 const ctx=await b.propose(plan,b.context({startProgress:(task,stop)=>relay.start(channel,task,stop)}));let unblock;b.backend.block=new Promise(resolve=>unblock=resolve);
 const action=ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'hello from bIT'});await until(()=>b.backend.actions.length);
 const customId=sent[0].components[0].components[0].data.custom_id;
 await relay.handle({user:{id:'other'},channelId:'A',message:{id:'progress'},customId});assert.ok(b.input.tasks.active);
 await relay.handle({user:{id:'owner'},channelId:'B',message:{id:'progress'},customId});assert.ok(b.input.tasks.active);
 const stopping=relay.handle({user:{id:'owner'},channelId:'A',message:{id:'progress'},customId,deferUpdate:async()=>{}});await until(()=>!b.input.tasks.active);assert.equal(b.backend.cancelled,true);unblock();await stopping;assert.ok((await action).isError);assert.ok(b.backend.releases);assert.equal((await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'hello from bIT'})).isError,true);assert.equal(b.backend.actions.length,1);
});
test('caps, expiry, GNOME Stop and restart require fresh scope and release held input',async t=>{
 const b=await setup(t),ctx=await b.propose({...plan,max_steps:1});assert.ok(!(await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'hello from bIT'})).isError);assert.equal(b.input.tasks.active,null);assert.ok((await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'hello from bIT'})).isError);
 const c=await setup(t),other=await c.propose();c.advance(600001);assert.ok((await other.execute({machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:'hello from bIT'})).isError);assert.equal(c.backend.actions.length,0);
 const d=await setup(t);await d.propose();d.backend.emit('closed',{reason:'GNOME Stop'});await until(()=>!d.input.session);assert.equal(d.input.tasks.active,null);
 const e=await setup(t);await e.propose();await e.input.close();assert.equal(e.input.tasks.active,null);assert.ok(e.backend.releases);
});
test('plans validate hard limits and approved desktop fingerprint; mode cannot be downgraded in a grant',async t=>{
 assert.equal(normalizePlan(plan).max_steps,25);assert.equal(normalizePlan(plan).max_minutes,10);for(const value of [{max_steps:41},{max_minutes:11},{allowed_apps:['Obsidian']},{free_text_apps:[browser.id]}])assert.throws(()=>normalizePlan({...plan,...value}));
 const b=await setup(t);const grant=b.input.session.grantId,prepared=await b.input.tasks.prepare({grantId:grant,...plan});const resolve=b.backend.resolveApp.bind(b.backend);b.backend.resolveApp=async id=>({...await resolve(id),fingerprint:'changed'});
 await assert.rejects(b.input.tasks.start({grantId:grant,proposalId:prepared.proposalId,taskId:'task',approvalId:'approval',captureBudget:40}),/changed since approval/);
 await assert.rejects(b.input.start({grantId:grant,expiresAt:b.input.session.expiresAt,maxActions:40,mode:'step'}),/mode cannot change/);
 assert.ok(commands().find(c=>c.name==='control').options.find(o=>o.name==='on').options.find(o=>o.name==='mode'));
});

test('no grant, other thread, scheduled or already-tainted sessions cannot propose tasks',async t=>{
 const b=await setup(t);
 for(const extra of [{scheduled:true},{tainted:()=>true},{thread:'B'}]){const ctx=b.controls.tasks.context({thread:'A',approve:async()=>{assert.fail('no card');},...extra});await assert.rejects(ctx.authorize({machine:'OZZY-AI',action:'propose_task',...plan}));}
 await b.controls.off('A');await assert.rejects(b.input.tasks.prepare({grantId:'absent',...plan}));assert.equal(b.backend.actions.length,0);
});
test('explicit extra editing key works; no task ID, other grant or forged macro flags cannot escape the scope',async t=>{
 const b=await setup(t),ctx=await b.propose({...plan,key_combos:['ctrl+n']});assert.ok(!(await ctx.execute({machine:'OZZY-AI',action:'key',expected_app:'obsidian',keys:'ctrl+n'})).isError);
 const tId=b.input.tasks.active.id;
 await assert.rejects(b.input.tasks.action({grantId:'other',taskId:tId,action:'type',expected_app:'obsidian',text:'hello from bIT'}),/grant mismatch/);
 await assert.rejects(b.input.tasks.action({grantId:b.input.session.grantId,taskId:'other',action:'type',expected_app:'obsidian',text:'hello from bIT'}));
 const denied=await ctx.execute({machine:'OZZY-AI',action:'type',expected_app:'gnome-shell-search',text:'Obsidian',raise_step:true,task_mode:false});assert.ok(denied.isError);assert.equal(b.backend.actions.length,1);
});
test('browser task taint requires approval for memory writes just like web taint',async t=>{
 const b=await setup(t,{startFocus:'firefox'});await b.propose({...plan,allowed_apps:[browser.id]});let requests=0;
 const permissions=createPermissions({root:b.root,web:b.web,sessionKey:'A',approve:async request=>{requests++;assert.equal(request.tool,'Write');return false;}});
 const result=await permissions.canUseTool('Write',{file_path:path.join(b.root,'bit/memory/web.md'),content:'a page claim'});assert.equal(result.behavior,'deny');assert.equal(requests,1);
});
test('resident helper refuses new sensitive hazards during a task before delivering another character',()=>{
 const code=`import importlib.util,sys
s=importlib.util.spec_from_file_location('portal',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
p.screen.availability=lambda bus:{'monitors':[]}
x=p.Input(None);x.release=lambda:None
f={'app':'obsidian','window':'Note','pid':1,'windowId':2}
sends=[]
x.key=lambda symbol,state:sends.append((symbol,state))
def snapshot(point=None):return {'focused':f,'overviewActive':False,'target':None,'candidates':[],'hazards':['credentials'] if sends else []}
p.snapshot=snapshot
try:x.action({'action':'type','text':'ab','expected_app':'obsidian','expectedFocus':f,'task_mode':True});assert False
except RuntimeError as error:assert str(error)=='task_escalation'
assert x.delivery['count']==1 and len(sends)==2
print('mid-type hazard stopped')`;
 assert.match(execFileSync('/usr/bin/python3',['-B','-c',code,path.resolve('src/node/input/portal.py')],{encoding:'utf8'}),/mid-type hazard stopped/);
});

test('raise macro aborts at scope cap before typing and still blocks Discord for direct autonomous actions',async t=>{
 const b=await setup(t,{startFocus:'Discord'}),ctx=await b.propose({...plan,max_steps:2});const result=await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id});assert.ok(result.isError);assert.deepEqual(b.backend.actions.map(a=>a.action),['launch_app','key']);assert.equal(b.input.tasks.active,null);assert.ok(b.backend.releases);
 const c=await setup(t,{startFocus:'Discord'}),other=await c.propose();assert.ok((await other.execute({machine:'OZZY-AI',action:'type',expected_app:'Discord',text:'hello from bIT'})).isError);assert.equal(c.backend.actions.length,0);
});

test('large plan cards retain browser and free-text warnings with the complete exact plan attached',async t=>{
 const relay=new ApprovalRelay('owner');t.after(()=>relay.close());let packet;
 const channel={id:'A',send:async value=>{packet=value;return{id:'card',edit:async()=>{}};}};
 const promise=relay.request(channel,{tool:'propose_task',action:'Task plan',description:'x'.repeat(1800)+'\n⚠️ page content could steer bIT\n⚠️ FREE TEXT IN obsidian.desktop',input:{texts:['full exact string']}});await until(()=>packet);
 assert.match(packet.content,/page content could steer bIT/);assert.match(packet.content,/FREE TEXT/);assert.ok(!packet.content.includes('Full URL'));assert.match(packet.files[0].attachment.toString(),/full exact string/);
 relay.close();assert.equal(await promise,false);
});

test('preparation failures name listing or fingerprint stage, send no card/input and never replace or downgrade the grant',async t=>{
 for(const stage of ['list','resolve']){
  const b=await setup(t),notices=[],original=b.controls.grant('A');
  if(stage==='list')b.backend.listApps=async()=>{throw new Error('Control app listing failed at list: helper output exceeded limit');};
  else b.backend.resolveApp=async()=>{throw new Error('Control app resolution failed at resolve: descriptor read failed');};
  const ctx=b.context({notify:async text=>notices.push(text)});
  const result=stage==='list'?await ctx.execute({machine:'OZZY-AI',action:'list_apps'}):await ctx.propose({machine:'OZZY-AI',...plan});
  assert.ok(result.isError);assert.match(notices.join('\n'),stage==='list'?/preparation failed at installed-app listing/:/preparation failed at installed-app resolution\/fingerprint/);
  assert.equal(b.cards.length,0);assert.equal(b.backend.actions.length,0);assert.equal(b.controls.grant('A').id,original.id);assert.equal(b.controls.grant('A').mode,'task');assert.equal(b.calls.filter(c=>c.method==='input_start').length,1);
  const later=await ctx.execute({machine:'OZZY-AI',action:'screenshot'});assert.ok(later.isError);assert.equal(b.backend.actions.length,0);
 }
});
test('brain and node default to task mode; step requires an explicit new grant',async t=>{
 const b=await setup(t);await b.controls.on('A','OZZY-AI',{withScreen:true});assert.equal(b.controls.grant('A').mode,'task');assert.equal(b.input.session.state.mode,'task');
 await b.controls.on('A','OZZY-AI',{withScreen:true,mode:'step'});assert.equal(b.controls.grant('A').mode,'step');assert.equal(b.input.session.state.mode,'step');
 await b.input.stop('test');await b.input.start({grantId:'node-default',expiresAt:new Date(b.input.now()+600000).toISOString(),maxActions:40});assert.equal(b.input.session.state.mode,'task');
});
test('/control on defaults to task; only explicit mode:step requests step and records owner provenance',async t=>{
 const b=await setup(t),client=new EventEmitter();client.destroy=()=>{};const issued=[],replies=[];
 const controls={subscribe(){},describe:()=>'',on:async(thread,machine,options)=>issued.push({thread,machine,options})};
 const discord=createDiscord({client,runner:{controls},hub:b.controls.hub,budget:{},env:{OWNER_DISCORD_ID:'owner',BIT_CHANNEL_ID:'bit'},auditFile:path.join(b.root,'audit.log')});t.after(()=>discord.close());
 for(const selected of [null,'step']){
  const i={user:{id:'owner'},channelId:'A',channel:{id:'A',parentId:'bit',isThread:()=>true,isDMBased:()=>false},commandName:'control',isChatInputCommand:()=>true,options:{getSubcommand:()=> 'on',getString:key=>key==='mode'?selected:null,getBoolean:()=>true},deferReply:async()=>{},editReply:async packet=>replies.push(packet),followUp:async()=>{}};
  client.emit('interactionCreate',i);await until(()=>issued.length===(selected===null?1:2));
 }
 assert.deepEqual(issued.map(i=>i.options.mode),['task','step']);assert.ok(issued.every(i=>i.options.actorId==='owner'&&i.options.source==='owner slash command'));
});

test('Discord with incomplete tree -> fixed raise -> approved typing evaluates only each actual recipient',async t=>{
 const b=await setup(t,{startFocus:'Discord'});b.backend.startHazards=['accessibility_incomplete'];const notices=[],ctx=await b.propose(plan,b.context({notify:async s=>notices.push(s)}));
 const raised=await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id});assert.ok(!raised.isError,raised.content[0].text);assert.equal(JSON.parse(raised.content[0].text).actual_app,'obsidian');
 const typed=await ctx.execute({machine:'OZZY-AI',action:'type',text:'hello from bIT',expected_app:'obsidian'});assert.ok(!typed.isError,typed.content[0].text);assert.equal(b.cards.length,1);assert.equal(b.backend.actions.length,6);assert.equal(b.backend.actions.at(-1).text,'hello from bIT');assert.equal(notices.length,0);
});
test('specific escalation metadata reaches thread and node logs without detected content',async t=>{
 for(const rule of ['sensitive_screen','sending_action','unsaved_work','unexpected_dialog','credentials','accessibility_incomplete']){
  const b=await setup(t),notices=[],logs=[];b.input.log=s=>logs.push(s);const ctx=await b.propose(plan,b.context({notify:async s=>notices.push(s)}));b.backend.hazards=[rule];
  const result=await ctx.execute({machine:'OZZY-AI',action:'type',text:'hello from bIT',expected_app:'obsidian'});assert.ok(result.isError);assert.match(notices.join('\n'),new RegExp(rule));assert.match(notices.join('\n'),/type #1; evaluated obsidian — Note/);assert.equal(b.backend.actions.length,0);
  assert.ok(logs.some(s=>s.includes(rule)&&s.includes('obsidian')));assert.ok(!logs.join('\n').includes('hello from bIT'));
 }
});
test('overview Enter is not a send; actual Shell hazards still stop the fixed raise macro',async t=>{
 const b=await setup(t,{startFocus:'Discord'});b.backend.shellHazards=['unexpected_dialog'];const ctx=await b.propose();const result=await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id});assert.ok(result.isError);assert.match(result.content[0].text,/unexpected_dialog.*raise_app\/focus_search/);assert.deepEqual(b.backend.actions.map(a=>a.action),['launch_app','key']);
});
test('approval JSON survives Discord ISO-8859-1 decoding and preserves exact Unicode strings',async t=>{
 const relay=new ApprovalRelay('owner');t.after(()=>relay.close());let packet;
 const channel={id:'A',send:async value=>{packet=value;return{id:'utf-card',edit:async()=>{}};}};
 const exact='hello · café 😀';const waiting=relay.request(channel,{tool:'propose_task',action:'Task plan',description:'Limits: 25 steps · 10 minutes',input:{texts:[exact]}});await until(()=>packet);
 const bytes=packet.files[0].attachment;assert.ok([...bytes].every(n=>n<128));const interpreted=bytes.toString('latin1');assert.ok(!interpreted.includes('Â'));assert.equal(JSON.parse(interpreted).texts[0],exact);assert.ok(packet.content.includes('·'));
 relay.close();await waiting;
});

test('raise waits for delayed activation, logs each fresh observation and returns a current verification frame',async t=>{
 const b=await setup(t,{startFocus:'Discord'});b.backend.delayFocus=4;const logs=[];b.input.log=s=>logs.push(s);let clock=0;b.input.tasks.focusNow=()=>clock;b.input.tasks.focusDelay=async ms=>{clock+=ms;};
 const ctx=await b.propose();const raised=await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id});assert.ok(!raised.isError,raised.content[0].text);assert.equal(JSON.parse(raised.content[0].text).actual_app,'obsidian');
 const observations=logs.filter(s=>s.startsWith('input raise focus ')).map(s=>JSON.parse(s.slice('input raise focus '.length)));assert.equal(observations.length,4);assert.equal(observations.at(-1).overviewActive,false);assert.equal(observations.at(-1).focusedApp,'obsidian');assert.equal(observations.at(-1).elapsedMs,600);
 assert.ok(!(await ctx.execute({machine:'OZZY-AI',action:'type',text:'hello from bIT',expected_app:'obsidian'})).isError);
});
test('post-capture fresh focus avoids a needless Super when launch already activated the target',async t=>{
 const b=await setup(t,{startFocus:'Discord'}),capture=b.input.screen.capture;b.input.screen.capture=async()=>{b.backend.focus=focus('obsidian');return capture();};
 const ctx=await b.propose(),raised=await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id});assert.ok(!raised.isError,raised.content[0].text);assert.deepEqual(b.backend.actions.map(a=>a.action),['launch_app']);
});
test('wrong top result stops fixed raise before Enter and reports only its app/file name',async t=>{
 for(const top of [{name:'Obsidian.md',kind:'file-or-other',desktopId:null},{name:'Text Editor',kind:'application',desktopId:'org.gnome.TextEditor.desktop'},{name:'Obsidian',kind:'file-or-other',desktopId:null}]){
  const b=await setup(t,{startFocus:'Discord'});b.backend.topResult=top;const ctx=await b.propose();const result=await ctx.execute({machine:'OZZY-AI',action:'raise_app',app:app.id});assert.ok(result.isError);assert.ok(result.content[0].text.includes(top.name));assert.match(result.content[0].text,/Enter not sent/);assert.equal(b.backend.actions.length,4);assert.ok(!b.backend.actions.some(a=>a.keys==='enter'));assert.equal(b.input.tasks.active,null);
 }
});
