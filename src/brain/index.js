import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, required } from '../shared.js';
import { NodeHub } from './nodeHub.js';
import { Budget } from './budget.js';
import { Runner } from './runner.js';
import { createDiscord } from './discord.js';
import { acquireBrainLock, installShutdown } from './lock.js';

export async function runBrain({ root = ROOT, env = process.env, runtime = process,
  makeHub = () => new NodeHub(), makeBudget = () => new Budget(),
  makeRunner = options => new Runner(options), makeDiscord = createDiscord } = {}) {
  let unlock = () => {}, hub, runner, discord;
  async function cleanup() {
    try { runner?.close(); }
    finally { try { discord?.close(); } finally { try { await hub?.close(); } finally { unlock(); } } }
  }
  try {
    required(env, ['ANTHROPIC_API_KEY', 'DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID', 'BIT_CHANNEL_ID', 'OWNER_DISCORD_ID']);
    unlock = acquireBrainLock(path.join(root, 'data/brain.lock'));
    installShutdown(unlock, cleanup, runtime);
    const budget = makeBudget();
    hub = makeHub(); await hub.ready;
    runner = makeRunner({ hub, budget, root });
    discord = makeDiscord({ runner, hub, budget, env }); await discord.start();
    console.log(`bIT awake. Node hub on ${env.NODE_HUB_BIND || '127.0.0.1'}:${env.NODE_HUB_PORT || 8787}`);
    await discord.failure;
  } catch (error) {
    console.error('bIT stopped after startup/Discord failure:', error);
    runtime.exitCode = 1;
    try { await cleanup(); } catch (cleanupError) { console.error('bIT cleanup failed:', cleanupError); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runBrain();
