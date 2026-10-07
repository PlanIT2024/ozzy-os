import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { InputControl, UnsupportedInput } from '../src/node/input/index.js';
import { validateAction, keyNames, mapPoint } from '../src/node/input/actions.js';
import { ControlGrants } from '../src/brain/controls.js';
import { ScreenGrants } from '../src/brain/screens.js';
import { ApprovalRelay, commands, createDiscord } from '../src/brain/discord.js';
import { createPermissions } from '../src/brain/permissions.js';
import { encodeCapture } from '../src/node/screen/image.js';
import { NodeHub, validCapabilities } from '../src/brain/nodeHub.js';
import { startNode } from '../src/node/index.js';
import { sodium, nodeKeys, publicHex } from '../src/transport/crypto.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await pause(10);}throw new Error('Timed out');}
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-control-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
class Backend extends EventEmitter {
  constructor(){super();this.releases=0;this.actions=[];this.stops=0;}
  async available(){return true;}
  async start(){}
  async act(action){this.actions.push(action);if(this.fail)throw new Error('PRIVATE_TYPED_TEXT');}
  async releaseAll(){this.releases++;}
  async stop(){this.stops++;}
}
function frame(now=Date.now()){return{original:{width:3840,height:1080},scaled:{width:1568,height:441},capturedAt:new Date(now).toISOString(),monitors:[{x:-1920,y:0,width:1920,height:1080,connector:'DP-1',coordinateSpace:'logical'},{x:0,y:0,width:1920,height:1080,connector:'DP-2',coordinateSpace:'logical'}]};}
async function brain(t,{cap=40}={}){
  const root=fixture(t),hub=new EventEmitter(),calls=[],notices=[];
  const screenshot=await encodeCapture(await sharp({create:{width:200,height:100,channels:3,background:'#123456'}}).png().toBuffer(),{monitors:[{x:0,y:0,width:200,height:100,connector:'DP-1',coordinateSpace:'logical'}]});
  hub.list=()=>[{machine:'OZZY-AI',online:true,capabilities:['status','screen','input']}];
  hub.request=async(machine,method,params)=>{calls.push({machine,method,params});return method==='screen'?screenshot:{done:true};};
  const screens=new ScreenGrants({root,cap:100}),controls=new ControlGrants({root,hub,screens,cap});t.after(()=>controls.close());
  controls.subscribe('A',async text=>notices.push(text));
  const context=extra=>controls.context({thread:'A',screen:screens.context({hub,thread:'A'}),...extra});
  return{root,hub,calls,notices,screens,controls,context,screenshot};
}
test('node combo validation blocks VT/delete, permits super+L, caps text and validates action vocabulary',()=>{
  for(const keys of ['ctrl+alt+del','ctrl+alt+f1','ctrl+shift+alt+F12'])assert.throws(()=>keyNames(keys),/Blocked/);
  assert.deepEqual(keyNames('super+L'),['super','l']);assert.deepEqual(keyNames('Control+s'),['ctrl','s']);
  assert.throws(()=>validateAction({action:'type',text:'x'.repeat(501)}));assert.throws(()=>validateAction({action:'type',text:'\x1bterminal'}));
  assert.throws(()=>validateAction({action:'shell',text:'bad'}));assert.throws(()=>validateAction({action:'scroll',direction:'down',amount:21}));
});
test('scaled coordinates map into two monitors, including negative origin and gaps',()=>{
  assert.equal(mapPoint([0,0],frame()).x,-1920);const point=mapPoint([1176,220.5],frame());assert.equal(point.x,960);assert.equal(point.y,540);assert.equal(point.monitor.connector,'DP-2');
  assert.throws(()=>mapPoint([1568,0],frame()),/outside/);
  const gap={original:{width:300,height:100},scaled:{width:300,height:100},monitors:[{x:0,y:0,width:100,height:100,coordinateSpace:'logical'},{x:200,y:0,width:100,height:100,coordinateSpace:'logical'}]};assert.throws(()=>mapPoint([150,50],gap),/gap/);
  const hidpi={original:{width:1920,height:1080},scaled:{width:1568,height:882},monitors:[{x:0,y:0,width:960,height:540,coordinateSpace:'logical'}]};assert.equal(mapPoint([784,441],hidpi).x,480);
});
test('disabled input is absent without touching portal; unsupported platform reports unsupported',async t=>{
  const root=fixture(t),backend=new Backend();let probes=0;backend.available=async()=>{probes++;return true;};
  const input=new InputControl({root,enabled:false,screen:{available:async()=>true},backend,log:()=>{}});
  assert.equal(await input.available(),false);assert.equal(probes,0);await assert.rejects(input.start({}),/unavailable/);for(const platform of ['darwin','win32']){const stub=new InputControl({root,platform,enabled:true,screen:{available:async()=>true},log:()=>{}});assert.equal(await stub.available(),false);await assert.rejects(stub.start({}),/not supported/);}
  assert.equal(await new UnsupportedInput().available(),false);await assert.rejects(new UnsupportedInput().start(),/not supported/);
});
test('node refuses blocked combos from brain and releases on action error, cap, cancel and disconnect',async t=>{
  const root=fixture(t),backend=new Backend(),logs=[];let now=Date.now();
  const input=new InputControl({root,enabled:true,screen:{available:async()=>true},backend,now:()=>now,log:text=>logs.push(text),cap:2});
  const start=async id=>{await input.start({grantId:id,expiresAt:new Date(now+600000).toISOString(),maxActions:2});input.observe(frame(now));};
  await start('one');await assert.rejects(input.act({grantId:'one',action:'key',keys:'ctrl+alt+f2'}));assert.equal(backend.actions.length,0);assert.ok(backend.releases);assert.equal(input.session,null);
  await start('two');await input.act({grantId:'two',action:'type',text:'PRIVATE_TYPED_TEXT'});assert.ok(!logs.join('\n').includes('PRIVATE_TYPED_TEXT'));assert.ok(logs.join('\n').includes('textLength'));
  now+=1000;input.observe(frame(now));await input.act({grantId:'two',action:'left_click',coordinate:[1176,220]});assert.equal(input.session,null);assert.equal(input.state.grants.two.count,2);
  now+=1000;await start('three');backend.fail=true;await assert.rejects(input.act({grantId:'three',action:'key',keys:'ctrl+s'}));assert.equal(input.session,null);backend.fail=false;
  await start('four');await input.close();assert.equal(input.session,null);assert.ok(backend.stops>=4);
  await start('five');backend.emit('closed');await until(()=>!input.session);assert.equal(input.state.grants.five.revoked,true);
});
test('node enforces rate limit, expired/wrong grant, fresh geometry and persisted session count',async t=>{
  const root=fixture(t),backend=new Backend();let now=Date.now();const make=()=>new InputControl({root,enabled:true,screen:{available:async()=>true},backend,now:()=>now,log:()=>{}});let input=make();
  const props={grantId:'rate',expiresAt:new Date(now+600000).toISOString(),maxActions:40};await input.start(props);input.observe(frame(now));await input.act({grantId:'rate',action:'key',keys:'ctrl+s'});
  await assert.rejects(input.act({grantId:'rate',action:'key',keys:'ctrl+s'}));assert.equal(backend.actions.length,1);
  input=make();await assert.rejects(input.start(props),/revoked/);
  const fresh={...props,grantId:'fresh'};await input.start(fresh);input.observe(frame(now));await assert.rejects(input.act({grantId:'wrong',action:'key',keys:'ctrl+s'}));
  await input.start({...props,grantId:'expiry',expiresAt:new Date(now+1000).toISOString()});input.observe(frame(now));now+=1000;await assert.rejects(input.act({grantId:'expiry',action:'key',keys:'ctrl+s'}));
});
test('brain hard denials have no approval route: absent/other thread/expired/tainted/scheduled/no input',async t=>{
  const b=await brain(t);let approvals=0;const approve=async()=>{approvals++;return true;};
  await assert.rejects(b.context({approve}).authorize({machine:'OZZY-AI',action:'screenshot',target:'desktop'}),/No active/);
  await assert.rejects(b.controls.on('A','OZZY-AI'),/screen on/);
  await b.controls.on('A','OZZY-AI',{withScreen:true});
  const raw={machine:'OZZY-AI',action:'screenshot',target:'desktop'};
  await assert.rejects(b.context({tainted:()=>true,approve}).authorize(raw),/Tainted/);
  await assert.rejects(b.context({scheduled:true,approve}).authorize(raw),/Scheduled/);
  await assert.rejects(b.controls.context({thread:'B',approve}).authorize(raw),/No active/);
  await b.controls.on('A','OZZY-AI',{withScreen:true});
  b.hub.list=()=>[{machine:'OZZY-AI',online:true,capabilities:['screen']}];await assert.rejects(b.context({approve}).authorize(raw),/capability/);
  b.controls.state.grants.A.expiresAt=new Date(0).toISOString();await assert.rejects(b.context({approve}).authorize(raw),/expired/);assert.equal(approvals,0);
});
test('every computer action waits for owner button; chat cannot approve; exact text on card; deny ends task',async t=>{
  const b=await brain(t);await b.controls.on('A','OZZY-AI',{withScreen:true});const sent=[],relay=new ApprovalRelay('owner');t.after(()=>relay.close());
  const channel={id:'A',send:async packet=>{sent.push(packet);return{id:'card-'+sent.length,edit:async()=>{}};}};
  const context=b.context({approve:request=>relay.request(channel,request)}),permissions=createPermissions({root:b.root,control:context});
  const raw={machine:'OZZY-AI',action:'screenshot',target:'read desktop before input'};let settled=false;
  const pending=permissions.canUseTool('mcp__computer__computer',raw).then(result=>{settled=true;return result;});await until(()=>sent.length===1);
  await relay.handle({user:{id:'owner'},customId:'approved'});assert.equal(settled,false);assert.equal(b.calls.filter(c=>c.method==='screen').length,0);
  const click=async(index,yes=true,owner='owner')=>relay.handle({user:{id:owner},channelId:'A',message:{id:'card-'+(index+1)},customId:sent[index].components[0].components[yes?0:1].data.custom_id,deferUpdate:async()=>{}});
  await click(0,true,'intruder');assert.equal(settled,false);await click(0);assert.equal((await pending).behavior,'allow');assert.equal((await context.execute({target:raw.target,action:raw.action,machine:raw.machine})).content[1].type,'image');assert.equal(sent.length,1);
  const text='exact text\nwith "quotes" and $()';const typing={machine:'OZZY-AI',action:'type',target:'draft text box',text};
  const next=context.execute(typing);await until(()=>sent.length===2);const card=JSON.parse(sent[1].files[0].attachment.toString());assert.equal(card.text,text);assert.match(sent[1].content,/exact text/);assert.equal(b.calls.filter(c=>c.method==='input_action').length,0);
  await click(1);assert.equal((await next).isError,undefined);assert.equal(b.calls.filter(c=>c.method==='input_action').length,1);assert.equal(b.calls.filter(c=>c.method==='screen').length,2);
  const denied=context.execute({machine:'OZZY-AI',action:'key',keys:'ctrl+s',target:'save draft'});await until(()=>sent.length===3);await click(2,false);assert.equal((await denied).isError,true);assert.equal(b.controls.active('A'),null);
  assert.equal((await context.execute(typing)).isError,true);assert.equal(sent.length,3);
  const audit=fs.readFileSync(path.join(b.root,'data/audit.log'),'utf8');assert.ok(!audit.includes(text));assert.ok(!audit.includes(b.screenshot.data));
});
test('taint or grant revocation during approval blocks execution; GNOME Stop and action cap end grants',async t=>{
  const b=await brain(t,{cap:1});await b.controls.on('A','OZZY-AI',{withScreen:true});let tainted=false;
  const context=b.context({tainted:()=>tainted,approve:async()=>{tainted=true;return true;}});
  const failed=await context.execute({machine:'OZZY-AI',action:'screenshot',target:'desktop'});assert.ok(failed.isError);assert.equal(b.calls.filter(c=>c.method==='screen').length,0);
  await b.controls.on('A','OZZY-AI',{withScreen:true});const good=b.context({approve:async()=>true});await good.execute({machine:'OZZY-AI',action:'screenshot',target:'desktop'});await good.execute({machine:'OZZY-AI',action:'key',keys:'ctrl+s',target:'save'});assert.equal(b.controls.active('A'),null);assert.match(b.notices.join('\n'),/1 approved steps/);
  await b.controls.on('A','OZZY-AI',{withScreen:true});const grant=b.controls.grant('A');b.hub.emit('control_closed',{machine:'OZZY-AI',grantId:grant.id,reason:'GNOME Stop'});assert.equal(b.controls.active('A'),null);assert.equal(b.controls.state.grants.A.reason,'GNOME Stop');
});
test('target previews are small crops attached in memory; grants persist with original expiry and counts',async t=>{
  const b=await brain(t);await b.controls.on('A','OZZY-AI',{withScreen:true});let approval;const context=b.context({approve:async request=>{approval=request;return true;}});
  await context.execute({machine:'OZZY-AI',action:'screenshot',target:'desktop'});b.controls.preview('A',true);await context.execute({machine:'OZZY-AI',action:'left_click',coordinate:[100,50],target:'safe test point'});
  const meta=await sharp(approval.preview).metadata();assert.ok(meta.width<=160&&meta.height<=120);assert.ok(meta.width<200);
  const restored=new ControlGrants({root:b.root,hub:b.hub,screens:b.screens});t.after(()=>restored.close());assert.equal(restored.grant('A').id,b.controls.grant('A').id);assert.equal(restored.grant('A').count,1);assert.equal(restored.grant('A').expiresAt,b.controls.grant('A').expiresAt);
  assert.ok(commands().find(command=>command.name==='control'));assert.equal(validCapabilities(['status','screen','input']),true);assert.equal(validCapabilities(['status','input']),false);
});
test('Python helper releases held keys/buttons on failure and shutdown, refuses blocked combo and rejects unshared monitor',()=>{
  const helper=path.resolve('src/node/input/portal.py');
  const code=`import importlib.util,sys
s=importlib.util.spec_from_file_location('input_portal',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
x=p.Input(None);x.session='/session';events=[]
x.notify=lambda method,signature,args:events.append((method,args))
x.held_keys.add(123);x.held_buttons.add(272);x.release();assert len(events)==2 and all(event[1][-1]==0 for event in events)
p.screen.availability=lambda bus:{'monitors':[]}
try:x.action({'action':'key','keys':'ctrl+alt+f1'});assert False
except RuntimeError:assert not x.held_keys
calls=[]
def fail(method,signature,args):
 calls.append((method,args))
 if args[-1]==1:raise RuntimeError('failure')
x.notify=fail
try:x.action({'action':'key','keys':'ctrl+s'});assert False
except RuntimeError:assert not x.held_keys and any(call[1][-1]==0 for call in calls)
x.streams=[(10,{'position':(0,0),'size':(100,100)})];x.notify=lambda *args:None
x.move({'x':50,'y':50,'monitor':{'x':0,'y':0,'width':100,'height':100}})
try:x.move({'x':50,'y':50,'monitor':{'x':100,'y':0,'width':100,'height':100}});assert False
except RuntimeError:pass
x.held_buttons.add(272);p.screen.call=lambda *args:None;x.shutdown();assert not x.held_buttons and x.closed
print('release verified')`;
  assert.match(execFileSync('/usr/bin/python3',['-B','-c',code,helper],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),/release verified/);
});
test('encrypted node/hub input capability changes and GNOME Stop event end control without changing crypto',async t=>{
  const brainKey=sodium.crypto_kx_keypair(),key=sodium.crypto_kx_keypair(),token='phase6-token-abcdefghijklmnop';let available=false;
  const hub=new NodeHub({port:0,relayURL:'',key:brainKey,trustedKeys:nodeKeys(`OZZY-AI:${publicHex(key)}`),tokens:new Map([['ozzy-ai',token]]),log:()=>{}});await hub.ready;t.after(()=>hub.close());
  const input=new EventEmitter();Object.assign(input,{available:async()=>available,close:async()=>{},observe:()=>{},start:async()=>({started:true}),stop:async()=>{},act:async()=>({done:true})});
  const node=startNode({transport:'local',url:`ws://127.0.0.1:${hub.server.address().port}`,token,machine:'OZZY-AI',key,brainKey:brainKey.publicKey,log:()=>{},screen:{available:async()=>true,close:()=>{}},input,capabilityInterval:10});t.after(()=>node.close());
  await until(()=>hub.list()[0].online);assert.ok(!hub.list()[0].capabilities.includes('input'));available=true;await until(()=>hub.list()[0].capabilities.includes('input'));
  assert.ok((await hub.request('OZZY-AI','input_start',{})).started);let closed;hub.once('control_closed',event=>closed=event);input.emit('closed',{grantId:'test-grant',reason:'GNOME Stop',count:0});await until(()=>closed);assert.equal(closed.reason,'GNOME Stop');available=false;await until(()=>!hub.list()[0].capabilities.includes('input'));
});

