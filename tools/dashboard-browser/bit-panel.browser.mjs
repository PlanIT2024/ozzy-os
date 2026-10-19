// npm run test:browser (install browsers once: npx playwright install chromium webkit)
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

let server, base;
const browsers = [];
const measurements = [];
before(async () => {
 server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0'], { cwd: fileURLToPath(new URL('../../apps/dashboard/', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
 let output = '';
 base = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(Error('Vite startup timeout: ' + output)), 15000);
  server.stdout.on('data', bytes => { output += bytes; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
  server.stderr.on('data', bytes => { output += bytes; });
  server.once('error', error => { clearTimeout(timeout); reject(error); });
  server.once('exit', code => { clearTimeout(timeout); reject(Error('Vite exited: ' + code + ' ' + output)); });
 });
 for (const [name, engine] of (process.env.BIT_PANEL_WEBKIT === '1' ? [['chromium', chromium], ['webkit', webkit]] : [['chromium', chromium]])) browsers.push({ name, browser: await engine.launch({ headless: true, ...(name === 'webkit' && process.env.BIT_PANEL_WEBKIT_EXECUTABLE ? { executablePath: process.env.BIT_PANEL_WEBKIT_EXECUTABLE } : {}) }) });
});
after(async () => {
 await Promise.all(browsers.map(({ browser }) => browser.close()));
 if (process.env.BIT_PANEL_PROOF_DIR) writeFileSync(`${process.env.BIT_PANEL_PROOF_DIR}/bounds.json`, JSON.stringify(measurements, null, 2) + '\n');
 if (server && server.exitCode === null) { const stopped = once(server, 'exit'); server.kill(); await stopped; }
});

