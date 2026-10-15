import { randomUUID } from 'node:crypto';
import { createMirrorClient } from './client.js';
import { wireText } from '../node/agent/policy.js';
import { redact } from './redact.js';

export function createDispatcher({ env = process.env, hub, makeClient = createMirrorClient, now = Date.now, interval = setInterval, log = console.warn, info = console.info } = {}) {
  if (env.BITOS_DISPATCH !== '1') return { ready: Promise.resolve(), close() {} };
  const settings = { ...env }, owner = settings.BITOS_OWNER_USER_ID;
  const allowed = new Set((settings.BITOS_AGENT_NODES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const disabled = new Set();
  const caps = new Map(), confirmed = new Set(), recovered = new Set(), retries = new Map();
  const started = now(); let subscribedTasks = ''; let db, channel, timer, closed = false, chain = Promise.resolve();
  // Keep query/RPC context without serializing errors, rows, request parameters,
  // stacks or Supabase details (which can contain an entire failing row).
  const failures = new WeakMap(), privateText = new Set();
  function rememberPrompt(prompt) {
    if (typeof prompt !== 'string' || !prompt) return;
    privateText.add(prompt);
    privateText.add(prompt.slice(0, 200));
    for (const line of prompt.split('\n')) if (line) privateText.add(line);
  }
  function report(error, operation, table) {
    const context = failures.get(error) || { error, operation, table };
    const source = context.error;
    const clean = value => {
      if (typeof value !== 'string') return null;
      // Known prompt text must be removed before redact truncates diagnostic text.
      for (const text of [...privateText].sort((a, b) => b.length - a.length)) value = value.replaceAll(text, '[prompt omitted]');
      return value;
    };
    const diagnostic = redact({ operation: context.operation, table: context.table,
      code: clean(source?.code), message: clean(typeof source === 'string' ? source : source?.message) || 'Unknown dispatcher failure',
      hint: clean(source?.hint),
    }, settings);
    try { log(`bIT dispatcher failure ${JSON.stringify(diagnostic)}`); } catch {}
  }
  async function attempt(operation, table, fn) {
    try { return await fn(); } catch (error) {
      const wrapped = new Error('Dispatcher operation failed');
      failures.set(wrapped, failures.get(error) || { error, operation, table });
      throw wrapped;
    }
  }
  const serial = (operation, table, fn) => {
    chain = chain.then(() => closed ? undefined : fn()).catch(error => report(error, operation, table));
    return chain;
  };
  async function query(table, operation, q) {
    return attempt(operation, table, async () => {
      const r = await q;
      if (r.error) throw r.error;
      if (table === 'agent_runs') for (const run of r.data || []) rememberPrompt(run.prompt);
      return r.data;
    });
  }
  const request = (machine, method, params) => attempt(method, 'nodes', () => hub.request(machine, method, params));
  const row = async (table, id) => (await query(table, 'select', db.from(table).select('*').eq('id', id)))[0];
  const update = (table, id, data) => query(table, 'update', db.from(table).update(data).eq('id', id));
  async function context(id) {
    const run = await row('agent_runs', id); if (!run) return {};
    const task = await row('tasks', run.task_id), node = await row('nodes', run.node_id);
    const members = task && await query('workspace_members', 'select', db.from('workspace_members').select('*').eq('workspace_id', task.workspace_id).eq('user_id', owner));
    if (!members?.length || node?.owner_id !== owner) return {};
    return { run, node };
  }
  function valid(r, n) {
    const c = caps.get(n.name.toLowerCase());
    return allowed.has(n.name.toLowerCase()) && c && ['codex','claude_code'].includes(r.executor) && c.executors.includes(r.executor) && c.folders.includes(r.folder_alias) && Number.isInteger(r.lease_minutes) && r.lease_minutes >= 1 && r.lease_minutes <= Math.min(120,c.maxLeaseMinutes) && typeof r.prompt === 'string' && r.prompt.trim() && r.prompt.length <= 8000;
  }
  async function finish(r, status, summary, branch) {
    for (const [key, retry] of retries) if (retry.runId === r.id) retries.delete(key);
    await update('agent_runs', r.id, { status, summary: redact(summary, settings), ...(branch ? { branch: redact(branch, settings) } : {}) });
    await update('tasks', r.task_id, { status: status === 'done' ? 'done' : ['stopped','expired','denied'].includes(status) ? 'cancelled' : 'waiting_on_you' });
  }
  const retryKey = (r, method, params = {}) => `${r.id}:${method}:${params.requestId || ''}`;
  async function retryRequest(r, n, method, params, a) {
    const key = retryKey(r, method, params), pending = retries.get(key);
    if (pending) {
      if (a && !(Date.parse(a.expires_at) > now())) {
        await finish(r, 'failed', 'Approval expired while node offline');
        return false;
      }
      if (now() - pending.since >= 90000) {
        await finish(r, 'failed', 'node offline for 90 s');
        return false;
      }
      if (now() < pending.next) return false;
    }
    try {
      await request(n.name, method, params);
      retries.delete(key);
      return true;
    } catch (error) {
      const source = failures.get(error)?.error;
      // These are hub/relay transport errors, not arbitrary remote tool failures.
      const offline = source?.message === `Machine ${n.name} is offline`
        || source?.message === 'Machine disconnected' || source?.message === 'Relay offline';
      if (!offline) { retries.delete(key); throw error; }
      if (!pending) {
        retries.set(key, { runId: r.id, since: now(), next: now() + 5000 });
        try { log(`bIT dispatcher retry ${method}: node offline; retrying every 5 s for up to 90 s`); } catch {}
      } else pending.next = now() + 5000;
      return false;
    }
  }
  async function approval(r, n, detail, summary) {
    await query('approvals', 'insert', db.from('approvals').insert({ id: randomUUID(), task_id: r.task_id, node_id: n.id, risk: 'risky', action_summary: summary, action_detail: detail, expires_at: new Date(now()+600000).toISOString() }));
    await update('tasks', r.task_id, { status: 'waiting_on_you' });
  }
  async function processRun(id) {
    const { run:r, node:n } = await context(id); if (!r) return;
    if (recovered.has(id) && !confirmed.has(id) && ['dispatched','running'].includes(r.status) && now()-started >= 120000 && ![...retries.values()].some(retry => retry.runId === id)) return finish(r,'failed','brain restarted');
    if (r.stop_requested && ['requested','awaiting_approval'].includes(r.status)) return finish(r,'stopped','Stopped by owner');
    if (r.stop_requested && ['dispatched','running'].includes(r.status)) {
      // An owner stop supersedes an unsent run retry; never dispatch it later.
      retries.delete(retryKey(r, 'agent.run'));
      await retryRequest(r,n,'agent.stop',{runId:r.id}); return;
    }
    if (r.status === 'requested') {
      if (!valid(r,n)) return finish(r,'denied','Node allowlist or agent capabilities rejected request');
      // Claim before creating approval; a crash here safely leaves an inert request.
      const claimed = await query('agent_runs', 'update', db.from('agent_runs').update({status:'awaiting_approval'}).eq('id',r.id).eq('status','requested').select('*'));
      if (!claimed.length) return;
      await approval(r,n,{run_id:r.id,kind:'run'},`Run ${r.executor} on ${n.name} in ${r.folder_alias} for ${r.lease_minutes} min: ${r.prompt.slice(0,200)}`);
    }
  }
  async function decide(id) {
    // Realtime only wakes the scanner. Always fetch both authoritative rows.
    const a = await row('approvals',id); if (!a?.action_detail?.run_id) return;
    const {run:r,node:n} = await context(a.action_detail.run_id); if (!r || a.task_id !== r.task_id || a.node_id !== n.id) return;
    const kind = a.action_detail.kind;
    const retryingRun = retries.has(retryKey(r, 'agent.run'));
    if (kind === 'run' && r.status !== 'awaiting_approval' && !(r.status === 'dispatched' && retryingRun)) return;
    if (kind === 'agent' && !['dispatched','running'].includes(r.status)) return;
    if (!['run','agent'].includes(kind)) return;
    const expired = Date.parse(a.expires_at) <= now();
    if (retries.has(retryKey(r, kind === 'run' ? 'agent.run' : 'agent.decide', {requestId: a.action_detail.request_id})) && expired) return finish(r,'failed','Approval expired while node offline');
    if (a.status === 'pending' && !expired) return;
    const yes = a.status === 'approved' && a.decided_by === n.owner_id && Number.isFinite(Date.parse(a.decided_at)) && Date.parse(a.decided_at) <= Date.parse(a.expires_at) && !expired && !r.stop_requested;
    if (a.status === 'approved' && !yes && !expired && !r.stop_requested) return;
    if (kind === 'run') {
      if (!yes) return finish(r,'denied','Approval denied or expired');
      if (!valid(r,n)) return finish(r,'denied','Agent capabilities changed');
      const claim = retryingRun ? [r] : await query('agent_runs', 'update', db.from('agent_runs').update({status:'dispatched'}).eq('id',r.id).eq('status','awaiting_approval').eq('stop_requested',false).select('*'));
      if (!claim.length) return;
      try {
        if (!await retryRequest(r,n,'agent.run',{runId:r.id,taskId:r.task_id,executor:r.executor,folderAlias:r.folder_alias,prompt:r.prompt,leaseMinutes:r.lease_minutes},a)) return;
        confirmed.add(r.id);
        const current = await row('agent_runs',r.id);
        if (current.status === 'dispatched') await update('agent_runs',r.id,{status:'running'});
        await update('tasks',r.task_id,{status:'running'});
      } catch (error) { report(error, 'dispatch_run', 'agent_runs'); await finish(r,'failed','Node dispatch failed'); }
    } else {
      if (typeof a.action_detail.request_id !== 'string') return;
      if (!await retryRequest(r,n,'agent.decide',{runId:r.id,requestId:a.action_detail.request_id,decision:yes?'allow':'deny'},a)) return;
      await update('approvals',a.id,{status:yes?'approved':expired?'expired':'denied',action_detail:{...a.action_detail,kind:'agent_decided'}});
      await update('tasks',r.task_id,{status:'running'});
    }
  }
  async function scan() {
    const memberships = await query('workspace_members', 'select', db.from('workspace_members').select('*').eq('user_id',owner));
    const workspaces = memberships.map(m => m.workspace_id);
    if (!workspaces.length) return;
    const tasks = await query('tasks', 'select', db.from('tasks').select('*').in('workspace_id',workspaces));
    const ids = tasks.map(t => t.id);
    if (!ids.length) return;
    for (const n of await query('nodes', 'select', db.from('nodes').select('*').eq('owner_id',owner))) {
      const agent = caps.get(n.name.toLowerCase());
      if (agent && JSON.stringify(n.metadata?.agent) !== JSON.stringify(agent)) await update('nodes',n.id,{capabilities:[...new Set([...(n.capabilities||[]),'run_agent'])],metadata:{...n.metadata,agent}});
    }
    for (const r of await query('agent_runs', 'select', db.from('agent_runs').select('*').in('task_id',ids))) {
      try { await processRun(r.id); } catch (error) { report(error, 'process_run', 'agent_runs'); }
    }
    for (const a of await query('approvals', 'select', db.from('approvals').select('*').in('task_id',ids))) {
      try { await decide(a.id); } catch (error) { report(error, 'decide_approval', 'approvals'); }
    }
    const key = ids.sort().join(',');
    if (key !== subscribedTasks) {
      if (channel) await attempt('unsubscribe', 'agent_runs,approvals', () => db.removeChannel(channel));
      subscribedTasks = key;
      channel = db.channel('bitos-dispatch').on('postgres_changes',{event:'*',schema:'public',table:'agent_runs',filter:`task_id=in.(${key})`},()=>serial('scan', 'agent_runs,approvals', scan)).on('postgres_changes',{event:'*',schema:'public',table:'approvals',filter:`task_id=in.(${key})`},()=>serial('scan', 'agent_runs,approvals', scan)).subscribe((status, error) => {
        if (error || ['CHANNEL_ERROR','TIMED_OUT'].includes(status)) report(error || new Error(status), 'subscribe', 'agent_runs,approvals');
      });
    }
  }
  const connect = ({machine}) => serial('node_connected', 'nodes', async () => {
    caps.delete(machine.toLowerCase());
    let c;
    try { c = await request(machine,'agent.capabilities'); } catch (error) {
      if (failures.get(error)?.error?.message !== 'Agent execution is disabled') throw error;
      if (!disabled.has(machine.toLowerCase())) { disabled.add(machine.toLowerCase()); info('bIT agent execution is disabled (no enabled node policy)'); }
      return;
    }
    if (!c || !Array.isArray(c.executors) || !Array.isArray(c.folders) || !c.folders.every(x => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)) || !Number.isInteger(c.maxLeaseMinutes) || !Number.isInteger(c.maxConcurrent)) return;
    const safe = {executors:c.executors.filter(x=>['codex','claude_code'].includes(x)),folders:c.folders,maxLeaseMinutes:c.maxLeaseMinutes,maxConcurrent:c.maxConcurrent};
    caps.set(machine.toLowerCase(),safe);
    const nodes = await query('nodes', 'select', db.from('nodes').select('*').eq('owner_id',owner));
    for (const n of nodes.filter(n=>n.name.toLowerCase()===machine.toLowerCase())) await update('nodes',n.id,{capabilities:[...new Set([...(n.capabilities||[]),'run_agent'])],metadata:{...n.metadata,agent:safe}});
  });
  const message = ({machine,message:m}) => serial('agent_message', 'agent_runs', async () => {
    const {run:r,node:n} = await context(m.runId);
    if (!r || n.name.toLowerCase() !== machine.toLowerCase() || !['dispatched','running'].includes(r.status)) return;
    confirmed.add(r.id);
    if (m.type === 'agent.approval_request' && typeof m.requestId === 'string') {
      const existing = await query('approvals', 'select', db.from('approvals').select('*').eq('task_id',r.task_id));
      if (!existing.some(a=>a.action_detail?.run_id===r.id && a.action_detail?.request_id===m.requestId)) await approval(r,n,...agentApproval(m, r, settings));
    } else if (m.type === 'agent.finished' && ['done','failed','stopped','expired'].includes(m.status)) await finish(r,m.status,m.reason && !String(m.summary || '').includes(m.reason) ? `${m.reason}: ${m.summary || m.status}` : m.summary,m.branch);
    else if (m.type === 'agent.event') await query('task_events', 'insert', db.from('task_events').insert({client_event_id:randomUUID(),task_id:r.task_id,node_id:n.id,kind:'agent',summary:redact(m.summary,settings),payload:redact(m,settings)}));
  });
  const ready = (async () => {
    db = await attempt('create_client', null, () => makeClient({...settings,BITOS_SUPABASE:'1'}));
    for (const r of await query('agent_runs', 'select', db.from('agent_runs').select('*'))) if (['dispatched','running'].includes(r.status)) recovered.add(r.id);
    hub.on('node_connected',connect); hub.on('agent',message);
    for (const n of hub.list()) if (n.online) await connect(n);
    timer = interval(()=>serial('scan', 'agent_runs,approvals', scan),5000); timer.unref?.();
    await serial('scan', 'agent_runs,approvals', scan);
  })().catch(error => { report(error, 'startup', 'agent_runs'); throw error; });
  return {ready,scan:()=>ready.then(()=>serial('scan', 'agent_runs,approvals', scan)),close(){closed=true;retries.clear();clearInterval(timer);hub.off('node_connected',connect);hub.off('agent',message);if(channel) void attempt('unsubscribe', 'agent_runs,approvals', () => db.removeChannel(channel)).catch(error => report(error, 'close', 'agent_runs,approvals'));}};
}

// Node wireText has already made worktree paths relative. Apply the same
// credential filtering as task_events, with an explicit command field allowlist.
function agentApproval(m, run, settings) {
  let input = m.detail;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
  input = input && typeof input === 'object' ? input : {};
  const clean = (value, limit = 240) => redact(wireText(String(value).replace(/[a-z]:[\\/][^\s"'<>;,]*/gi, '[path]')), settings, 0, limit);
  const tool = clean(m.action || 'Agent permission requested');
  const paths = [];
  function visit(value, key = '') {
    if (typeof value === 'string' && /^(path|file_path|filePath|target|destination|paths)$/.test(key)) {
      const normalized = value.replaceAll('\\', '/');
      if (!/^(?:\/|~|[a-z]:)/i.test(normalized) && !normalized.split('/').includes('..') && normalized !== '[path]' && paths.length < 10) paths.push(clean(normalized));
    } else if (Array.isArray(value)) value.forEach(v => visit(v, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => visit(v,k));
  }
  visit(input);
  const command = /bash|commandExecution|shell|command/i.test(tool) && typeof input.command === 'string' ? clean(input.command, 500) : '';
  const detail = { run_id:run.id, request_id:m.requestId, kind:'agent', executor:clean(m.executor || run.executor), tool, command, paths };
  return [detail, `${tool}${command || paths.length ? ': ' + (command || paths.join(', ')) : ''}`];
}