test('restored runtime requires another screen review and step approval before input; shutdown preserves bounded grant',async t=>{
  const b=await brain(t);await b.controls.on('A','OZZY-AI',{withScreen:true});let approvals=0;
  const context=b.context({approve:async()=>{approvals++;return true;}});await context.execute({machine:'OZZY-AI',action:'screenshot',target:'desktop'});
  const request=b.hub.request;b.hub.request=async(machine,method,params)=>method==='input_start'?{newSession:true}:request(machine,method,params);
  const result=await context.execute({machine:'OZZY-AI',action:'key',keys:'ctrl+s',target:'save'});
  assert.match(result.content[0].text,/no input was sent/);assert.equal(b.calls.filter(c=>c.method==='input_action').length,0);assert.equal(b.controls.grant('A').count,0);assert.equal(approvals,2);
  const id=b.controls.grant('A').id;await b.controls.close();assert.equal(b.controls.grant('A').id,id);assert.equal(b.calls.at(-1).params.revoke,false);
});

test('web result ends an active control grant before any further step approval',async t=>{
  const b=await brain(t);await b.controls.on('A','OZZY-AI',{withScreen:true});const context=b.context({approve:async()=>true});
  const web={result:()=>{},session:()=>({tainted:true})};const permissions=createPermissions({root:b.root,control:context,web,sessionKey:'thread'});
  await permissions.hooks.PostToolUse[0].hooks[0]({tool_name:'WebSearch',tool_input:{query:'example'},tool_response:{}});
  assert.equal(b.controls.active('A'),null);assert.equal(b.controls.state.grants.A.reason,'thread tainted by web result');
});