async function ready(browser, width, height) {
 const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 640, hasTouch: width < 640 });
 // Run the actual component with deterministic content, without hosted credentials.
 await page.route('**/src/client.ts', route => route.fulfill({ contentType: 'application/javascript', body: `const presence={state:'idle',mood:'chill',reaction:null,node:null,lease:null,watching:[],attention:'ambient',updatedAt:new Date().toISOString()}; export const supabase={from:()=>({select(){return this},eq(){return this},async maybeSingle(){return {data:{presence},error:null}}}),channel:()=>({on(){return this},subscribe(){return this}}),removeChannel:async()=>{}};` }));
 await page.goto(base + '/scripts/fixtures/bit-panel.html');
 await page.getByRole('button', { name: 'Show bIT presence' }).waitFor();
 return page;
}
async function inside(page) {
 await page.waitForFunction(() => {
  const panel = document.querySelector('.bit-panel'); if (!panel?.open) return false;
  const r = panel.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
 }).catch(async error=>{const geometry=await page.evaluate(()=>({viewport:[innerWidth,innerHeight],panel:document.querySelector('.bit-panel')?.getBoundingClientRect().toJSON(),open:document.querySelector('.bit-panel')?.open}));throw new Error(error.message+' '+JSON.stringify(geometry));});
 const box = await page.getByRole('dialog').boundingBox(), viewport = page.viewportSize();
 assert.ok(box.x >= -0.5 && box.y >= -0.5);
 assert.ok(box.x + box.width <= viewport.width + 0.5);
 assert.ok(box.y + box.height <= viewport.height + 0.5);
 const content = await page.locator('.bit-panel-chat .chat-messages, .bit-panel:not(.bit-panel-chat) .bit-panel-body').evaluate(el => ({ box: el.getBoundingClientRect().toJSON(), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
 assert.ok(content.box.width > 100 && content.box.height > 50, 'content has a usable visible area');
 assert.ok(content.box.x >= box.x && content.box.y >= box.y);
 assert.ok(content.scrollHeight > content.clientHeight, 'long content scrolls inside the shell');
 return box;
}

for (const width of [320, 390, 768, 1280]) test(`panel bounds, scrolling and dismissal at ${width}px (configured browsers)`, async () => {
 for (const { name, browser } of browsers) {
  const page = await ready(browser, width, width === 320 ? 568 : 844);
  try {
   const errors = []; page.on('pageerror', error => errors.push(error.message));
   const trigger = page.getByRole('button', { name: 'Show bIT presence' });
   await trigger.click(); const bounds = await inside(page);
   measurements.push({ browser: name, viewport: page.viewportSize(), panel: bounds });
   assert.equal(await page.getByRole('button', { name: 'Close bIT panel' }).evaluate(el => el === document.activeElement), true, name + ': focus enters panel');
   assert.equal(await page.locator('.bit-panel-header bit-orb').count(), 1);
   if (width < 640) {
    assert.equal(await page.evaluate(() => document.body.style.position), 'fixed');
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
    const height = await page.getByRole('dialog').evaluate(el => el.getBoundingClientRect().height);
    assert.equal(Math.round(height), page.viewportSize().height);
    const scrollBefore = await page.evaluate(() => scrollY);
    if(name === 'chromium') await page.mouse.wheel(0, 800);
    await page.evaluate(() => scrollBy(0, 800));
    assert.equal(await page.evaluate(() => scrollY), scrollBefore, 'background cannot scroll');
   }
   await page.locator('.bit-panel-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
   await page.waitForFunction(() => { const el = document.querySelector('.bit-panel-body'); return el.scrollTop + el.clientHeight >= el.scrollHeight - 1; });
   await page.getByRole('dialog').getByText('Approval 80: visible scrolling content', { exact: true }).scrollIntoViewIfNeeded();
   const last = await page.getByRole('dialog').getByText('Approval 80: visible scrolling content', { exact: true }).boundingBox();
   const box = await page.getByRole('dialog').boundingBox();
   assert.ok(last.y >= box.y && last.y + last.height <= box.y + box.height, 'last content is visible after scrolling');
   if (process.env.BIT_PANEL_PROOF_DIR) await page.screenshot({ path: `${process.env.BIT_PANEL_PROOF_DIR}/after-${name}-${width}.png` });
   await page.getByRole('button', { name: 'Close bIT panel' }).click();
   await page.getByRole('dialog').waitFor({ state: 'detached' });
   assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'close restores trigger focus');
   assert.equal(await page.evaluate(() => document.body.style.position), '');
   assert.equal(await page.evaluate(() => document.body.style.overflow), '');
   await trigger.click(); await inside(page); await page.keyboard.press('Escape');
   await page.getByRole('dialog').waitFor({ state: 'detached' });
   assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'Escape restores focus');
   if (width >= 640) {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
     await page.locator('.bit-presence').evaluate((el, corner) => { Object.assign(el.style, { position: 'fixed', top: corner.startsWith('top') ? '2px' : 'auto', bottom: corner.startsWith('bottom') ? '2px' : 'auto', left: corner.endsWith('left') ? '2px' : 'auto', right: corner.endsWith('right') ? '2px' : 'auto', zIndex: '10' }); }, corner);
     await trigger.click(); await inside(page);
     await page.mouse.click(5, 5);
     await page.getByRole('dialog').waitFor({ state: 'detached' });
     assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'outside click restores focus');
    }
   }
   assert.deepEqual(errors, [], name + ': no browser errors');
  } finally { await page.close(); }
 }
});

test('open panel responds to resizing and restores a scrolled mobile page', async () => {
 for (const { browser } of browsers) {
  const page = await ready(browser, 1280, 844);
  try {
   const trigger = page.getByRole('button', { name: 'Show bIT presence' });
   await trigger.click(); await inside(page);
   for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 768, height: 600 }, { width: 1280, height: 400 }]) { await page.setViewportSize(viewport); await inside(page); }
   await page.keyboard.press('Escape');
   await page.setViewportSize({ width: 390, height: 844 });
   await page.evaluate(() => { document.body.style.overflow = 'auto'; scrollTo(0, 500); });
   const before = await page.evaluate(() => scrollY);
   // Open without scrolling the trigger into view, to verify scroll restoration.
   await trigger.evaluate(el => el.click()); await inside(page);
   await page.keyboard.press('Tab');
   assert.equal(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement)), true, 'focus stays in modal');
   await page.keyboard.press('Escape');
   assert.equal(await page.evaluate(() => scrollY), before);
   assert.equal(await page.evaluate(() => document.body.style.overflow), 'auto', 'pre-existing styles restored');
  } finally { await page.close(); }
 }
});

