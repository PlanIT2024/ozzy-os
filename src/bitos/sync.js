import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createMirrorClient } from './client.js';
import { Outbox } from './outbox.js';
import { redact } from './redact.js';

const methods = ['nodeSeen', 'nodeGone', 'taskUpsert', 'approvalRequested', 'approvalDecided', 'leaseStarted', 'leaseEnded', 'event'];
export const noSync = Object.freeze(Object.fromEntries([...methods, 'close'].map(name => [name, () => {}])));
const canonical = value => String(value).trim().toLowerCase();
// Deterministic UUIDs remain stable even if state persistence is unavailable.
function stableUUID(owner, kind, identity) {
  const bytes = createHash('sha256').update(JSON.stringify([owner, kind, identity])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const riskClasses = new Set(['risky', 'destructive', 'production', 'spend', 'message_as_user', 'physical']);
export function riskClass(value) {
  return riskClasses.has(value) ? value : ({ high: 'destructive', critical: 'destructive', medium: 'risky', low: 'risky', message: 'message_as_user', cost: 'spend' }[value] || 'risky');
}

export function startBrainSync({ env = process.env, ...options } = {}) {
  // Capture once into private module state; downstream code receives the scrubbed
  // environment. Keep the snapshot for lazy client retries and redaction.
  const captured = Object.freeze({ ...env });
  for (const target of new Set([env, process.env])) {
    for (const key of Object.keys(target)) if (/^(SUPABASE_|BITOS_)/.test(key)) delete target[key];
  }
  return createSync({ ...options, env: captured });
}

export function createSync({ root, env = process.env, makeClient = createMirrorClient, now = Date.now, log = console.warn, schedule = setTimeout, interval = setInterval } = {}) {
  const settings = Object.freeze({ ...env });
  if (settings.BITOS_SUPABASE !== '1') return noSync;
  const owner = settings.BITOS_OWNER_USER_ID, workspace = settings.BITOS_DEFAULT_WORKSPACE_ID;
  const directory = path.join(root, 'data');
  const nodes = new Map(), tasks = new Map(), leases = new Map(), approvals = new Map();
  const iso = () => new Date(now()).toISOString();
  const warn = text => { try { log(text); } catch {} };
  let client, identities = {}, identityStorage = Promise.resolve(), closed = false;
  const identityFile = path.join(directory, 'bitos-node-ids.json');
  // Disk/network initialization is detached from brain startup.
  const identityReady = fs.readFile(identityFile, 'utf8').then(raw => { identities = JSON.parse(raw); }).catch(() => {});
  function nodeId(identity) {
    const key = canonical(identity);
    const id = stableUUID(owner, 'node', key);
    if (identities[key] !== id) {
      identities[key] = id;
      identityStorage = identityStorage.catch(() => {}).then(async () => {
        await identityReady; identities[key] = id;
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(identityFile + '.tmp', JSON.stringify(identities), { mode: 0o600 });
        await fs.rename(identityFile + '.tmp', identityFile);
      });
      void identityStorage.catch(() => warn('bIT OS identity persistence unavailable'));
    }
    return id;
  }
  const taskId = thread => stableUUID(workspace, 'task', String(thread));
  async function write(entry) {
    client ||= await makeClient(settings);
    if (!client) throw new Error('Mirror client unavailable');
    let result;
    if (entry.operation === 'ownerOffline') {
      if (!entry.filter?.owner_id) throw Object.assign(new Error('Owner offline reset is missing owner_id'), { code: 'BITOS_CONFIG', hint: 'Set BITOS_OWNER_USER_ID in the brain-only settings' });
      result = await client.from('nodes').update(entry.payload).eq('owner_id', entry.filter.owner_id);
    }
    else if (entry.operation === 'event') result = await client.from('task_events').upsert(entry.payload, { onConflict: 'client_event_id', ignoreDuplicates: true });
    else if (entry.operation === 'lease') {
      result = await client.from('leases').upsert(entry.payload, { onConflict: 'id', ignoreDuplicates: true });
      if (result.error && /already has an active lease/.test(result.error.message || '')) {
        warn(`bIT OS active lease conflict; local grant unchanged ${JSON.stringify(redact({ table: entry.table, operation: entry.operation,
          code: result.error.code || null, message: result.error.message, hint: result.error.hint || null,
        }, settings))}`); return;
      }
    } else if (entry.operation === 'leaseEnd') {
      // A rejected watch/control insert has no database row to revoke.
      result = await client.from('leases').update(entry.payload).eq('id', entry.payload.id);
    } else result = await client.from(entry.table).upsert(entry.payload, { onConflict: 'id' });
    if (result?.error) throw Object.assign(new Error(result.error.message || 'Mirror write failed'), { code: result.error.code, hint: result.error.hint });
  }
  const outbox = new Outbox({ directory, write, env: settings, log, now, schedule,
    migrate: entry => entry.operation === 'ownerOffline' && (!entry.filter?.owner_id || !Object.keys(entry.payload || {}).length)
      ? { ...entry, payload: { status: 'offline' }, filter: { owner_id: entry.filter?.owner_id || owner }, next: 0 }
      : entry,
  });
  // Startup reset must follow old outbox replay but precede current connections.
  outbox.enqueue('nodes', { status: 'offline' }, 'ownerOffline', { owner_id: owner });
  const queue = (table, row, op) => outbox.enqueue(table, row, op);
  function task(thread, status = 'running', machine) {
    if (!thread) return null;
    const old = tasks.get(String(thread));
    const row = { id: taskId(thread), workspace_id: workspace, title: 'Discord task', executor: 'bit', external_ref: { discord_thread_id: String(thread) }, source: 'typed', assigned_to_bit: true, created_by: owner, status, ...(old || {}), ...(machine ? { node_id: nodeId(machine) } : {}) };
    row.status = status; tasks.set(String(thread), row); queue('tasks', row); return row.id;
  }
  function event(e) {
    const id = e.thread ? (tasks.has(String(e.thread)) ? taskId(e.thread) : task(e.thread)) : null;
    if (e.machine && e.thread) task(e.thread, tasks.get(String(e.thread))?.status || 'running', e.machine);
    const lease = e.leaseId && leases.get(e.leaseId);
    queue('task_events', { client_event_id: e.id || randomUUID(),
      task_id: id, node_id: e.machine ? nodeId(e.machine) : null,
      // Lease inserts can legitimately conflict. Avoid dangling event FKs.
      lease_id: null, kind: e.kind || 'note', summary: e.summary || 'Brain action',
      payload: { ...(e.payload || {}), ...(lease ? { local_lease_id: e.leaseId } : {}) },
      screenshot_path: null, model: e.model || null, cost_cents: Number.isFinite(e.cost_cents) ? e.cost_cents : 0, created_at: iso(),
    }, 'event');
  }
  const api = {
    nodeSeen(n) {
      const identity = n.identity || n.machine || n.id;
      const key = canonical(identity), previous = nodes.get(key), time = now();
      nodes.set(key, { ...n, seen: time, written: previous?.written ?? -Infinity, online: true });
      if (previous?.online && time - previous.written < 60000 && !n.connected && !n.capabilitiesChanged) return;
      nodes.get(key).written = time;
      queue('nodes', { id: nodeId(identity), owner_id: owner, name: n.machine || n.name || identity, os: n.os || null, capabilities: n.capabilities || [], agent_version: n.version || n.agent_version || null, status: 'online', last_seen_at: iso() });
    },
    nodeGone(identity) {
      const n = nodes.get(canonical(identity)); if (n) n.online = false;
      queue('nodes', { id: nodeId(identity), owner_id: owner, name: n?.machine || String(identity), status: 'offline', ...(n ? { last_seen_at: new Date(n.seen).toISOString() } : {}) });
    },
    taskUpsert(t) {
      const status = ({ started: 'running', waiting: 'waiting_on_you', finished: 'done', failed: 'cancelled', cancelled: 'cancelled' })[t.status] || t.status || 'running';
      task(t.thread, status, t.machine);
      event({ thread: t.thread, machine: t.machine, kind: 'status', summary: `Task ${status}`, payload: { status, ...(t.reason ? { reason: t.reason } : {}) } });
    },
    approvalRequested(a) {
      const id = task(a.thread, 'waiting_on_you', a.machine);
      const row = { id: a.id, task_id: id, node_id: a.machine ? nodeId(a.machine) : null, action_summary: a.summary || 'Owner approval requested', action_detail: a.detail || {}, risk: riskClass(a.risk), status: 'pending', requested_at: iso(), expires_at: a.expires_at };
      approvals.set(a.id, row); queue('approvals', row);
      event({ thread: a.thread, kind: 'status', summary: 'Waiting for owner approval', payload: { approval_id: a.id } });
    },
    approvalDecided(a) {
      queue('approvals', { ...(approvals.get(a.id) || { id: a.id, task_id: taskId(a.thread), action_summary: a.summary || 'Owner approval requested', risk: riskClass(a.risk) }), status: a.status, decided_by: owner, decided_at: iso() });
      approvals.delete(a.id);
      task(a.thread, a.status === 'approved' ? 'running' : 'cancelled');
      event({ thread: a.thread, kind: 'status', summary: `Approval ${a.status}`, payload: { approval_id: a.id, reason: a.reason } });
    },
    leaseStarted(l) {
      const row = { id: l.id || randomUUID(), node_id: nodeId(l.machine), task_id: task(l.thread, tasks.get(String(l.thread))?.status || 'running', l.machine), level: l.level, granted_by: owner, starts_at: l.issuedAt, expires_at: l.expiresAt };
      leases.set(row.id, row); queue('leases', row, 'lease');
    },
    leaseEnded(l) { queue('leases', { id: l.id, revoked_at: l.revokedAt || iso(), revoked_reason: l.reason || 'user' }, 'leaseEnd'); },
    event,
  };
  // Each public call contains local serialization/redaction errors as well.
  for (const [name, fn] of Object.entries(api)) api[name] = (...args) => { if (!closed) try { fn(...args); } catch { warn(`bIT OS ${name} mirror failed`); } };
  const sweep = interval(() => { for (const [id, n] of nodes) if (n.online && now() - n.seen >= 90000) api.nodeGone(id); }, 1000); sweep.unref?.();
  api.close = () => {
    closed = true; clearInterval(sweep); outbox.close();
    // Shutdown may wait for local disk only, never the in-flight network write.
    return Promise.allSettled([outbox.ready.then(() => outbox.persist()), identityStorage]);
  };
  // Exposed for offline verification; never awaited by the brain.
  api.outbox = outbox; api.identityReady = () => identityStorage;
  return api;
}