test('node state-write failure still releases and closes portal, and disables capability',async t=>{
  const root=fixture(t),backend=new Backend(),input=new InputControl({root,enabled:true,screen:{available:async()=>true},backend,log:()=>{}});
  const now=Date.now();await input.start({grantId:'disk-error',expiresAt:new Date(now+600000).toISOString(),maxActions:40});input.observe(frame(now));fs.rmSync(input.file);fs.mkdirSync(input.file,{recursive:true});
  await assert.rejects(input.act({grantId:'disk-error',action:'key',keys:'ctrl+s'}));assert.equal(backend.actions.length,0);assert.equal(input.session,null);assert.ok(backend.releases);assert.ok(backend.stops);assert.equal(await input.available(),false);
});

test('rate limits span new grants and restored grants cannot extend node-owned expiry',async t=>{
  const root=fixture(t),backend=new Backend();let now=0;const input=new InputControl({root,enabled:true,screen:{available:async()=>true},backend,now:()=>now,log:()=>{}});
  await input.start({grantId:'initial',expiresAt:new Date(5000).toISOString(),maxActions:40});input.observe(frame(now));await input.act({grantId:'initial',action:'key',keys:'s+ctrl'});assert.equal(backend.actions[0].keys,'ctrl+s');
  await input.close();await input.start({grantId:'other',expiresAt:new Date(600000).toISOString(),maxActions:40});input.observe(frame(now));await assert.rejects(input.act({grantId:'other',action:'key',keys:'ctrl+s'}));assert.equal(backend.actions.length,1);
  now=1000;await input.start({grantId:'initial',expiresAt:new Date(now+600000).toISOString(),maxActions:40});assert.equal(input.session.expiresAt,new Date(5000).toISOString());assert.equal(input.session.state.count,1);await input.close();
});

