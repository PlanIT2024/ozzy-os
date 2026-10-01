import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startRelay, clientsFromEnv } from '../relay/index.js';
import { pack, unpack, MAX_MESSAGE } from '../relay/wire.js';
import { Cipher, SecurePeer, sodium, publicHex, nodeKeys, loadKey } from '../src/transport/crypto.js';
import { NodeHub, parseTokens } from '../src/brain/nodeHub.js';
import { startNode } from '../src/node/index.js';
import { Growth } from '../src/brain/growth.js';
import { createPermissions } from '../src/brain/permissions.js';
import { ApprovalRelay } from '../src/brain/discord.js';
import { machinesText } from '../src/brain/discord.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await pause(10); } throw new Error('Condition timed out'); }
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-phase2-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function ciphers() {
  const brain = sodium.crypto_kx_keypair(), node = sodium.crypto_kx_keypair();
  return { brain, node, client: new Cipher({ role: 'node', name: 'test-node', key: node, peerKey: brain.publicKey }), server: new Cipher({ role: 'brain', name: 'TEST-NODE', key: brain, peerKey: node.publicKey }) };
}
function entries() { return ['brain', 'test-node', 'other'].map(name => ({ name, role: name === 'brain' ? 'brain' : 'node', sha256: createHash('sha256').update('token-' + name).digest('hex') })); }
async function relayFixture(t, options = {}) { const relay = startRelay({ port: 0, clients: clientsFromEnv(JSON.stringify(entries())), log: () => {}, ...options }); await relay.ready; t.after(() => relay.close()); return { relay, url: `ws://127.0.0.1:${relay.server.address().port}` }; }
function socket(url, name, token = 'token-' + name) { return new WebSocket(url, { headers: { Authorization: 'Bearer ' + token, 'X-Bit-Name': name } }); }

test('libsodium E2E hides plaintext, authenticates routing, rejects tampering, replay and reordering', () => {
  const { client, server } = ciphers();
  const frame = client.seal({ secret: 'PLAINTEXT-MUST-NOT-REACH-RELAY' });
  assert.equal(frame.includes(Buffer.from('PLAINTEXT-MUST-NOT-REACH-RELAY')), false);
  const tampered = Buffer.from(frame); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => server.open(tampered), /decryption failed/);
  assert.equal(server.open(frame).secret, 'PLAINTEXT-MUST-NOT-REACH-RELAY');
  assert.throws(() => server.open(frame), /Replayed/);
  const earlier = client.seal({ n: 1 }), later = client.seal({ n: 2 });
  assert.equal(server.open(later).n, 2); assert.throws(() => server.open(earlier), /out-of-order/);
  const m = unpack(client.seal({ n: 3 })); assert.throws(() => server.open(pack({ ...m.meta, id: randomUUID() }, m.payload)), /decryption failed/);
});

test('fresh challenge prevents replay across connections and simulated restarts', () => {
  const { brain, node } = ciphers(); const fromNode = [], fromBrain = [];
  const client = new SecurePeer({ role: 'node', name: 'test-node', key: node, peerKey: brain.publicKey, send: f => fromNode.push(f) });
  const server = new SecurePeer({ role: 'brain', name: 'test-node', key: brain, peerKey: node.publicKey, send: f => fromBrain.push(f) });
  client.start(); const oldInit = fromNode.shift(); server.receive(oldInit); client.receive(fromBrain.shift()); const oldFinish = fromNode.shift(); server.receive(oldFinish); client.receive(fromBrain.shift());
  client.send({ secret: 'old' }); const oldData = fromNode.shift();
  const restarted = new SecurePeer({ role: 'brain', name: 'test-node', key: brain, peerKey: node.publicKey, send: () => {} });
  restarted.receive(oldInit); assert.equal(restarted.state, 'finish');
  assert.throws(() => restarted.receive(oldFinish), /expired session/); assert.throws(() => restarted.receive(oldData), /expired session/);
});