for (const status of ['approved','denied']) test(`panel and Approvals share ${status} decisions and command confirmation`, async()=>{
 for(const {browser} of browsers) for(const surface of ['panel','section']) {
  const page=await ready(browser,390,844);
  try {
   await page.evaluate(()=>window.qa.command());
   if(surface==='panel')await page.getByRole('button',{name:'Show bIT presence'}).click();
   const scope=surface==='panel'?page.getByRole('dialog'):page.locator('main .approvals');
   const card=scope.locator('[data-approval-id="0"]');
   await card.getByRole('button',{name:status==='approved'?'Approve':'Deny',exact:true}).click();
   if(status==='approved') {
    assert.deepEqual(await page.evaluate(()=>window.decisions),[], 'first command click only arms');
    await card.getByRole('button',{name:'Approve command?',exact:true}).click();
   }
   await page.waitForFunction(()=>window.decisions.length===1);
   assert.deepEqual(await page.evaluate(()=>window.decisions),[{id:'0',status}]);
   assert.equal(await card.getByRole('button',{name:/^(Approve|Deny)$/}).count(),0);
   assert.ok(await card.getByText(status==='approved'?'Approved':'Denied',{exact:true}).count());
   if(surface==='panel'){
    await page.evaluate(()=>window.qa.advance(3000));
    await card.waitFor({state:'detached'});
    assert.equal(await page.locator('.orb-badge').count(),0);
    assert.equal(await page.locator('.orb-button bit-orb').evaluate(el=>el.presence.state),'idle');
   }
  } finally {await page.close();}
 }
});
test('panel orders urgency, shows run details, and removes remotely decided and expired cards',async()=>{
 for(const {browser} of browsers){
  const page=await ready(browser,320,568);
  try{
   await page.getByRole('button',{name:'Show bIT presence'}).click();
   const panel=page.getByRole('dialog');
   assert.equal(await panel.locator('.approval-card').first().getAttribute('data-approval-id'),'0');
   assert.ok(await panel.getByText('Folder: ozzy-os · Lease: 20 min',{exact:true}).count());
   assert.equal(await page.locator('.orb-badge').innerText(),'80');
   assert.equal(await page.locator('.orb-button bit-orb').evaluate(el=>el.presence.state),'approve');
   await page.evaluate(()=>window.qa.remote('0','denied'));
   const first=panel.locator('[data-approval-id="0"]');
   await first.getByText('Denied',{exact:true}).waitFor();
   assert.equal(await page.locator('.orb-badge').innerText(),'79');
   await page.evaluate(()=>window.qa.advance(3000));await first.waitFor({state:'detached'});
   await page.evaluate(()=>window.qa.remove('1'));
   const remote=panel.locator('[data-approval-id="1"]');await remote.getByText('Decided elsewhere',{exact:true}).waitFor();
   await page.evaluate(()=>window.qa.advance(6000));await remote.waitFor({state:'detached'});
   await page.evaluate(()=>window.qa.advance(4000000));
   await panel.getByText('Expired',{exact:true}).first().waitFor();
   assert.equal(await page.locator('.orb-badge').count(),0);
   assert.equal(await panel.getByRole('button',{name:'Approve',exact:true}).count(),0);
   await page.evaluate(()=>window.qa.advance(4003000));
   await page.waitForFunction(()=>document.querySelectorAll('.bit-panel .approval-card').length===0);
  }finally{await page.close();}
 }
});

