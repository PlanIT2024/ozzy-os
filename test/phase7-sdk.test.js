import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
import { encodeCapture } from '../src/node/screen/image.js';

test('real SDK autonomous task approves once, executes scoped tools, streams progress and never persists pixels or plan text',{timeout:90000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-task-sdk-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const area of ['memory','skills','persona','schedules'])fs.mkdirSync(path.join(root,'bit',area),{recursive:true});fs.writeFileSync(path.join(root,'bit/persona/persona.md'),'bIT');fs.writeFileSync(path.join(root,'bit/persona/personalities.json'),'{}');
 const frame=await encodeCapture(await sharp({create:{width:32,height:16,channels:3,background:'#ff33dd'}}).png().toBuffer());
 const app={id:'obsidian.desktop',name:'Obsidian',focusNames:['obsidian'],fingerprint:'a'.repeat(64)},plan={goal:'Run the fixture',allowed_apps:[app.id],texts:['plan-text-private-marker'],allowed_actions:['screenshot','type']};
 let requests=0,imageSeen=false,approvals=0,actions=0,progress=0;const hub=new EventEmitter();let task;
 hub.list=()=>[{machine:'OZZY-AI',online:true,capabilities:['status','screen','input']}];
 hub.request=async(machine,method,input)=>{
  if(method==='input_task_prepare')return {proposalId:'prepared',plan,apps:[app],browser:false};
  if(method==='input_task_start'){task=input;return {taskId:input.taskId,expiresAt:new Date(Date.now()+600000).toISOString()};}
  if(method==='input_task_action'){
   assert.ok(task);actions++;hub.emit('control_task_progress',{machine,taskId:task.taskId,grantId:task.grantId,steps:actions,phase:'running',action:input.action,app:'obsidian',willCapture:true});hub.emit('control_task_progress',{machine,taskId:task.taskId,grantId:task.grantId,steps:actions,phase:'verified',action:input.action,app:'obsidian',capture:{capturedAt:frame.capturedAt,original:frame.original,scaled:frame.scaled}});
   return {frame,focus:{focused:{app:'obsidian',window:'Note',pid:1,windowId:2}},steps:actions};
  }return {started:true};
 };
 const uses=[['mcp__computer__propose_task',{machine:'OZZY-AI',...plan}],['mcp__computer__computer',{machine:'OZZY-AI',action:'screenshot',target:'Inspect'}],['mcp__computer__computer',{machine:'OZZY-AI',action:'type',expected_app:'obsidian',text:plan.texts[0],target:'Fixture note'}],['mcp__computer__finish_task',{machine:'OZZY-AI'}]];
 const server=http.createServer(async(req,res)=>{
  const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts).toString()||'{}');if(req.url.includes('count_tokens')){res.end('{"input_tokens":20}');return;}
  const containsImage=value=>Array.isArray(value)?value.some(containsImage):value&&typeof value==='object'?(value.type==='image'||Object.values(value).some(containsImage)):false;imageSeen ||= containsImage(body.messages);
  if(!Array.isArray(body.tools)){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'warmup',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'Ready.'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));return;}
  const next=uses[requests++],content=next?{type:'tool_use',id:'toolu_'+requests,name:next[0],input:next[1]}:{type:'text',text:'Task completed.'};
  if(next)assert.ok(body.tools.some(tool=>tool.name===next[0]),'SDK exposes the task tool');
  const usage={input_tokens:20,output_tokens:10},message={id:'msg_'+requests,type:'message',role:'assistant',model:body.model,content:[content],stop_reason:next?'tool_use':'end_turn',stop_sequence:null,usage};
  if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(message));return;}
  res.setHeader('Content-Type','text/event-stream');const send=data=>res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:20,output_tokens:1}}});send({type:'content_block_start',index:0,content_block:next?{...content,input:{}}:{type:'text',text:''}});send({type:'content_block_delta',index:0,delta:next?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}});send({type:'content_block_stop',index:0});send({type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}});send({type:'message_stop'});res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const runner=new Runner({root,hub,budget:new Budget({file:path.join(root,'data/budget.json'),cap:1}),queryFn:args=>query({...args,options:{...args.options,model:'claude-sonnet-4-6',maxTurns:8,env:{...args.options.env,HOME:root,ANTHROPIC_API_KEY:'test-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}})});t.after(()=>runner.close());
 await runner.controls.on('thread','OZZY-AI',{withScreen:true,mode:'task'});
 const result=await runner.run('thread','Perform the approved fixture task.',{notify:async()=>{},approve:async()=>{approvals++;return true;},startProgress:async()=>({update:async()=>progress++,finish:async()=>{}})});
 assert.match(result,/Task completed/);assert.equal(approvals,1);assert.equal(actions,2);assert.ok(imageSeen);assert.equal(progress,4);assert.equal(runner.screens.status().captures,2);assert.equal(runner.controls.tasks.live.size,0);
 const scan=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);if(entry.isDirectory())scan(file);else{const data=fs.readFileSync(file,'utf8');assert.ok(!data.includes(frame.data),file);assert.ok(!data.includes(plan.texts[0]),file);assert.ok(!/\.(png|jpe?g|webp)$/i.test(file));}}};scan(root);
});
