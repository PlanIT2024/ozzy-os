import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
export function parseTokens(raw = '') {
  const tokens = new Map(); const secrets = new Set();
  for (const entry of raw.split(',').filter(s => s.trim())) {
    const split = entry.indexOf(':'); const machine = entry.slice(0, split).trim(); const token = entry.slice(split + 1).trim();
    if (split < 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(machine) || token.length < 16 || tokens.has(machine) || secrets.has(token)) throw new Error('NODE_TOKENS requires unique machine names and tokens (at least 16 characters)');
    tokens.set(machine, token); secrets.add(token);
  }
  return tokens;
}
export class NodeHub {
  constructor({ port = Number(process.env.NODE_HUB_PORT || 8787), host = process.env.NODE_HUB_BIND || '127.0.0.1', tokens = parseTokens(process.env.NODE_TOKENS), timeout = 10000, stale = 90000 } = {}) {
    this.nodes = new Map([...tokens.keys()].map(machine => [machine, { machine, online: false }]));
    this.pending = new Map(); this.timeout = timeout; this.stale = stale;
    this.server = new WebSocketServer({ port, host, maxPayload: 256 * 1024, verifyClient: ({ req }, done) => {
      const auth = req.headers.authorization || ''; let identity;
      for (const [machine, token] of tokens) {
        const expected = Buffer.from(`Bearer ${token}`); const got = Buffer.from(auth);
        if (got.length === expected.length && timingSafeEqual(got, expected)) identity = machine;
      }
      req.machine = identity; done(Boolean(identity), 401, 'Unauthorized');
    } });
    this.ready = new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject); });
    this.server.on('connection', (ws, req) => this.connect(ws, req.machine));
    this.sweep = setInterval(() => { for (const n of this.nodes.values()) if (n.online && Date.now() - n.lastSeen > stale) n.ws.terminate(); }, Math.min(10000, stale));
    this.sweep.unref();
  }
  connect(ws, machine) {
    let current;
    const helloTimer = setTimeout(() => ws.close(1008, 'Hello required'), 5000);
    ws.on('error', () => {});
    ws.on('message', data => {
      try {
        const m = JSON.parse(data.toString());
        if (!current) {
          if (m.type !== 'hello' || m.machine !== machine || !Array.isArray(m.capabilities) || m.capabilities.length !== 1 || m.capabilities[0] !== 'status' || !['os', 'arch', 'hostname', 'version'].every(k => typeof m[k] === 'string' && m[k].length < 256)) throw new Error('Invalid hello');
          const old = this.nodes.get(machine); old?.ws?.terminate();
          current = { machine, os: m.os, arch: m.arch, hostname: m.hostname, version: m.version, capabilities: ['status'], online: true, lastSeen: Date.now(), ws };
          this.nodes.set(machine, current); clearTimeout(helloTimer); return;
        }
        if (m.type === 'heartbeat') { current.lastSeen = Date.now(); return; }
        if (m.type !== 'res' || typeof m.id !== 'string' || typeof m.ok !== 'boolean') throw new Error('Invalid response');
        const pending = this.pending.get(m.id);
        if (!pending || pending.ws !== ws) return;
        this.pending.delete(m.id); clearTimeout(pending.timer);
        if (m.ok) pending.resolve(m.result); else pending.reject(new Error(String(m.error || 'Node request failed')));
      } catch { ws.close(1008, 'Invalid protocol'); }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer); if (current) current.online = false;
      for (const [id, p] of this.pending) if (p.ws === ws) { clearTimeout(p.timer); p.reject(new Error('Machine disconnected')); this.pending.delete(id); }
    });
  }
  list() { return [...this.nodes.values()].map(({ ws, ...n }) => ({ ...n, online: Boolean(n.online && Date.now() - n.lastSeen <= this.stale) })); }
  request(machine, method, params = {}) {
    const n = this.nodes.get(machine);
    if (!n?.online || Date.now() - n.lastSeen > this.stale || n.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`Machine ${machine} is offline`));
    if (method !== 'status' || !n.capabilities.includes('status')) return Promise.reject(new Error('Unsupported method'));
    return new Promise((resolve, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Node request timed out')); }, this.timeout);
      this.pending.set(id, { ws: n.ws, resolve, reject, timer });
      n.ws.send(JSON.stringify({ type: 'req', id, method, params }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async close() { clearInterval(this.sweep); for (const ws of this.server.clients) ws.terminate(); await new Promise(resolve => this.server.close(resolve)); }
}
