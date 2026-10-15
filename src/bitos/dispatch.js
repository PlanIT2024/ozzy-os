import { randomUUID } from 'node:crypto';
import { createMirrorClient } from './client.js';
import { redact } from './redact.js';

export function createDispatcher({ env = process.env, hub, makeClient = createMirrorClient, now = Date.now, interval = setInterval, log = console.warn } = {}) {
  if (env.BITOS_DISPATCH !== '1') return { ready: Promise.resolve(), close() {} };
  const settings = { ...env }, owner = settings.BITOS_OWNER_USER_ID;
  const allowed = new Set((settings.BITOS_AGENT_NODES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const caps = new Map(), confirmed = new Set(), recovered = new Set();
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
    await update('agent_runs', r.id, { status, summary: redact(summary, settings), ...(branch ? { branch: redact(branch, settings) } : {}) });
    await update('tasks', r.task_id, { status: status === 'done' ? 'done' : ['stopped','expired','denied'].includes(status) ? 'cancelled' : 'waiting_on_you' });
  }
  async function approval(r, n, detail, summary) {
    await query('approvals', 'insert', db.from('approvals').insert({ id: randomUUID(), task_id: r.task_id, node_id: n.id, risk: 'risky', action_summary: summary, action_detail: detail, expires_at: new Date(now()+600000).toISOString() }));
    await update('tasks', r.task_id, { status: 'waiting_on_you' });
  }
  async function processRun(id) {
    const { run:r, node:n } = await context(id); if (!r) return;
    if (recovered.has(id) && !confirmed.has(id) && ['dispatched','running'].includes(r.status) && now()-started >= 120000) return finish(r,'failed','brain restarted');
    if (r.stop_requested && ['requested','awaiting_approval'].includes(r.status)) return finish(r,'stopped','Stopped by owner');
    if (r.stop_requested && ['dispatched','running'].includes(r.status)) { await request(n.name,'agent.stop',{runId:r.id}); return; }
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
    if (kind === 'run' && r.status !== 'awaiting_approval') return;
    if (kind === 'agent' && !['dispatched','running'].includes(r.status)) return;
    if (!['run','agent'].includes(kind)) return;
    const expired = Date.parse(a.expires_at) <= now();
    if (a.status === 'pending' && !expired) return;
    const yes = a.status === 'approved' && a.decided_by === n.owner_id && Number.isFinite(Date.parse(a.decided_at)) && Date.parse(a.decided_at) <= Date.parse(a.expires_at) && !expired && !r.stop_requested;
    if (a.status === 'approved' && !yes && !expired && !r.stop_requested) return;
    if (kind === 'run') {
      if (!yes) return finish(r,'denied','Approval denied or expired');
      if (!valid(r,n)) return finish(r,'denied','Agent capabilities changed');
      const claim = await query('agent_runs', 'update', db.from('agent_runs').update({status:'dispatched'}).eq('id',r.id).eq('status','awaiting_approval').eq('stop_requested',false).select('*'));
      if (!claim.length) return;
      try {
        await request(n.name,'agent.run',{runId:r.id,taskId:r.task_id,executor:r.executor,folderAlias:r.folder_alias,prompt:r.prompt,leaseMinutes:r.lease_minutes});
        confirmed.add(r.id);
        const current = await row('agent_runs',r.id);
        if (current.status === 'dispatched') await update('agent_runs',r.id,{status:'running'});
        await update('tasks',r.task_id,{status:'running'});
      } catch (error) { report(error, 'dispatch_run', 'agent_runs'); await finish(r,'failed','Node dispatch failed'); }
    } else {
      if (typeof a.action_detail.request_id !== 'string') return;
      await request(n.name,'agent.decide',{runId:r.id,requestId:a.action_detail.request_id,decision:yes?'allow':'deny'});
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
    const c = await request(machine,'agent.capabilities');
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
      if (!existing.some(a=>a.action_detail?.run_id===r.id && a.action_detail?.request_id===m.requestId)) await approval(r,n,{run_id:r.id,request_id:m.requestId,kind:'agent'},String(redact(m.action || 'Agent permission requested',settings)));
    } else if (m.type === 'agent.finished' && ['done','failed','stopped','expired'].includes(m.status)) await finish(r,m.status,m.summary,m.branch);
    else if (m.type === 'agent.event') await query('task_events', 'insert', db.from('task_events').insert({client_event_id:randomUUID(),task_id:r.task_id,node_id:n.id,kind:'agent',summary:redact(m.summary,settings),payload:redact(m,settings)}));
  });
  const ready = (async () => {
    db = await attempt('create_client', null, () => makeClient({...settings,BITOS_SUPABASE:'1'}));
    for (const r of await query('agent_runs', 'select', db.from('agent_runs').select('*'))) if (['dispatched','running'].includes(r.status)) recovered.add(r.id);
    hub.on('node_connected',connect); hub.on('agent',message);
    for (const n of hub.list()) if (n.online) await connect(n);
    timer = interval(()=>serial('scan', 'agent_runs,approvals', scan),15000); timer.unref?.();
    await serial('scan', 'agent_runs,approvals', scan);
  })().catch(error => { report(error, 'startup', 'agent_runs'); throw error; });
  return {ready,scan:()=>ready.then(()=>serial('scan', 'agent_runs,approvals', scan)),close(){closed=true;clearInterval(timer);hub.off('node_connected',connect);hub.off('agent',message);if(channel) void attempt('unsubscribe', 'agent_runs,approvals', () => db.removeChannel(channel)).catch(error => report(error, 'close', 'agent_runs,approvals'));}};
}
