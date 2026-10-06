import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import { ROOT, readJSON, saveJSON, serial } from '../shared.js';
import { DEFAULT_TZ, zonedTime } from './scheduler.js';
export function resolveWhen(text, now = new Date(), timezone = DEFAULT_TZ()) {
  if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new Error('Give me a short reminder time, Ozzy.');
  text = text.trim();
  let date;
  const relative = /^in\s+(\d+(?:\.\d+)?)\s+(seconds?|minutes?|hours?)$/i.exec(text);
  if (relative) {
    const multiplier = relative[2].toLowerCase().startsWith('hour') ? 3600000 : relative[2].toLowerCase().startsWith('minute') ? 60000 : 1000;
    date = new Date(+now + Number(relative[1]) * multiplier);
  } else if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(text)) {
    const parsed = DateTime.fromISO(text, { zone: timezone });
    if (!parsed.isValid) throw new Error('Invalid reminder timestamp');
    if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(text) && parsed.getPossibleOffsets().length > 1) throw new Error('That time occurs twice at the DST change; include an explicit UTC offset.');
    date = parsed.toJSDate();
  } else {
    const offset = DateTime.fromJSDate(now, { zone: timezone }).offset;
    const results = chrono.en.casual.parse(text, { instant: now, timezone: offset }, { forwardDate: true });
    if (results.length !== 1 || results[0].end || !results[0].start.isCertain('hour')) throw new Error('Give me one date and a time, Ozzy (for example, tomorrow at 3pm).');
    const start = results[0].start;
    if (start.isCertain('timezoneOffset')) date = start.date();
    else {
      const fields = Object.fromEntries(['year','month','day','hour','minute','second'].map(k => [k, start.get(k) ?? 0]));
      const local = DateTime.fromObject(fields, { zone: timezone });
      if (!local.isValid || local.hour !== fields.hour || local.day !== fields.day) throw new Error('That local time does not exist at the DST change; choose another time.');
      if (local.getPossibleOffsets().length > 1) throw new Error('That time occurs twice at the DST change; include an explicit UTC offset.');
      date = local.toJSDate();
    }
  }
  if (!Number.isFinite(+date) || date <= now) throw new Error('That time is already past, Ozzy. Pick a future time.');
  return date;
}
export class Reminders {
  constructor({ root = ROOT, timezone = DEFAULT_TZ(), now = () => new Date(), deliver, log = console.error } = {}) {
    Object.assign(this, { timezone, now, deliver, log }); this.file = path.join(root, 'data/reminders.json');
    this.state = readJSON(this.file, { reminders: [] }); this.queue = serial();
  }
  save() { saveJSON(this.file, this.state); }
  proposal(when, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1500) throw new Error('Reminder text must be 1–1500 characters');
    const due = resolveWhen(when, this.now(), this.timezone);
    return { due: due.toISOString(), text: text.trim(), resolved: `${zonedTime(due, this.timezone)} (${this.timezone})` };
  }
  set(proposal, channel) {
    if (new Date(proposal.due) <= this.now()) throw new Error('The reminder time passed while waiting for approval; choose a new time.');
    const reminder = { id: randomUUID(), due: proposal.due, text: proposal.text, channel, status: 'pending', createdAt: this.now().toISOString() };
    this.state.reminders.push(reminder); this.save();
    return { ...reminder, confirmation: `⏰ ${proposal.resolved} — ${proposal.text} (id: ${reminder.id})` };
  }
  list() { return this.state.reminders.filter(r => r.status === 'pending' || r.status === 'failed' || r.status === 'claimed').map(r => ({ ...r, resolved: `${zonedTime(new Date(r.due), this.timezone)} (${this.timezone})` })).sort((a,b) => a.due.localeCompare(b.due)); }
  cancel(id) {
    const reminder = this.state.reminders.find(r => r.id === id && r.status === 'pending');
    if (!reminder) throw new Error('No pending reminder with that id, Ozzy.');
    reminder.status = 'cancelled'; this.save(); return { id, cancelled: true };
  }
  tick({ startup = false } = {}) {
    return this.queue(async () => {
      if (this.stopped) return;
      const now = this.now();
      for (const reminder of this.state.reminders) {
        if (!['pending', 'claimed'].includes(reminder.status) || new Date(reminder.due) > now || (reminder.nextAttempt && new Date(reminder.nextAttempt) > now)) continue;
        const recover = reminder.status === 'claimed';
        reminder.status = 'claimed'; reminder.claimedAt ||= now.toISOString(); this.save();
        try {
          const sent = await this.deliver(reminder, { recover, late: startup || +now - +new Date(reminder.due) > 60000, route: id => { reminder.deliveryChannel = id; this.save(); } });
          reminder.status = 'delivered'; reminder.deliveredAt = this.now().toISOString(); reminder.messageId = sent?.id; this.save();
        } catch (error) {
          // Recover a persisted claim by checking Discord history before re-sending.
          reminder.error = error.message; reminder.attempts = (reminder.attempts || 0) + 1;
          reminder.nextAttempt = new Date(+now + Math.min(60000, 2000 * 2 ** Math.min(reminder.attempts - 1, 5))).toISOString();
          this.save(); this.log(`Reminder ${reminder.id} delivery uncertain/failed: ${error.message}`);
        }
      }
    });
  }
  async start() { this.stopped = false; this.timer = setInterval(() => { void this.tick().catch(this.log); }, 1000); this.timer.unref(); await this.tick({ startup: true }); }
  close() { this.stopped = true; clearInterval(this.timer); }
}
