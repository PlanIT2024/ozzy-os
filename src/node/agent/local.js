import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dataDir, minimalEnv } from './policy.js';

export const socketPath = path.join(dataDir, 'agent.sock');
export class AgentClient extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.pending = new Map(); this.next = 0;
    readline.createInterface({ input: socket }).on('line', line => {
      try { const m = JSON.parse(line); if (m.type === 'reply') { const p = this.pending.get(m.id); this.pending.delete(m.id); if (p) { clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } } else this.emit('message', m); } catch {}
    });
    socket.on('error', () => {});
    socket.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Agent coordinator disconnected')); } this.pending.clear(); this.emit('closed'); });
  }
  request(method, params = {}) {
    if (this.socket.destroyed || this.socket.writableEnded) return Promise.reject(new Error('Agent coordinator disconnected'));
    return new Promise((resolve, reject) => { const id = ++this.next; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Agent coordinator timed out')); }, 20000); this.pending.set(id, { resolve, reject, timer }); this.socket.write(JSON.stringify({ id, method, params }) + '\n'); });
  }
  close() { this.socket.end(); }
}
export function connect(file = socketPath) {
  return new Promise((resolve, reject) => { const socket = net.connect(file); socket.once('error', reject); socket.once('connect', () => { socket.removeListener('error', reject); resolve(new AgentClient(socket)); }); });
}
export async function connectAgent() {
  try { return await connect(); } catch {}
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { detached: true, stdio: 'ignore', env: minimalEnv() }); child.unref(); child.on('error', () => {});
  for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 50)); try { return await connect(); } catch {} }
  throw new Error('Cannot start local agent coordinator; inspect data/agent-coordinator.lock (never remove it while its PID is alive)');
}
