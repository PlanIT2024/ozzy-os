import { createInput } from './input/index.js';
import { createScreen } from './screen/index.js';
import { retryDelay } from '../networkRetry.js';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadKey, decodePublic, SecurePeer } from '../transport/crypto.js';
import { RelayClient } from '../transport/relayClient.js';
import { canonical, MAX_MESSAGE } from '../../relay/wire.js';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import si from 'systeminformation';
import { ROOT, required } from '../shared.js';
export function usableDisks(disks) {
  const pseudo = /^(?:efivarfs|tmpfs|devtmpfs|squashfs|proc|sysfs|devpts|cgroup2?|securityfs|debugfs|tracefs|pstore|mqueue|hugetlbfs|configfs|fusectl|ramfs|autofs|nsfs|binfmt_misc)$/i;
  return disks.filter(d => {
    const mount = String(d.mount || '').replaceAll('\\', '/');
    return Number(d.size) > 0 && !pseudo.test(d.type || '') &&
      !/^\/dev\/(?:loop|ram)\d+(?:$|p\d+$)/.test(d.fs || '') &&
      !/^\/(?:proc|sys|dev|run|snap)(?:\/|$)/.test(mount) &&
      !/^\/(?:boot\/efi|var\/lib\/snapd\/snap)(?:\/|$)/.test(mount);
  });
}
export async function machineStatus() {
  const [cpu, memory, disks, battery, users, version] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.battery(), si.users(), si.osInfo()]);
  return { uptime: os.uptime(), cpu: { loadPercent: cpu.currentLoad, cores: os.cpus().length }, memory: { total: memory.total, used: memory.active, available: memory.available }, disks: usableDisks(disks).map(d => ({ mount: d.mount, size: d.size, used: d.used, usePercent: d.use })), battery: battery.hasBattery ? { percent: battery.percent, charging: battery.isCharging, remainingMinutes: battery.timeRemaining } : null, users: [...new Set(users.map(u => u.user))], processUser: os.userInfo().username, os: { platform: version.platform, distro: version.distro, release: version.release, kernel: version.kernel } };
}
export function startNode({ transport = process.env.NODE_TRANSPORT || 'local', url = transport === 'relay' ? process.env.RELAY_URL : process.env.BRAIN_URL || 'ws://127.0.0.1:8787', token = transport === 'relay' ? process.env.NODE_RELAY_TOKEN || process.env.RELAY_TOKEN : process.env.NODE_TOKEN, machine = process.env.MACHINE_NAME, key = loadKey(process.env.NODE_KEY_FILE || path.join(ROOT, 'data/keys/node.json')), brainKey = decodePublic(process.env.BRAIN_PUBLIC_KEY), heartbeat = 30000, status = machineStatus, log = console.log, Socket = WebSocket, retry = 2000, screen = createScreen({ log }), input = createInput({ screen, log }), capabilityInterval = 15000 } = {}) {
  required({ TOKEN: token, MACHINE_NAME: machine }, ['TOKEN', 'MACHINE_NAME']);
  if (!['local', 'relay'].includes(transport) || canonical(machine) === 'brain') throw new Error('Invalid transport or machine name');
  if (transport === 'local' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Local transport must use loopback');
  const events = new EventEmitter();
  let ws, relay, peer, reconnect, pulse, handshakeTimer, stopped = false, connected = false, attempt = 0, busy = false, screenAvailable = false, inputAvailable = false, checkingScreen = false;
  function transition(next) { if (connected !== next) { connected = next; log(`bit-node ${machine} ${next ? 'connected' : 'disconnected'}`); } }
  function clearPeer() { void input.close(); clearTimeout(handshakeTimer); clearInterval(pulse); peer?.close(); peer = null; transition(false); }
  function fatal(reason) { if (stopped) return; log(`bit-node ${machine} rejected: ${reason}. Check token, NODE_KEYS, BRAIN_PUBLIC_KEY and machine name; restart after fixing.`); stop(); events.emit('fatal', new Error(reason)); }
  function begin(send) {
    clearPeer(); const current = peer = new SecurePeer({ role: 'node', name: machine, key, peerKey: brainKey, send });
    handshakeTimer = setTimeout(() => fatal('E2E handshake timed out (untrusted key/name or unreachable brain)'), 10000);
    current.on('ready', () => {
      clearTimeout(handshakeTimer); transition(true); attempt = 0;
      current.send({ type: 'hello', machine, os: os.platform(), arch: os.arch(), hostname: os.hostname(), version: '2.0.0', capabilities: capabilities() });
      pulse = setInterval(() => { try { current.send({ type: 'heartbeat' }); } catch { clearPeer(); } }, heartbeat);
    });
    current.on('message', async m => {
      if (m.type !== 'req' || typeof m.id !== 'string' || m.id.length > 128) return;
      const sendResult = value => { if (current === peer && current.state === 'open') current.send({ type: 'res', id: m.id, ...value }); };
      if (m.method === 'input_stop') { if (!input.session || m.params?.grantId === input.session.grantId) await input.stop(m.params?.revoke === false ? 'runtime suspended' : 'owner off', m.params?.revoke !== false); return sendResult({ ok: true, result: { stopped: true } }); }
      if (!['status', 'screen','input_start','input_action'].includes(m.method)) return sendResult({ ok: false, error: 'Unsupported method' });
      if (m.method === 'screen') log('screen capture attempt stage=node_request');
      if (m.method === 'screen' && !await screen.available({ diagnose: true })) { log('screen capture failure stage=availability'); return sendResult({ ok: false, error: 'Screen capture disabled or graphical session unavailable' }); }
      if (busy) { if (m.method === 'screen') log('screen capture failure stage=busy'); return sendResult({ ok: false, error: 'Status collection busy' }); }
      busy = true;
      try {
        let result;
        if (m.method === 'screen') { result = await screen.capture(); input.observe(result); }
        else if (m.method === 'input_start') result = await input.start(m.params || {});
        else if (m.method === 'input_action') result = await input.act(m.params || {});
        else result = await status();
        sendResult({ ok: true, result });
      } catch { if (m.method === 'screen') log('screen capture failure stage=node_capture (see helper diagnostics)'); else if (m.method.startsWith('input')) log('input failure stage=node_request'); sendResult({ ok: false, error: m.method.startsWith('input') ? 'Input control refused or failed; check node portal diagnostics' : m.method === 'screen' ? 'Screen capture failed or desktop consent was denied/timed out' : 'Status collection failed' }); }
      finally { busy = false; }
    });
    current.start();
  }
  function receive(frame) { try { if (!peer) throw new Error('No E2E handshake'); peer.receive(frame); } catch (error) { fatal(error.message); } }
  function connectLocal() {
    log(`bit-node ${machine} connection attempt ${attempt + 1}`);
    ws = new Socket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: MAX_MESSAGE, handshakeTimeout: 10000, perMessageDeflate: false });
    let lastPong = Date.now();
    const ping = setInterval(() => { if (Date.now() - lastPong > 90000) ws.terminate(); else if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30000);
    ws.on('open', () => begin(frame => ws.send(frame)));
    ws.on('pong', () => { lastPong = Date.now(); });
    ws.on('message', (data, binary) => { if (!binary) fatal('Brain sent unencrypted data'); else receive(data); });
    ws.on('error', error => log(`bit-node ${machine} network error: ${error.code || error.message}; retrying`));
    ws.on('unexpected-response', (_request, response) => { response.resume(); if ([401,403].includes(response.statusCode)) fatal(`Authentication failed: HTTP ${response.statusCode}`); else ws.terminate(); });
    ws.on('close', (code, reason) => {
      clearInterval(ping); clearPeer();
      if ([4400, 4401, 4403, 4408, 1009].includes(code)) { fatal(`${code} ${reason}`); return; }
      if (!stopped) reconnect = setTimeout(connectLocal, retryDelay(attempt++, retry));
    });
  }
  function capabilities() { return ['status', ...(screenAvailable ? ['screen'] : []), ...(screenAvailable && inputAvailable ? ['input'] : [])]; }
  input.on('closed', details => { if (peer?.state === 'open') { try { peer.send({ type: 'control_closed', ...details }); } catch { log('input closure delivery unavailable'); } } });
  async function refreshScreen() {
    if (stopped || checkingScreen) return; checkingScreen = true;
    try {
      let next = false;
      try { next = await screen.available(); } catch {}
      let nextInput = false;
      try { nextInput = next && await input.available(); } catch {}
      if (!nextInput && input.session) await input.stop('graphical session unavailable', true);
      if (next !== screenAvailable || nextInput !== inputAvailable) {
        screenAvailable = next; inputAvailable = nextInput;
        if (peer?.state === 'open') peer.send({ type: 'capabilities', capabilities: capabilities() });
      }
    } catch { screenAvailable = false; } finally { checkingScreen = false; }
  }
  const capabilityTimer = setInterval(() => { void refreshScreen(); }, capabilityInterval); capabilityTimer.unref();
  void refreshScreen();
  function stop() { stopped = true; clearInterval(capabilityTimer); screen.close(); void input.close(); clearTimeout(reconnect); clearPeer(); relay?.close(); ws?.terminate(); }
  if (transport === 'relay') {
    relay = new RelayClient({ url, token, name: machine, log, retry });
    relay.on('frame', receive);
    relay.on('control', m => {
      if (m.type === 'peer' && m.name === 'brain') { if (m.online) begin(frame => relay.send(frame)); else clearPeer(); }
      if (m.type === 'rejected') fatal(m.reason === 'unknown_key' ? 'Unknown node key/name in brain NODE_KEYS' : 'E2E authentication failed: wrong key/name or rejected ciphertext');
    });
    relay.on('offline', clearPeer); relay.on('fatal', error => fatal(error.message));
  } else connectLocal();
  return Object.assign(events, { close: stop });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const node = startNode(); node.on('fatal', () => { process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => node.close());
}
