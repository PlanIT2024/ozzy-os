import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from './redact.js';

export class Outbox {
  constructor({ directory, write, env = {}, limit = 5000, log = console.warn, now = Date.now, schedule = setTimeout, migrate = entry => entry }) {
    Object.assign(this, { write, env, limit, log, now, schedule, migrate });
    this.file = path.join(directory, 'bitos-outbox.jsonl');
    this.deadFile = path.join(directory, 'bitos-outbox-dead.jsonl'); this.deadIds = new Set();
    this.entries = []; this.pending = []; this.closed = false; this.storage = Promise.resolve();
    this.ready = this.load();
    void this.ready.catch(() => this.warn('bIT OS outbox load failed'));
  }
  warn(message) { try { this.log(message); } catch { /* logging cannot affect brain */ } }
  cap(entries) {
    if (entries.length > this.limit) {
      entries.splice(0, entries.length - this.limit);
      if (!this.overflowWarned) { this.overflowWarned = true; this.warn('bIT OS outbox full; oldest entries dropped'); }
    }
  }
  async load() {
    try {
      for (const line of (await fs.readFile(this.deadFile, 'utf8')).split('\n').filter(Boolean)) {
        try { const entry = JSON.parse(line); if (entry.outbox_id) this.deadIds.add(entry.outbox_id); } catch { /* skip interrupted journal lines */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.warn('bIT OS dead-letter journal unavailable'); }
    try {
      const lines = (await fs.readFile(this.file, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = this.migrate(JSON.parse(line));
          if (entry.table && entry.payload && !this.deadIds.has(entry.outbox_id)) this.entries.push({
            ...entry, outbox_id: entry.outbox_id || randomUUID(), payload: redact(entry.payload, this.env),
            filter: redact(entry.filter || {}, this.env), last_error: redact(entry.last_error, this.env),
          });
        }
        catch { this.warn('bIT OS outbox skipped malformed entry'); }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.warn('bIT OS outbox unavailable'); }
    this.entries.push(...this.pending); this.pending = []; this.cap(this.entries);
    this.loaded = true; this.kick();
  }
  enqueue(table, payload, operation = 'upsert', filter = {}) {
    try {
      if (this.closed) return;
      const list = this.loaded ? this.entries : this.pending;
      list.push({ outbox_id: randomUUID(), table, payload: redact(payload, this.env), operation, filter: redact(filter, this.env), attempts: 0, next: 0 }); this.cap(list);
      if (this.loaded) {
        // Serialize disk snapshots independently of a slow network request.
        void this.persist().catch(() => this.warn('bIT OS outbox persistence failed; retry queued'));
        this.kick();
      }
    } catch { this.warn('bIT OS mirror enqueue failed'); }
  }
  kick(delay = 0) {
    if (this.closed || this.running) return;
    const deadline = this.now() + delay;
    if (this.timer && this.timerAt <= deadline) return;
    clearTimeout(this.timer); this.timerAt = deadline;
    this.timer = this.schedule(() => { this.timer = null; void this.flush(); }, delay);
    this.timer?.unref?.();
  }
  entity(entry) {
    if (entry.operation === 'ownerOffline') return `${entry.table}:owner:${entry.filter?.owner_id || entry.outbox_id}`;
    return `${entry.table}:${entry.payload.id || entry.payload.client_event_id || entry.outbox_id}`;
  }
  delay() {
    const entities = new Set(); let delay = Infinity;
    for (const entry of this.entries) {
      const key = this.entity(entry); if (entities.has(key)) continue; entities.add(key);
      delay = Math.min(delay, Math.max(0, (entry.next || 0) - this.now()));
    }
    return Number.isFinite(delay) ? delay : 0;
  }
  diagnostic(entry, error) {
    return redact({ table: entry.table, operation: entry.operation,
      code: error?.code || error?.cause?.code || null,
      message: error?.message || String(error), hint: error?.hint || null,
    }, this.env);
  }
  async deadLetter(entry) {
    if (!this.deadIds.has(entry.outbox_id)) {
      const record = redact({ ...entry, dead_at: new Date(this.now()).toISOString() }, this.env);
      await fs.appendFile(this.deadFile, JSON.stringify(record) + '\n', { mode: 0o600 });
      this.deadIds.add(entry.outbox_id);
      this.warn(`bIT OS mirror entry dead-lettered after 20 failed attempts ${JSON.stringify(entry.last_error)}`);
    }
    const index = this.entries.indexOf(entry); if (index >= 0) this.entries.splice(index, 1);
  }
  persist() {
    this.latestSnapshot = this.entries.map(e => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
    if (this.storageRunning) return this.storage;
    this.storageRunning = true;
    this.storage = Promise.resolve().then(async () => {
      try {
        while (this.latestSnapshot !== undefined) {
          const snapshot = this.latestSnapshot; this.latestSnapshot = undefined;
          await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
          await fs.writeFile(this.file + '.tmp', snapshot, { mode: 0o600 });
          await fs.rename(this.file + '.tmp', this.file);
        }
      } finally { this.storageRunning = false; }
    });
    return this.storage;
  }
  async flush() {
    if (this.running || this.closed) return;
    this.running = true;
    let diskRetry;
    try {
      // Keep entity order, while failures and backoff never hold up other rows.
      await this.persist();
      const blocked = new Set();
      for (const entry of [...this.entries]) {
        if (this.closed) break;
        if (!this.entries.includes(entry)) continue;
        const entity = this.entity(entry);
        if (blocked.has(entity)) continue;
        if (entry.next > this.now()) { blocked.add(entity); continue; }
        if (entry.attempts >= 20) { await this.deadLetter(entry); await this.persist(); continue; }
        try {
          await this.write(entry);
          const index = this.entries.indexOf(entry); if (index >= 0) this.entries.splice(index, 1);
        } catch (error) {
          if (!this.entries.includes(entry)) continue;
          entry.attempts++; entry.last_error = this.diagnostic(entry, error);
          if (entry.attempts >= 20) { entry.next = 0; await this.deadLetter(entry); }
          else {
            entry.next = this.now() + Math.min(300000, 1000 * 2 ** Math.min(20, entry.attempts - 1));
            blocked.add(entity);
            this.warn(`bIT OS mirror write failed; retry queued ${JSON.stringify(entry.last_error)}`);
          }
        }
        await this.persist();
      }
    } catch { diskRetry = 1000; this.warn('bIT OS outbox persistence failed; retry queued'); }
    finally { this.running = false; if (this.entries.length) this.kick(diskRetry ?? this.delay()); }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
