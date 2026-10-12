import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from './redact.js';

export class Outbox {
  constructor({ directory, write, env = process.env, limit = 5000, log = console.warn, now = Date.now, schedule = setTimeout }) {
    Object.assign(this, { write, env, limit, log, now, schedule });
    this.file = path.join(directory, 'bitos-outbox.jsonl');
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
      const lines = (await fs.readFile(this.file, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) {
        try { const entry = JSON.parse(line); if (entry.table && entry.payload) this.entries.push({ ...entry, payload: redact(entry.payload, this.env) }); }
        catch { this.warn('bIT OS outbox skipped malformed entry'); }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.warn('bIT OS outbox unavailable'); }
    this.entries.push(...this.pending); this.pending = []; this.cap(this.entries);
    this.loaded = true; this.kick();
  }
  enqueue(table, payload, operation = 'upsert') {
    try {
      if (this.closed) return;
      const list = this.loaded ? this.entries : this.pending;
      list.push({ table, payload: redact(payload, this.env), operation, attempts: 0, next: 0 }); this.cap(list);
      if (this.loaded) {
        // Serialize disk snapshots independently of a slow network request.
        void this.persist().catch(() => this.warn('bIT OS outbox persistence failed; retry queued'));
        this.kick();
      }
    } catch { this.warn('bIT OS mirror enqueue failed'); }
  }
  kick(delay = 0) {
    if (this.closed || this.running || this.timer) return;
    this.timer = this.schedule(() => { this.timer = null; void this.flush(); }, delay);
    this.timer?.unref?.();
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
    let delay = 0;
    try {
      // Persist even while a failed head is waiting; new writes survive restart.
      await this.persist();
      while (this.entries.length && !this.closed) {
        const entry = this.entries[0];
        if (entry.next > this.now()) { delay = entry.next - this.now(); break; }
        try {
          await this.write(entry);
          const index = this.entries.indexOf(entry); if (index >= 0) this.entries.splice(index, 1);
        } catch {
          entry.attempts++; delay = Math.min(300000, 1000 * 2 ** Math.min(20, entry.attempts - 1));
          entry.next = this.now() + delay;
          this.warn(`bIT OS mirror write failed (${entry.table}); retry queued`);
          await this.persist(); break;
        }
        await this.persist();
      }
    } catch { delay = 1000; this.warn('bIT OS outbox persistence failed; retry queued'); }
    finally { this.running = false; if (this.entries.length) this.kick(delay); }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
