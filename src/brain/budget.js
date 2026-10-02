import path from 'node:path';
import { ROOT, readJSON, saveJSON } from '../shared.js';
export class Budget {
  constructor({ file = path.join(ROOT, 'data/budget.json'), cap = Number(process.env.BIT_MONTHLY_CAP_USD || 25), now = () => new Date(), timezone = process.env.TZ || 'America/New_York' } = {}) {
    if (!Number.isFinite(cap) || cap < 0) throw new Error('Invalid monthly cap');
    Object.assign(this, { file, cap, now, timezone });
    this.state = readJSON(file, { months: {}, sessions: {}, uncertain: false });
  }
  month() { const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, year: 'numeric', month: '2-digit' }).formatToParts(this.now()); return parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value; }
  status() { const month = this.month(); const sdkSpent = this.state.months[month] || 0; const searchEstimate = this.web?.status().estimatedSearchUSD || 0; const spent = sdkSpent + searchEstimate; return { month, spent, sdkSpent, searchEstimate, cap: this.cap, remaining: Math.max(0, this.cap - spent), uncertain: this.state.uncertain }; }
  begin() { this.state.uncertain = true; saveJSON(this.file, this.state); }
  record(session, total) {
    if (!Number.isFinite(total) || total < 0 || !session) throw new Error('Missing SDK cost data');
    const previous = this.state.sessions[session] || 0;
    // Resumed SDK results include historical session cost. Never double count it.
    const delta = Math.max(0, total - previous);
    this.state.months[this.month()] = (this.state.months[this.month()] || 0) + delta;
    this.state.sessions[session] = Math.max(previous, total);
    this.state.uncertain = false;
    saveJSON(this.file, this.state);
  }
}
