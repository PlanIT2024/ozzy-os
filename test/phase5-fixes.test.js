import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../src/brain/runner.js';
import { Budget } from '../src/brain/budget.js';
import { Transcript } from '../src/brain/transcript.js';

test('text context survives grant on, screen run, grant off and brain restart; no-grant tool stays hidden', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-continuity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const area of ['memory', 'skills', 'persona']) fs.mkdirSync(path.join(root, 'bit', area), { recursive: true });
  fs.writeFileSync(path.join(root, 'bit/persona/persona.md'), 'bIT');
  const hub = { list: () => [{ machine: 'OZZY-AI', online: true, capabilities: ['screen'] }] };
  let calls = 0;
  const queryFn = async function* ({ prompt, options }) {
    let text; for await (const message of prompt) text = message.message.content;
    if (calls++) assert.match(text, /favorite constellation is Orion/);
    if (options.persistSession === false) { assert.ok(options.mcpServers.screens); assert.equal(options.resume, undefined); }
    else { assert.equal(options.mcpServers.screens, undefined); assert.match(options.systemPrompt, /Screenshots are available on OZZY-AI/); assert.match(options.systemPrompt, /\/screen on enables screenshots for 15 minutes in this thread/); }
    yield { type: 'result', subtype: 'success', session_id: options.persistSession === false ? 'ephemeral' : 'persistent', total_cost_usd: 0, result: 'Your favorite constellation is Orion.' };
  };
  const make = () => new Runner({ root, hub, queryFn, budget: new Budget({ file: path.join(root, 'data/budget.json'), cap: 1 }) });
  let runner = make();
  await runner.run('thread', 'My favorite constellation is Orion.');
  const before = runner.transcript.context('thread');
  runner.screens.on('thread', 'OZZY-AI');
  assert.equal(runner.transcript.context('thread'), before);
  assert.match(await runner.run('thread', 'What was my first message?'), /Orion/);
  assert.equal(runner.sessions.thread, 'persistent');
  runner.screens.off('thread');
  assert.match(await runner.run('thread', 'What did we discuss during the grant?'), /Orion/);
  runner.close(); runner = make();
  assert.match(await runner.run('thread', 'Remember my first message?'), /Orion/);
  await runner.reset('thread'); assert.equal(runner.transcript.context('thread'), ''); runner.close();
});

test('transcript caps and summarizes older turns, omits encoded images and imports only SDK text', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = new Transcript(root);
  const directory = path.join(root, 'data/claude/projects/project'); fs.mkdirSync(directory, { recursive: true });
  const pixels = 'A'.repeat(1000);
  fs.writeFileSync(path.join(directory, 'legacy.jsonl'), JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'First message Orion' }, { type: 'image', data: pixels }, { type: 'tool_result', content: pixels }] } }));
  transcript.bootstrap('thread', 'legacy', root);
  assert.match(transcript.context('thread'), /First message Orion/);
  for (let i = 0; i < 100; i++) transcript.append('thread', 'Ozzy', `Turn ${i}: data:image/png;base64,${pixels} ${pixels} ${'words '.repeat(300)}`);
  const state = transcript.read('thread');
  assert.ok(state.turns.length <= 24); assert.ok(state.summary.length <= 12000);
  assert.match(state.summary, /First message Orion/);
  assert.ok(JSON.stringify(state).length < 62000); assert.ok(!JSON.stringify(state).includes(pixels));
});
