import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { MAX_MESSAGE, canonical } from '../../relay/wire.js';
export function validateRelayURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Remote relay requires wss://; ws:// allowed only on loopback for tests');
  if (url.username || url.password) throw new Error('Use Authorization header, not URL credentials'); return url.href;
}
export class RelayClient extends EventEmitter {
  constructor({ url, token, name, log = console.log, retry = 1000 }) {
    super(); this.url = validateRelayURL(url); if (!token) throw new Error('Missing RELAY_TOKEN');
    Object.assign(this, { token, name: canonical(name), log, retry }); this.attempt = 0; this.stopped = false;
    this.connect();
  }
  connect() {
    const ws = this.ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}`, 'X-Bit-Name': this.name }, maxPayload: MAX_MESSAGE, handshakeTimeout: 10000, perMessageDeflate: false });
    let alive = Date.now(), ready = false;
    const pulse = setInterval(() => { if (Date.now() - alive > 90000) ws.terminate(); else if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30000);
    ws.on('pong', () => { alive = Date.now(); });
    ws.on('message', (data, binary) => {
      if (binary) { this.emit('frame', data); return; }
      try {
        if (data.length > 1024) throw new Error();
        const m = JSON.parse(data.toString());
        if (m.type === 'ready') { ready = true; this.attempt = 0; this.emit('ready'); }
        else this.emit('control', m);
      } catch { ws.close(4400, 'Invalid relay control'); }
    });
    ws.on('error', error => { this.lastError = error.code || error.message; });
    ws.on('unexpected-response', (_request, response) => { response.resume(); this.lastError = `Relay HTTP ${response.statusCode}`; if ([401, 403].includes(response.statusCode)) this.fatal(this.lastError); else ws.terminate(); });
    ws.on('close', (code, reason) => {
      clearInterval(pulse); if (ready) this.emit('offline');
      if ([4400, 4401, 4403, 4409, 1009].includes(code)) { this.fatal(`Relay rejected ${this.name}: ${code} ${reason}`); return; }
      if (!this.stopped) { this.log(`relay ${this.name} disconnected (${code}${this.lastError ? ` ${this.lastError}` : ''}); retrying`); this.timer = setTimeout(() => this.connect(), Math.min(30000, this.retry * 2 ** Math.min(this.attempt++, 5)) + Math.random() * 250); }
    });
  }
  fatal(message) { if (this.stopped) return; this.close(); this.log(message); this.emit('fatal', new Error(message)); }
  send(frame) { if (this.ws.readyState !== WebSocket.OPEN) throw new Error('Relay offline'); this.ws.send(frame, { binary: true }); }
  reject(to, reason) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'reject', to, reason })); }
  close() { this.stopped = true; clearTimeout(this.timer); this.ws?.terminate(); }
}
