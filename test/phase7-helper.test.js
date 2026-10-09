import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LinuxInput} from '../src/node/input/linux.js';
const exec=promisify(execFile);
test('real Gio installed-app helper lists >16KiB of fixture desktops and binds exact file fingerprints',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bit-real-apps-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const applications=path.join(root,'applications');fs.mkdirSync(applications);
 for(let i=0;i<160;i++)fs.writeFileSync(path.join(applications,`fixture-${i}.desktop`),`[Desktop Entry]\nType=Application\nName=Fixture Application ${i}\nExec=/usr/bin/true\nStartupWMClass=fixture-${i}\nCategories=Utility;\nTerminal=false\n`);
 fs.writeFileSync(path.join(applications,'blocked.desktop'),'[Desktop Entry]\nType=Application\nName=Harmless name\nExec=/usr/bin/true\nStartupWMClass=Discord\n');
 const env={...process.env,XDG_DATA_HOME:root,XDG_DATA_DIRS:path.join(root,'empty'),CONTROL_BLOCKED_APPS:'discord'};
 const backend=new LinuxInput({env,getEnvironment:async()=>env,log:()=>{}});
 const apps=await backend.listApps();assert.equal(apps.length,160);assert.ok(Buffer.byteLength(JSON.stringify(apps))>16384);assert.ok(apps.every(a=>/^[a-f0-9]{64}$/.test(a.fingerprint)));assert.ok(!apps.some(a=>a.id==='blocked.desktop'));
 await assert.rejects(backend.resolveApp('blocked.desktop'),/Control launch safety refusal at resolve: blocked application/);
 const approved=await backend.resolveApp('fixture-1.desktop');assert.deepEqual(approved,apps.find(a=>a.id===approved.id));
 fs.appendFileSync(path.join(applications,approved.id),'Comment=changed\n');const current=await backend.resolveApp(approved.id);assert.notEqual(current.fingerprint,approved.fingerprint);
 await assert.rejects(backend.launchApp(approved),/changed since approval/);
 // The old production limit fails with these real helper bytes, without mocks.
 await assert.rejects(exec('/usr/bin/python3',['-B',new URL('../src/node/input/apps.py',import.meta.url).pathname,'list','null'],{env,maxBuffer:16384}),e=>e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});
test('helper output overflow names the app-list stage and native code without exposing stdout',async()=>{
 const logs=[],backend=new LinuxInput({getEnvironment:async()=>({}),run:async()=>{throw Object.assign(new Error('private stdout'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',stdout:'secret'});},log:line=>logs.push(line)});
 await assert.rejects(backend.listApps(),/Control app listing failed at list: helper output exceeded 1048576-byte limit/);
 assert.match(logs.join('\n'),/ERR_CHILD_PROCESS_STDIO_MAXBUFFER/);assert.ok(!logs.join('\n').includes('secret'));
});
