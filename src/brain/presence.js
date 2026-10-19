import { EventEmitter } from 'node:events';

export const REACTION_MS = { celebrate: 1600, wince: 1200, curious: 2000, unsure: 2500 };
export const CAPTURE_PULSE_MS = 1200;
export const PRIORITY = ['idle', 'listen', 'think', 'agent', 'screen', 'lease', 'approve'];
const time = value => typeof value === 'number' ? value : Date.parse(value);
export function computePresence(inputs = {}, now = Date.now()) {
  now = +now;
  const displayNode = name => Object.keys(inputs.nodes || {}).find(key => key.toLowerCase() === String(name).toLowerCase()) || name;
  const watching = Object.entries(inputs.nodes || {}).filter(([, n]) => n.capture?.screen === true).map(([name]) => name).sort();
  const screenGrants = [...new Set(Object.values(inputs.screenGrants || {}).filter(g => time(g.endsAt) > now).map(g => displayNode(g.node)))].sort();
  const capturePulse = inputs.capturePulse && now >= time(inputs.capturePulse.at) && now - time(inputs.capturePulse.at) < CAPTURE_PULSE_MS ? inputs.capturePulse : null;
  const leases = Object.values(inputs.leases || {}).filter(l => time(l.endsAt) > now).map(l => ({ ...l, node: displayNode(l.node) }));
  const lease = leases.sort((a, b) => time(a.endsAt) - time(b.endsAt))[0] || null;
  const approvals = Object.values(inputs.approvals || {}).some(a => !a.expiresAt || time(a.expiresAt) > now);
  const agent = Object.values(inputs.agents || {})[0];
  const flags = { idle: true, listen: inputs.listening > 0, think: inputs.thinking > 0, agent: !!agent, screen: watching.length > 0 || screenGrants.length > 0, lease: !!lease, approve: approvals };
  const state = [...PRIORITY].reverse().find(s => flags[s]);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
  const reaction = inputs.reaction && REACTION_MS[inputs.reaction.kind] && now >= time(inputs.reaction.at) && now - time(inputs.reaction.at) < REACTION_MS[inputs.reaction.kind] ? inputs.reaction : null;
  return { state, mood: hour >= 22 || hour < 5 ? 'sage' : inputs.mood || 'chill', reaction,
    node: state === 'lease' ? lease.node : state === 'screen' ? watching[0] || screenGrants[0] : state === 'agent' ? agent.node : null, lease, watching, screenGrants, capturePulse,
    attention: approvals || leases.some(l => time(l.endsAt) - now < 120000) ? 'interrupt' : 'ambient', updatedAt: new Date(now).toISOString() };
}
const signature = ({ updatedAt, ...value }) => JSON.stringify(value);
export class PresenceHub extends EventEmitter {
  constructor({ now = Date.now, interval = setInterval } = {}) {
    super(); this.now = now; this.inputs = { nodes: {}, leases: {}, screenGrants: {}, approvals: {}, agents: {} };
    this.value = computePresence(this.inputs, now());
    this.timer = interval(() => this.recompute(), 100); this.timer?.unref?.();
  }
  recompute() {
    const next = computePresence(this.inputs, this.now());
    if (signature(next) !== signature(this.value)) { this.value = next; this.emit('change', next); }
    return this.value;
  }
  set(patch) { Object.assign(this.inputs, patch); return this.recompute(); }
  react(kind) { if (REACTION_MS[kind]) this.set({ reaction: { kind, at: new Date(this.now()).toISOString() } }); }
  observe(name, e) {
    if (name === 'nodeSeen') {
      const previous = this.inputs.nodes[e.machine];
      if (e.capture?.screen === true && previous?.capture?.screen !== true) this.inputs.capturePulse = { node: e.machine, at: new Date(this.now()).toISOString() };
      this.inputs.nodes[e.machine] = { capture: e.capture || { screen: false, input: false } };
    }
    if (name === 'nodeGone') for (const key of Object.keys(this.inputs.nodes)) if (key.toLowerCase() === String(e).toLowerCase()) delete this.inputs.nodes[key];
    if (name === 'leaseStarted' && e.level === 'control') this.inputs.leases[e.id] = { node: e.machine, endsAt: e.expiresAt, totalSec: (time(e.expiresAt) - time(e.issuedAt)) / 1000 };
    if (name === 'leaseStarted' && e.level === 'watch') this.inputs.screenGrants[e.id] = { node: e.machine, endsAt: e.expiresAt };
    if (name === 'leaseEnded') { delete this.inputs.leases[e.id]; delete this.inputs.screenGrants[e.id]; }
    if (name === 'approvalRequested') this.inputs.approvals[e.id] = { expiresAt: e.expires_at };
    if (name === 'approvalDecided') delete this.inputs.approvals[e.id];
    this.recompute();
  }
  close() { clearInterval(this.timer); this.removeAllListeners(); }
}
// Observe local grants/approvals even when Supabase mirroring is disabled.
export function observeSync(sync, presence) {
  return Object.fromEntries(Object.entries(sync).map(([name, fn]) => [name, typeof fn === 'function' ? (...args) => { presence.observe(name, args[0]); return fn.apply(sync, args); } : fn]));
}

// Presence is ephemeral: retry the latest value, never replay an old heartbeat.
export function createPresencePublisher({ hub, write, now = Date.now, schedule = setTimeout, interval = setInterval, log = console.warn }) {
  let timer, closed = false, writing = false, dirty = true, lastWrite = -Infinity;
  async function flush() {
    timer = undefined;
    if (closed || writing || (!dirty && now() - lastWrite < 60000)) return;
    writing = true; dirty = false;
    try { await write({ ...hub.value, updatedAt: new Date(now()).toISOString() }); lastWrite = now(); }
    catch { dirty = true; log('bIT presence publish unavailable'); }
    finally { writing = false; if (dirty && !closed && !timer) timer = schedule(flush, 250); }
  }
  const change = () => { dirty = true; clearTimeout(timer); timer = schedule(flush, 250); };
  hub.on('change', change); change();
  const heartbeat = interval(() => { if (now() - lastWrite >= 60000) void flush(); }, 1000); heartbeat?.unref?.();
  return { flush, close() { closed = true; clearTimeout(timer); clearInterval(heartbeat); hub.off('change', change); } };
}
