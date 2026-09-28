import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createDiscord } from '../src/brain/discord.js';
import { acquireBrainLock, installShutdown } from '../src/brain/lock.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-discord-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function adapter(t, overrides = {}) {
  const client = new EventEmitter(); client.destroy = () => {};
  const auditFile = path.join(fixture(t), 'audit.log');
  createDiscord({ client, auditFile, env: { OWNER_DISCORD_ID: 'owner', BIT_CHANNEL_ID: 'bit' }, runner: { mood() {}, async reset() {} }, budget: { status: () => ({ month: '2026-09', spent: 0, cap: 25 }) }, hub: { list: () => [] }, ...overrides });
  return { handle: client.listeners('interactionCreate')[0], auditFile };
}
function interaction(commandName = 'machines') {
  const calls = [];
  return {
    commandName, user: { id: 'owner' }, channelId: 'bit',
    channel: { id: 'bit', isDMBased: () => false, isThread: () => false },
    options: { getString: () => 'hype' },
    isChatInputCommand: () => true, isButton: () => false,
    calls,
    async deferReply() { calls.push('defer'); this.deferred = true; },
    async editReply(value) { calls.push(['edit', value]); },
    async reply(value) { calls.push(['reply', value]); this.replied = true; },
    async followUp(value) { calls.push(['followup', value]); },
  };
}

test('slow /machines acknowledges before >3s status collection', async t => {
  const request = interaction(); const start = Date.now(); let elapsed;
  const { handle } = adapter(t, { hub: {
    list: () => [{ machine: 'OZZY-AI', online: true }],
    request: async () => {
      assert.deepEqual(request.calls, ['defer']); elapsed = Date.now() - start;
      await delay(3100); return { uptime: 42 };
    },
  } });
  await handle(request);
  assert.ok(elapsed < 3000); assert.ok(Date.now() - start >= 3100);
  assert.equal(request.calls[0], 'defer'); assert.match(request.calls[1][1].content, /OZZY-AI: online/);
});

test('every slash command defers first and command failures edit reply with full audit', async t => {
  for (const name of ['mood', 'budget', 'machines', 'reset']) {
    const error = new Error(`${name} test failure`);
    const fail = () => { throw error; };
    const { handle, auditFile } = adapter(t, { runner: { mood: fail, reset: fail }, budget: { status: fail }, hub: { list: fail } });
    const request = interaction(name); request.channel.isThread = () => true;
    await handle(request);
    assert.equal(request.calls[0], 'defer'); assert.match(request.calls[1][1].content, /My ring hit a snag/);
    const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8').trim());
    assert.equal(audit.command, name); assert.equal(audit.stack, error.stack); assert.match(audit.error, /test failure/);
  }
});

test('node failures are audited and returned; owner location rejects are acknowledged', async t => {
  const { handle, auditFile } = adapter(t, { hub: { list: () => [{ machine: 'OZZY-AI', online: true }], request: async () => { throw new Error('node timeout'); } } });
  const request = interaction(); await handle(request);
  assert.match(request.calls[1][1].content, /status sensor hit a snag/);
  assert.match(fs.readFileSync(auditFile, 'utf8'), /node timeout/);
  const elsewhere = interaction(); elsewhere.channel.id = 'elsewhere'; await handle(elsewhere);
  assert.equal(elsewhere.calls[0], 'defer'); assert.match(elsewhere.calls[1][1].content, /#bit/);
  const outsider = interaction(); outsider.user.id = 'other'; await handle(outsider); assert.deepEqual(outsider.calls, []);
});

test('failed deferral attempts an initial error reply and records both transport failures', async t => {
  const { handle, auditFile } = adapter(t);
  const request = interaction();
  request.deferReply = async () => { throw new Error('defer transport failed'); };
  request.reply = async () => { throw new Error('reply transport failed'); };
  await assert.doesNotReject(handle(request));
  const events = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2); assert.equal(events[1].stage, 'error_reply');
});

test('lock reclaims a confirmed dead PID, protects live/invalid locks, releases only its own lock', async t => {
  const file = path.join(fixture(t), 'brain.lock');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']); const pid = child.pid; await once(child, 'exit');
  fs.writeFileSync(file, String(pid));
  const release = acquireBrainLock(file); assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  assert.throws(() => acquireBrainLock(file), /already running/);
  release(); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, 'not-a-pid'); assert.throws(() => acquireBrainLock(file), /invalid PID/);
  fs.unlinkSync(file); const releaseAgain = acquireBrainLock(file);
  fs.writeFileSync(file, String(pid)); releaseAgain(); assert.equal(fs.readFileSync(file, 'utf8'), String(pid));
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} cleans up brain lock in a real subprocess`, async t => {
  const file = path.join(fixture(t), 'brain.lock');
  const moduleURL = new URL('../src/brain/lock.js', import.meta.url).href;
  const code = `import { acquireBrainLock, installShutdown } from ${JSON.stringify(moduleURL)}; const release = acquireBrainLock(process.argv[1]); installShutdown(release, async () => {}); console.log('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data'); assert.equal(fs.existsSync(file), true);
  const exited = once(child, 'exit'); child.kill(signal);
  assert.equal((await exited)[0], 0); assert.equal(fs.existsSync(file), false);
});

test('shutdown failure still releases lock', async () => {
  const runtime = new EventEmitter(); let unlocked = false;
  const exited = new Promise(resolve => { runtime.exit = resolve; });
  installShutdown(() => { unlocked = true; }, async () => { throw new Error('shutdown failed'); }, runtime);
  runtime.emit('SIGTERM'); assert.equal(await exited, 1); assert.equal(unlocked, true);
});
