import { retryNetwork, temporary } from '../networkRetry.js';
import { zonedTime } from './scheduler.js';
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client, Events, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, MessageFlags } from 'discord.js';
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
  const sent = [];
  for (const content of splitMessage(text)) sent.push(await channel.send({ content, flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } }));
  return sent;
}
export function allowedLocation(channel, bitChannel) { return Boolean(channel && (channel.isDMBased() || channel.id === bitChannel || (channel.isThread() && channel.parentId === bitChannel))); }
export function acceptsMessage(message, owner, bitChannel) { return !message.author.bot && message.author.id === owner && allowedLocation(message.channel, bitChannel); }
export function commands() {
  return [
    new SlashCommandBuilder().setName('mood').setDescription('Set bIT’s daytime personality').addStringOption(o => o.setName('personality').setDescription('Voice').setRequired(true).addChoices(...['chill', 'hype', 'chaotic', 'gremlin', 'sage'].map(name => ({ name, value: name })))),
    new SlashCommandBuilder().setName('machines').setDescription('Show machines and live status'),
    new SlashCommandBuilder().setName('budget').setDescription('Show this month’s juice meter'),
    new SlashCommandBuilder().setName('screen').setDescription('Grant read-only screen access in this conversation')
      .addSubcommand(s => s.setName('on').setDescription('Grant 15 minutes of read-only capture').addStringOption(o => o.setName('machine').setDescription('Machine name (optional if just one has screen)')))
      .addSubcommand(s => s.setName('off').setDescription('Revoke this conversation’s screen grant'))
      .addSubcommand(s => s.setName('status').setDescription('Show this conversation’s screen grant')),
    new SlashCommandBuilder().setName('control').setDescription('Owner task or step-approved computer input (shell-level access)')
      .addSubcommand(s => s.setName('on').setDescription('Grant up to 10 minutes; task mode by default').addStringOption(o=>o.setName('mode').setDescription('task (default) or step').addChoices({name:'task',value:'task'},{name:'step',value:'step'})).addStringOption(o => o.setName('machine').setDescription('Machine name')).addBooleanOption(o => o.setName('with-screen').setDescription('Also start the required screen grant')))
      .addSubcommand(s => s.setName('off').setDescription('Stop input and revoke this grant'))
      .addSubcommand(s => s.setName('status').setDescription('Show input grant and step count'))
      .addSubcommand(s => s.setName('preview').setDescription('Attach a small target crop to step cards').addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true).addChoices({name:'on',value:'on'},{name:'off',value:'off'}))),
    new SlashCommandBuilder().setName('schedule').setDescription('Manage bIT scheduled jobs')
      .addSubcommand(s => s.setName('list').setDescription('List jobs and next run times'))
      .addSubcommand(s => s.setName('pause').setDescription('Pause a job').addStringOption(o => o.setName('name').setDescription('Schedule name').setRequired(true)))
      .addSubcommand(s => s.setName('resume').setDescription('Resume a job').addStringOption(o => o.setName('name').setDescription('Schedule name').setRequired(true)))
      .addSubcommand(s => s.setName('run').setDescription('Run a job now in a new thread').addStringOption(o => o.setName('name').setDescription('Schedule name').setRequired(true))),
    new SlashCommandBuilder().setName('reset').setDescription('Start a fresh session in this thread or DM'),
  ].map(c => c.toJSON());
}
// Discord serves JSON attachments as ISO-8859-1 despite UTF-8 upload bytes.
// ASCII JSON escapes are charset-independent and decode to the exact reviewed strings.
export function asciiJSON(value, replacer=null, space=2){return JSON.stringify(value,replacer,space).replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));}
export class ApprovalRelay {
  constructor(owner, { timeout = 600000 } = {}) { this.owner = owner; this.timeout = timeout; this.pending = new Map(); }
  async request(channel, { tool, file, url, action, description, input, diff, signal, approvalId, preview }) {
    if (signal?.aborted) return false;
    const id = approvalId || randomUUID();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve:${id}:yes`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`approve:${id}:no`).setLabel('❌ Deny').setStyle(ButtonStyle.Danger));
    // Show the complete proposed operation; large edits are reviewable as an attachment.
    const review = diff || asciiJSON({ tool, ...(file ? { file } : {}), ...(action ? { action, description } : {}), ...input }, null, 2);
    const target = url || file || [action, description].filter(Boolean).join(' · ') || tool;
    const longWarnings=[...(description?.includes('page content could steer bIT')?['⚠️ page content could steer bIT — browser task taints this thread']:[]),...(/FREE TEXT IN/.test(description||'')?['⚠️ FREE TEXT enabled: see the exact apps in the attached plan; never terminals']:[])].join('\n');
    const label = target?.length > 1700 ? (url?'Full URL in proposed-operation.json (including query string)':`${action||tool}: full operation in proposed-operation.json${longWarnings?'\n'+longWarnings:''}`) : target;
    const diffPreview = diff && diff.length <= 1400 && !diff.includes('```') ? `\n\`\`\`diff\n${diff}\n\`\`\`` : '';
    const message = await channel.send({ flags: MessageFlags.SuppressEmbeds, content: `This needs your say-so, Ozzy: ${action ? label : `${tool} ${label}`}\nExpires in 10 minutes.${diffPreview}`, files: [{ attachment: Buffer.from(review), name: diff ? 'proposed-change.diff' : 'proposed-operation.json' }, ...(preview ? [{ attachment: preview, name: 'target-preview.png' }] : [])], components: [row], allowedMentions: { parse: [] } });
    return new Promise(resolve => {
      let done = false;
      const finish = async (allowed, reason) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(id);
        try { await message.edit({ content: `${allowed ? '✅ Approved' : '❌ Denied'}: ${label} (${reason})`, components: [], allowedMentions: { parse: [] } }); } catch { /* decision still resolves if Discord loses the message */ }
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
export class TaskProgressRelay {
  constructor(owner){this.owner=owner;this.pending=new Map();}
  async start(channel,task,stop){
    const id=task.id,row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`task-stop:${id}`).setLabel('⏹ Stop').setStyle(ButtonStyle.Danger));
    const message=await channel.send({content:`🖱️ Task: ${task.goal}\n${task.machine} · approved, 0 steps · until ${task.expiresAt}`,flags:MessageFlags.SuppressEmbeds,components:[row],allowedMentions:{parse:[]}});
    let done=false,chain=Promise.resolve();
    const edit=packet=>{chain=chain.catch(()=>{}).then(()=>message.edit({...packet,allowedMentions:{parse:[]}}));return chain;};
    const ui={update:async value=>{if(!done)await edit({content:`🖱️ Task: ${task.goal}\n${value.steps}/${value.max} · ${value.action} · ${value.app||task.machine} · ${value.result}${value.capture?' · 📸 verified':''}`,components:[row]});},finish:async summary=>{if(done)return;done=true;this.pending.delete(id);await edit({content:`Task: ${task.goal}\n${summary}`,components:[]}).catch(()=>{});}};
    this.pending.set(id,{channel:channel.id,message:message.id,stop});return ui;
  }
  async handle(interaction){
    if(interaction.user.id!==this.owner)return;
    const match=/^task-stop:([^:]+)$/.exec(interaction.customId||'');if(!match)return;
    const p=this.pending.get(match[1]);if(!p||p.channel!==interaction.channelId||p.message!==interaction.message.id)return;
    this.pending.delete(match[1]);const stopped=p.stop();await interaction.deferUpdate();await stopped;
  }
  close(){for(const p of this.pending.values())void p.stop();this.pending.clear();}
}

export function machineLine(machine, status) {
  const number = (n, suffix = '') => Number.isFinite(n) ? `${Math.round(n)}${suffix}` : '?';
  const seconds = Number(status.uptime);
  const up = !Number.isFinite(seconds) ? '?' : seconds >= 86400 ? `${Math.floor(seconds / 86400)}d` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 60)}m`;
  const gb = n => number(Number.isFinite(n) ? n / 1e9 : NaN);
  const disks = status.disks || [];
  const primary = disks.find(d => d.mount === '/' || /^c:[\\/]?$/i.test(d.mount)) || disks[0];
  return `${machine} 🟢 up ${up} · CPU ${number(status.cpu?.loadPercent, '%')} · RAM ${gb(status.memory?.used)}/${gb(status.memory?.total)} GB · disk ${number(primary?.usePercent, '%')}`;
}
export async function machinesText(hub, onError = () => {}) {
  const machines = hub.list(); if (!machines.length) return 'No machines registered yet. My ring is listening.';
  return (await Promise.all(machines.map(async machine => {
    if (!machine.online) return `${machine.machine} ⚫ offline · last seen ${machine.lastSeen ? new Date(machine.lastSeen).toISOString() : 'never'}`;
    try { return machineLine(machine.machine, await hub.request(machine.machine, 'status')) + (machine.capabilities?.includes('screen') ? ' · screen available' : '') + (machine.capabilities?.includes('input') ? ' · input available (task/step-approved)' : ''); }
    catch (e) { onError(e, { machine: machine.machine }); return `${machine.machine} 🟡 my status sensor hit a snag. Try again in a moment, Ozzy.`; }
  }))).join('\n');
}
export function createDiscord({ runner, hub, budget, scheduler, reminders, env = process.env, auditFile = path.join(ROOT, 'data/audit.log'), client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] }) }) {
  const owner = env.OWNER_DISCORD_ID, bitChannel = env.BIT_CHANNEL_ID;
  const approvals = new ApprovalRelay(owner),taskProgress=new TaskProgressRelay(owner);
  if (runner.controls) runner.controls.notifyThread = async (thread, text) => sendText(await client.channels.fetch(thread), text);
  const fail = (error, context = {}) => {
    console.error('Discord operation failed:', context, error);
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(auditFile, JSON.stringify({ time: new Date().toISOString(), event: 'discord_error', ...context, error: inspect(error, { depth: null }), stack: error?.stack || String(error) }) + '\n', { mode: 0o600 });
    } catch (auditError) { console.error('Could not write Discord error audit:', auditError); }
  };
  let rejectFailure, fatalSeen = false;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  // May reject during login before the entry point starts awaiting failure.
  void failure.catch(() => {});
  const fatal = (error, stage = 'gateway') => {
    if (fatalSeen) return; fatalSeen = true;
    const reason = error instanceof Error ? error : new Error(String(error));
    const hint = reason.code === 4014 || /disallowed.*intent/i.test(reason.message)
      ? ' Enable Message Content Intent in the Discord Developer Portal, or remove disallowed intents.' : '';
    console.error(`Discord ${stage} failed: ${reason.message}.${hint} Brain will exit with status 1.`);
    fail(reason, { stage }); rejectFailure(reason);
  };
  client.once(Events.ClientReady, ready => console.log(`Discord connected as ${ready.user.tag}`));
  let reconnecting, closed = false;
  const reconnect = () => {
    if (closed || fatalSeen) return;
    if (reconnecting) return reconnecting;
    reconnecting = Promise.resolve().then(() => retryNetwork(() => client.login(env.DISCORD_TOKEN), { stopped: () => closed, log: console.log })).catch(error => { fatal(error, 'login/reconnect'); throw error; }).finally(() => { reconnecting = null; });
    void reconnecting.catch(() => {});
    return reconnecting;
  };
  const gatewayError = error => { if (temporary(error)) { fail(error, { stage: 'temporary_gateway' }); reconnect(); } else fatal(error); };
  client.on(Events.Error, gatewayError);
  client.on(Events.ShardError, gatewayError);
  client.on(Events.Invalidated, reconnect);
  client.on(Events.ShardDisconnect, event => {
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
      const error = new Error(event.code === 4014 ? 'Disallowed gateway intents (4014)' : `Gateway closed (${event.code}): ${event.reason || 'authentication/configuration error'}`);
      error.code = event.code; fatal(error);
    } else reconnect();
  });
  client.on('messageCreate', async message => {
    const filters = { owner: message.author.id === owner, location: allowedLocation(message.channel, bitChannel), human: !message.author.bot };
    console.debug(`Discord message: author=${message.author.id} channel=${message.channel.id} owner=${filters.owner} location=${filters.location} human=${filters.human} accepted=${filters.owner && filters.location && filters.human}`);
    if (!acceptsMessage(message, owner, bitChannel)) return;
    let channel = message.channel;
    try {
      if (!message.content.trim()) return;
      const fresh = channel.id === bitChannel && !channel.isThread();
      if (fresh) channel = await message.startThread({ name: `bIT · ${message.content.slice(0, 70).replace(/\s+/g, ' ')}`, autoArchiveDuration: 1440 });
      await channel.sendTyping();
      const response = await runner.run(channel.id, message.content, { fresh, notify: text => sendText(channel, text), startProgress: (task,stop)=>taskProgress.start(channel,task,stop), approve: request => approvals.request(channel, request), publish: ({ buffer, mimeType }) => channel.send({ files: [{ attachment: buffer, name: mimeType === 'image/png' ? 'screenshot.png' : 'screenshot.jpg' }], allowedMentions: { parse: [] } }) });
      await sendText(channel, response);
    } catch (e) { fail(e); await sendText(channel, 'My ring hit a snag. Check the brain console, Ozzy.').catch(fail); }
  });
  client.on('interactionCreate', async interaction => {
    const ownerPassed = interaction.user.id === owner;
    const context = { command: interaction.commandName || interaction.customId || `type:${interaction.type}`, userId: interaction.user.id, ownerPassed };
    console.debug(`Discord interaction: command=${context.command} author=${context.userId} channel=${interaction.channelId} owner=${ownerPassed} location=${allowedLocation(interaction.channel, bitChannel)} slash=${interaction.isChatInputCommand()}`);
    if (!ownerPassed) return;
    try {
      if (interaction.isChatInputCommand()) {
        // Acknowledge before channel resolution, validation, or any command work.
        await interaction.deferReply();
      } else {
        if (interaction.isButton() && allowedLocation(interaction.channel, bitChannel)){if(interaction.customId?.startsWith('task-stop:'))await taskProgress.handle(interaction);else await approvals.handle(interaction);}
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
          const w = runner.web?.status();
          const screens = runner.screens?.status();
          const s = budget.status(); response = `Juice meter · ${s.month}: $${s.spent.toFixed(4)} / $${s.cap.toFixed(2)}${s.uncertain ? ' — reconciliation needed after an interrupted run' : ''}`; if (w) {
            response += `\nWeb today: ${w.daily.search}/${w.searchCap} searches · ${w.daily.fetch}/${w.fetchCap} fetches (search fees included in spend).\nWeb this month: ${w.monthly.search} searches · ${w.monthly.fetch} fetches.`;
            if (w.estimatedSearchUSD > 0) response += `\nIncludes $${w.estimatedSearchUSD.toFixed(2)} estimated fees for searches not yet reported by the SDK.`;
          } if (screens) response += `\nScreens today: ${screens.captures}/${screens.cap} captures.`; break;
        }
        case 'screen': {
          if (!runner.screens) throw new Error('Screen grants unavailable');
          const action = interaction.options.getSubcommand();
          if (action === 'status') response = runner.screens.describe(channel.id);
          else if (action === 'off') { await runner.controls?.off(channel.id, 'screen off'); runner.screens.off(channel.id); response = 'Screen access revoked for this conversation, Ozzy.'; }
          else if (!channel.isThread() && !channel.isDMBased()) response = 'Use /screen on inside a #bit thread or DM, Ozzy. Grants stay in that conversation.';
          else {
            const requested = interaction.options.getString('machine');
            const available = hub.list().filter(n => n.online && n.capabilities?.includes('screen'));
            const machine = requested ? available.find(n => n.machine.toLowerCase() === requested.toLowerCase()) : available.length === 1 ? available[0] : null;
            if (!machine) response = available.length ? `Choose a machine with /screen on machine:<name>: ${available.map(n => n.machine).join(', ')}` : 'No machine advertises screen right now, Ozzy. SCREEN_ENABLED and a reachable Wayland session are required.';
            else { await runner.controls?.off(channel.id, 'screen grant changed'); runner.screens.on(channel.id, machine.machine); response = `${runner.screens.describe(channel.id)} Read-only; no mouse or keyboard control.`; }
          }
          break;
        }
        case 'control': {
          if (!runner.controls) throw new Error('Control grants unavailable');
          const action = interaction.options.getSubcommand();
          const requestedMode = action === 'on' ? interaction.options.getString('mode') : null;
          console.log(`Control owner command: ${JSON.stringify({actorId: interaction.user.id, thread: channel.id, action, requestedMode, effectiveMode: action === 'on' ? requestedMode || 'task' : undefined})}`);
          if (action === 'status') response = runner.controls.describe(channel.id);
          else if (action === 'off') { await runner.controls.off(channel.id); response = 'Computer control ended in this conversation, Ozzy.'; }
          else if (!channel.isThread() && !channel.isDMBased()) response = 'Use /control inside a #bit thread or DM, Ozzy.';
          else if (action === 'preview') { runner.controls.preview(channel.id, interaction.options.getString('state',true) === 'on'); response = `Control preview ${runner.controls.state.previews[channel.id]?'on':'off'}: only small in-memory target crops go on step cards.`; }
          else {
            const requested = interaction.options.getString('machine');
            const available = hub.list().filter(n => n.online && n.capabilities?.includes('input'));
            const machine = requested ? available.find(n => n.machine.toLowerCase() === requested.toLowerCase()) : available.length === 1 ? available[0] : null;
            if (!machine) response = available.length ? `Choose an input machine: ${available.map(n=>n.machine).join(', ')}` : 'No machine advertises input control, Ozzy. CONTROL_ENABLED defaults to false.';
            else {
              try {
                runner.controls.subscribe(channel.id, text => sendText(channel,text));
                await runner.controls.on(channel.id,machine.machine,{ withScreen: interaction.options.getBoolean('with-screen') === true, mode: requestedMode||'task', actorId: interaction.user.id, source:'owner slash command', tainted: Boolean(runner.web?.session(runner.webKeys?.[channel.id] || runner.sessions?.[channel.id] || channel.id).tainted) });
                response = `🖱️ controlling ${machine.machine}. ${runner.controls.describe(channel.id)} Input is equivalent to shell access; task mode needs one complete approved plan. Step mode waits for a button on every input action.`;
              } catch(error) { response = error.message; }
            }
          }
          break;
        }
        case 'schedule': {
          if (!scheduler) throw new Error('Scheduler unavailable');
          const action = interaction.options.getSubcommand();
          if (action === 'list') response = scheduler.describe();
          else {
            const name = interaction.options.getString('name', true);
            try {
              if (action === 'pause' || action === 'resume') response = await scheduler.pause(name, action === 'pause');
              else if (action === 'run') { const result = await scheduler.runNow(name); response = result?.threadId ? `Posted ${name}: <#${result.threadId}>` : `Handled ${name}, Ozzy.`; }
              else response = 'Unknown schedule action.';
            } catch (error) { response = error.message; }
          }
          break;
        }
        case 'machines': response = await machinesText(hub, (error, details) => fail(error, { ...context, ...details })); break;
        case 'reset':
          if (!channel.isDMBased() && !channel.isThread()) response = 'Use /reset inside the thread you want to refresh.';
          else { await runner.reset(interaction.channelId); response = 'Fresh thoughts, same orb. This conversation starts a new session next message.'; }
          break;
        default: response = 'Unknown command.';
      }
      const chunks = splitMessage(response); await interaction.editReply({ content: chunks.shift(), allowedMentions: { parse: [] } });
      for (const content of chunks) await interaction.followUp({ content, flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [] } });
    } catch (error) {
      fail(error, context);
      const response = { content: 'My ring hit a snag, Ozzy. Try again in a moment.', allowedMentions: { parse: [] } };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(response);
        else await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
      } catch (replyError) { fail(replyError, { ...context, stage: 'error_reply' }); }
    }
  });
  return { client, approvals, taskProgress, failure,
    async runScheduled(job, { due, misses, timezone, webAllowed }) {
      const base = await client.channels.fetch(bitChannel);
      const balance = budget.status();
      if (balance.uncertain || balance.remaining <= 0) {
        await sendText(base, `My ring is out of scheduled-job juice, Ozzy. Skipping ${job.name}${balance.uncertain ? ' until the budget is reconciled' : ' until next month'}.`);
        return { skipped: 'budget' };
      }
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(due);
      const thread = await base.threads.create({ name: `${job.name} · ${date}`, autoArchiveDuration: 1440 });
      if (misses.length) await sendText(thread, `⏭ ${misses.join('\n')}`);
      const context = `Job: ${job.name}. Due: ${zonedTime(due, timezone)} (${timezone}). Current date/time: ${zonedTime(new Date(), timezone)}.\n${job.instructions}`;
      const response = await runner.run(thread.id, context, { fresh: true, scheduled: true, webAllowed, notify: text => sendText(thread, text), approve: request => approvals.request(thread, request) });
      const messages = await sendText(thread, response);
      return { threadId: thread.id, threadName: thread.name, messageIds: messages.map(m => m?.id) };
    },
    async deliverReminder(reminder, { late, recover = false, route = () => {} }) {
      let target = await client.channels.fetch(bitChannel);
      const originalId = reminder.deliveryChannel || reminder.channel;
      if (originalId && originalId !== bitChannel) {
        try {
          const original = await client.channels.fetch(originalId);
          if (original?.isThread() && original.parentId === bitChannel) {
            if (original.archived) await original.setArchived(false);
            target = original;
          }
        } catch (error) { if (!(recover ? [10003, 10008] : [10003, 10008, 50001, 50013]).includes(error.code)) throw error; }
      }
      if (recover) {
        // A crash may occur after Discord accepted the message but before saving its id.
        // Reconcile that window using the persisted id marker, rather than replaying blindly.
        let before;
        for (let page = 0; page < 250; page++) {
          const messages = await target.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
          const ordered = [...messages.values()];
          const existing = ordered.find(m => m.author.id === client.user.id && m.content.endsWith(`· reminder ${reminder.id}`));
          if (existing) return existing;
          const oldest = ordered.reduce((a,b) => !a || b.createdTimestamp < a.createdTimestamp ? b : a, null);
          if (messages.size < 100 || !oldest || oldest.createdTimestamp < +new Date(reminder.claimedAt) - 60000) break;
          if (page === 249) throw new Error('Reminder history reconciliation limit reached; keeping claim for owner review.');
          before = oldest.id;
        }
      }
      route(target.id);
      return target.send({ content: `⏰ <@${owner}> ${late ? '(late) ' : ''}${reminder.text}\nDue: ${zonedTime(new Date(reminder.due), reminders?.timezone)} · reminder ${reminder.id}`, flags: MessageFlags.SuppressEmbeds, allowedMentions: { parse: [], users: [owner] }, nonce: reminder.id.replaceAll('-', '').slice(0, 24), enforceNonce: true });
    },
    async notifyGrowth(text) { const channel = await client.channels.fetch(bitChannel); await sendText(channel, text); }, async start() {
    try { await Promise.race([reconnect(), failure]);
      if (typeof client.isReady === 'function' && !client.isReady()) await Promise.race([new Promise(resolve => client.once(Events.ClientReady, resolve)), failure]); }
    catch (error) { fatal(error, 'login'); throw error; }
  }, close() { closed = true; approvals.close(); taskProgress.close();client.destroy(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--register')) {
  required(process.env, ['DISCORD_TOKEN', 'DISCORD_APP_ID', 'DISCORD_GUILD_ID']);
  await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, process.env.DISCORD_GUILD_ID), { body: commands() });
  console.log('Registered /mood, /machines, /budget, /screen, /control, /schedule and /reset in the configured guild.');
}