test('Discord control commands enforce owner, thread, taint and explicit with-screen; screen off ends input',async t=>{
  const b=await brain(t),client=new EventEmitter(),sent=[];client.destroy=()=>{};
  const channel={id:'A',parentId:'bit',isThread:()=>true,isDMBased:()=>false,send:async packet=>{sent.push(packet);return{id:'notice',edit:async()=>{}};}};
  client.channels={fetch:async()=>channel};let tainted=false,response='';
  const runner={controls:b.controls,screens:b.screens,web:{session:()=>({tainted})},webKeys:{},sessions:{}};
  const discord=createDiscord({client,runner,hub:b.hub,budget:{},env:{OWNER_DISCORD_ID:'owner',BIT_CHANNEL_ID:'bit'},auditFile:path.join(b.root,'data/audit.log')});t.after(()=>discord.close());
  const handler=client.listeners('interactionCreate')[0];
  const request=(command,action,{owner='owner',withScreen=false}={})=>({user:{id:owner},commandName:command,channelId:'A',channel,isChatInputCommand:()=>true,deferReply:async()=>{},editReply:async packet=>{response=packet.content;},followUp:async()=>{},options:{getSubcommand:()=>action,getString:key=>key==='state'?'on':null,getBoolean:()=>withScreen}});
  await handler(request('control','on',{owner:'other',withScreen:true}));assert.equal(b.controls.active('A'),null);
  await handler(request('control','on'));assert.match(response,/screen on/);assert.equal(b.screens.active('A'),null);
  await handler(request('control','on',{withScreen:true}));assert.match(response,/🖱️ controlling/);assert.ok(b.controls.active('A'));assert.ok(b.screens.active('A'));
  await handler(request('control','preview'));assert.equal(b.controls.state.previews.A,true);
  await handler(request('screen','off'));assert.equal(b.controls.active('A'),null);assert.equal(b.screens.active('A'),null);assert.match(sent.at(-1).content,/control ended/);
  tainted=true;await handler(request('control','on',{withScreen:true}));assert.match(response,/Web-tainted/);assert.equal(b.screens.active('A'),null);
});