test('key files persist with 0600 permissions; duplicate case-insensitive names/keys rejected', t => {
  const root = fixture(t), file = path.join(root, 'data/keys/node.json');
  const key = loadKey(file, true); assert.equal(publicHex(loadKey(file)), publicHex(key));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => nodeKeys(`A:${publicHex(key)},a:${publicHex(key)}`), /Duplicate/);
  assert.throws(() => nodeKeys(`A:${publicHex(key)},B:${publicHex(key)}`), /Duplicate/);
});

test('relay routes opaque encrypted frames, blocks node-to-node, only one brain; health', async t => {
  const { url, relay } = await relayFixture(t); const brain = socket(url, 'brain'), node = socket(url, 'test-node'), other = socket(url, 'other');
  for (const ws of [brain, node, other]) t.after(() => ws.terminate());
  await Promise.all([brain, node, other].map(ws => once(ws, 'open')));
  const response = await fetch(url.replace('ws:', 'http:') + '/health'); assert.equal(response.status, 200);
  const seen = []; for (const ws of relay.wss.clients) ws.on('message', data => seen.push(Buffer.from(data)));
  const { client, server } = ciphers(); const frame = client.seal({ secret: 'local secret marker' });
  const delivered = new Promise(resolve => brain.on('message', (data, binary) => { if (binary) resolve(data); }));
  node.send(frame); assert.equal(server.open(await delivered).secret, 'local secret marker');
  assert.ok(seen.length > 0); assert.ok(seen.every(b => !b.includes(Buffer.from('local secret marker'))));
  const duplicate = socket(url, 'brain'); const dupClose = once(duplicate, 'close'); await once(duplicate, 'open'); assert.equal((await dupClose)[0], 4409);
  const blocked = once(node, 'close'); node.send(pack({ from: 'test-node', to: 'other', id: randomUUID() }, Buffer.from('opaque'))); assert.equal((await blocked)[0], 4403);
});

test('relay rejects unknown tokens and oversized frames with clear close codes', async t => {
  const { url } = await relayFixture(t); const bad = socket(url, 'test-node', 'wrong'); const denied = once(bad, 'close'); await once(bad, 'open'); assert.equal((await denied)[0], 4401);
  const node = socket(url, 'test-node'); await once(node, 'open'); const closed = once(node, 'close'); node.send(Buffer.alloc(MAX_MESSAGE + 1)); assert.equal((await closed)[0], 1009);
});

test('relay rate limit rejects floods without inspecting payload', async t => {
  const { url } = await relayFixture(t, { rate: 2 }); const node = socket(url, 'test-node'); await once(node, 'open'); const closed = once(node, 'close');
  for (let i = 0; i < 3; i++) node.send(pack({ from: 'test-node', to: 'brain', id: randomUUID() }, Buffer.from('opaque')));
  assert.equal((await closed)[0], 4429);
});

test('real encrypted relay node status, case-insensitive names and offline last seen', async t => {
  const { url, relay } = await relayFixture(t); const brainKey = sodium.crypto_kx_keypair(), key = sodium.crypto_kx_keypair();
  const seen = []; relay.wss.on('connection', ws => ws.on('message', data => seen.push(Buffer.from(data))));
  const hub = new NodeHub({ port: 0, key: brainKey, trustedKeys: nodeKeys(`TEST-NODE:${publicHex(key)}`), tokens: new Map(), relayURL: url, relayToken: 'token-brain', log: () => {} }); await hub.ready; t.after(() => hub.close());
  const node = startNode({ transport: 'relay', url, token: 'token-test-node', machine: 'Test-Node', key, brainKey: brainKey.publicKey, log: () => {}, status: async () => ({ marker: 'secret status value', uptime: 42, cpu: { loadPercent: 3 }, memory: { total: 50e9, used: 6e9 }, disks: [] }) }); t.after(() => node.close());
  await until(() => hub.list()[0].online); assert.equal((await hub.request('TEST-node', 'status')).marker, 'secret status value');
  assert.ok(seen.every(b => !b.includes(Buffer.from('secret status value')) && !b.includes(Buffer.from('hostname'))));
  node.close(); await until(() => !hub.list()[0].online); assert.match(await machinesText(hub), /last seen \d{4}-/);
});

