import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import si from 'systeminformation';
import { required } from '../shared.js';
export async function machineStatus() {
  const [cpu, memory, disks, battery, users, version] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.battery(), si.users(), si.osInfo()]);
  return { uptime: os.uptime(), cpu: { loadPercent: cpu.currentLoad, cores: os.cpus().length }, memory: { total: memory.total, used: memory.active, available: memory.available }, disks: disks.map(d => ({ mount: d.mount, size: d.size, used: d.used, usePercent: d.use })), battery: battery.hasBattery ? { percent: battery.percent, charging: battery.isCharging, remainingMinutes: battery.timeRemaining } : null, users: [...new Set(users.map(u => u.user))], processUser: os.userInfo().username, os: { platform: version.platform, distro: version.distro, release: version.release, kernel: version.kernel } };
}
export function startNode({ url = process.env.BRAIN_URL || 'ws://127.0.0.1:8787', token = process.env.NODE_TOKEN, machine = process.env.MACHINE_NAME, heartbeat = 30000, status = machineStatus, log = console.log } = {}) {
  required({ NODE_TOKEN: token, MACHINE_NAME: machine }, ['NODE_TOKEN', 'MACHINE_NAME']);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(machine)) throw new Error('Invalid MACHINE_NAME');
  let ws, timer, pulse, stopped = false, attempt = 0, busy = false, lastPong = Date.now();
  function connect() {
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 256 * 1024, handshakeTimeout: 10000 });
    ws.on('open', () => {
      attempt = 0; lastPong = Date.now(); log(`bit-node ${machine} connected`);
      ws.send(JSON.stringify({ type: 'hello', machine, os: os.platform(), arch: os.arch(), hostname: os.hostname(), version: '1.0.0', capabilities: ['status'] }));
      pulse = setInterval(() => {
        if (Date.now() - lastPong > 90000) { ws.terminate(); return; }
        if (ws.readyState === WebSocket.OPEN) { ws.ping(); ws.send(JSON.stringify({ type: 'heartbeat' })); }
      }, heartbeat);
    });
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('message', async data => {
      const peer = ws; let m;
      try { m = JSON.parse(data.toString()); } catch { peer.close(1008, 'Invalid JSON'); return; }
      if (m.type !== 'req' || typeof m.id !== 'string' || m.id.length > 128) return;
      const send = value => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'res', id: m.id, ...value })); };
      if (m.method !== 'status') return send({ ok: false, error: 'Unsupported method' });
      if (busy) return send({ ok: false, error: 'Status collection busy' });
      busy = true;
      try { send({ ok: true, result: await status() }); } catch { send({ ok: false, error: 'Status collection failed' }); } finally { busy = false; }
    });
    ws.on('error', () => log('bit-node connection failed; retrying'));
    ws.on('close', () => { clearInterval(pulse); if (!stopped) timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.random() * 500); });
  }
  connect(); return { close() { stopped = true; clearTimeout(timer); clearInterval(pulse); ws?.terminate(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const node = startNode(); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => node.close());
}