test('approval preview expands and active activity uses live-log and stop callbacks',async()=>{
 for(const {browser} of browsers){
  const page=await ready(browser,390,844);
  try{
   await page.evaluate(()=>window.qa.longPrompt());
   const trigger=page.getByRole('button',{name:'Show bIT presence'});await trigger.click();
   const panel=page.getByRole('dialog'), card=panel.locator('[data-approval-id="0"]');
   await card.getByText('60:00 left',{exact:true}).waitFor();
   const preview=card.locator('.approval-preview');const before=await preview.evaluate(el=>el.clientHeight);
   await card.getByRole('button',{name:'Show more',exact:true}).click();
   assert.ok(await card.locator('.approval-detail .plain').evaluate(el=>el.clientHeight)>before);
   await card.getByText('last prompt line',{exact:false}).waitFor();
   await card.getByRole('button',{name:'Show less',exact:true}).click();
   assert.ok(await preview.count());
   const activity=panel.getByRole('region',{name:'Current activity'});
   await activity.getByText('QA task title',{exact:true}).waitFor();
   await activity.getByText('MacBook · running 0:00',{exact:true}).waitFor();
   assert.equal(await panel.getByText('No machines being watched',{exact:true}).count(),0);
   await activity.getByRole('button',{name:'Stop',exact:true}).click();
   await activity.getByRole('button',{name:'Stopping…',exact:true}).waitFor();
   assert.deepEqual(await page.evaluate(()=>window.stops),['run']);
   assert.equal(await activity.getByRole('button',{name:'Stopping…',exact:true}).isDisabled(),true);
   await activity.getByRole('link',{name:'View live log'}).click();
   await panel.waitFor({state:'detached'});
   assert.equal(await page.evaluate(()=>window.viewedTask),'task');
  }finally{await page.close();}
 }
});

