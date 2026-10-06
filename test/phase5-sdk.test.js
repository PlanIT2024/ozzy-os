import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
import { ScreenGrants } from '../src/brain/screens.js';
import { encodeCapture } from '../src/node/screen/image.js';

test('real SDK sends the MCP image to a local fake API without persisting pixel files or transcripts', { timeout: 30000 }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-screen-sdk-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const area of ['memory','skills','persona','schedules'])fs.mkdirSync(path.join(root,'bit',area),{recursive:true});
  fs.writeFileSync(path.join(root,'bit/persona/persona.md'),'bIT');fs.writeFileSync(path.join(root,'bit/persona/personalities.json'),'{}');
  const capture=await encodeCapture(await sharp({create:{width:32,height:16,channels:3,background:'#37b8d5'}}).png().toBuffer());
  let imageSeen=false, calls=0;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if(req.url.includes('count_tokens')){res.setHeader('Content-Type','application/json');res.end('{"input_tokens":20}');return;}
    const imageBlock=(value)=>Array.isArray(value)?value.some(imageBlock):value && typeof value==='object'?(value.type==='image' || Object.values(value).some(imageBlock)):false;
    imageSeen ||= imageBlock(body.messages);
    const tool=body.tools?.find(tool=>tool.name==='mcp__screens__screenshot');
    const useTool=Boolean(tool && !imageSeen);
    calls++;
    const content=useTool?{type:'tool_use',id:`toolu_${calls}`,name:tool.name,input:{machine:'OZZY-AI'}}:{type:'text',text:'I see a blue rectangle.'};
    const usage={input_tokens:20,output_tokens:10};
    const message={id:`msg_${calls}`,type:'message',role:'assistant',model:body.model || 'claude-sonnet-4-6',content:[content],stop_reason:useTool?'tool_use':'end_turn',stop_sequence:null,usage};
    if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(message));return;}
    res.setHeader('Content-Type','text/event-stream');
    const event=data=>res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    event({type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:20,output_tokens:1}}});
    event({type:'content_block_start',index:0,content_block:useTool?{...content,input:{}}:{type:'text',text:''}});
    event({type:'content_block_delta',index:0,delta:useTool?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}});
    event({type:'content_block_stop',index:0});event({type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}});event({type:'message_stop'});res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const screens=new ScreenGrants({root});screens.on('thread','OZZY-AI');
  const runner=new Runner({root,screens,budget:new Budget({file:path.join(root,'data/budget.json'),cap:1}),hub:{list:()=>[{machine:'OZZY-AI',online:true,capabilities:['status','screen']}],request:async()=>capture},
    queryFn: args=>query({...args,options:{...args.options,model:'claude-sonnet-4-6',maxTurns:4,env:{...args.options.env,HOME:root,ANTHROPIC_API_KEY:'test-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}})});
  t.after(()=>runner.close());const timeout=setTimeout(()=>runner.close(),25000);
  try{assert.match(await runner.run('thread','Use screenshot for OZZY-AI once and describe it.',{notify:async()=>{}}),/blue rectangle/);}finally{clearTimeout(timeout);}
  assert.ok(imageSeen,'real SDK must pass image content to the local API');assert.equal(screens.status().captures,1);
  const scan=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())scan(file);else{const bytes=fs.readFileSync(file);assert.ok(!bytes.toString().includes(capture.data),`pixels leaked into ${file}`);assert.ok(!/\.(?:png|jpe?g|webp)$/i.test(file));assert.ok(!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')));assert.ok(!(bytes[0]===255 && bytes[1]===216));}}};scan(root);
  assert.equal(runner.sessions.thread,undefined);
});
