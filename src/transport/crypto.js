import sodium from 'libsodium-wrappers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { canonical, pack, unpack } from '../../relay/wire.js';
await sodium.ready;
export { sodium };
export const publicHex = key => sodium.to_hex(key.publicKey);
export function loadKey(file, create = false) {
  if (!fs.existsSync(file)) {
    if (!create) throw new Error(`Missing key ${file}; run npm run keygen -- --role brain|node`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const key = sodium.crypto_kx_keypair();
    fs.writeFileSync(file, JSON.stringify({ publicKey: sodium.to_hex(key.publicKey), privateKey: sodium.to_hex(key.privateKey) }) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe key file');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Key file must have mode 0600');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = { publicKey: decodePublic(data.publicKey), privateKey: sodium.from_hex(data.privateKey) };
  if (key.privateKey.length !== 32 || !sodium.memcmp(sodium.crypto_scalarmult_base(key.privateKey), key.publicKey)) throw new Error('Invalid keypair');
  return key;
}
export function decodePublic(value) { if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error('Public key must be 64 hex characters'); return sodium.from_hex(value); }
export function nodeKeys(raw = '') {
  const keys = new Map(), seen = new Set();
  for (const pair of raw.split(',').filter(Boolean)) {
    const [name, hex, extra] = pair.trim().split(':'); const id = canonical(name);
    if (extra || id === 'brain' || keys.has(id) || seen.has(hex?.toLowerCase())) throw new Error('Duplicate or invalid NODE_KEYS');
    keys.set(id, { name, publicKey: decodePublic(hex) }); seen.add(hex.toLowerCase());
  }
  return keys;
}
const ZERO = '0'.repeat(64);
export class Cipher {
  constructor({ role, name, key, peerKey }) {
    this.name = canonical(name); this.from = role === 'brain' ? 'brain' : this.name; this.to = role === 'brain' ? this.name : 'brain';
    const keys = role === 'brain' ? sodium.crypto_kx_server_session_keys(key.publicKey, key.privateKey, peerKey) : sodium.crypto_kx_client_session_keys(key.publicKey, key.privateKey, peerKey);
    this.tx = keys.sharedTx; this.rx = keys.sharedRx; this.session = ZERO; this.sent = 0n; this.received = -1n;
  }
  bind(session) { if (!/^[a-f0-9]{64}$/.test(session)) throw new Error('Invalid session'); this.session = session; this.sent = 0n; this.received = 0n; }
  aad(meta, session, counter) { return sodium.from_string(JSON.stringify(['bit-e2e-v1', meta.from, meta.to, meta.id, session, counter.toString()])); }
  seal(message) {
    const meta = { from: this.from, to: this.to, id: randomUUID() }; const counter = this.sent++;
    const nonce = sodium.randombytes_buf(24); const session = Buffer.from(this.session, 'hex'); const count = Buffer.alloc(8); count.writeBigUInt64BE(counter);
    const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(JSON.stringify(message), this.aad(meta, this.session, counter), null, nonce, this.tx);
    return pack(meta, Buffer.concat([session, count, Buffer.from(nonce), Buffer.from(encrypted)]));
  }
  open(frame) {
    const { meta, payload } = unpack(frame);
    if (meta.from !== this.to || meta.to !== this.from || payload.length < 80) throw new Error('Wrong name for E2E key');
    const session = payload.subarray(0, 32).toString('hex'); const counter = payload.readBigUInt64BE(32);
    if (session !== this.session || counter <= this.received) throw new Error('Replayed/out-of-order counter or expired session');
    let plain;
    try { plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, payload.subarray(64), this.aad(meta, session, counter), payload.subarray(40, 64), this.rx); }
    catch { throw new Error('E2E decryption failed: unknown/mismatched key or name, or tampered ciphertext'); }
    const message = JSON.parse(sodium.to_string(plain)); this.received = counter; return message;
  }
  destroy() { sodium.memzero(this.tx); sodium.memzero(this.rx); }
}
export class SecurePeer extends EventEmitter {
  constructor({ role, name, key, peerKey, send }) { super(); this.role = role; this.cipher = new Cipher({ role, name, key, peerKey }); this.transmit = send; this.state = role === 'brain' ? 'init' : 'challenge'; }
  start() { this.clientNonce = sodium.to_hex(sodium.randombytes_buf(32)); this.transmit(this.cipher.seal({ type: 'init', clientNonce: this.clientNonce })); }
  receive(frame) {
    const m = this.cipher.open(frame);
    if (this.role === 'brain' && this.state === 'init') {
      if (m.type !== 'init' || !/^[a-f0-9]{64}$/.test(m.clientNonce)) throw new Error('Invalid encrypted init');
      this.clientNonce = m.clientNonce; this.session = sodium.to_hex(sodium.randombytes_buf(32));
      const challenge = this.cipher.seal({ type: 'challenge', clientNonce: m.clientNonce, session: this.session });
      this.cipher.bind(this.session); this.cipher.sent = 1n; this.state = 'finish'; this.transmit(challenge);
    } else if (this.role === 'node' && this.state === 'challenge') {
      if (m.type !== 'challenge' || m.clientNonce !== this.clientNonce) throw new Error('Replayed handshake challenge');
      this.cipher.bind(m.session); this.cipher.sent = 1n; this.state = 'ready'; this.transmit(this.cipher.seal({ type: 'finish', clientNonce: this.clientNonce }));
    } else if (this.role === 'brain' && this.state === 'finish') {
      if (m.type !== 'finish' || m.clientNonce !== this.clientNonce) throw new Error('Invalid handshake proof');
      this.state = 'open'; this.transmit(this.cipher.seal({ type: 'ready' })); this.emit('ready');
    } else if (this.role === 'node' && this.state === 'ready') {
      if (m.type !== 'ready') throw new Error('Invalid handshake acknowledgement'); this.state = 'open'; this.emit('ready');
    } else if (this.state === 'open') this.emit('message', m);
    else throw new Error('Invalid handshake state');
  }
  send(message) { if (this.state !== 'open') throw new Error('E2E handshake not complete'); this.transmit(this.cipher.seal(message)); }
  close() { this.cipher.destroy(); this.state = 'closed'; this.emit('close'); }
}
