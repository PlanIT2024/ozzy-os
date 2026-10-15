import { EventEmitter } from 'node:events';
import { readPolicy, wireText } from './policy.js';
import { connectAgent } from './local.js';

// No policy mutation or local.* method is reachable from encrypted node RPC.
export class AgentBridge extends EventEmitter {
  constructor({ policy = readPolicy, connect = connectAgent } = {}) {
    super(); this.policy = policy; this.connect = connect; this.online = false;
  }
  reconnect() {
    if (this.closed || !this.available() || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.client().catch(() => this.reconnect()); }, 1000);
  }
  available() { return !this.closed && this.policy().enabled === true; }
  async client() {
    if (!this.connection) this.connection = this.connect().then(async client => {
      this.connectedClient = client;
      client.on('message', m => this.emit('message', m));
      client.on('closed', () => { this.connection = null; this.connectedClient = null; this.reconnect(); });
      await client.request('local.connection', { online: this.online });
      if (this.closed) { await client.request('local.shutdown'); client.close(); throw new Error('Agent bridge closed'); }
      return client;
    }).catch(e => { this.connection = null; throw e; });
    return this.connection;
  }
  async request(method, params) {
    if (!this.available()) throw new Error('Agent execution is disabled');
    if (!['agent.capabilities','agent.run','agent.stop','agent.decide'].includes(method)) throw new Error('Unsupported agent method');
    try { return await (await this.client()).request(method, params); }
    catch (e) { throw new Error(wireText(e.message)); }
  }
  connectionState(online) {
    this.online = online;
    if (online && this.available() && !this.connection) void this.client().catch(() => this.reconnect());
    if (this.connectedClient) void this.connectedClient.request('local.connection', { online }).catch(() => {});
  }
  async close() {
    if (!this.connection && this.available()) void this.client().catch(() => this.reconnect());
    this.closed = true; clearTimeout(this.timer);
    if (this.connection) { try { const c = await this.connection; await c.request('local.shutdown'); c.close(); } catch {} }
  }
}
