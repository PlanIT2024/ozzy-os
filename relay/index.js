import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { canonical, unpack, MAX_MESSAGE } from './wire.js';
export function clientsFromEnv(raw = '[]') {
  const clients = new Map(); const hashes = new Set(); let brains = 0;
  for (const entry of JSON.parse(raw)) {
    const name = canonical(entry.name);
    if (!['brain', 'node'].includes(entry.role) || !/^[a-f0-9]{64}$/.test(entry.sha256) || clients.has(name) || hashes.has(entry.sha256) || (entry.role === 'brain') !== (name === 'brain')) throw new Error('Invalid RELAY_CLIENTS entry');
    clients.set(name, { ...entry, name }); hashes.add(entry.sha256); if (entry.role === 'brain') brains++;
  }
  if (brains !== 1) throw new Error('RELAY_CLIENTS needs exactly one brain named brain');
  return clients;
}
export function startRelay({ port = Number(process.env.PORT || 8788), host = process.env.RELAY_BIND || '127.0.0.1', clients = clientsFromEnv(process.env.RELAY_CLIENTS), rate = 60, byteRate = 16 * 1024 * 1024, heartbeat = 30000, log = console.log } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' }); res.end(req.url === '/health' ? '{"ok":true}' : '{}'); });
  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  const peers = new Map();
  const control = (ws, value) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  wss.on('connection', (ws, req) => {
    let name;
    ws.on('error', error => log(`error ${name || 'unauthenticated'} code=${error.code || 'socket'}`));
    try { name = canonical(req.headers['x-bit-name']); } catch { ws.close(4401, 'Unknown client name or token'); return; }
    const entry = clients.get(name);
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const digest = createHash('sha256').update(token).digest();
    if (!entry || !String(req.headers.authorization || '').startsWith('Bearer ') || !timingSafeEqual(digest, Buffer.from(entry.sha256, 'hex'))) { ws.close(4401, 'Unknown client name or token'); return; }
    if (peers.has(name)) { ws.close(4409, name === 'brain' ? 'Brain already connected' : 'Client already connected'); return; }
    peers.set(name, ws); ws.alive = true;
    let windowStart = Date.now(), messages = 0, bytes = 0, total = 0;
    log(`connect ${name} role=${entry.role}`);
    control(ws, { type: 'ready' });
    if (entry.role === 'brain') {
      for (const [peer, socket] of peers) if (peer !== 'brain') { control(ws, { type: 'peer', name: peer, online: true }); control(socket, { type: 'peer', name: 'brain', online: true }); }
    } else control(ws, { type: 'peer', name: 'brain', online: peers.has('brain') });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, binary) => {
      total += data.length;
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); messages = 0; bytes = 0; }
      if (++messages > rate || (bytes += data.length) > byteRate) { ws.close(4429, 'Rate limit exceeded'); return; }
      try {
        if (!binary) {
          // Transport rejection only; no application payload may use this control path.
          if (data.length > 512 || entry.role !== 'brain') throw new Error('Invalid control');
          const m = JSON.parse(data.toString());
          if (m.type !== 'reject' || !['unknown_key', 'auth_failed', 'protocol'].includes(m.reason) || canonical(m.to) === 'brain') throw new Error('Invalid control');
          control(peers.get(canonical(m.to)), { type: 'rejected', reason: m.reason }); return;
        }
        const { meta } = unpack(data); // Deliberately never decode or inspect opaque payload bytes.
        if (meta.from !== name || (entry.role === 'node' ? meta.to !== 'brain' : meta.to === 'brain')) { ws.close(4403, 'Node-to-node or forged routing forbidden'); return; }
        const target = peers.get(meta.to);
        if (!target) { control(ws, { type: 'peer', name: meta.to, online: false }); return; }
        if (target.bufferedAmount > MAX_MESSAGE * 2) { ws.close(4429, 'Destination backpressure'); return; }
        target.send(data, { binary: true });
      } catch { ws.close(4400, 'Invalid routing frame'); }
    });
    ws.on('close', code => {
      if (peers.get(name) !== ws) return; peers.delete(name);
      log(`disconnect ${name} code=${code} bytes=${total}`);
      if (name === 'brain') for (const socket of peers.values()) control(socket, { type: 'peer', name: 'brain', online: false });
      else control(peers.get('brain'), { type: 'peer', name, online: false });
    });
  });
  const sweep = setInterval(() => { for (const ws of wss.clients) { if (ws.alive === false) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, heartbeat); sweep.unref();
  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, wss, ready, async close() { clearInterval(sweep); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = startRelay(); await relay.ready; console.log(`bit-hub listening on ${relay.server.address().port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close(); });
}