test('resident helper consumes batched release commands before pipe EOF, without buffering them indefinitely',()=>{
  const helper=path.resolve('src/node/input/portal.py');
  const code=`import importlib.util,sys
s=importlib.util.spec_from_file_location('input_portal',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
p.screen.connect=lambda:None
p.screen.availability=lambda bus:None
p.screen.call=lambda *args:[2]
p.Input.start=lambda self:{'started':True}
p.Input.release=lambda self:None
p.main()`;
  const stdout=execFileSync('/usr/bin/python3',['-B','-c',code,helper],{input:'{"id":"one","method":"start"}\n{"id":"two","method":"release"}\n{"id":"three","method":"release"}\n',encoding:'utf8',timeout:5000,stdio:['pipe','pipe','pipe']});
  const responses=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(responses.map(response=>response.id),['one','two','three']);assert.ok(responses.every(response=>response.ok));
});

test('only one outstanding control step is allowed; another action cannot queue its own approval',async t=>{
  const b=await brain(t);await b.controls.on('A','OZZY-AI',{withScreen:true});let resolveApproval,requests=0;
  const context=b.context({approve:()=>{requests++;return new Promise(resolve=>resolveApproval=resolve);}});
  const raw={machine:'OZZY-AI',action:'screenshot',target:'inspect desktop'};const first=context.authorize(raw);await until(()=>requests===1);
  await assert.rejects(context.authorize({...raw,target:'another request'}),/current control step/);assert.equal(requests,1);
  resolveApproval(true);await first;assert.equal((await context.execute(raw)).isError,undefined);
});

test('runtime suspension preserves grants; stale task cleanup cannot revoke a newer owner grant',async t=>{
  const b=await brain(t);await b.controls.on('A','OZZY-AI',{withScreen:true});const old=b.controls.grant('A'),context=b.context({approve:async()=>true});
  b.hub.emit('control_closed',{machine:'OZZY-AI',grantId:old.id,reason:'runtime suspended'});assert.equal(b.controls.grant('A').id,old.id);assert.ok(b.controls.grant('A').runtimeClosedAt);
  await b.controls.on('A','OZZY-AI',{withScreen:true});const fresh=b.controls.grant('A');
  assert.ok((await context.execute({machine:'OZZY-AI',action:'screenshot',target:'old task'})).isError);assert.equal(b.controls.grant('A').id,fresh.id);
});
