// npm run test:browser (install browsers once: npx playwright install chromium webkit)
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
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
 });
 const box = await page.getByRole('dialog').boundingBox(), viewport = page.viewportSize();
 assert.ok(box.x >= -0.5 && box.y >= -0.5);
 assert.ok(box.x + box.width <= viewport.width + 0.5);
 assert.ok(box.y + box.height <= viewport.height + 0.5);
 const content = await page.locator('.bit-panel-body').evaluate(el => ({ box: el.getBoundingClientRect().toJSON(), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
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
   assert.equal(await card.getByRole('button').count(),0);
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
