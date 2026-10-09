import { validDelivery } from '../node/input/delivery.js';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ROOT } from '../shared.js';
import { loadKey, nodeKeys, SecurePeer } from '../transport/crypto.js';
import { RelayClient } from '../transport/relayClient.js';
import { canonical, unpack, MAX_MESSAGE } from '../../relay/wire.js';
export function parseTokens(raw = '') {
  const tokens = new Map(), secrets = new Set();
  for (const entry of raw.split(',').filter(s => s.trim())) {
    const split = entry.indexOf(':'); const machine = canonical(entry.slice(0, split).trim()); const token = entry.slice(split + 1).trim();
    if (split < 1 || machine === 'brain' || token.length < 16 || tokens.has(machine) || secrets.has(token)) throw new Error('NODE_TOKENS requires unique machine names and tokens (at least 16 characters)');
    tokens.set(machine, token); secrets.add(token);
  }
  return tokens;
}
export function validCapabilities(values) {
  return Array.isArray(values) && values.length >= 1 && values.length <= 3 && values[0] === 'status' && (values.length === 1 || values[1] === 'screen') && (values.length < 3 || values[2] === 'input');
}
export class NodeHub extends EventEmitter {
  constructor({ port = Number(process.env.NODE_HUB_PORT || 8787), host = process.env.NODE_HUB_BIND || '127.0.0.1', tokens = parseTokens(process.env.NODE_TOKENS), key = loadKey(process.env.BRAIN_KEY_FILE || path.join(ROOT, 'data/keys/brain.json')), trustedKeys = nodeKeys(process.env.NODE_KEYS), relayURL = process.env.RELAY_URL, relayToken = process.env.BRAIN_RELAY_TOKEN || process.env.RELAY_TOKEN, timeout = 10000, stale = 90000, log = console.log } = {}) {
    super(); if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Brain hub must bind to loopback only');
    Object.assign(this, { key, trustedKeys, timeout, stale, log }); this.pending = new Map(); this.handshakes = new Map();
    this.failure = new Promise((_, reject) => { this.rejectFailure = reject; }); void this.failure.catch(() => {});
    this.nodes = new Map([...trustedKeys].map(([id, value]) => [id, { machine: value.name, online: false, lastSeen: null }]));
    this.server = new WebSocketServer({ port, host, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject); });
    this.server.on('connection', (ws, req) => {
      ws.on('error', () => {});
      const auth = req.headers.authorization || ''; let name;
      for (const [id, token] of tokens) { const got = Buffer.from(auth), expected = Buffer.from(`Bearer ${token}`); if (got.length === expected.length && timingSafeEqual(got, expected)) name = id; }
      if (!name) { ws.close(4401, 'Unknown local token'); return; }
      const timer = setTimeout(() => ws.close(4408, 'E2E hello timed out'), 10000);
      ws.on('message', (data, binary) => {
        if (!binary) { ws.close(4400, 'Encrypted binary frames required'); return; }
        this.receive(name, data, frame => ws.send(frame), reason => ws.close(4403, reason), ws, () => clearTimeout(timer));
      });
      ws.on('close', () => { clearTimeout(timer); this.disconnect(name, ws); this.dropHandshake(name, ws); });
    });
    if (relayURL) {
      this.relay = new RelayClient({ url: relayURL, token: relayToken, name: 'brain', log });
      this.relay.on('frame', frame => {
        try { const { meta } = unpack(frame); this.receive(meta.from, frame, f => this.relay.send(f), reason => this.relay.reject(meta.from, reason), this.relay); }
        catch { log('brain relay: rejected invalid routing frame'); }
      });
      this.relay.on('control', m => { if (m.type === 'peer' && m.online === false) { this.disconnect(m.name, this.relay); this.dropHandshake(m.name, this.relay); } });
      this.relay.on('offline', () => { for (const id of this.nodes.keys()) { this.disconnect(id, this.relay); this.dropHandshake(id, this.relay); } });
      this.relay.on('fatal', error => { this.rejectFailure(error); this.emit('fatal', error); });
    }
    this.sweep = setInterval(() => {
      for (const [id, n] of this.nodes) if (n.online && Date.now() - n.lastSeen > stale) { this.disconnect(id, n.connection); if (n.connection !== this.relay) n.connection?.terminate(); }
    }, Math.min(10000, stale)); this.sweep.unref();
  }
  dropHandshake(id, connection) { const h = this.handshakes.get(id); if (h && (!connection || h.connection === connection)) { clearTimeout(h.timer); h.peer.close(); this.handshakes.delete(id); } }
  receive(name, frame, send, reject, connection, authenticated = () => {}) {
    let id;
    try {
      id = canonical(name); const trust = this.trustedKeys.get(id);
      if (!trust) { reject('unknown_key'); return; }
      const { meta, payload } = unpack(frame);
      if (meta.from !== id || meta.to !== 'brain') throw new Error('Name mismatch');
      const initial = payload.subarray(0, 32).equals(Buffer.alloc(32));
      if (initial) {
        this.dropHandshake(id);
        const peer = new SecurePeer({ role: 'brain', name: id, key: this.key, peerKey: trust.publicKey, send });
        const timer = setTimeout(() => { this.dropHandshake(id, connection); reject('auth_failed'); }, 10000);
        this.handshakes.set(id, { peer, timer, connection });
        peer.on('message', m => this.message(id, peer, m));
        peer.once('ready', () => {
          clearTimeout(timer); this.handshakes.delete(id); authenticated();
          const previous = this.nodes.get(id); previous?.peer?.close();
          this.nodes.set(id, { machine: trust.name, online: false, lastSeen: previous?.lastSeen || null, peer, connection });
        });
        peer.receive(frame);
      } else {
        const candidate = this.handshakes.get(id);
        const active = this.nodes.get(id);
        const peer = candidate?.connection === connection && candidate.peer.cipher.session === payload.subarray(0, 32).toString('hex') ? candidate.peer : active?.connection === connection ? active.peer : null;
        if (!peer) throw new Error('No authenticated session'); peer.receive(frame);
      }
    } catch (error) { this.log(`E2E rejected ${id || 'unknown'}: ${error.message}`); this.dropHandshake(id, connection); this.disconnect(id, connection); reject('auth_failed'); }
  }
  message(id, peer, m) {
    const n = this.nodes.get(id); if (!n || n.peer !== peer) return;
    if (!n.online) {
      if (m.type !== 'hello' || canonical(m.machine) !== id || !validCapabilities(m.capabilities) || !['os', 'arch', 'hostname', 'version'].every(k => typeof m[k] === 'string' && m[k].length < 256)) throw new Error('Invalid authenticated hello');
      this.log(`node ${m.machine} authenticated online via ${n.connection === this.relay ? 'relay' : 'local'}`);
      this.log(`node ${m.machine} capabilities: ${m.capabilities.join(', ')}`);
      Object.assign(n, { machine: m.machine, os: m.os, arch: m.arch, hostname: m.hostname, version: m.version, capabilities: m.capabilities, online: true });
    } else if (m.type === 'capabilities') {
      if (!validCapabilities(m.capabilities)) throw new Error('Invalid capabilities');
      n.capabilities = m.capabilities; this.log(`node ${n.machine} capabilities: ${m.capabilities.join(', ')}`);
    } else if (m.type === 'control_closed') {
      if (typeof m.grantId !== 'string' || m.grantId.length > 80 || typeof m.reason !== 'string' || m.reason.length > 100) throw new Error('Invalid control closure');
      this.emit('control_closed', { machine: n.machine, grantId: m.grantId, reason: m.reason,delivery:validDelivery(m.delivery)?m.delivery:undefined });
    } else if (['control_task_progress','control_task_ended'].includes(m.type)) {
      if(![m.taskId,m.grantId].every(id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(id))||!Number.isInteger(m.steps)||m.steps<0||m.steps>40)throw new Error('Invalid task metadata');
      const event={machine:n.machine,taskId:m.taskId,grantId:m.grantId,steps:m.steps};
      for(const key of ['action','app','phase','reason'])if(typeof m[key]==='string')event[key]=m[key].slice(0,160);
      if(m.willCapture===true)event.willCapture=true;
      if(Number.isInteger(m.textLength)&&m.textLength>=0&&m.textLength<=500)event.textLength=m.textLength;
      if(validDelivery(m.delivery))event.delivery=m.delivery;
      if(m.capture&&typeof m.capture.capturedAt==='string')event.capture={capturedAt:m.capture.capturedAt,original:{width:m.capture.original?.width,height:m.capture.original?.height},scaled:{width:m.capture.scaled?.width,height:m.capture.scaled?.height}};
      this.emit(m.type,event);
    } else if (m.type === 'res') {
      const p = this.pending.get(m.id);
      if (p && p.peer === peer) { this.pending.delete(m.id); clearTimeout(p.timer); if (m.ok === true) p.resolve(m.result); else p.reject(Object.assign(new Error(String(m.error || 'Node request failed')),{delivery:validDelivery(m.delivery)?m.delivery:undefined,launchFailure:m.launchFailure===true})); }
    } else if (m.type !== 'heartbeat') throw new Error('Invalid application message');
    n.lastSeen = Date.now();
  }
  disconnect(id, connection) {
    const n = this.nodes.get(id); if (!n || n.connection !== connection) return;
    n.online = false; n.peer?.close();
    for (const [request, p] of this.pending) if (p.peer === n.peer) { clearTimeout(p.timer); p.reject(new Error('Machine disconnected')); this.pending.delete(request); }
    n.peer = null;
  }
  list() { return [...this.nodes.values()].map(({ peer, connection, ...n }) => ({ ...n, online: Boolean(n.online && Date.now() - n.lastSeen <= this.stale) })); }
  request(machine, method, params = {}) {
    let n; try { n = this.nodes.get(canonical(machine)); } catch { return Promise.reject(new Error('Invalid machine name')); }
    if (!n?.online || !n.peer || Date.now() - n.lastSeen > this.stale) return Promise.reject(new Error(`Machine ${machine} is offline`));
    if (!['status','screen','input_start','input_action','input_focus','input_resolve_app','input_stop','input_list_apps','input_task_prepare','input_task_start','input_task_action','input_task_check','input_task_finish'].includes(method)) return Promise.reject(new Error('Unsupported method'));
    if (['input_start','input_action','input_focus','input_resolve_app','input_list_apps','input_task_prepare','input_task_start','input_task_action','input_task_check'].includes(method) && !n.capabilities?.includes('input')) return Promise.reject(new Error('Machine has no input capability'));
    if (method === 'screen' && !n.capabilities?.includes('screen')) return Promise.reject(new Error('Machine has no screen capability'));
    return new Promise((resolve, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Node request timed out')); }, ['screen','input_start','input_task_action'].includes(method) ? Math.max(this.timeout, 120000) : this.timeout);
      this.pending.set(id, { peer: n.peer, resolve, reject, timer });
      try { n.peer.send({ type: 'req', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async close() { clearInterval(this.sweep); for (const id of this.handshakes.keys()) this.dropHandshake(id); for (const [id, n] of this.nodes) this.disconnect(id, n.connection); this.relay?.close(); for (const ws of this.server.clients) ws.terminate(); await new Promise(resolve => this.server.close(resolve)); }
}
