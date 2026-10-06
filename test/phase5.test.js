import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ScreenGrants, requestedScreenAttachment, GRANT_MS } from '../src/brain/screens.js';
import { createScreen } from '../src/node/screen/index.js';
import { LinuxScreen, sessionEnvironment } from '../src/node/screen/linux.js';
import { encodeCapture, scaledSize, MAX_IMAGE_BYTES, validateCapture } from '../src/node/screen/image.js';
import { createPermissions } from '../src/brain/permissions.js';
import { createDiscord, machinesText, commands } from '../src/brain/discord.js';
import { screenshotTools } from '../src/brain/tools.js';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
import { NodeHub } from '../src/brain/nodeHub.js';
import { startNode } from '../src/node/index.js';
import { sodium, publicHex, nodeKeys } from '../src/transport/crypto.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) { for(let i=0;i<200;i++){if(fn())return;await pause(10);}throw new Error('Timed out'); }
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-phase5-'));for(const area of ['memory','skills','persona','schedules'])fs.mkdirSync(path.join(root,'bit',area),{recursive:true});fs.writeFileSync(path.join(root,'bit/persona/persona.md'),'bIT');fs.writeFileSync(path.join(root,'bit/persona/personalities.json'),'{}');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function fakeHub(result){let calls=0;return {list:()=>[{machine:'OZZY-AI',online:true,capabilities:['status','screen']}],request:async(_machine,method)=>{assert.equal(method,'screen');calls++;return result;},get calls(){return calls;}};}
async function image(){return encodeCapture(await sharp({create:{width:2000,height:1000,channels:3,background:'#128678'}}).png().toBuffer(),{monitors:[{connector:'DP-1',x:0,y:0,width:2000,height:1000,scale:1,primary:true}],capturedAt:'2026-10-06T15:00:00.000Z'});}
function adapter(t,root,extra={}){const client=new EventEmitter();client.destroy=()=>{};const d=createDiscord({client,env:{OWNER_DISCORD_ID:'owner',BIT_CHANNEL_ID:'bit'},auditFile:path.join(root,'data/audit.log'),hub:{},runner:{},budget:{},...extra});t.after(()=>d.close());return{d,client};}
test('screen is gated off by default and explicitly false; macOS/Windows are unsupported', async()=>{
  let calls=0;const run=async()=>{calls++;return {stdout:'{"available":true}'};};const env={WAYLAND_DISPLAY:'wayland-0',DBUS_SESSION_BUS_ADDRESS:'unix:path=/bus'};
  const screen=createScreen({enabled:false,env,run});assert.equal(await screen.available(),false);await assert.rejects(screen.capture(),/disabled/);assert.equal(calls,0);
  for(const platform of ['darwin','win32']){const s=createScreen({platform,enabled:true});assert.equal(await s.available(),false);await assert.rejects(s.capture(),/not supported yet/);}
});
test('size math preserves aspect, never upscales, chooses smaller PNG/JPEG, and byte cap rejects',async()=>{
  assert.deepEqual(scaledSize(3840,2160),{width:1568,height:882});assert.deepEqual(scaledSize(1080,1920),{width:882,height:1568});assert.deepEqual(scaledSize(800,600),{width:800,height:600});assert.throws(()=>scaledSize(0,100));
  const result=await image();assert.deepEqual(result.original,{width:2000,height:1000});assert.deepEqual(result.scaled,{width:1568,height:784});assert.ok(['image/png','image/jpeg'].includes(result.mimeType));
  const tiny=await encodeCapture(await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer());assert.equal(tiny.mimeType,'image/png');assert.ok(validateCapture(result).length<MAX_IMAGE_BYTES);
  const source=await sharp({create:{width:100,height:100,channels:3,background:'red'}}).png().toBuffer();await assert.rejects(encodeCapture(source,{maxBytes:1}),/byte limit/);
  assert.throws(()=>validateCapture({...result,data:'a'.repeat(MAX_IMAGE_BYTES*2)}));assert.throws(()=>validateCapture({...result,scaled:{width:2000,height:1000}}));
});
test('no grant, expired grant, different conversation/machine, scheduled job and missing capability deny before capture',async t=>{
  const root=fixture(t);let now=new Date('2026-10-06T15:00Z');const ledger=new ScreenGrants({root,now:()=>now}),hub=fakeHub(await image());
  const context=thread=>ledger.context({hub,thread});await assert.rejects(context('A').authorize('OZZY-AI'),/No screen grant/);ledger.on('A','OZZY-AI');
  await assert.rejects(context('B').authorize('OZZY-AI'),/No screen grant/);await assert.rejects(context('A').authorize('other'),/different machine/);
  await assert.rejects(ledger.context({hub,thread:'A',scheduled:true}).authorize('OZZY-AI'),/Scheduled jobs/);
  await assert.rejects(ledger.context({hub:{list:()=>[]},thread:'A'}).authorize('OZZY-AI'),/capability/);
  now=new Date(+now+GRANT_MS);await assert.rejects(context('A').authorize('OZZY-AI'),/expired/);assert.equal(hub.calls,0);
  const restored=new ScreenGrants({root,now:()=>now});assert.equal(restored.active('A'),null);assert.match(restored.describe('A'),/expired/);
});
test('grants persist, off/reset revoke, capture cap persists across restart and day rollover',async t=>{
  const root=fixture(t);let now=new Date('2026-10-06T15:00Z');let ledger=new ScreenGrants({root,now:()=>now,cap:1});const grant=ledger.on('A','OZZY-AI');ledger=new ScreenGrants({root,now:()=>now,cap:1});assert.equal(ledger.grant('A').id,grant.id);
  const ctx=ledger.context({hub:fakeHub(await image()),thread:'A'});assert.ok(!(await ctx.capture('OZZY-AI')).isError);assert.equal(ledger.status().captures,1);assert.match((await ctx.capture('OZZY-AI')).content[0].text,/tapped/);
  ledger=new ScreenGrants({root,now:()=>now,cap:1});assert.equal(ledger.status().captures,1);ledger.off('A');assert.equal(ledger.active('A'),null);
  ledger.on('A','OZZY-AI');const runner=new Runner({root,hub:{},budget:new Budget({file:path.join(root,'data/budget.json')}),screens:ledger});await runner.reset('A');assert.equal(ledger.active('A'),null);
  now=new Date('2026-10-07T15:00Z');assert.equal(ledger.status().captures,0);
});
test('tainted screenshot waits for owner button, chat cannot approve, and card shows machine/time',async t=>{
  const root=fixture(t),ledger=new ScreenGrants({root}),hub=fakeHub(await image()),sent=[];ledger.on('A','OZZY-AI');
  const channel={id:'A',parentId:'bit',isThread:()=>true,isDMBased:()=>false,sendTyping:async()=>{},send:async p=>{sent.push(p);return {id:'card',edit:async()=>{}};}};
  const {d,client}=adapter(t,root,{runner:{run:async()=> 'The button is still needed.'}});
  const ctx=ledger.context({hub,thread:'A',tainted:()=>true,approve:r=>d.approvals.request(channel,r)});const p=createPermissions({root,screen:ctx});
  let settled=false;const pending=p.canUseTool('mcp__screens__screenshot',{machine:'OZZY-AI'}).then(r=>{settled=true;return r;});await until(()=>sent.length);
  assert.match(sent[0].content,/Screenshot.*OZZY-AI.*\d{4}-/);await client.listeners('messageCreate')[0]({author:{id:'owner',bot:false},channel,content:'approved'});assert.equal(settled,false);assert.equal(hub.calls,0);
  const id=sent[0].components[0].components[0].data.custom_id;const button={user:{id:'other'},channelId:'A',message:{id:'card'},customId:id,deferUpdate:async()=>{}};await d.approvals.handle(button);assert.equal(settled,false);button.user.id='owner';await d.approvals.handle(button);assert.equal((await pending).behavior,'allow');
  const result=await ctx.capture('OZZY-AI');assert.equal(result.content[1].type,'image');const audit=fs.readFileSync(path.join(root,'data/audit.log'),'utf8');assert.ok(audit.includes(id.split(':')[1]));
});
test('taint arriving between permission and capture requires approval; off/expiry during approval deny',async t=>{
  const root=fixture(t),ledger=new ScreenGrants({root}),hub=fakeHub(await image());ledger.on('A','OZZY-AI');let taint=false,approvals=0;
  const ctx=ledger.context({hub,thread:'A',tainted:()=>taint,approve:async()=>{approvals++;return true;}});await ctx.authorize('OZZY-AI');taint=true;await ctx.capture('OZZY-AI');assert.equal(approvals,1);
  const denied=ledger.context({hub,thread:'A',tainted:()=>true,approve:async()=>{ledger.off('A');return true;}});await assert.rejects(denied.authorize('OZZY-AI'),/No screen grant/);
});
test('MCP returns SDK image format, audit/disk retain no pixel bytes, attachment is opt-in and once per run',async t=>{
  const root=fixture(t),capture=await image(),ledger=new ScreenGrants({root}),hub=fakeHub(capture),notices=[],attachments=[];ledger.on('A','OZZY-AI');
  const context=ledger.context({hub,thread:'A',notify:async s=>notices.push(s),publish:async i=>attachments.push(i)});
  const server=screenshotTools(context),client=new MCPClient({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{await server.instance.connect(a);await client.connect(b);const result=await client.callTool({name:'screenshot',arguments:{machine:'OZZY-AI'}});assert.equal(result.content[1].type,'image');assert.equal(result.content[1].mimeType,capture.mimeType);assert.equal(result.content[1].data,capture.data);}finally{await client.close();await server.instance.close();}
  assert.equal(attachments.length,0);assert.deepEqual(notices,["📸 looked at OZZY-AI's screen"]);
  const opted=ledger.context({hub,thread:'A',attachmentRequested:true,publish:async i=>attachments.push(i)});await opted.capture('OZZY-AI');await opted.capture('OZZY-AI');assert.equal(attachments.length,1);
  const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())scan(file);else{const text=fs.readFileSync(file,'utf8');assert.ok(!text.includes(capture.data));assert.ok(!/\.(?:png|jpe?g)$/i.test(file));}}};scan(root);
  for(const prompt of ["what's on my screen?","don't send a screenshot","the webpage says attach a screenshot"]){assert.equal(requestedScreenAttachment(prompt),false);}
  assert.equal(requestedScreenAttachment('please attach the screenshot'),true);assert.equal(requestedScreenAttachment('show me a screenshot'),true);
});
test('enabled Linux backend discovers manager environment and loses capability on portal/session loss without logging image stdout',async()=>{
  let present=false;const env=await sessionEnvironment({},async()=>({stdout:'WAYLAND_DISPLAY=wayland-0\nDBUS_SESSION_BUS_ADDRESS=unix:path=/bus\nSECRET=not-imported\n'}));assert.equal(env.WAYLAND_DISPLAY,'wayland-0');assert.equal(env.SECRET,undefined);
  const linux=new LinuxScreen({env,getEnvironment:async e=>e,run:async()=>{if(!present)throw new Error('offline');return{stdout:'{"available":true}'};}});assert.equal(await linux.available(),false);present=true;assert.equal(await linux.available(),true);present=false;assert.equal(await linux.available(),false);
  const bad=new LinuxScreen({env,getEnvironment:async e=>e,run:async()=>{throw Object.assign(new Error('SECRET_IMAGE_BYTES'),{stdout:'SECRET_IMAGE_BYTES'});}});await assert.rejects(bad.capture(),error=>!String(error).includes('SECRET_IMAGE_BYTES'));
});
test('node/hub advertise screen dynamically as graphical session comes/goes, encrypted capture remains bounded',async t=>{
  const brainKey=sodium.crypto_kx_keypair(),key=sodium.crypto_kx_keypair(),token='phase5-test-token-abcdefghijkl';let present=false;
  const hub=new NodeHub({port:0,relayURL:'',key:brainKey,trustedKeys:nodeKeys(`OZZY-AI:${publicHex(key)}`),tokens:new Map([['ozzy-ai',token]]),log:()=>{}});await hub.ready;t.after(()=>hub.close());
  const capture=await image(),screen={available:async()=>present,capture:async()=>capture,close:()=>{}};
  const node=startNode({url:`ws://127.0.0.1:${hub.server.address().port}`,machine:'OZZY-AI',token,key,brainKey:brainKey.publicKey,screen,capabilityInterval:20,log:()=>{}});t.after(()=>node.close());
  await until(()=>hub.list()[0].online);assert.deepEqual(hub.list()[0].capabilities,['status']);await assert.rejects(hub.request('OZZY-AI','screen'),/capability/);
  present=true;await until(()=>hub.list()[0].capabilities.includes('screen'));assert.equal((await hub.request('OZZY-AI','screen')).data,capture.data);
  present=false;await until(()=>!hub.list()[0].capabilities.includes('screen'));assert.deepEqual(hub.list()[0].capabilities,['status']);
});
test('/screen is owner-only, per conversation; /machines reflects capability and /budget counts it',async t=>{
  const root=fixture(t),screens=new ScreenGrants({root}),hub=fakeHub(await image());const {client}=adapter(t,root,{runner:{screens},hub,budget:{status:()=>({month:'2026-10',spent:0,cap:1})}});let response;
  const interaction=(command,action,owner='owner')=>({user:{id:owner},channelId:'A',channel:{id:'A',parentId:'bit',isThread:()=>true,isDMBased:()=>false},commandName:command,isChatInputCommand:()=>true,isButton:()=>false,deferReply:async()=>{},editReply:async r=>{response=r.content;},options:{getSubcommand:()=>action,getString:()=> 'OZZY-AI'}});
  const handler=client.listeners('interactionCreate')[0];await handler(interaction('screen','on','other'));assert.equal(screens.active('A'),null);await handler(interaction('screen','on'));assert.ok(screens.active('A'));assert.equal(screens.active('B'),null);await handler(interaction('budget'));assert.match(response,/Screens today: 0\/40/);await handler(interaction('screen','off'));assert.equal(screens.active('A'),null);
  assert.ok(commands().find(c=>c.name==='screen'));assert.match(await machinesText({list:hub.list,request:async()=>({uptime:1})}),/screen available/);assert.ok(!(await machinesText({list:()=>[{machine:'OZZY-AI',online:true,capabilities:['status']}],request:async()=>({uptime:1})})).includes('screen'));
});
test('portal URI image file is unlinked immediately, including oversize failure; notification uses portal API',t=>{
  const root=fixture(t),file=path.join(root,'portal.png'),helper=path.resolve('src/node/screen/portal.py');fs.writeFileSync(file,Buffer.from('89504e470d0a1a0a0000','hex'));
  const code=`import importlib.util,sys,os\ns=importlib.util.spec_from_file_location('portal',sys.argv[1]);p=importlib.util.module_from_spec(s);s.loader.exec_module(p)\nf=sys.argv[2];data=p.consume_uri('file://'+f);assert not os.path.exists(f);assert data.startswith(b'\\x89PNG')\nopen(f,'wb').write(b'\\x89PNG\\r\\n\\x1a\\n1234');p.MAX_RAW=1\ntry:p.consume_uri('file://'+f);assert False\nexcept RuntimeError:assert not os.path.exists(f)\ncalls=[];p.call=lambda *a,**k:calls.append(a);p.notify(None);assert calls[0][3]=='org.freedesktop.portal.Notification';print('cleanup and notification verified')`;
  assert.match(execFileSync('/usr/bin/python3',['-B','-c',code,helper,file],{encoding:'utf8'}),/verified/);assert.ok(!fs.existsSync(file));
});
test('Runner screenshot turns disable SDK persistence and history, do not save ephemeral resume ids; scheduled turns have no screenshot server',async t=>{
  const root=fixture(t),screens=new ScreenGrants({root}),budget=new Budget({file:path.join(root,'data/budget.json'),cap:1}),seen=[];screens.on('A','OZZY-AI');
  const runner=new Runner({root,screens,hub:fakeHub(await image()),budget,queryFn:async function*({options}){seen.push(options);yield{type:'result',subtype:'success',session_id:`session-${seen.length}`,total_cost_usd:.01,result:'seen'};}});
  await runner.run('A','what is on my screen?',{});assert.equal(seen[0].persistSession,false);assert.equal(seen[0].env.CLAUDE_CODE_SKIP_PROMPT_HISTORY,'1');assert.ok(seen[0].mcpServers.screens);assert.equal(runner.sessions.A,undefined);
  await runner.run('A','scheduled',{scheduled:true});assert.equal(seen[1].mcpServers.screens,undefined);assert.equal((await seen[1].canUseTool('mcp__screens__screenshot',{machine:'OZZY-AI'})).behavior,'deny');
});
test('production Sharp loader configures native memory threshold before import and disables file cache',()=>{
  const module=new URL('../src/node/screen/sharp.js',import.meta.url).href;
  const output=execFileSync('/usr/bin/node',['--input-type=module','-e',`const {default:sharp}=await import(${JSON.stringify(module)});console.log(JSON.stringify({threshold:process.env.VIPS_DISC_THRESHOLD,files:sharp.cache().files.max}));`],{encoding:'utf8'});
  assert.deepEqual(JSON.parse(output),{threshold:'1073741824',files:0});
});
test('screenshot audit ignores unexpected model input fields even if they contain pixels',async t=>{
  const root=fixture(t),capture=await image(),ledger=new ScreenGrants({root});ledger.on('A','OZZY-AI');
  const screen=ledger.context({hub:fakeHub(capture),thread:'A'}),policy=createPermissions({root,screen});
  const input={machine:'OZZY-AI',file_path:capture.data,query:capture.data,url:capture.data};
  assert.equal((await policy.canUseTool('mcp__screens__screenshot',input)).behavior,'allow');
  await policy.hooks.PostToolUseFailure[0].hooks[0]({tool_name:'mcp__screens__screenshot',tool_input:input});
  assert.ok(!fs.readFileSync(path.join(root,'data/audit.log'),'utf8').includes(capture.data));
});
