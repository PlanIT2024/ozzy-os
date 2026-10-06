import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import { parseDocument } from 'yaml';
import { ROOT, readJSON, saveJSON, serial } from '../shared.js';
export const DEFAULT_TZ = () => process.env.TZ || 'America/New_York';
const namePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function cron(expression, date, timezone = DEFAULT_TZ()) {
  if (typeof expression !== 'string' || expression.trim().split(/\s+/).length !== 5 || /[?#]|\b(?:H|L|\d+L|L\d+)\b/i.test(expression)) throw new Error('Cron must have five standard fields');
  return CronExpressionParser.parse(expression, { currentDate: date, tz: timezone });
}
export function nextRun(expression, date = new Date(), timezone = DEFAULT_TZ()) { return cron(expression, date, timezone).next().toDate(); }
export function latestRun(expression, date = new Date(), timezone = DEFAULT_TZ()) {
  const due = cron(expression, new Date(+date + 1), timezone).prev().toDate();
  // Reverse cron iteration can choose the second DST fold; match forward iteration's first occurrence.
  return DateTime.fromJSDate(due, { zone: timezone }).getPossibleOffsets().sort((a,b) => a.toMillis() - b.toMillis())[0].toJSDate();
}
export function validateSchedule(content, fileName, timezone = DEFAULT_TZ()) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) throw new Error('Schedule needs YAML frontmatter and instructions');
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid schedule YAML');
  const data = document.toJS({ maxAliasCount: 0 });
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['name','cron','enabled','channel'].includes(k))) throw new Error('Unexpected schedule frontmatter');
  if (!namePattern.test(data.name) || data.name !== fileName || typeof data.enabled !== 'boolean' || data.channel !== 'bit' || !match[2].trim()) throw new Error('Schedule name, enabled, channel or instructions invalid');
  nextRun(data.cron, new Date(), timezone);
  const instructions = match[2].trim();
  // Explicit positive tool directive, not incidental links or a skill's instructions.
  const webAllowed = instructions.split('\n').some(line => /^\s*(?:[-*]\s*)?(?:use|call|invoke)\s+(?:the\s+)?(?:WebSearch|WebFetch)\b/i.test(line));
  return { ...data, instructions, webAllowed };
}
export function loadSchedules(root = ROOT, timezone = DEFAULT_TZ(), onError = console.error) {
  const directory = path.join(root, 'bit/schedules');
  if (!fs.existsSync(directory)) return [];
  const dirStat = fs.lstatSync(directory);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('Schedules directory must not be a symlink');
  const jobs = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.md')) continue;
    try {
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Schedule must be a regular single-link file');
      jobs.push(validateSchedule(fs.readFileSync(file, 'utf8'), entry.name.slice(0,-3), timezone));
    } catch (error) { onError(`Schedule ${entry.name} rejected: ${error.message}`); }
  }
  return jobs;
}
export function zonedTime(date, timezone = DEFAULT_TZ()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'long' }).format(date);
}
export class Scheduler {
  constructor({ root = ROOT, timezone = DEFAULT_TZ(), now = () => new Date(), execute, log = console.error, grace = 2 * 3600000 } = {}) {
    Object.assign(this, { root, timezone, now, execute, log, grace });
    this.file = path.join(root, 'data/scheduler.json'); this.state = readJSON(this.file, { jobs: {} }); this.queue = serial();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  }
  save() { saveJSON(this.file, this.state); }
  jobs() { return loadSchedules(this.root, this.timezone, this.log); }
  jobState(name) { return this.state.jobs[name] ||= { paused: false, cursor: null, lastRun: null, misses: [] }; }
  list() { return this.jobs().map(job => ({ name: job.name, cron: job.cron, enabled: job.enabled, paused: this.jobState(job.name).paused, next: nextRun(job.cron, this.now(), this.timezone).toISOString() })); }
  describe() {
    const jobs = this.list();
    return jobs.length ? jobs.map(j => `${j.name} · ${!j.enabled ? 'disabled' : j.paused ? 'paused' : 'enabled'} · next ${zonedTime(new Date(j.next), this.timezone)} (${this.timezone})`).join('\n') : 'No schedules yet, Ozzy.';
  }
  pause(name, paused) {
    return this.queue(() => {
      const job = this.jobs().find(j => j.name === name); if (!job) throw new Error('Unknown schedule');
      if (!paused && !job.enabled) throw new Error('This schedule is disabled in its file; enabling it needs a reviewed file change.');
      const state = this.jobState(name); state.paused = paused;
      // Runtime pause does not accumulate catch-up work.
      state.cursor = latestRun(job.cron, this.now(), this.timezone).toISOString(); this.save();
      return `${name} ${paused ? 'paused' : 'resumed'}, Ozzy.`;
    });
  }
  async claimRun(job, due, manual = false) {
    const state = this.jobState(job.name), misses = [...state.misses];
    state.lastRun = { due: due.toISOString(), claimedAt: this.now().toISOString(), manual, status: 'claimed' };
    this.save(); // Reserve before Discord/model side effects: never replay an interrupted run.
    try {
      const result = await this.execute(job, { due, misses, fresh: true, webAllowed: job.webAllowed, timezone: this.timezone });
      state.lastRun.status = result?.skipped ? 'skipped' : 'completed';
      if (result?.skipped) state.misses.push(`Skipped ${job.name} at ${zonedTime(due, this.timezone)} because of ${result.skipped}.`);
      else state.misses = [];
      this.save(); return result;
    } catch (error) {
      state.lastRun.status = 'failed'; state.misses.push(`Run ${due.toISOString()} failed or was interrupted.`); this.save(); throw error;
    }
  }
  runNow(name) {
    return this.queue(async () => {
      const job = this.jobs().find(j => j.name === name); if (!job) throw new Error('Unknown schedule');
      const state = this.jobState(name);
      if (!job.enabled || state.paused) throw new Error('That job is paused or disabled, Ozzy. Resume it first.');
      return this.claimRun(job, this.now(), true);
    });
  }
  tick() {
    return this.queue(async () => {
      if (this.stopped) return;
      const now = this.now();
      for (const job of this.jobs()) {
        const state = this.jobState(job.name), due = latestRun(job.cron, now, this.timezone), dueISO = due.toISOString();
        if (state.cursor && due <= new Date(state.cursor)) continue;
        if (state.lastRun?.status === 'claimed') state.misses.push(`Interrupted run ${state.lastRun.due} was not replayed.`);
        if (state.cursor && job.enabled && !state.paused) {
          const firstMissed = nextRun(job.cron, new Date(state.cursor), this.timezone);
          if (firstMissed < due) state.misses.push(`Earlier scheduled runs between ${firstMissed.toISOString()} and ${dueISO} were missed; only the latest can catch up.`);
        }
        state.cursor = dueISO; this.save();
        if (!job.enabled || state.paused) continue;
        if (+now - +due > this.grace) { state.misses.push(`Missed ${job.name} at ${zonedTime(due, this.timezone)}; outside the two-hour catch-up window.`); this.save(); continue; }
        try { await this.claimRun(job, due); } catch (error) { this.log(`Schedule ${job.name} failed: ${error.message}`); }
      }
    });
  }
  async start() {
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(this.log); }, 15000); this.timer.unref();
    await this.tick();
  }
  close() { this.stopped = true; clearInterval(this.timer); }
}