for (const scenario of ['unknown', 'wrong-key', 'wrong-name']) test(`valid relay token cannot bypass E2E trust: ${scenario}`, async t => {
  const { url } = await relayFixture(t); const brainKey = sodium.crypto_kx_keypair(), trusted = sodium.crypto_kx_keypair(), wrong = sodium.crypto_kx_keypair();
  const config = scenario === 'unknown' ? '' : scenario === 'wrong-name' ? `other:${publicHex(trusted)}` : `test-node:${publicHex(trusted)}`;
  const hub = new NodeHub({ port: 0, key: brainKey, trustedKeys: nodeKeys(config), tokens: new Map(), relayURL: url, relayToken: 'token-brain', log: () => {} }); await hub.ready; t.after(() => hub.close());
  const logs = [], node = startNode({ transport: 'relay', url, token: 'token-test-node', machine: 'test-node', key: scenario === 'wrong-key' ? wrong : trusted, brainKey: brainKey.publicKey, log: m => logs.push(m) }); t.after(() => node.close());
  const [error] = await once(node, 'fatal'); assert.match(error.message, /key|authentication/i); assert.ok(hub.list().every(n => !n.online)); assert.ok(logs.some(s => s.includes('rejected')));
});

test('loopback requires both local token and E2E key, rejects public binding', async t => {
  const brainKey = sodium.crypto_kx_keypair(), key = sodium.crypto_kx_keypair();
  assert.throws(() => new NodeHub({ host: '0.0.0.0', key: brainKey }), /loopback/);
  const hub = new NodeHub({ port: 0, key: brainKey, trustedKeys: nodeKeys(`test-node:${publicHex(key)}`), tokens: parseTokens('test-node:token-0123456789'), relayURL: '' }); await hub.ready; t.after(() => hub.close());
  const node = startNode({ url: `ws://127.0.0.1:${hub.server.address().port}`, token: 'token-0123456789', machine: 'TEST-NODE', key, brainKey: brainKey.publicKey, status: async () => ({ okay: true }), log: () => {} }); t.after(() => node.close());
  await until(() => hub.list()[0].online); assert.equal((await hub.request('test-node', 'status')).okay, true);
});

