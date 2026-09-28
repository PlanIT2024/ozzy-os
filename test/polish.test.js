import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Events } from 'discord.js';
import { skillOptions } from '../src/brain/runner.js';
import { createPermissions } from '../src/brain/permissions.js';
import { createDiscord, machineLine, machinesText } from '../src/brain/discord.js';
import { usableDisks, startNode } from '../src/node/index.js';
import { runBrain } from '../src/brain/index.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-polish-'));
  for (const dir of ['.git', 'bit/skills', 'bit/memory', 'bit/persona']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function skill(root, relative, name) {
  const dir = path.join(root, relative, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\nBe helpful.`);
}
const env = { ANTHROPIC_API_KEY: 'test', DISCORD_TOKEN: 'test', DISCORD_APP_ID: 'app', DISCORD_GUILD_ID: 'guild', OWNER_DISCORD_ID: 'owner', BIT_CHANNEL_ID: 'bit' };
function client() { const c = new EventEmitter(); c.destroy = () => {}; return c; }

test('real SDK available skills equal bit/skills folders; user settings and bundled skills excluded', { timeout: 20000 }, async t => {
  const root = fixture(t);
  for (const name of ['weekly-summary', 'notes']) skill(root, 'bit/skills', name);
  const config = path.join(root, 'user-config');
  skill(root, 'user-config/skills', 'forbidden-user-skill');
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ disableBundledSkills: false, env: { BIT_USER_SETTINGS_LEAK: 'yes' } }));
  const options = skillOptions(root);
  const folders = fs.readdirSync(path.join(root, 'bit/skills')).sort();
  assert.deepEqual(options.skills, folders);
  assert.deepEqual(options.settingSources, ['project']);
  let release; const wait = new Promise(resolve => { release = resolve; });
  // No prompt is sent: inspect the actual SDK command surface without API use.
  const sdk = query({ prompt: (async function* () { await wait; })(), options: {
    ...options, cwd: root, tools: ['Skill'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' },
  } });
  const timer = setTimeout(() => sdk.close(), 15000);
  try {
    const commands = await sdk.supportedCommands();
    const available = commands.filter(command => !command.builtin).map(command => command.name).sort();
    assert.deepEqual(available, folders);
  } finally { clearTimeout(timer); release(); sdk.close(); }
});

test('home Claude writes and alternate nested discovery directories denied', async t => {
  const root = fixture(t), p = createPermissions({ root, approve: async () => true });
  for (const file of ['~/.claude/settings.json', path.join(os.homedir(), '.claude/skills/rogue/SKILL.md'), path.join(os.homedir(), '.claude/settings.json'), 'bit/memory/.claude/settings.json', 'bit/skills/.agents/skills/rogue.md']) {
    for (const tool of ['Write', 'Edit']) assert.equal((await p.canUseTool(tool, { file_path: file, content: '{}' })).behavior, 'deny');
  }
  skill(root, 'bit/skills', 'valid'); skillOptions(root);
  fs.writeFileSync(path.join(root, '.claude/settings.json'), '{}');
  assert.throws(() => skillOptions(root), /Unexpected project Claude configuration/);
});

test('owner chat cannot approve pending skill write; only owner affirmative button can', async t => {
  const root = fixture(t), c = client(), messages = [];
  const channel = { id: 'thread', parentId: 'bit', isDMBased: () => false, isThread: () => true, sendTyping: async () => {},
    send: async payload => { messages.push(payload); return { id: 'proposal', edit: async () => {} }; } };
  const adapter = createDiscord({ client: c, env, auditFile: path.join(root, 'audit.log'), hub: {}, budget: {}, runner: { run: async () => 'I still need the button, Ozzy.' } });
  t.after(() => adapter.close());
  const policy = createPermissions({ root, approve: request => adapter.approvals.request(channel, request) });
  let settled = false;
  const pending = policy.canUseTool('Write', { file_path: 'bit/skills/demo/SKILL.md', content: '---\nname: demo\ndescription: Demo\n---\nInstructions.' }).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  const yes = messages[0].components[0].components[0].data.custom_id;
  for (const content of ['approved', 'sounds good']) {
    await c.listeners('messageCreate')[0]({ author: { id: 'owner', bot: false }, channel, content });
    assert.equal(settled, false); assert.equal(adapter.approvals.pending.size, 1);
  }
  const button = { user: { id: 'other' }, customId: yes, channelId: 'thread', channel, message: { id: 'proposal' }, isChatInputCommand: () => false, isButton: () => true, deferUpdate: async () => {} };
  await c.listeners('interactionCreate')[0](button); assert.equal(settled, false);
  button.user.id = 'owner'; await c.listeners('interactionCreate')[0](button);
  assert.equal((await pending).behavior, 'allow'); assert.equal(adapter.approvals.pending.size, 0);
});

test('machine lines are concise and raw tool status stays intact', async () => {
  const status = { uptime: 3 * 86400 + 90, cpu: { loadPercent: 8.1 }, memory: { used: 6e9, total: 50e9 }, disks: [{ mount: '/', usePercent: 6.2 }] };
  assert.equal(machineLine('OZZY-AI', status), 'OZZY-AI 🟢 up 3d · CPU 8% · RAM 6/50 GB · disk 6%');
  const before = JSON.stringify(status);
  const text = await machinesText({ list: () => [{ machine: 'OZZY-AI', online: true }, { machine: 'MAC', online: false }], request: async () => status });
  assert.equal(text.split('\n').length, 2); assert.ok(!text.includes('{')); assert.equal(JSON.stringify(status), before);
  assert.match(machineLine('WIN', { ...status, disks: [{ mount: 'D:', usePercent: 90 }, { mount: 'C:', usePercent: 20 }] }), /disk 20%/);
});

test('disk filter removes pseudo/system mounts and keeps Linux, macOS and Windows storage', () => {
  const kept = [{ mount: '/', fs: '/dev/nvme0n1p2', type: 'ext4', size: 100 }, { mount: '/home', fs: '/dev/sda1', type: 'btrfs', size: 100 }, { mount: '/System/Volumes/Data', type: 'apfs', size: 100 }, { mount: 'C:', type: 'NTFS', size: 100 }];
  const excluded = [{ mount: '/sys/firmware/efi/efivars', type: 'efivarfs' }, { mount: '/boot/efi', type: 'vfat' }, { mount: '/tmp', type: 'tmpfs' }, { mount: '/snap/core/1', type: 'squashfs', fs: '/dev/loop0' }, { mount: '/var/lib/snapd/snap/core/1', fs: '/dev/loop1' }, { mount: '/other', fs: '/dev/loop2' }, { mount: '/run/user/1000', type: 'tmpfs' }].map(d => ({ size: 100, ...d }));
  assert.deepEqual(usableDisks([...kept, ...excluded]), kept);
});

test('node logs connected/disconnected only on changes, failed retries stay quiet', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [], logs = [];
  class Socket extends EventEmitter {
    constructor() { super(); sockets.push(this); this.readyState = 1; }
    send() {} ping() {} terminate() { this.emit('close'); }
  }
  const node = startNode({ machine: 'OZZY-AI', token: 'test', Socket, log: line => logs.push(line) });
  sockets[0].emit('error', new Error('offline')); sockets[0].emit('close');
  t.mock.timers.tick(1600); assert.equal(sockets.length, 2); assert.deepEqual(logs, []);
  sockets[1].emit('open'); t.mock.timers.tick(30000); assert.deepEqual(logs, ['bit-node OZZY-AI connected']);
  sockets[1].emit('error', new Error('lost')); sockets[1].emit('close'); t.mock.timers.tick(1600);
  sockets[2].emit('error', new Error('still offline')); sockets[2].emit('close');
  assert.deepEqual(logs, ['bit-node OZZY-AI connected', 'bit-node OZZY-AI disconnected']); node.close();
});

for (const mode of ['login', 'intents', 'gateway']) test(`Discord ${mode} failure logs fully, exits nonzero and removes lock`, async t => {
  const root = fixture(t), c = client(), runtime = new EventEmitter(), closed = [];
  c.destroy = () => closed.push('discord');
  c.login = async () => {
    if (mode === 'login') throw new Error('Invalid login token');
    c.emit(Events.ClientReady, { user: { tag: 'bIT#1234' } });
    setImmediate(() => {
      if (mode === 'intents') c.emit(Events.ShardDisconnect, { code: 4014, reason: 'Disallowed intents' });
      else c.emit(Events.ShardError, new Error('Gateway transport failure'));
    });
  };
  const output = [], errors = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => errors.push(args.map(String).join(' ')));
  await runBrain({ root, env, runtime, makeHub: () => ({ ready: Promise.resolve(), close: async () => closed.push('hub') }), makeBudget: () => ({}), makeRunner: () => ({ close: () => closed.push('runner') }),
    makeDiscord: options => createDiscord({ ...options, client: c, auditFile: path.join(root, 'data/audit.log') }) });
  assert.equal(runtime.exitCode, 1); assert.equal(fs.existsSync(path.join(root, 'data/brain.lock')), false);
  assert.deepEqual(closed, ['runner', 'discord', 'hub']);
  assert.match(fs.readFileSync(path.join(root, 'data/audit.log'), 'utf8'), /"stack":/);
  if (mode !== 'login') assert.ok(output.some(line => line === 'Discord connected as bIT#1234'));
  if (mode === 'intents') assert.ok(errors.some(line => line.includes('Message Content Intent')));
});
