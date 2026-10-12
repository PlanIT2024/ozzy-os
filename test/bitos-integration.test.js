import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { runBrain } from '../src/brain/index.js';
import { startBrainSync } from '../src/bitos/sync.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSync } from '../src/bitos/sync.js';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
import { createDiscord } from '../src/brain/discord.js';
import { NodeHub } from '../src/brain/nodeHub.js';

const env = { BITOS_SUPABASE: '1', BITOS_OWNER_USER_ID: '11111111-1111-4111-8111-111111111111', BITOS_DEFAULT_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222' };
const schema = await fs.readFile(new URL('../supabase/migrations/0001_bit_os_core.sql', import.meta.url), 'utf8');
const migration2 = await fs.readFile(new URL('../supabase/migrations/0002_executor_and_refs.sql', import.meta.url), 'utf8');
const migration3 = await fs.readFile(new URL('../supabase/migrations/0003_replay_safe_writes.sql', import.meta.url), 'utf8');
function fakeDB() {
  const rows = Object.fromEntries(['nodes', 'tasks', 'approvals', 'leases', 'task_events'].map(t => [t, new Map()]));
  const calls = []; let failure = false, lostResponse;
  function check(table, row) {
    const definition = new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`).exec(schema)[1];
    const columns = new Set([...definition.matchAll(/^\s*(\w+)\s+(?:uuid|text|boolean|integer|timestamptz|jsonb|bigint|numeric|node_kind|node_status|task_status|task_source|autonomy_mode|lease_level|approval_status|risk_class)\b/gm)].map(m => m[1]));
    if (table === 'tasks') { columns.add('executor'); columns.add('external_ref'); }
    if (table === 'task_events') columns.add('client_event_id');
    for (const column of Object.keys(row)) assert.ok(columns.has(column), `unknown ${table}.${column}`);
  }
  async function apply(table, row, operation, options) {
    calls.push({ table, operation, row: structuredClone(row), options });
    if (failure) throw Error('fake Supabase outage');
    check(table, row);
    if (operation === 'upsert') {
      const key = table === 'task_events' ? 'client_event_id' : 'id';
      assert.equal(options.onConflict, key);
      if (['task_events','leases'].includes(table)) assert.equal(options.ignoreDuplicates, true);
      if (table === 'task_events') assert.ok(!('id' in row), 'generated identity must be left to PostgreSQL');
      const existing = rows[table].get(row[key]);
      // Models 0003's early trigger return before INSERT conflict handling.
      if (table === 'leases' && !existing) {
        if ([...rows.leases.values()].some(l => l.node_id === row.node_id && !l.revoked_at && Date.parse(l.expires_at) > Date.now())) return { error: { message: 'Node already has an active lease' } };
        assert.ok(Date.parse(row.expires_at) > Date.parse(row.starts_at));
        assert.ok(Date.parse(row.expires_at) - Date.parse(row.starts_at) <= 4 * 3600000);
      }
      if (!(existing && options.ignoreDuplicates)) rows[table].set(row[key], { ...(table === 'task_events' ? { id: rows.task_events.size + 1 } : {}), ...existing, ...row });
      if (lostResponse === table) { lostResponse = undefined; throw Error('response lost after committed write'); }
    }
    return { error: null };
  }
  return { rows, calls, fail: value => { failure = value; }, loseNextResponse: table => { lostResponse = table; },
    from(table) {
      return {
        select() { throw Error('database reads prohibited in mirror'); },
        upsert: (row, options) => apply(table, row, 'upsert', options),
        update: row => ({ eq: async (column, value) => {
          await apply(table, row, 'update');
          for (const [id, old] of rows[table]) if (old[column] === value) rows[table].set(id, { ...old, ...row });
          return { error: null };
        } }),
      };
    },
    rpc() { throw Error('RPC writes are not part of this mirror'); },
  };
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bitos-integration-'));
  const db = fakeDB(); let creations = 0;
  const sync = createSync({ root, env, makeClient: () => { creations++; return db; }, schedule: () => ({ unref() {} }), log: () => {}, ...options });
  t.after(async () => { await sync.close(); await sync.outbox?.storage.catch(() => {}); await sync.identityReady?.().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  const drain = async () => { await sync.outbox?.ready; await sync.outbox?.flush(); };
  return { root, db, sync, drain, creations: () => creations };
}
async function runnerFixture(root, sync, queryFn) {
  for (const folder of ['memory','skills','persona','schedules']) await fs.mkdir(path.join(root, 'bit', folder), { recursive: true });
  await fs.writeFile(path.join(root, 'bit/persona/persona.md'), 'bIT');
  await fs.writeFile(path.join(root, 'bit/persona/personalities.json'), '{}');
  return new Runner({ root, sync, queryFn, budget: new Budget({ file: path.join(root,'data/budget.json'), cap: 1 }), hub: { list: () => [] } });
}

test('flag unset/0 makes zero clients or calls across Runner and Discord approval task flow', async t => {
  for (const flag of [undefined, '0']) {
    const f = await fixture(t, { env: { ...env, BITOS_SUPABASE: flag } });
    const client = new EventEmitter(); client.destroy = () => {};
    let adapter;
    const thread = { id: 'thread', isThread: () => true, isDMBased: () => false, parentId: 'bit', send: async () => ({ id: 'card', edit: async () => {} }) };
    const runner = await runnerFixture(f.root, f.sync, async function* () {
      const pending = adapter.approvals.request(thread, { tool: 'Write', input: { content: 'private' } });
      while (!adapter.approvals.pending.size) await new Promise(r => setImmediate(r));
      const id = [...adapter.approvals.pending.keys()][0];
      await client.listeners('interactionCreate')[0]({ user: { id: 'owner' }, customId: `approve:${id}:yes`, channel: thread, channelId: thread.id, message: { id: 'card' }, isChatInputCommand: () => false, isButton: () => true, deferUpdate: async () => {} });
      assert.equal(await pending, true);
      yield { type: 'result', subtype: 'success', session_id: 'fixture', result: 'done', total_cost_usd: .01 };
    });
    adapter = createDiscord({ sync: f.sync, runner, hub: runner.hub, budget: runner.budget, client, env: { OWNER_DISCORD_ID: 'owner', BIT_CHANNEL_ID: 'bit' }, auditFile: path.join(f.root,'audit.log') });
    assert.equal(await runner.run('thread','Do a small task'), 'done');
    await runner.close(); adapter.close();
    assert.equal(f.creations(), 0); assert.equal(f.db.calls.length, 0);
    await assert.rejects(fs.access(path.join(f.root, 'data/bitos-outbox.jsonl')));
  }
});

test('NodeHub hello, throttled heartbeat, disconnect and restart retain node UUID', async t => {
  let time = Date.now(); const f = await fixture(t, { now: () => time });
  const hub = Object.create(NodeHub.prototype); const peer = { close() {} };
  Object.assign(hub, { sync: f.sync, nodes: new Map([['ozzy-ai', { peer, connection: 'relay', machine: 'OZZY-AI', online: false }]]), pending: new Map(), log() {} });
  hub.message('ozzy-ai', peer, { type: 'hello', machine: 'OZZY-AI', os: 'linux', arch: 'x64', hostname: 'ozzy', version: '1.0', capabilities: ['status'] });
  await f.drain(); const id = [...f.db.rows.nodes.keys()][0];
  assert.equal(f.db.rows.nodes.get(id).status, 'online');
  hub.message('ozzy-ai', peer, { type: 'heartbeat' }); time += 59000; hub.message('ozzy-ai', peer, { type: 'heartbeat' });
  await f.drain(); assert.equal(f.db.calls.filter(c => c.table === 'nodes' && c.operation === 'upsert').length, 1);
  time += 1000; hub.message('ozzy-ai', peer, { type: 'heartbeat' }); await f.drain();
  assert.equal(f.db.calls.filter(c => c.table === 'nodes' && c.operation === 'upsert').length, 2);
  hub.disconnect('ozzy-ai', 'relay'); await f.drain(); assert.equal(f.db.rows.nodes.get(id).status, 'offline');
  await f.sync.identityReady(); const mapping = JSON.parse(await fs.readFile(path.join(f.root,'data/bitos-node-ids.json'))); assert.equal(mapping['ozzy-ai'], id);
  await f.sync.close();
  const restarted = createSync({ root: f.root, env, now: () => time, makeClient: () => f.db, schedule: () => ({ unref() {} }), log() {} });
  restarted.nodeSeen({ machine: 'OZZY-AI', os: 'linux', capabilities: ['status'], connected: true }); await restarted.outbox.ready; await restarted.outbox.flush(); await restarted.identityReady(); await restarted.close();
  assert.equal(f.db.rows.nodes.size, 1); assert.equal(f.db.rows.nodes.get(id).status, 'online');
});

test('approval mirrors request and Discord button; thrown DB error cannot escape handler', async t => {
  const f = await fixture(t); f.db.fail(true);
  const client = new EventEmitter(); client.destroy = () => {};
  const thread = { id: 'thread', parentId: 'bit', isThread: () => true, isDMBased: () => false, send: async () => ({ id: 'card', edit: async () => {} }) };
  const adapter = createDiscord({ sync: f.sync, client, runner: {}, hub: {}, budget: {}, env: { OWNER_DISCORD_ID: 'owner', BIT_CHANNEL_ID: 'bit' }, auditFile: path.join(f.root,'audit.log') });
  const pending = adapter.approvals.request(thread, { tool: 'computer', input: { action: 'type', machine: 'OZZY-AI', text: 'private typed marker' } });
  while (!adapter.approvals.pending.size) await new Promise(r => setImmediate(r));
  const id = [...adapter.approvals.pending.keys()][0];
  await f.drain();
  await assert.doesNotReject(client.listeners('interactionCreate')[0]({ user: { id: 'owner' }, customId: `approve:${id}:yes`, channel: thread, channelId: thread.id, message: { id: 'card' }, isChatInputCommand: () => false, isButton: () => true, deferUpdate: async () => {} }));
  assert.equal(await pending, true); adapter.close();
  assert.ok(f.sync.outbox.entries.length > 0); f.db.fail(false); f.sync.outbox.entries[0].next = 0; await f.drain();
  const requests = f.db.calls.filter(c => c.table === 'approvals');
  assert.deepEqual(requests.map(c => c.row.status), ['pending', 'approved']);
  const approval = f.db.rows.approvals.get(id); assert.equal(approval.decided_by, env.BITOS_OWNER_USER_ID); assert.ok(approval.decided_at);
  assert.equal(approval.action_detail.text_length, 20); assert.equal(approval.risk, 'risky');
  assert.ok(!JSON.stringify(f.db.calls).includes('private typed marker'));
});

test('task status, model cost and tool events use only schema columns', async t => {
  const f = await fixture(t);
  const runner = await runnerFixture(f.root, f.sync, async function* ({ options }) {
    assert.ok(Object.keys(options.env).every(key => !/^(SUPABASE_|BITOS_)/.test(key)));
    await options.hooks.PostToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: {}, tool_use_id: 'tool' });
    yield { type: 'result', subtype: 'success', session_id: 'fixture', result: 'done', total_cost_usd: .0123 };
  });
  assert.equal(await runner.run('thread','private owner prompt'), 'done'); await f.drain(); await runner.close();
  const task = [...f.db.rows.tasks.values()][0]; assert.equal(task.status, 'done'); assert.equal(task.executor, 'bit'); assert.equal(task.source, 'typed'); assert.deepEqual(task.external_ref, { discord_thread_id: 'thread' });
  const events = [...f.db.rows.task_events.values()]; assert.equal(events.filter(e => e.kind === 'model_call').length, 1);
  assert.equal(events.find(e => e.kind === 'model_call').cost_cents, 1.23);
  assert.ok(events.some(e => e.kind === 'note')); assert.ok(events.every(e => e.screenshot_path === null));
  assert.ok(!JSON.stringify(f.db.calls).includes('private owner prompt'));
  assert.match(migration2, /executor task_executor/);
});

test('90 seconds without node messages marks node offline without changing local connections', async t => {
  let time = Date.now(), sweep;
  const f = await fixture(t, { now: () => time, interval: fn => { sweep = fn; return { unref() {} }; } });
  f.sync.nodeSeen({ machine: 'OZZY-AI', connected: true }); await f.drain();
  time += 89999; sweep(); await f.drain(); assert.equal([...f.db.rows.nodes.values()][0].status, 'online');
  time++; sweep(); await f.drain(); assert.equal([...f.db.rows.nodes.values()][0].status, 'offline');
});

test('runner failures are cancelled with a reason event', async t => {
  const f = await fixture(t);
  const runner = await runnerFixture(f.root, f.sync, async function* () { throw new TypeError('private failure detail'); });
  await runner.run('thread','task'); await f.drain(); await runner.close();
  assert.equal([...f.db.rows.tasks.values()][0].status, 'cancelled');
  assert.ok([...f.db.rows.task_events.values()].some(e => e.kind === 'status' && e.payload.reason === 'TypeError'));
  assert.ok(!JSON.stringify(f.db.calls).includes('private failure detail'));
});

test('active lease conflict is logged and dropped; replay does not reinsert active lease', async t => {
  const logs = [], f = await fixture(t, { log: message => logs.push(message) });
  const watch = { id: randomUUID(), machine: 'OZZY-AI', thread: 'thread', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), level: 'watch' };
  f.sync.leaseStarted(watch); f.sync.leaseStarted(watch); f.sync.leaseStarted({ ...watch, id: randomUUID(), level: 'control' }); await f.drain();
  assert.equal(f.db.rows.leases.size, 1); assert.ok(logs.some(l => /active lease conflict/.test(l))); assert.equal(f.sync.outbox.entries.length, 0);
  f.sync.leaseEnded({ id: watch.id, reason: 'user' }); await f.drain(); assert.equal(f.db.rows.leases.get(watch.id).revoked_reason, 'user');
});

for (const table of ['task_events', 'leases']) test(`${table} replay after lost response and restart creates one row without error`, async t => {
  let time = Date.now(); const logs = [];
  const f = await fixture(t, { now: () => time, log: message => logs.push(message) });
  await f.sync.outbox.ready;
  if (table === 'task_events') f.sync.event({ kind: 'note', summary: 'Replay fixture' });
  else f.sync.leaseStarted({ machine: 'OZZY-AI', level: 'watch', issuedAt: new Date(time).toISOString(), expiresAt: new Date(time + 600000).toISOString() });
  const entry = f.sync.outbox.entries.find(e => e.table === table);
  const stableId = entry.payload[table === 'task_events' ? 'client_event_id' : 'id'];
  assert.match(stableId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
  f.db.loseNextResponse(table); await f.drain();
  assert.equal(f.db.rows[table].size, 1);
  assert.equal(f.sync.outbox.entries[0].payload[table === 'task_events' ? 'client_event_id' : 'id'], stableId);
  await f.sync.close(); time += 1000;
  const replay = createSync({ root: f.root, env, now: () => time, makeClient: () => f.db, schedule: () => ({ unref() {} }), log: message => logs.push(message) });
  await replay.outbox.ready; await assert.doesNotReject(replay.outbox.flush());
  assert.equal(f.db.rows[table].size, 1); assert.equal(replay.outbox.entries.length, 0);
  assert.equal(f.db.calls.filter(c => c.table === table).length, 2);
  assert.equal(logs.filter(l => /write failed/.test(l)).length, 1, 'only the deliberately lost initial response fails');
  assert.ok(!logs.some(l => /active lease conflict/.test(l)));
  await replay.close();
});

test('brain startup captures settings once and scrubs real SDK child environment', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bitos-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = { ...env, SUPABASE_URL: 'https://fake-project.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fake-brain-only-key', BITOS_EXTRA_SETTING: 'private', SUPABASE_EXTRA_SETTING: 'private' };
  const old = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SUPABASE_|BITOS_)/.test(key)));
  Object.assign(process.env, settings);
  t.after(() => { for (const key of Object.keys(process.env)) if (/^(SUPABASE_|BITOS_)/.test(key)) delete process.env[key]; Object.assign(process.env, old); });
  const startupEnv = { ...settings, ANTHROPIC_API_KEY: 'fake-anthropic', DISCORD_TOKEN: 'fake-discord', DISCORD_APP_ID: 'app', DISCORD_GUILD_ID: 'guild', BIT_CHANNEL_ID: 'bit', OWNER_DISCORD_ID: 'owner' };
  const runtime = new EventEmitter(); runtime.exit = () => {};
  const reads = {};
  for (const [key, value] of Object.entries(settings)) Object.defineProperty(startupEnv, key, { enumerable: true, configurable: true, get() { reads[key] = (reads[key] || 0) + 1; return value; } });
  const db = fakeDB(); let sync, child, childKeys, captured, observedKeys, sdkSpawned = false, completed = false;
  const scrubbed = () => {
    assert.ok(Object.keys(process.env).every(key => !/^(SUPABASE_|BITOS_)/.test(key)));
    assert.ok(Object.keys(startupEnv).every(key => !/^(SUPABASE_|BITOS_)/.test(key)));
  };
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
  const preparation = await runnerFixture(root, undefined, async function* () {}); await preparation.close();
  await runBrain({ root, env: startupEnv, runtime,
    makeSync: options => { sync = startBrainSync({ ...options, makeClient: snapshot => { captured = snapshot; return db; }, schedule: () => ({ unref() {} }), log() {} }); return sync; },
    makeBudget: () => { scrubbed(); return new Budget({ file: path.join(root, 'data/budget.json'), cap: 1 }); },
    makeHub: () => { scrubbed(); return { ready: Promise.resolve(), list: () => [], close: async () => {} }; },
    makeGrowth: () => ({ close: async () => {} }),
    makeReminders: () => ({ start: async () => {}, close() {} }),
    makeScheduler: () => ({ start: async () => {}, close() {} }),
    makeRunner: options => {
      scrubbed();
      return new Runner({ ...options, queryFn: args => query({ ...args, options: { ...args.options,
        spawnClaudeCodeProcess: specification => {
          sdkSpawned = true; scrubbed();
          assert.ok(Object.keys(specification.env).every(key => !/^(SUPABASE_|BITOS_)/.test(key)));
          // Use the SDK's actual ProcessTransport environment on a real process.
          // Exit deliberately so no model API or other network is contacted.
          child = spawn(process.execPath, ['-e', 'process.stderr.write(JSON.stringify(Object.keys(process.env))); process.exitCode = 1;'], { env: specification.env, stdio: ['pipe','pipe','pipe'] });
          let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
          childKeys = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => { try { resolve(JSON.parse(stderr)); } catch (error) { reject(error); } }); });
          return child;
        },
      } }) });
    },
    makeDiscord: ({ runner }) => { scrubbed(); return { close() {}, start: async () => {
      await runner.run('thread', 'Environment fixture');
      observedKeys = await childKeys;
      await sync.outbox.ready; await sync.outbox.flush();
      completed = true;
      throw Error('fixture finished');
    } }; },
  });
  assert.equal(sdkSpawned, true); assert.equal(runtime.exitCode, 1);
  assert.equal(completed, true); assert.ok(Array.isArray(observedKeys));
  assert.ok(observedKeys.every(key => !/^(SUPABASE_|BITOS_)/.test(key)));
  assert.equal(captured.SUPABASE_URL, settings.SUPABASE_URL);
  assert.equal(captured.SUPABASE_SERVICE_ROLE_KEY, settings.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(captured.BITOS_SUPABASE, '1'); assert.ok(Object.isFrozen(captured));
  assert.deepEqual(reads, Object.fromEntries(Object.keys(settings).map(key => [key, 1])));
  assert.ok(child.exitCode !== null); scrubbed();
});

test('service templates isolate brain settings and node/relay contain no Supabase references', async () => {
  const brain = await fs.readFile(new URL('../deploy/systemd/bit-brain.service', import.meta.url), 'utf8');
  const node = await fs.readFile(new URL('../deploy/systemd/bit-node.service', import.meta.url), 'utf8');
  const files = brain.split('\n').filter(l => l.startsWith('EnvironmentFile='));
  assert.deepEqual(files, ['EnvironmentFile=%h/ozzy-os/.env','EnvironmentFile=-%h/ozzy-os/.env.brain']);
  assert.doesNotMatch(node, /\.env\.brain|SUPABASE_/);
  async function scan(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else assert.doesNotMatch(await fs.readFile(file, 'utf8'), /SUPABASE_SERVICE_ROLE_KEY|@supabase\/supabase-js|bitos\/sync/);
    }
  }
  for (const dir of ['src/node','src/transport','relay']) await scan(fileURLToPath(new URL('../' + dir, import.meta.url)));
  const sync = await fs.readFile(new URL('../src/bitos/sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sync, /\.select\(|\.subscribe\(|\.channel\(/);
  assert.doesNotMatch(sync, /\.rpc\(/);
  assert.match(migration3, /alter table task_events add column client_event_id uuid;/);
  assert.match(migration3, /create unique index on task_events \(client_event_id\);/);
  assert.ok(migration3.indexOf('where id = new.id') < migration3.indexOf('l.node_id = new.node_id'));
});
