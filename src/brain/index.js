import fs from 'node:fs';
import path from 'node:path';
import { ROOT, required } from '../shared.js';
import { NodeHub } from './nodeHub.js';
import { Budget } from './budget.js';
import { Runner } from './runner.js';
import { createDiscord } from './discord.js';
required(process.env, ['ANTHROPIC_API_KEY', 'DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID', 'BIT_CHANNEL_ID', 'OWNER_DISCORD_ID']);
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true, mode: 0o700 });
const lock = path.join(ROOT, 'data/brain.lock');
try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
catch { throw new Error('Brain lock exists. Stop the other brain, or remove data/brain.lock after verifying its PID is no longer running.'); }
let hub, runner, discord;
const unlock = () => { try { fs.unlinkSync(lock); } catch {} };
process.once('exit', unlock);
try {
  const budget = new Budget();
  hub = new NodeHub(); await hub.ready;
  runner = new Runner({ hub, budget });
  discord = createDiscord({ runner, hub, budget }); await discord.start();
  console.log(`bIT awake. Node hub on ${process.env.NODE_HUB_BIND || '127.0.0.1'}:${process.env.NODE_HUB_PORT || 8787}`);
} catch (error) {
  runner?.close(); discord?.close(); await hub?.close(); unlock(); throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  runner.close(); discord.close(); await hub.close(); unlock();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
