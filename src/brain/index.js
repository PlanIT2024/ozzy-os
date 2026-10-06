import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, required } from '../shared.js';
import { NodeHub } from './nodeHub.js';
import { Growth } from './growth.js';
import { Budget } from './budget.js';
import { Scheduler } from './scheduler.js';
import { Reminders } from './reminders.js';
import { Runner } from './runner.js';
import { createDiscord } from './discord.js';
import { acquireBrainLock, installShutdown } from './lock.js';

export async function runBrain({ root = ROOT, env = process.env, runtime = process,
  makeHub = () => new NodeHub(), makeBudget = () => new Budget(),
  makeGrowth = options => new Growth(options), makeRunner = options => new Runner(options), makeDiscord = createDiscord, makeScheduler = options => new Scheduler(options), makeReminders = options => new Reminders(options) } = {}) {
  let unlock = () => {}, hub, runner, discord, growth, scheduler, reminders;
  async function cleanup() {
    try { scheduler?.close(); reminders?.close(); runner?.close(); await growth?.close(); }
    finally { try { discord?.close(); } finally { try { await hub?.close(); } finally { unlock(); } } }
  }
  try {
    required(env, ['ANTHROPIC_API_KEY', 'DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID', 'BIT_CHANNEL_ID', 'OWNER_DISCORD_ID']);
    unlock = acquireBrainLock(path.join(root, 'data/brain.lock'));
    installShutdown(unlock, cleanup, runtime);
    const budget = makeBudget();
    hub = makeHub(); await hub.ready;
    growth = makeGrowth({ root, notify: text => discord?.notifyGrowth(text) });
    reminders = makeReminders({ root, timezone: env.TZ || 'America/New_York', deliver: (reminder, context) => discord.deliverReminder(reminder, context) });
    scheduler = makeScheduler({ root, timezone: env.TZ || 'America/New_York', execute: (job, context) => discord.runScheduled(job, context) });
    runner = makeRunner({ hub, budget, root, growth, reminders });
    discord = makeDiscord({ runner, hub, budget, scheduler, reminders, env }); await discord.start();
    await reminders.start();
    void scheduler.start().catch(error => console.error('Scheduler startup failed:', error));
    console.log(`bIT awake. Node hub on ${env.NODE_HUB_BIND || '127.0.0.1'}:${env.NODE_HUB_PORT || 8787}`);
    await Promise.race([discord.failure, hub.failure || new Promise(() => {})]);
  } catch (error) {
    console.error('bIT stopped after startup/Discord failure:', error);
    runtime.exitCode = 1;
    try { await cleanup(); } catch (cleanupError) { console.error('bIT cleanup failed:', cleanupError); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runBrain();