function gitRepo(t) {
  const root = fixture(t); const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'test'); git('config', 'user.name', 'Test bIT'); git('config', 'user.email', 'bit@example.invalid');
  for (const dir of ['bit/memory', 'bit/skills', 'src']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'data/\n'); fs.writeFileSync(path.join(root, 'bit/memory/profile.md'), 'Owner: Test'); fs.writeFileSync(path.join(root, 'src/main.js'), 'old'); git('add', '.'); git('commit', '-m', 'initial'); return { root, git };
}
test('approved skill auto-commit includes only that folder and preserves unrelated staged source/env', async t => {
  const { root, git } = gitRepo(t), notes = [];
  const growth = new Growth({ root, notify: async s => notes.push(s) }); t.after(() => growth.close());
  fs.writeFileSync(path.join(root, 'src/main.js'), 'new'); fs.writeFileSync(path.join(root, '.env'), 'DO_NOT_COMMIT=test'); git('add', 'src', '.env');
  fs.mkdirSync(path.join(root, 'bit/skills/demo')); fs.writeFileSync(path.join(root, 'bit/skills/demo/SKILL.md'), 'instruction');
  await growth.written('bit/skills/demo/SKILL.md');
  assert.equal(git('log', '-1', '--format=%s'), 'bIT: add skill demo'); assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'bit/skills/demo/SKILL.md');
  assert.equal(git('diff', '--cached', '--name-only'), '.env\nsrc/main.js'); assert.equal(notes.length, 1);
  fs.appendFileSync(path.join(root, 'bit/skills/demo/SKILL.md'), '\nmore'); await growth.written('bit/skills/demo/SKILL.md'); assert.equal(git('log', '-1', '--format=%s'), 'bIT: update skill demo');
});
test('memory auto-commit batches at most hourly across restarts and rejects outside paths', async t => {
  const { root, git } = gitRepo(t); let now = Date.now();
  const growth = new Growth({ root, now: () => now }); t.after(() => growth.close());
  fs.appendFileSync(path.join(root, 'bit/memory/profile.md'), '\nnotes'); await growth.memory(); assert.equal(git('log', '-1', '--format=%s'), 'initial');
  now += 3600000; await growth.memory(); assert.match(git('log', '-1', '--format=%s'), /^bIT: memory notes /);
  const head = git('rev-parse', 'HEAD'); fs.appendFileSync(path.join(root, 'bit/memory/profile.md'), '\nmore');
  const restarted = new Growth({ root, now: () => now }); t.after(() => restarted.close()); await restarted.memory(); assert.equal(git('rev-parse', 'HEAD'), head);
  await assert.rejects(growth.commit('src', 'bad'), /denied/);
});
test('auto-commit survives git and push failures without staging forbidden paths', async t => {
  const { root } = gitRepo(t), errors = [], calls = [];
  fs.mkdirSync(path.join(root, 'bit/skills/demo')); fs.writeFileSync(path.join(root, 'bit/skills/demo/SKILL.md'), 'test');
  const growth = new Growth({ root, push: true, log: (...args) => errors.push(args), run: async args => { calls.push(args); if (args.includes('push')) throw new Error('offline push'); return { stdout: args.includes('diff') ? 'bit/skills/demo/SKILL.md' : '' }; } }); t.after(() => growth.close());
  await assert.doesNotReject(growth.written('bit/skills/demo/SKILL.md')); assert.equal(errors.length, 1);
  assert.deepEqual(calls.find(args => args.includes('add')).slice(-3), ['add', '--', 'bit/skills/demo']);
  const broken = new Growth({ root, log: (...args) => errors.push(args), run: async () => { throw new Error('git unavailable'); } }); t.after(() => broken.close());
  await assert.doesNotReject(broken.written('bit/skills/demo/SKILL.md')); assert.equal(errors.length, 2);
});


test('owner button -> successful skill write -> real folder-only commit and note', async t => {
  const { root, git } = gitRepo(t), notes = [];
  const growth = new Growth({ root, notify: async text => notes.push(text) }); t.after(() => growth.close());
  const relay = new ApprovalRelay('owner'); t.after(() => relay.close()); let proposal;
  const channel = { id: 'thread', send: async value => { proposal = value; return { id: 'approval', edit: async () => {} }; } };
  const permissions = createPermissions({ root, approve: request => relay.request(channel, request), afterWrite: file => growth.written(file) });
  const input = { file_path: 'bit/skills/proof/SKILL.md', content: '---\nname: proof\ndescription: Approval proof\n---\nGive a short summary.' };
  const decision = permissions.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Write', tool_input: input }, 'proof-write', {});
  await until(() => Boolean(proposal));
  await relay.handle({ user: { id: 'owner' }, channelId: 'thread', message: { id: 'approval' }, customId: proposal.components[0].components[0].data.custom_id, deferUpdate: async () => {} });
  const result = (await decision).hookSpecificOutput; assert.equal(result.permissionDecision, 'allow');
  fs.mkdirSync(path.dirname(result.updatedInput.file_path), { recursive: true }); fs.writeFileSync(result.updatedInput.file_path, input.content);
  await permissions.hooks.PostToolUse[0].hooks[0]({ tool_name: 'Write', tool_input: result.updatedInput, tool_use_id: 'proof-write' });
  assert.equal(git('log', '-1', '--format=%s'), 'bIT: add skill proof');
  assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'bit/skills/proof/SKILL.md');
  assert.deepEqual(notes, ['🧠 bIT: add skill proof']);
});

test('relay closes dead connections without pong responses', async t => {
  const { url } = await relayFixture(t, { heartbeat: 20 });
  const node = new WebSocket(url, { autoPong: false, headers: { Authorization: 'Bearer token-test-node', 'X-Bit-Name': 'test-node' } });
  const closed = once(node, 'close'); await once(node, 'open'); assert.equal((await closed)[0], 1006);
});