async function chatReady(browser,width,keyboard=false) {
 const page=await browser.newPage({viewport:{width,height:width===320?568:844},isMobile:width<640,hasTouch:width<640});
 if(keyboard)await page.addInitScript(()=>{
  const viewport=new EventTarget();let height=innerHeight,top=0;
  Object.defineProperties(viewport,{height:{get:()=>height},width:{get:()=>innerWidth},offsetTop:{get:()=>top},offsetLeft:{get:()=>0}});
  Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
  window.setKeyboardViewport=(nextHeight,nextTop=0)=>{height=nextHeight;top=nextTop;viewport.dispatchEvent(new Event('resize'));viewport.dispatchEvent(new Event('scroll'));};
 });
 await page.route('**/src/client.ts',route=>route.fulfill({contentType:'application/javascript',body:readFileSync(new URL('./chat-client.fixture.mjs',import.meta.url),'utf8')}));
 await page.goto(base+'/scripts/fixtures/bit-panel.html?chat=1');
 await page.getByRole('button',{name:'Show bIT presence'}).click();await inside(page);
 await page.getByRole('region',{name:'Chat with bIT'}).locator('.chat-message').getByText('I made a task. This action needs your decision.',{exact:true}).waitFor();
 return page;
}
for(const width of [320,390,768,1280])test(`chat sheet viewport and shared cards at ${width}`,async()=>{
 for(const {browser} of browsers){const page=await chatReady(browser,width);try{
  const panel=page.getByRole('dialog'),chat=panel.getByRole('region',{name:'Chat with bIT'});
  const box=await panel.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+.5&&box.y+box.height<=page.viewportSize().height+.5);
  if(process.env.BIT_PANEL_PROOF_DIR){await chat.getByRole('textbox',{name:'Message bIT'}).scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.BIT_PANEL_PROOF_DIR}/chat-${browsers.find(item=>item.browser===browser).name}-${width}.png`});}
  const card=chat.locator('[data-approval-id="chat-approval"]');await card.getByRole('button',{name:'Approve',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.decisions),[]);
  await card.getByRole('button',{name:'Approve command?',exact:true}).click();await card.getByText('Approved',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.decisions),[{id:'chat-approval',status:'approved'}]);
  await chat.getByRole('button',{name:'Undo',exact:true}).click();await chat.getByText('Undone',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.chatDB.tables.tasks[0].status),'cancelled');
  const input=chat.getByRole('textbox',{name:'Message bIT'});await input.fill('First line');await input.press('Shift+Enter');await input.type('Second line');assert.equal(await input.inputValue(),'First line\nSecond line');await input.press('Enter');
  await page.waitForFunction(()=>window.chatDB.tables.chat_messages.some(m=>m.author==='owner'));
  const owner=await page.evaluate(()=>window.chatDB.tables.chat_messages.find(m=>m.author==='owner'));assert.equal(owner.body,'First line\nSecond line');assert.equal(owner.cards,null);assert.equal(owner.owner_id,'owner');assert.equal(await input.inputValue(),'');
  await chat.getByRole('button',{name:'New chat',exact:true}).click();await page.waitForFunction(()=>window.chatDB.tables.conversations.length===2);assert.ok(await chat.getByRole('status').count());
  assert.equal(await page.evaluate(()=>window.chatDB.writes.some(w=>w.table==='approvals')),false,'decisions use shared fixture callback, no new chat write path');
 }finally{await page.close();}}
});
test('task card opens the existing board task and remote expiry updates approval in chat',async()=>{
 for(const {browser} of browsers){const page=await chatReady(browser,390);try{
  const chat=page.getByRole('region',{name:'Chat with bIT'});await page.evaluate(()=>{window.chatDB.tables.approvals[0].expires_at=new Date(0).toISOString();window.chatDB.notify();});await chat.locator('[data-approval-id="chat-approval"]').getByText('Expired',{exact:true}).waitFor();
  await chat.getByRole('link',{name:'Open task on board'}).click();await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.viewedBoard),'chat-task');
 }finally{await page.close();}}
});

test('update Undo reverts previous fields and null started_at omits running time',async()=>{
 for(const {browser} of browsers){const page=await chatReady(browser,390);try{
  await page.evaluate(()=>{const db=window.chatDB;db.tables.tasks[0].title='Changed title';const card=db.tables.chat_messages[0].cards[0];card.created=false;card.before={title:'Original title'};card.changed={title:'Changed title'};db.notify();});
  const chat=page.getByRole('region',{name:'Chat with bIT'});await chat.getByRole('button',{name:'Undo',exact:true}).click();await chat.getByText('Undone',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.chatDB.tables.tasks[0].title),'Original title');
  await page.evaluate(()=>window.qa.noStart());const activity=page.getByRole('region',{name:'Current activity'});await activity.getByText('MacBook',{exact:true}).waitFor();assert.equal(await activity.getByText(/running [0-9]/).count(),0);
 }finally{await page.close();}}
});

test('completed replies are announced after realtime streaming updates',async()=>{
 for(const {browser} of browsers){const page=await chatReady(browser,390);try{
  await page.evaluate(()=>{const db=window.chatDB;db.tables.chat_messages.push({id:'live-reply',created_at:new Date(Date.now()+1000).toISOString(),conversation_id:'conversation',workspace_id:'ws',owner_id:'owner',author:'bit',body:'Streaming text',status:'streaming',cards:null});db.notify();});
  const chat=page.getByRole('region',{name:'Chat with bIT'});await chat.locator('.chat-message').getByText('Streaming text',{exact:true}).waitFor();assert.equal(await chat.locator('.sr-only').innerText(),'I made a task. This action needs your decision.');
  await page.evaluate(()=>{const db=window.chatDB;Object.assign(db.tables.chat_messages.at(-1),{body:'New completed reply',status:'done'});db.notify();});await page.waitForFunction(()=>document.querySelector('.dashboard-chat .sr-only')?.textContent==='New completed reply');
 }finally{await page.close();}}
});

test('390x844 keyboard and Safari toolbar viewport keep header and Send pinned',async()=>{
 for(const {name,browser} of browsers){const page=await chatReady(browser,390,true);try{
  const chat=page.getByRole('region',{name:'Chat with bIT'}),input=chat.getByRole('textbox',{name:'Message bIT'}),send=chat.getByRole('button',{name:'Send',exact:true});
  await input.fill('Keyboard layout proof');
  for(const [height,top] of [[480,0],[420,32]]){
   await page.evaluate(([h,y])=>window.setKeyboardViewport(h,y),[height,top]);
   await page.waitForFunction(([h,y])=>{const r=document.querySelector('.bit-panel').getBoundingClientRect();return Math.abs(r.height-h)<1&&Math.abs(r.top-y)<1;},[height,top]);
   measurements.push({browser:name,viewport:page.viewportSize(),visualViewport:{height,top},panel:await page.getByRole('dialog').boundingBox()});
   const header=await page.locator('.bit-panel-header').boundingBox(),composer=await page.locator('.chat-composer').boundingBox(),button=await send.boundingBox();
   assert.ok(header.y>=top && header.y+header.height<top+height,'header stays in visible viewport');
   assert.ok(button.y>=header.y+header.height&&button.y+button.height<=top+height,'Send is above keyboard/toolbar');
   const list=page.locator('.chat-messages');
   assert.ok(await list.evaluate(el=>el.scrollHeight>el.clientHeight),'messages scroll with keyboard open');
   for(const fraction of [0,1]){
    await list.evaluate((el,fraction)=>{el.scrollTop=fraction*el.scrollHeight;},fraction);
    assert.deepEqual(await page.locator('.bit-panel-header').boundingBox(),header,'scrolling does not move header');
    assert.deepEqual(await page.locator('.chat-composer').boundingBox(),composer,'scrolling does not move composer');
   }
   assert.equal(await page.locator('.bit-panel-body').evaluate(el=>el.scrollHeight>el.clientHeight),false,'no nested body scrolling');
  }
  if(process.env.BIT_PANEL_PROOF_DIR)await page.screenshot({path:`${process.env.BIT_PANEL_PROOF_DIR}/keyboard-${name}-390.png`});
  await send.click();await page.waitForFunction(()=>window.chatDB.tables.chat_messages.some(m=>m.body==='Keyboard layout proof'));
  await page.evaluate(()=>window.setKeyboardViewport(844,0));
  await page.waitForFunction(()=>Math.abs(document.querySelector('.bit-panel').getBoundingClientRect().height-844)<1);
 }finally{await page.close();}}
});
test('opens latest chat, renames any selected conversation, and retains selection on realtime',async()=>{
 for(const {browser} of browsers){const page=await chatReady(browser,390);try{
  const chat=page.getByRole('region',{name:'Chat with bIT'}),select=chat.getByRole('combobox',{name:'Recent conversations'});
  assert.equal(await select.inputValue(),'conversation');
  assert.equal(await chat.getByRole('button',{name:'New chat',exact:true}).count(),1);
  await page.evaluate(()=>{const db=window.chatDB;db.tables.conversations.push({id:'older',workspace_id:'ws',owner_id:'owner',title:'Older chat',title_set_by_owner:false,updated_at:'2000-01-01T00:00:00Z'});db.notify();});
  await select.selectOption('older');await chat.getByRole('button',{name:'Rename conversation'}).click();
  const title=chat.getByRole('textbox',{name:'Conversation title'});assert.equal(await title.inputValue(),'Older chat');assert.equal(await title.getAttribute('maxlength'),'80');
  await title.fill('My manual name');await chat.getByRole('button',{name:'Save title'}).click();
  await page.waitForFunction(()=>window.chatDB.tables.conversations.find(c=>c.id==='older').title_set_by_owner===true);
  assert.equal(await select.inputValue(),'older');assert.equal(await select.locator('option:checked').innerText(),'My manual name');
  const write=await page.evaluate(()=>window.chatDB.writes.find(w=>w.table==='conversations'&&w.operation==='update'));
  assert.deepEqual(write.payload,{title:'My manual name',title_set_by_owner:true});
  await page.evaluate(()=>{window.chatDB.tables.conversations[0].updated_at=new Date(Date.now()+60000).toISOString();window.chatDB.notify();});
  assert.equal(await select.inputValue(),'older','realtime does not switch an active selection');
  await page.getByRole('button',{name:'Close bIT panel'}).click();await page.getByRole('button',{name:'Show bIT presence'}).click();
  await page.waitForFunction(()=>document.querySelector('.dashboard-chat select')?.value==='conversation');
 }finally{await page.close();}}
});
test('markdown uses safe markup and streaming has no thinking placeholder',async()=>{
 for(const {browser} of browsers){const page=await chatReady(browser,390);try{
  const chat=page.getByRole('region',{name:'Chat with bIT'});
  await page.evaluate(()=>{const db=window.chatDB;Object.assign(db.tables.chat_messages[0],{body:'**Bold** *italic* `inline`\n\n- first\n- second\n\n[link](https://example.com)\n\n```js\nconst n = 1;\n```\n\n<img src=x onerror="window.pwned=1">\n\n[bad](javascript:alert%281%29)',cards:null});db.notify();});
  const markdown=chat.locator('.message-markdown');await markdown.locator('strong').filter({hasText:'Bold'}).waitFor();
  assert.equal(await markdown.locator('em').innerText(),'italic');assert.equal(await markdown.locator('ul li').count(),2);assert.equal(await markdown.locator('pre code').count(),1);
  assert.equal(await markdown.getByRole('link',{name:'link',exact:true}).getAttribute('target'),'_blank');assert.equal(await markdown.getByRole('link',{name:'link',exact:true}).getAttribute('rel'),'noopener noreferrer');
  assert.equal(await markdown.locator('img,script,iframe,[onerror],a[href^="javascript:"]').count(),0);assert.equal(await page.evaluate(()=>window.pwned),undefined);
  await page.evaluate(()=>{const db=window.chatDB;db.tables.chat_messages[0].body='';db.tables.chat_messages[0].status='streaming';db.tables.approvals=[];db.notify();window.qa.idle();});
  await page.waitForFunction(()=>document.querySelector('.message-markdown')?.textContent==='');
  assert.equal(await chat.getByText('bIT is thinking…',{exact:true}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Current activity'}).count(),0,'idle activity hidden');
  assert.equal(await page.getByRole('heading',{name:'Chat with bIT',exact:true}).count(),1);
 }finally{await page.close();}}
});
test('access card duration, kind-based control confirmation and Stop use owner decision columns',async()=>{
 for(const {browser}of browsers){const page=await chatReady(browser,390);try{
  await page.evaluate(()=>{window.qa.remotePolicy();const db=window.chatDB;db.tables.access_requests.push({id:'access-test',node_id:'mac',conversation_id:'conversation',workspace_id:'ws',owner_id:'owner',kind:'control',reason:'Open an editor and type hello. Each step needs approval.',requested_minutes:8,expires_at:new Date(Date.now()+60000).toISOString(),status:'pending'});db.notify();});
  const card=page.locator('[data-approval-id="access-test"]');await card.getByRole('heading',{name:'control access'}).waitFor();const picker=card.getByRole('combobox',{name:'Grant duration'});assert.equal(await picker.locator('option').count(),3);await picker.selectOption('2');
  await card.getByRole('button',{name:'Approve',exact:true}).click();assert.equal(await page.evaluate(()=>window.chatDB.writes.some(w=>w.table==='access_requests')),false);
  await card.getByRole('button',{name:'Confirm access?',exact:true}).click();await card.getByText('Approved',{exact:true}).waitFor();const decision=await page.evaluate(()=>window.chatDB.writes.find(w=>w.table==='access_requests').payload);assert.deepEqual(decision,{status:'approved',decided_by:'owner',granted_minutes:2});
  await page.evaluate(()=>{window.chatDB.tables.access_grants.push({id:'active',node_id:'mac',conversation_id:'conversation',kind:'control',status:'active',expires_at:new Date(Date.now()+120000).toISOString(),stop_requested:false});window.chatDB.notify();});
  await page.getByRole('button',{name:'Stop access',exact:true}).click();await page.getByRole('button',{name:'Stopping…',exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.chatDB.writes.find(w=>w.table==='access_grants').payload),{stop_requested:true});
 }finally{await page.close();}}
});
