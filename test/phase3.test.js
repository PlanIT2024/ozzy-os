import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { publicURL, WebLedger } from '../src/brain/web.js';
import { createPermissions } from '../src/brain/permissions.js';
import { retryNetwork, retryDelay } from '../src/networkRetry.js';
import { createDiscord, sendText } from '../src/brain/discord.js';
import { Events } from 'discord.js';
const resolve = async () => [{ address:'93.184.216.34' }];
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-web-')); fs.mkdirSync(path.join(root,'bit/memory'),{recursive:true}); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
test('URL policy blocks schemes, IP literals and every non-public DNS answer', async () => {
  for(const url of ['file:///etc/passwd','http://127.0.0.1','http://localhost','http://[::1]','http://2130706433']) await assert.rejects(publicURL(url,resolve));
  for(const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.1.1','100.64.1.1','0.0.0.0','198.18.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) await assert.rejects(publicURL('https://example.com',async()=>[{address}]));
  await assert.rejects(publicURL('https://example.com',async()=>[{address:'93.184.216.34'},{address:'10.0.0.1'}]));
  assert.equal(await publicURL('https://example.com',resolve),'https://example.com');
});
test('taint persists, owner/search provenance allows fetches, other full URLs need approval, caps deny', async t => {
  const root=fixture(t), web=new WebLedger({root,dailySearchCap:1,dailyFetchCap:3}); const notices=[], reviews=[];
  let accept=false;
  const p=createPermissions({root,web,sessionKey:'s',resolve,notify:async x=>notices.push(x),approve:async x=>{reviews.push(x);return accept;}});
  const pre=async(name,input,id)=>p.hooks.PreToolUse[0].hooks[0]({tool_name:name,tool_input:input},id,{});
  const post=async(name,input,output)=>p.hooks.PostToolUse[0].hooks[0]({tool_name:name,tool_input:input,tool_response:output});
  assert.equal((await pre('Write',{file_path:'bit/memory/a.md',content:'a'})).hookSpecificOutput.permissionDecision,'allow');
  fs.writeFileSync(path.join(root,'bit/memory/a.md'),'a'); await post('Write',{file_path:'bit/memory/a.md'}); assert.equal(notices.length,1); assert.equal(reviews.length,0);
  web.owner('s','read https://example.com/a?secret=visible');
  assert.equal((await pre('WebFetch',{url:'https://example.com/a?secret=visible',prompt:'read'},'f')).hookSpecificOutput.permissionDecision,'allow');
  await post('WebFetch',{url:'https://example.com/a?secret=visible'},{result:'untrusted',url:'https://example.com/a?secret=visible'});
  assert.equal(new WebLedger({root}).session('s').tainted,true);
  assert.equal((await pre('Write',{file_path:'bit/memory/a.md',content:'approved in chat'})).hookSpecificOutput.permissionDecision,'deny'); assert.match(reviews.at(-1).diff,/\+approved in chat/);
  accept=true; assert.equal((await pre('Edit',{file_path:'bit/memory/a.md',old_string:'a',new_string:'b'})).hookSpecificOutput.permissionDecision,'allow');
  assert.equal((await pre('Write',{file_path:'bit/memory/a.md',content:'b'})).hookSpecificOutput.permissionDecision,'allow');
  const url='https://example.com/model?private=full'; assert.equal((await pre('WebFetch',{url,prompt:'read'})).hookSpecificOutput.permissionDecision,'allow'); assert.equal(reviews.at(-1).url,url);
  assert.equal((await pre('WebSearch',{query:'test'})).hookSpecificOutput.permissionDecision,'allow');
  await post('WebSearch',{query:'test'},{results:[{content:[{url:'https://example.com/hit'}]},'https://example.com/commentary']});
  assert.ok(web.session('s').urls.includes('https://example.com/hit')); assert.ok(!web.session('s').urls.includes('https://example.com/commentary'));
  assert.equal((await pre('WebSearch',{query:'over cap'})).hookSpecificOutput.permissionDecision,'deny');
  assert.equal(web.status().monthly.search,1);
  await pre('WebFetch',{url:'https://example.com/hit',prompt:'read'});
  assert.equal((await pre('WebFetch',{url:'https://example.com/hit',prompt:'read'})).hookSpecificOutput.permissionDecision,'deny');
  assert.match(fs.readFileSync(path.join(root,'data/audit.log'),'utf8'),/"tainted":true/);
});
test('DNS startup failure retries then connects; auth errors reject; backoff capped', async () => {
  let n=0;const waits=[];await retryNetwork(async()=>{if(++n<3) throw Object.assign(new Error('dns'),{code:'EAI_AGAIN'});},{sleep:async ms=>waits.push(ms),log:()=>{}}); assert.equal(n,3);assert.equal(waits.length,2);
  await assert.rejects(retryNetwork(async()=>{throw new Error('Invalid token');},{log:()=>{}}),/Invalid token/); assert.equal(retryDelay(100),60000);
});
test('Discord startup simulated DNS failure then successful login; replies suppress embeds', async t => {
  const root=fixture(t), client=new EventEmitter();let attempts=0;client.destroy=()=>{};client.login=async()=>{ if(++attempts===1) throw Object.assign(new Error('simulated DNS outage'),{code:'EAI_AGAIN'}); client.emit(Events.ClientReady,{user:{tag:'proof'}}); };
  const d=createDiscord({client,env:{},runner:{},hub:{},budget:{},auditFile:path.join(root,'data/audit.log')});t.after(()=>d.close()); await d.start();assert.equal(attempts,2);
  let sent;await sendText({send:async value=>{sent=value;}},'https://example.com');assert.ok(sent.flags);
});
test('search surcharge fallback avoids double charging SDK-reported searches', t => {
  const web=new WebLedger({root:fixture(t)}); web.reserve('WebSearch'); assert.equal(web.status().estimatedSearchUSD,.01);
  web.reportedCost('s',{model:{webSearchRequests:1}});assert.equal(web.status().estimatedSearchUSD,0);
  web.reportedCost('s',{model:{webSearchRequests:1}});assert.equal(web.status().sdkSearches,1);
  web.reserve('WebSearch');assert.equal(web.status().estimatedSearchUSD,.01);
});
