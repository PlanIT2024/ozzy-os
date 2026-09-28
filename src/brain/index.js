import path from 'node:path';
import { ROOT, required } from '../shared.js';
import { NodeHub } from './nodeHub.js';
import { Budget } from './budget.js';
import { Runner } from './runner.js';
import { createDiscord } from './discord.js';
import { acquireBrainLock, installShutdown } from './lock.js';
required(process.env, ['ANTHROPIC_API_KEY', 'DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID', 'BIT_CHANNEL_ID', 'OWNER_DISCORD_ID']);
const unlock = acquireBrainLock(path.join(ROOT, 'data/brain.lock'));
let hub, runner, discord;
installShutdown(unlock, async () => {
  try { runner?.close(); }
  finally { try { discord?.close(); } finally { await hub?.close(); } }
});
try {
  const budget = new Budget();
  hub = new NodeHub(); await hub.ready;
  runner = new Runner({ hub, budget });
  discord = createDiscord({ runner, hub, budget }); await discord.start();
  console.log(`bIT awake. Node hub on ${process.env.NODE_HUB_BIND || '127.0.0.1'}:${process.env.NODE_HUB_PORT || 8787}`);
} catch (error) {
  runner?.close(); discord?.close(); await hub?.close(); unlock(); throw error;
}
