import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, MessageFlags } from 'discord.js';
import { ROOT, required } from '../shared.js';
export function splitMessage(text, limit = 2000) {
  const chunks = []; text = String(text);
  while (text.length > limit) {
    let end = text.lastIndexOf('\n', limit); if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text); return chunks;
}
export async function sendText(channel, text) {
  for (const content of splitMessage(text)) await channel.send({ content, allowedMentions: { parse: [] } });
}
export function allowedLocation(channel, bitChannel) { return Boolean(channel && (channel.isDMBased() || channel.id === bitChannel || (channel.isThread() && channel.parentId === bitChannel))); }
export function acceptsMessage(message, owner, bitChannel) { return !message.author.bot && message.author.id === owner && allowedLocation(message.channel, bitChannel); }
export function commands() {
  return [
    new SlashCommandBuilder().setName('mood').setDescription('Set bIT’s daytime personality').addStringOption(o => o.setName('personality').setDescription('Voice').setRequired(true).addChoices(...['chill', 'hype', 'chaotic', 'gremlin', 'sage'].map(name => ({ name, value: name })))),
    new SlashCommandBuilder().setName('machines').setDescription('Show machines and live status'),
    new SlashCommandBuilder().setName('budget').setDescription('Show this month’s juice meter'),
    new SlashCommandBuilder().setName('reset').setDescription('Start a fresh session in this thread or DM'),
  ].map(c => c.toJSON());
}
export class ApprovalRelay {
  constructor(owner, { timeout = 600000 } = {}) { this.owner = owner; this.timeout = timeout; this.pending = new Map(); }
  async request(channel, { tool, file, input, signal }) {
    if (signal?.aborted) return false;
    const id = randomUUID();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve:${id}:yes`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`approve:${id}:no`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger));
    // Show the complete proposed operation; large edits are reviewable as an attachment.
    const review = JSON.stringify({ tool, file, ...input }, null, 2);
    const message = await channel.send({ content: `Skill change needs your say-so, Ozzy: ${tool} ${file}\nExpires in 10 minutes.`, files: [{ attachment: Buffer.from(review), name: 'proposed-skill-change.json' }], components: [row], allowedMentions: { parse: [] } });
    return new Promise(resolve => {
      let done = false;
      const finish = async (allowed, reason) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(id);
        try { await message.edit({ content: `${allowed ? '✅ Approved' : '❌ Denied'}: ${file} (${reason})`, components: [], allowedMentions: { parse: [] } }); } catch { /* decision still resolves if Discord loses the message */ }
        resolve(allowed);
      };
      const cancel = () => { void finish(false, 'cancelled'); };
      const timer = setTimeout(() => { void finish(false, 'approval timed out'); }, this.timeout);
      this.pending.set(id, { channel: channel.id, message: message.id, finish });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  async handle(interaction) {
    if (interaction.user.id !== this.owner) return;
    const match = /^approve:([^:]+):(yes|no)$/.exec(interaction.customId || '');
    if (!match) return;
    const pending = this.pending.get(match[1]);
    if (!pending || pending.channel !== interaction.channelId || pending.message !== interaction.message.id) {
      await interaction.reply({ content: 'That approval has expired.', flags: MessageFlags.Ephemeral }); return;
    }
    await interaction.deferUpdate(); await pending.finish(match[2] === 'yes', 'owner decision');
  }
  close() { for (const p of this.pending.values()) void p.finish(false, 'brain shutting down'); }
}
export async function machinesText(hub, onError = () => {}) {
  const machines = hub.list(); if (!machines.length) return 'No machines registered yet. My ring is listening.';
  return (await Promise.all(machines.map(async machine => {
    if (!machine.online) return `⚫ ${machine.machine}: offline`;
    try {
      const s = await hub.request(machine.machine, 'status');
      return `🟢 ${machine.machine}: online\n${JSON.stringify(s, null, 2)}`;
    } catch (e) { onError(e, { machine: machine.machine }); return `🟡 ${machine.machine}: my status sensor hit a snag. Try again in a moment, Ozzy.`; }
  }))).join('\n\n');
}
export function createDiscord({ runner, hub, budget, env = process.env, auditFile = path.join(ROOT, 'data/audit.log'), client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] }) }) {
  const owner = env.OWNER_DISCORD_ID, bitChannel = env.BIT_CHANNEL_ID;
  const approvals = new ApprovalRelay(owner);
  const fail = (error, context = {}) => {
    console.error('Discord operation failed:', context, error);
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(auditFile, JSON.stringify({ time: new Date().toISOString(), event: 'discord_error', ...context, error: inspect(error, { depth: null }), stack: error?.stack || String(error) }) + '\n', { mode: 0o600 });
    } catch (auditError) { console.error('Could not write Discord error audit:', auditError); }
  };
  client.on('error', fail);
  client.on('messageCreate', async message => {
    if (!acceptsMessage(message, owner, bitChannel)) return;
    let channel = message.channel;
    try {
      if (!message.content.trim()) return;
      if (channel.id === bitChannel && !channel.isThread()) channel = await message.startThread({ name: `bIT · ${message.content.slice(0, 70).replace(/\s+/g, ' ')}`, autoArchiveDuration: 1440 });
      await channel.sendTyping();
      const response = await runner.run(channel.id, message.content, { notify: text => sendText(channel, text), approve: request => approvals.request(channel, request) });
      await sendText(channel, response);
    } catch (e) { fail(e); await sendText(channel, 'My ring hit a snag. Check the brain console, Ozzy.').catch(fail); }
  });
  client.on('interactionCreate', async interaction => {
    const ownerPassed = interaction.user.id === owner;
    const context = { command: interaction.commandName || interaction.customId || `type:${interaction.type}`, userId: interaction.user.id, ownerPassed };
    console.log(`Discord interaction: command=${context.command} user=${context.userId} owner=${ownerPassed}`);
    if (!ownerPassed) return;
    try {
      if (interaction.isChatInputCommand()) {
        // Acknowledge before channel resolution, validation, or any command work.
        await interaction.deferReply();
      } else {
        if (interaction.isButton() && allowedLocation(interaction.channel, bitChannel)) await approvals.handle(interaction);
        return;
      }
      const channel = interaction.channel || await client.channels.fetch(interaction.channelId);
      if (!allowedLocation(channel, bitChannel)) {
        await interaction.editReply({ content: 'Catch me in #bit or one of its threads, Ozzy.', allowedMentions: { parse: [] } });
        return;
      }
      let response;
      switch (interaction.commandName) {
        case 'mood': {
          const mood = interaction.options.getString('personality', true); runner.mood(mood);
          response = `Default personality saved: ${mood}. Sage still takes the night shift, 10pm–5am.`; break;
        }
        case 'budget': {
          const s = budget.status(); response = `Juice meter · ${s.month}: $${s.spent.toFixed(4)} / $${s.cap.toFixed(2)}${s.uncertain ? ' — reconciliation needed after an interrupted run' : ''}`; break;
        }
        case 'machines': response = await machinesText(hub, (error, details) => fail(error, { ...context, ...details })); break;
        case 'reset':
          if (!channel.isDMBased() && !channel.isThread()) response = 'Use /reset inside the thread you want to refresh.';
          else { await runner.reset(interaction.channelId); response = 'Fresh thoughts, same orb. This conversation starts a new session next message.'; }
          break;
        default: response = 'Unknown command.';
      }
      const chunks = splitMessage(response); await interaction.editReply({ content: chunks.shift(), allowedMentions: { parse: [] } });
      for (const content of chunks) await interaction.followUp({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      fail(error, context);
      const response = { content: 'My ring hit a snag, Ozzy. Try again in a moment.', allowedMentions: { parse: [] } };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(response);
        else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
      } catch (replyError) { fail(replyError, { ...context, stage: 'error_reply' }); }
    }
  });
  return { client, approvals, async start() { await client.login(env.DISCORD_TOKEN); }, close() { approvals.close(); client.destroy(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--register')) {
  required(process.env, ['DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID']);
  await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, process.env.DISCORD_GUILD_ID), { body: commands() });
  console.log('Registered /mood, /machines, /budget and /reset in the configured guild.');
}
