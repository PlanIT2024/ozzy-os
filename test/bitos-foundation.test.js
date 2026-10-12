import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMirrorClient } from '../src/bitos/client.js';
import { Outbox } from '../src/bitos/outbox.js';
import { redact } from '../src/bitos/redact.js';

test('disabled client never loads SDK or creates a client', async () => {
  for (const flag of [undefined, '0']) {
    assert.equal(await createMirrorClient({ BITOS_SUPABASE: flag }, () => { throw Error('SDK loaded'); }), null);
  }
});

test('redaction removes credentials, env, typed text, file and image content', () => {
  const result = redact({ summary: 'fake-token-value API_KEY=fake-env-secret', text: 'private typing', content: 'file contents', pixels: Buffer.from('image'), nested: { password: 'secret', summary: 'sk-fake123456' } }, { TEST_TOKEN: 'fake-token-value' });
  const encoded = JSON.stringify(result);
  for (const secret of ['fake-token-value', 'fake-env-secret', 'private typing', 'file contents', 'sk-fake123456']) assert.ok(!encoded.includes(secret));
  assert.equal(result.text_length, 14);
});

async function box(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bitos-test-'));
  const scheduled = [];
  const outbox = new Outbox({ directory, env: {}, schedule: (fn, delay) => { scheduled.push({ fn, delay }); return { unref() {} }; }, ...options });
  t.after(async () => { outbox.close(); await outbox.storage.catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  await outbox.ready;
  return { outbox, directory, scheduled };
}

test('failures persist, retries back off, restart replays stable ids', async t => {
  let time = 0, fail = true;
  const rows = new Map(), logs = [];
  const write = async entry => { if (fail) throw Error('bad key'); rows.set(entry.payload.id, entry.payload); };
  const { outbox, directory } = await box(t, { now: () => time, write, log: message => logs.push(message) });
  outbox.enqueue('tasks', { id: 'stable', status: 'running' });
  await outbox.flush(); assert.equal(outbox.entries[0].next, 1000);
  time = 1000; await outbox.flush(); assert.equal(outbox.entries[0].next, 3000);
  const persisted = await fs.readFile(outbox.file, 'utf8'); assert.ok(persisted.includes('stable'));
  outbox.close(); fail = false; time = 3000;
  const replay = new Outbox({ directory, write, env: {}, now: () => time, schedule: () => ({ unref() {} }) });
  await replay.ready; await replay.flush();
  replay.enqueue('tasks', { id: 'stable', status: 'done' }); await replay.flush();
  assert.equal(rows.size, 1); assert.equal(rows.get('stable').status, 'done');
  assert.equal(await fs.readFile(replay.file, 'utf8'), ''); replay.close();
});

test('bounded outbox drops oldest and warns once', async t => {
  const logs = [];
  const { outbox } = await box(t, { limit: 3, write: async () => {}, log: message => logs.push(message) });
  for (let i = 0; i < 8; i++) outbox.enqueue('tasks', { id: String(i) });
  assert.deepEqual(outbox.entries.map(e => e.payload.id), ['5', '6', '7']);
  assert.equal(logs.length, 1);
});

test('enqueue returns before network starts or completes; thrown writes stay isolated', async t => {
  let called = false, reject;
  const { outbox } = await box(t, { write: () => { called = true; return new Promise((_, no) => { reject = no; }); }, log: () => {} });
  assert.equal(outbox.enqueue('tasks', { id: 'stable' }), undefined); assert.equal(called, false);
  const flushing = outbox.flush();
  while (!called) await new Promise(resolve => setImmediate(resolve));
  assert.equal(outbox.enqueue('tasks', { id: 'next' }), undefined);
  reject(Error('Supabase exploded')); await flushing;
  assert.equal(outbox.entries.length, 2);
});

test('retry delay reaches five-minute cap and new writes persist during a hung request', async t => {
  let time = 0;
  const { outbox } = await box(t, { now: () => time, write: async () => { throw Error('offline'); }, log() {} });
  outbox.enqueue('tasks', { id: 'first' });
  let delay;
  for (let i = 0; i < 12; i++) { await outbox.flush(); delay = outbox.entries[0].next - time; time = outbox.entries[0].next; }
  assert.equal(delay, 300000);
  let entered = false, finish;
  outbox.write = () => { entered = true; return new Promise(resolve => { finish = resolve; }); };
  const flushing = outbox.flush(); while (!entered) await new Promise(resolve => setImmediate(resolve));
  outbox.enqueue('tasks', { id: 'second' }); await outbox.storage;
  assert.ok((await fs.readFile(outbox.file, 'utf8')).includes('second'));
  outbox.close(); finish(); await flushing;
});
