import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createPermissions } from '../src/brain/permissions.js';
import { Budget } from '../src/brain/budget.js';
import { NodeHub, parseTokens } from '../src/brain/nodeHub.js';
import { startNode } from '../src/node/index.js';
import { ApprovalRelay, acceptsMessage, splitMessage, machinesText, createDiscord } from '../src/brain/discord.js';
import { Runner, activeMood } from '../src/brain/runner.js';
import { EventEmitter } from 'node:events';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-test-'));
  for (const p of ['bit/memory', 'bit/persona', 'bit/skills', 'src']) fs.mkdirSync(path.join(root, p), { recursive: true });
  fs.writeFileSync(path.join(root, 'bit/persona/persona.md'), 'bIT');
  fs.writeFileSync(path.join(root, 'bit/persona/personalities.json'), JSON.stringify({ chill: 'relaxed', hype: 'energy', sage: 'calm' }));
  fs.writeFileSync(path.join(root, 'bit/memory/profile.md'), 'Owner: Ozzy');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('path policy blocks source, env, traversal, links and forbidden tools; memory writes notify', async t => {
  const root = fixture(t), notices = [];
  const p = createPermissions({ root, notify: async s => notices.push(s) });
  for (const tool of ['Bash', 'Agent', 'WebSearch', 'NotebookEdit', 'mcp__evil__Read']) assert.equal((await p.canUseTool(tool, {})).behavior, 'deny');
  for (const file of ['src/index.js', '.env', 'bit/persona/persona.md', '../secret', 'bit/memory/../persona/persona.md']) assert.equal((await p.canUseTool('Write', { file_path: file, content: 'x' })).behavior, 'deny');
  assert.equal((await p.canUseTool('Read', { file_path: 'bit/persona/persona.md' })).behavior, 'allow');
  assert.equal((await p.canUseTool('Glob', { pattern: '**/*' })).behavior, 'deny');
  assert.equal((await p.canUseTool('Glob', { path: 'bit/memory', pattern: '../*' })).behavior, 'deny');
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'bit/memory/escape'));
  assert.equal((await p.canUseTool('Read', { file_path: 'bit/memory/escape/new' })).behavior, 'deny');
  assert.equal((await p.canUseTool('Grep', { path: 'bit/memory', pattern: '.' })).behavior, 'deny');
  const input = { file_path: 'bit/memory/color.md', content: 'teal' };
  const decision = await p.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Write', tool_input: input }, 'a', {});
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow');
  fs.writeFileSync(decision.hookSpecificOutput.updatedInput.file_path, 'teal');
  await p.hooks.PostToolUse[0].hooks[0]({ tool_name: 'Write', tool_input: decision.hookSpecificOutput.updatedInput, tool_use_id: 'a' });
  assert.deepEqual(notices, ['📝 noted: bit/memory/color.md']);
  assert.match(fs.readFileSync(path.join(root, 'data/audit.log'), 'utf8'), /"decision":"deny"/);
});
test('skill writes require approval; denial, revalidation and unsafe skill invocation', async t => {
  const root = fixture(t); let calls = 0;
  const deny = createPermissions({ root, approve: async () => { calls++; return false; } });
  assert.equal((await deny.canUseTool('Write', { file_path: 'bit/skills/foo/SKILL.md', content: '---\nname: foo\ndescription: Demo\n---\nInstructions' })).behavior, 'deny');
  assert.equal(calls, 1);
  const allow = createPermissions({ root, approve: async () => true });
  assert.equal((await allow.canUseTool('Write', { file_path: 'bit/skills/foo/SKILL.md', content: '---\nname: foo\ndescription: Demo\n---\nInstructions' })).behavior, 'allow');
  fs.mkdirSync(path.join(root, 'bit/skills/foo')); fs.writeFileSync(path.join(root, 'bit/skills/foo/SKILL.md'), '!`pwd`');
  assert.equal((await allow.canUseTool('Skill', { skill: 'foo' })).behavior, 'deny');
  const race = createPermissions({ root, approve: async () => { fs.symlinkSync(path.join(root, 'src'), path.join(root, 'bit/skills/swap')); return true; } });
  assert.equal((await race.canUseTool('Write', { file_path: 'bit/skills/swap/SKILL.md', content: '---\nname: swap\ndescription: Demo\n---\nInstructions' })).behavior, 'deny');
});
test('approval buttons deny, reject non-owner and time out', async () => {
  let posted; const edits = [];
  const channel = { id: 'c', send: async payload => { posted = payload; return { id: 'm', edit: async x => edits.push(x) }; } };
  const relay = new ApprovalRelay('owner', { timeout: 50 });
  const pending = relay.request(channel, { tool: 'Write', file: 'bit/skills/a/SKILL.md', input: { content: 'demo' } });
  await pause(1);
  const customId = posted.components[0].components[1].data.custom_id;
  const interaction = { user: { id: 'intruder' }, channelId: 'c', message: { id: 'm' }, customId, deferUpdate: async () => {} };
  await relay.handle(interaction); assert.equal(relay.pending.size, 1);
  interaction.user.id = 'owner'; await relay.handle(interaction);
  assert.equal(await pending, false); assert.match(edits[0].content, /owner decision/);
  assert.equal(await relay.request(channel, { tool: 'Write', file: 'x', input: {} }), false);
  assert.match(edits[1].content, /timed out/);
});
test('budget cumulative costs persist, cap gates, local month rolls over', t => {
  const root = fixture(t); let date = new Date('2026-10-01T02:00:00Z');
  const opts = { file: path.join(root, 'data/budget.json'), cap: 1, now: () => date, timezone: 'America/New_York' };
  const b = new Budget(opts); b.record('s', 0.4); b.record('s', 0.7); b.record('s', 0.7);
  assert.equal(b.status().month, '2026-09'); assert.equal(b.status().spent, 0.7);
  date = new Date('2026-10-01T05:00:00Z'); b.record('s', 1.2);
  assert.equal(b.status().spent, 0.5); b.record('next', 0.5); assert.equal(b.status().remaining, 0);
  assert.equal(new Budget(opts).status().spent, 1); b.begin(); assert.equal(new Budget(opts).status().uncertain, true);
});
test('owner routing, Unicode splitting and night personality', () => {
  const channel = { id: 'bit', isDMBased: () => false, isThread: () => false };
  assert.equal(acceptsMessage({ author: { id: 'other' }, channel }, 'owner', 'bit'), false);
  assert.equal(acceptsMessage({ author: { id: 'owner' }, channel }, 'owner', 'bit'), true);
  assert.equal(acceptsMessage({ author: { id: 'owner', bot: true }, channel }, 'owner', 'bit'), false);
  const source = 'x'.repeat(1999) + '💚'.repeat(2000); const chunks = splitMessage(source);
  assert.equal(chunks.join(''), source); assert.ok(chunks.every(c => c.length <= 2000 && !/[\uD800-\uDBFF]$/.test(c)));
  assert.equal(activeMood('hype', new Date('2026-09-29T02:00Z'), 'America/New_York'), 'sage');
  assert.equal(activeMood('hype', new Date('2026-09-29T09:00Z'), 'America/New_York'), 'hype');
});
test('real hub and OZZY-AI node: authentication, live status, offline, timeout', async t => {
  const token = 'test-token-0123456789';
  const hub = new NodeHub({ port: 0, tokens: parseTokens(`OZZY-AI:${token}`), timeout: 150 }); await hub.ready;
  t.after(() => hub.close()); const url = `ws://127.0.0.1:${hub.server.address().port}`;
  await new Promise(resolve => { const ws = new WebSocket(url, { headers: { Authorization: 'Bearer wrong' } }); ws.on('error', e => { assert.match(e.message, /401/); resolve(); }); });
  const node = startNode({ url, token, machine: 'OZZY-AI', heartbeat: 100, log: () => {} }); t.after(() => node.close());
  for (let i = 0; i < 100 && !hub.list()[0].online; i++) await pause(10);
  assert.equal(hub.list()[0].online, true);
  hub.timeout = 10000;
  const status = await hub.request('OZZY-AI', 'status'); assert.ok(status.uptime > 0); assert.ok(status.memory.total > 0); assert.ok(status.os.release);
  console.log('LIVE OZZY-AI status:', JSON.stringify({ uptime: status.uptime, cpu: status.cpu, memory: status.memory, os: status.os }));
  assert.match(await machinesText(hub), /OZZY-AI: online/);
  await assert.rejects(hub.request('OZZY-AI', 'shell'), /Unsupported/);
  node.close(); await pause(30); assert.equal(hub.list()[0].online, false);
  await assert.rejects(hub.request('OZZY-AI', 'status'), /offline/);
  const silent = startNode({ url, token, machine: 'OZZY-AI', status: () => new Promise(() => {}), log: () => {} }); t.after(() => silent.close());
  for (let i = 0; i < 100 && !hub.list()[0].online; i++) await pause(10);
  hub.timeout = 20; await assert.rejects(hub.request('OZZY-AI', 'status'), /timed out/);
});
test('runner resumes by channel, new thread reads memory, mood persists, cap prevents API', async t => {
  const root = fixture(t), seen = []; let total = 0;
  const budget = new Budget({ file: path.join(root, 'data/budget.json'), cap: 1 });
  const queryFn = async function* ({ prompt, options }) {
    for await (const message of prompt) seen.push({ message, options });
    const session = options.resume || `session-${seen.length}`;
    yield { type: 'system', subtype: 'init', session_id: session };
    const read = await options.canUseTool('Read', { file_path: 'bit/memory/profile.md' }); assert.equal(read.behavior, 'allow');
    if (seen.length === 1) {
      const input = { file_path: 'bit/memory/profile.md', content: 'Owner: Ozzy\nFavorite color: teal' };
      const write = await options.canUseTool('Write', input); fs.writeFileSync(write.updatedInput.file_path, input.content);
      await options.hooks.PostToolUse[0].hooks[0]({ tool_name: 'Write', tool_input: write.updatedInput });
    }
    total += 0.1;
    yield { type: 'result', subtype: 'success', session_id: session, total_cost_usd: options.resume ? total : 0.1, result: fs.readFileSync(read.updatedInput.file_path, 'utf8') };
  };
  const runner = new Runner({ root, hub: { list: () => [] }, budget, queryFn }); const notices = [];
  const ctx = { notify: async s => notices.push(s), approve: async () => false };
  await runner.run('thread1', 'remember teal', ctx); await runner.run('thread1', 'hello', ctx);
  assert.equal(seen[1].options.resume, 'session-1');
  assert.match(await runner.run('thread2', 'favorite color?', ctx), /teal/); assert.equal(seen[2].options.resume, undefined);
  assert.deepEqual(notices, ['📝 noted: bit/memory/profile.md']);
  runner.mood('hype'); assert.equal(new Runner({ root, hub: {}, budget, queryFn }).preferences.mood, 'hype');
  await runner.reset('thread1'); assert.equal(runner.sessions.thread1, undefined);
  budget.record('cap', 1); const before = seen.length; assert.match(await runner.run('x', 'hello', ctx), /out of juice/); assert.equal(seen.length, before);
});
test('Discord adapter simulates non-owner ignore and top-level thread continuity', async () => {
  const client = new EventEmitter(); client.destroy = () => {};
  const calls = []; const thread = { id: 'thread', parentId: 'bit', isThread: () => true, isDMBased: () => false, sendTyping: async () => {}, send: async data => calls.push(data) };
  const channel = { id: 'bit', isThread: () => false, isDMBased: () => false };
  let runs = 0, threads = 0;
  createDiscord({ client, env: { OWNER_DISCORD_ID: 'owner', BIT_CHANNEL_ID: 'bit' }, runner: { run: async id => { assert.equal(id, 'thread'); runs++; return 'Hello'; } }, hub: {}, budget: {} });
  const handler = client.listeners('messageCreate')[0];
  const message = { author: { id: 'other' }, channel, content: 'hi', startThread: async () => { threads++; return thread; } };
  await handler(message); assert.equal(runs, 0); assert.equal(threads, 0);
  message.author.id = 'owner'; await handler(message); message.channel = thread; await handler(message);
  assert.equal(runs, 2); assert.equal(threads, 1); assert.equal(calls.length, 2);
});

