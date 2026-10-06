import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Scheduler, nextRun, validateSchedule } from '../src/brain/scheduler.js';
import { Reminders, resolveWhen } from '../src/brain/reminders.js';
import { reviewDiff } from '../src/brain/reviewDiff.js';
import { createPermissions } from '../src/brain/permissions.js';
import { WebLedger } from '../src/brain/web.js';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
import { Growth } from '../src/brain/growth.js';
import { createDiscord, commands } from '../src/brain/discord.js';
const tz = 'America/New_York';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-phase4-'));
  for (const area of ['schedules','memory','skills','persona']) fs.mkdirSync(path.join(root,'bit',area),{recursive:true});
  fs.writeFileSync(path.join(root,'bit/persona/persona.md'),'bIT');
  fs.writeFileSync(path.join(root,'bit/persona/personalities.json'),'{}');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root;
}
function schedule(root, name='daily-brief', { cron='0 8 * * 1-5', enabled=true, instructions='Say hello.' }={}) {
  const text=`---\nname: ${name}\ncron: "${cron}"\nenabled: ${enabled}\nchannel: bit\n---\n${instructions}\n`;
  fs.writeFileSync(path.join(root,`bit/schedules/${name}.md`),text);return text;
}
const env={OWNER_DISCORD_ID:'owner',BIT_CHANNEL_ID:'bit'};
function adapter(t, root, options={}) {
  const client=new EventEmitter();client.destroy=()=>{};
  const base={id:'bit',isDMBased:()=>false,isThread:()=>false};
  const d=createDiscord({client,env,runner:{},hub:{},budget:{},auditFile:path.join(root,'data/audit.log'),...options});t.after(()=>d.close());return {d,client,base};
}
test('five-field cron resolves TZ across spring/fall DST and seed weekdays/weekends', () => {
  assert.equal(nextRun('0 8 * * 1-5',new Date('2026-03-06T14:00Z'),tz).toISOString(),'2026-03-09T12:00:00.000Z');
  assert.equal(nextRun('0 8 * * 1-5',new Date('2026-10-30T13:00Z'),tz).toISOString(),'2026-11-02T13:00:00.000Z');
  assert.equal(nextRun('0 18 * * 0',new Date('2026-10-06T14:00Z'),tz).toISOString(),'2026-10-11T22:00:00.000Z');
  assert.equal(nextRun('30 2 * * *',new Date('2026-03-08T05:00Z'),tz).toISOString(),'2026-03-08T07:30:00.000Z');
  assert.throws(()=>nextRun('0 0 8 * * 1-5')); assert.throws(()=>nextRun('0 99 * * *')); assert.throws(()=>nextRun('@daily'));
});
test('schedule validation enforces exact schema and explicit positive web instructions', t => {
  const root=fixture(t), text=schedule(root);assert.equal(validateSchedule(text,'daily-brief').webAllowed,false);
  assert.equal(validateSchedule(text.replace('Say hello.','Use WebSearch to find news.'),'daily-brief').webAllowed,true);
  assert.equal(validateSchedule(text.replace('Say hello.','Do not use WebSearch.'),'daily-brief').webAllowed,false);
  for(const bad of [text.replace('channel: bit','channel: elsewhere'),text.replace('enabled: true','enabled: "true"'),text.replace('name: daily-brief','name: other'),text.replace('channel: bit','channel: bit\nhooks: {}')]) assert.throws(()=>validateSchedule(bad,'daily-brief'));
});
test('catch-up runs once within grace, restart never replays; old miss is mentioned next run', async t => {
  const root=fixture(t);schedule(root);let now=new Date('2026-10-06T13:00Z'), calls=[];
  const options={root,timezone:tz,now:()=>now,execute:async(job,ctx)=>{calls.push(ctx);return {};}};
  await new Scheduler(options).tick();await new Scheduler(options).tick();assert.equal(calls.length,1);assert.equal(calls[0].fresh,true);
  now=new Date('2026-10-07T16:00Z');await new Scheduler(options).tick();assert.equal(calls.length,1);
  now=new Date('2026-10-08T12:00Z');await new Scheduler(options).tick();assert.equal(calls.length,2);assert.match(calls[1].misses.join('\n'),/outside the two-hour/);
});
test('crash reservation is not replayed; paused and disabled jobs never run', async t => {
  const root=fixture(t);schedule(root);let calls=0;const now=()=>new Date('2026-10-06T13:00Z');
  const scheduler=new Scheduler({root,now,execute:async()=>{calls++;}});await scheduler.pause('daily-brief',true);await scheduler.tick();assert.equal(calls,0);await assert.rejects(scheduler.runNow('daily-brief'),/paused/);
  await scheduler.pause('daily-brief',false);await scheduler.tick();assert.equal(calls,0);
  schedule(root,'disabled',{enabled:false});await assert.rejects(scheduler.pause('disabled',false),/reviewed/);
  scheduler.state.jobs['daily-brief'].cursor='2026-10-06T12:00:00.000Z';scheduler.state.jobs['daily-brief'].lastRun={status:'claimed',due:'2026-10-06T12:00:00.000Z'};scheduler.save();
  await new Scheduler({root,now,execute:async()=>{calls++;}}).tick();assert.equal(calls,0);
});
test('scheduler records budget skip without losing missed-run notices', async t => {
  const root=fixture(t);schedule(root);let now=new Date('2026-10-06T13:00Z');let contexts=[];
  const s=new Scheduler({root,now:()=>now,execute:async(_j,ctx)=>{contexts.push(ctx);return contexts.length===1?{skipped:'budget'}:{};}});await s.tick();assert.equal(s.state.jobs['daily-brief'].lastRun.status,'skipped');
  now=new Date('2026-10-07T12:00Z');await s.tick();assert.match(contexts[1].misses.join('\n'),/because of budget/);
});
test('approval diff contains only changed lines and three lines of context; newline-only changes normalize', () => {
  const before=Array.from({length:30},(_,i)=>`line ${i}`).join('\r\n')+'\r\n';const after=before.replace('line 15','changed');
  const diff=reviewDiff('test.md',before,after);assert.match(diff,/-line 15\n\+changed/);assert.match(diff,/ line 12/);assert.match(diff,/ line 18/);assert.ok(!diff.includes('line 0'));assert.ok(!diff.includes('line 29'));
  assert.match(reviewDiff('test.md','a\r\n\r\n','a\n'),/No content changes/);
});
test('schedule writes await button approval with a minimal diff; malformed schedules denied before asking', async t => {
  const root=fixture(t), before=schedule(root);let review, release;
  const p=createPermissions({root,approve:async r=>{review=r;return new Promise(resolve=>{release=resolve;});}});
  let settled=false;const pending=p.canUseTool('Edit',{file_path:'bit/schedules/daily-brief.md',old_string:'Say hello.',new_string:'Say morning.'}).then(r=>{settled=true;return r;});
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.match(review.diff,/-Say hello.\n\+Say morning./);release(true);assert.equal((await pending).behavior,'allow');
  assert.equal((await p.canUseTool('Write',{file_path:'bit/schedules/daily-brief.md',content:before.replace('channel: bit','channel: evil')})).behavior,'deny');
});
test('reminder natural times resolve in TZ, with exact instants and DST validation', () => {
  const now=new Date('2026-10-06T14:00Z');assert.equal(resolveWhen('in 20 minutes',now,tz).toISOString(),'2026-10-06T14:20:00.000Z');assert.equal(resolveWhen('tomorrow at 3pm',now,tz).toISOString(),'2026-10-07T19:00:00.000Z');
  assert.equal(resolveWhen('tomorrow at 3pm',new Date('2026-10-31T14:00Z'),tz).toISOString(),'2026-11-01T20:00:00.000Z');
  assert.throws(()=>resolveWhen('March 8, 2026 at 2:30am',new Date('2026-03-07T14:00Z'),tz),/does not exist/);
  assert.throws(()=>resolveWhen('November 1, 2026 at 1:30am',new Date('2026-10-31T14:00Z'),tz),/occurs twice/);
  assert.throws(()=>resolveWhen('yesterday at 3pm',now,tz));assert.throws(()=>resolveWhen('sometime',now,tz));
});
test('late reminders deliver once after restart; cancellation and original channel persist', async t => {
  const root=fixture(t);let now=new Date('2026-10-06T14:00Z'), sends=[];const options={root,now:()=>now,timezone:tz,deliver:async(r,c)=>{sends.push({r,c});return {id:'message'};}};
  const r=new Reminders(options), saved=r.set(r.proposal('in 20 minutes','stretch'),'original-thread');const cancelled=r.set(r.proposal('in 10 minutes','cancel me'),'original-thread');r.cancel(cancelled.id);
  now=new Date('2026-10-06T15:00Z');await new Reminders(options).tick({startup:true});await new Reminders(options).tick({startup:true});assert.equal(sends.length,1);assert.equal(sends[0].c.late,true);assert.equal(sends[0].r.id,saved.id);assert.equal(sends[0].r.channel,'original-thread');
  assert.deepEqual(new Reminders(options).list(),[]);
});
test('tainted reminder waits for owner button; chat cannot approve; untainted resolves automatically', async t => {
  const root=fixture(t), web=new WebLedger({root}), reminders=new Reminders({root,now:()=>new Date('2026-10-06T14:00Z')});
  const sent=[], channel={id:'thread',parentId:'bit',isDMBased:()=>false,isThread:()=>true,sendTyping:async()=>{},send:async payload=>{sent.push(payload);return {id:'card',edit:async()=>{}};}};
  const {d,client}=adapter(t,root,{runner:{run:async()=> 'Still waiting for the button.'}});
  const p=createPermissions({root,web,sessionKey:'s',reminders,approve:r=>d.approvals.request(channel,r)});
  assert.equal((await p.canUseTool('mcp__reminders__set_reminder',{when:'in 20 minutes',text:'stretch'})).updatedInput.when,'2026-10-06T14:20:00.000Z');
  web.result('s','WebSearch',{results:[]});let settled=false;
  const pending=p.canUseTool('mcp__reminders__set_reminder',{when:'in 20 minutes',text:'stretch'}).then(r=>{settled=true;return r;});await new Promise(r=>setImmediate(r));
  assert.match(sent[0].content,/Oct 6, 2026/);await client.listeners('messageCreate')[0]({channel,author:{id:'owner',bot:false},content:'approved'});assert.equal(settled,false);
  const id=sent[0].components[0].components[0].data.custom_id;await d.approvals.handle({user:{id:'owner'},channelId:'thread',message:{id:'card'},customId:id,deferUpdate:async()=>{}});assert.equal((await pending).behavior,'allow');
});
test('scheduled Runner ignores previous session/taint; web hook denies unrequested web and normal taint applies when permitted', async t => {
  const root=fixture(t), seen=[], budget=new Budget({file:path.join(root,'data/budget.json'),cap:10});
  const runner=new Runner({root,hub:{list:()=>[]},budget,queryFn:async function*({options}){
    seen.push(options);assert.equal(options.resume,undefined);
    const check=await options.canUseTool('WebSearch',{query:'query'});assert.equal(check.behavior,seen.length===1?'deny':'allow');
    if(seen.length===2) await options.hooks.PostToolUse[0].hooks[0]({tool_name:'WebSearch',tool_input:{query:'query'},tool_response:{results:[]}});
    yield {type:'result',subtype:'success',session_id:`fresh-${seen.length}`,total_cost_usd:.01,result:'brief'};
  }});
  runner.sessions.thread='old';runner.webKeys.thread='old';runner.web.result('old','WebSearch',{results:[]});
  const ctx={fresh:true,scheduled:true,webAllowed:false,approve:async()=>false,notify:async()=>{}};await runner.run('thread','Schedule',ctx);assert.equal(runner.web.session(runner.webKeys.thread).tainted,false);assert.ok(!seen[0].tools.includes('WebSearch'));
  await runner.run('thread','Use WebSearch', {...ctx,webAllowed:true});assert.equal(runner.web.session(runner.webKeys.thread).tainted,true);
});
test('Discord scheduled run creates a dated thread, budget gate avoids API/thread, reminder delivery mentions only owner and falls back', async t => {
  const root=fixture(t), sent=[], threads=[], runs=[];const thread={id:'new-thread',name:'daily-brief · 2026-10-06',send:async p=>{sent.push(p);return {id:'brief'};},isThread:()=>true,parentId:'bit'};
  const base={id:'bit',send:async p=>{sent.push(p);return {id:'base-message'};},threads:{create:async args=>{threads.push(args);return thread;}}};
  const {d,client}=adapter(t,root,{runner:{run:async(id,prompt,ctx)=>{runs.push(ctx);return 'Health: good';}},budget:{status:()=>({remaining:1})},reminders:{timezone:tz}});client.channels={fetch:async id=>id==='original'?thread:base};
  const job={name:'daily-brief',instructions:'Give a brief'}, context={due:new Date('2026-10-06T12:00Z'),misses:[],timezone:tz,webAllowed:false};
  assert.equal((await d.runScheduled(job,context)).threadId,'new-thread');assert.match(threads[0].name,/daily-brief.*2026-10-06/);assert.equal(runs[0].fresh,true);assert.equal(runs[0].scheduled,true);assert.equal(runs[0].webAllowed,false);
  await d.deliverReminder({id:'reminder',channel:'original',due:'2026-10-06T14:00Z',text:'stretch @everyone'},{late:true});assert.match(sent.at(-1).content,/<@owner> \(late\)/);assert.deepEqual(sent.at(-1).allowedMentions,{parse:[],users:['owner']});
  client.channels.fetch=async id=>{if(id==='deleted')throw Object.assign(new Error('gone'),{code:10003});return base;};await d.deliverReminder({id:'r2',channel:'deleted',due:'2026-10-06T14:00Z',text:'stretch'},{late:false});
  const {d:blocked,client:blockedClient}=adapter(t,root,{budget:{status:()=>({remaining:0})}});blockedClient.channels={fetch:async()=>base};await blocked.runScheduled(job,context);assert.equal(threads.length,1);assert.equal(runs.length,1);assert.match(sent.at(-1).content,/Skipping daily-brief/);
});
test('/schedule command lists next times, pause/resume and run routes to persisted scheduler', async t => {
  assert.ok(commands().find(c=>c.name==='schedule').options.some(s=>s.name==='run'));
  const root=fixture(t);schedule(root);schedule(root,'weekly-review',{cron:'0 18 * * 0'});const s=new Scheduler({root,now:()=>new Date('2026-10-06T14:00Z'),execute:async()=>({threadId:'job-thread'})});
  const {client,base}=adapter(t,root,{scheduler:s});const handle=client.listeners('interactionCreate')[0];
  let result;const interaction=action=>({user:{id:'owner'},channelId:'bit',channel:base,commandName:'schedule',isChatInputCommand:()=>true,isButton:()=>false,deferReply:async()=>{},editReply:async r=>{result=r.content;},options:{getSubcommand:()=>action,getString:()=> 'daily-brief'}});
  await handle(interaction('list'));assert.match(result,/daily-brief.*Oct 7, 2026, 8:00:00 AM EDT/);assert.match(result,/weekly-review.*Oct 11, 2026, 6:00:00 PM EDT/);
  await handle(interaction('pause'));assert.equal(s.jobState('daily-brief').paused,true);await handle(interaction('resume'));assert.equal(s.jobState('daily-brief').paused,false);await handle(interaction('run'));assert.match(result,/<#job-thread>/);
});
test('approved schedules auto-commit narrowly with add/update messages', async t => {
  const root=fixture(t);execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['config','user.name','Test'],{cwd:root});execFileSync('git',['config','user.email','test@example.com'],{cwd:root});
  fs.writeFileSync(path.join(root,'unrelated'),'keep');execFileSync('git',['add','unrelated'],{cwd:root});execFileSync('git',['commit','-qm','init'],{cwd:root});
  const growth=new Growth({root,push:false,notify:async()=>{}});t.after(()=>growth.close());const file=path.join(root,'bit/schedules/daily-brief.md');schedule(root);await growth.written(file);
  assert.equal(execFileSync('git',['log','-1','--format=%s'],{cwd:root,encoding:'utf8'}).trim(),'bIT: add schedule daily-brief');
  schedule(root,'daily-brief',{instructions:'Different brief.'});await growth.written(file);assert.equal(execFileSync('git',['log','-1','--format=%s'],{cwd:root,encoding:'utf8'}).trim(),'bIT: update schedule daily-brief');
});
test('fall-back repeated wall-clock slot never double-runs across a restart', async t => {
  const root=fixture(t);schedule(root,'fold',{cron:'30 1 * * *'});let now=new Date('2026-11-01T05:31Z'), calls=0;
  const opts={root,timezone:tz,now:()=>now,execute:async()=>{calls++;}};await new Scheduler(opts).tick();
  now=new Date('2026-11-01T06:31Z');await new Scheduler(opts).tick();assert.equal(calls,1);
});
test('reminder claim interrupted before send is recovered on startup, with the same id', async t => {
  const root=fixture(t);let now=new Date('2026-10-06T14:00Z'), contexts=[];
  const options={root,now:()=>now,deliver:async(r,c)=>{contexts.push(c);return {id:'sent'};}};
  const r=new Reminders(options), saved=r.set(r.proposal('in 1 minute','stretch'),'original');
  Object.assign(r.state.reminders[0],{status:'claimed',claimedAt:'2026-10-06T14:01:00.000Z'});r.save();now=new Date('2026-10-06T15:00Z');
  await new Reminders(options).tick({startup:true});await new Reminders(options).tick({startup:true});assert.equal(contexts.length,1);assert.equal(contexts[0].recover,true);assert.equal(contexts[0].late,true);assert.equal(new Reminders(options).state.reminders[0].id,saved.id);
});
test('Discord reconciles previously delivered reminder after a crash without a second mention', async t => {
  const root=fixture(t);let sends=0;
  const existing={id:'already-sent',author:{id:'bot'},content:'⏰ stretch\nDue: today · reminder same-id',createdTimestamp:+new Date('2026-10-06T14:01Z')};
  const target={id:'bit',messages:{fetch:async()=>new Map([[existing.id,existing]])},send:async()=>{sends++;}};
  const {d,client}=adapter(t,root);client.user={id:'bot'};client.channels={fetch:async()=>target};
  const sent=await d.deliverReminder({id:'same-id',due:'2026-10-06T14:01Z',claimedAt:'2026-10-06T14:01Z',text:'stretch'},{late:true,recover:true});assert.equal(sent.id,'already-sent');assert.equal(sends,0);
});