test('hub rejects machine identity spoofing, expires stale peers and node reconnects', async t => {
  const token = 'test-reconnect-token-123';
  const hub = new NodeHub({ port: 0, tokens: parseTokens(`OZZY-AI:${token}`), stale: 70 }); await hub.ready; t.after(() => hub.close());
  const url = `ws://127.0.0.1:${hub.server.address().port}`;
  const open = () => new Promise(resolve => { const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }); ws.on('open', () => resolve(ws)); });
  const hello = { type: 'hello', machine: 'OZZY-AI', os: 'linux', arch: 'x64', hostname: 'test', version: '1', capabilities: ['status'] };
  const spoof = await open(); spoof.send(JSON.stringify({ ...hello, machine: 'OTHER' }));
  await new Promise(resolve => spoof.once('close', code => { assert.equal(code, 1008); resolve(); }));
  const stale = await open(); stale.send(JSON.stringify(hello));
  await new Promise(resolve => stale.once('close', resolve)); assert.equal(hub.list()[0].online, false);
  let connections = 0;
  const node = startNode({ url, token, machine: 'OZZY-AI', heartbeat: 10, log: s => { if (s.includes('connected')) connections++; } }); t.after(() => node.close());
  for (let i = 0; i < 100 && !hub.list()[0].online; i++) await pause(10);
  hub.nodes.get('OZZY-AI').ws.terminate();
  for (let i = 0; i < 250 && connections < 2; i++) await pause(10);
  assert.ok(connections >= 2); await pause(20); assert.equal(hub.list()[0].online, true);
});

test('skill YAML parsing rejects quoted executable directives before approval', async t => {
  const root = fixture(t); let prompts = 0;
  const policy = createPermissions({ root, approve: async () => { prompts++; return true; } });
  for (const extra of ['"hooks": {}', 'context: fork', 'allowed-tools: Bash', '"\\x68ooks": {}']) {
    const result = await policy.canUseTool('Write', { file_path: 'bit/skills/demo/SKILL.md', content: `---\nname: demo\ndescription: Demo\n${extra}\n---\nText` });
    assert.equal(result.behavior, 'deny');
  }
  assert.equal(prompts, 0);
});
