import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { minimalEnv, denial } from './policy.js';

const approvals = new Map(); let next = 0;
const send = m => { if (process.connected) process.send(m); };
const approve = (action, detail) => new Promise(resolve => { const id = ++next; approvals.set(id, resolve); send({ type: 'approval', id, action, detail }); });

export async function codex({ cwd, prompt }, { spawnProcess = spawn, ask = approve, event = summary => send({ type: 'event', summary }) } = {}) {
  const child = spawnProcess('codex', ['app-server', '--listen', 'stdio://'], { cwd, env: minimalEnv(), stdio: ['pipe','pipe','pipe'] });
  let id = 0; const pending = new Map(); const items = new Map();
  let complete, fail;
  const done = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // Attach immediately: startup failures must not become unhandled rejections.
  done.catch(() => {});
  const write = m => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(m) + '\n'); };
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Codex protocol request timed out')); }, 30000);
    pending.set(key, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    write({ id: key, method, params });
  });
  const failed = () => { const e = new Error('Codex exited or failed to launch; install Codex and sign in with codex login'); for (const p of pending.values()) p.reject(e); pending.clear(); fail(e); };
  child.on('error', failed); child.on('exit', failed); child.stdin.on('error', failed); child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { void (async () => {
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) { const p = pending.get(m.id); pending.delete(m.id); if (p) m.error ? p.reject(new Error('Codex protocol request rejected')) : p.resolve(m.result); return; }
    if (m.id !== undefined) {
      if (!/^item\/(commandExecution|fileChange|permissions)\/requestApproval$/.test(m.method)) { write({ id: m.id, error: { code: -32601, message: 'Unsupported request' } }); return; }
      const detail = { ...m.params, changes: items.get(m.params?.itemId)?.changes };
      let response;
      if (m.method === 'item/fileChange/requestApproval' && !detail.changes?.length) response = { decision: 'deny' };
      else response = await ask(m.method, detail);
      write({ id: m.id, result: m.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: response.decision === 'allow' ? 'accept' : (m.params?.availableDecisions?.includes('decline') ? 'decline' : 'cancel') } });
      return;
    }
    if (m.params?.item) items.set(m.params.item.id, m.params.item);
    if (m.method === 'item/agentMessage/delta') event(m.params?.delta || '');
    if (m.method === 'item/completed' && ['agentMessage','commandExecution'].includes(m.params?.item?.type)) event(m.params.item.text || `${m.params.item.command}: ${m.params.item.status}`);
    if (m.method === 'turn/completed') m.params?.turn?.status === 'completed' ? complete('Codex completed') : fail(new Error('Codex turn failed or was interrupted'));
  })().catch(fail); });
  try {
    await request('initialize', { clientInfo: { name: 'bit_node', title: 'bIT node', version: '0.1.0' } });
    write({ method: 'initialized' });
    const result = await request('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
    await request('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: prompt }] });
    return await done;
  } finally { lines.close(); child.kill('SIGTERM'); for (const p of pending.values()) p.reject(new Error('Run finished')); }
}

export async function claude({ cwd, prompt }, { queryFn, ask = approve, event = summary => send({ type: 'event', summary }) } = {}) {
  const query = queryFn || (await import('@anthropic-ai/claude-agent-sdk')).query;
  const permission = async (name, input) => {
    const reason = denial(name, input, cwd);
    if (reason) return { behavior: 'deny', message: reason };
    const result = await ask(name, input);
    return result.decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: result.reason || 'Approval denied or timed out' };
  };
  const stream = query({ prompt, options: {
    cwd, env: minimalEnv(), permissionMode: 'default', settingSources: [],
    settings: { permissions: { deny: ['Read(**/.env*)', 'Read(**/data/keys/**)', 'Read(~/.ssh/**)', 'Edit(**/.git/**)'] } },
    allowedTools: [], tools: ['Read','Glob','Grep','Write','Edit','Bash'],
    canUseTool: permission,
    // PreToolUse also covers tools the CLI would otherwise allow without canUseTool.
    hooks: { PreToolUse: [{ hooks: [async input => {
      const result = await permission(input.tool_name, input.tool_input);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.behavior, permissionDecisionReason: result.message } };
    }] }] },
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [cwd], denyRead: ['~/.ssh', '**/.env*', '**/data/keys/**'] } },
    spawnClaudeCodeProcess: options => spawn(options.command, options.args, { cwd, env: minimalEnv(options.env), stdio: ['pipe','pipe','pipe'] }),
  } });
  try {
    for await (const m of stream) {
      if (m.type === 'assistant') event(m.message?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Claude tool activity');
      if (m.type === 'result') {
        if (m.is_error || m.subtype !== 'success') throw new Error((m.errors || [m.result || m.subtype]).join('; '));
        return m.result || 'Claude completed';
      }
    }
    throw new Error('Claude ended without a result');
  } catch (e) {
    throw new Error(`Claude Code failed: ${e.message}. This runner requires an existing Claude Code subscription login (run claude, then /login locally), and a working OS sandbox. API keys are not accepted or injected.`);
  } finally { stream.close?.(); }
}

if (process.send) {
  process.on('message', m => { if (m.type === 'decision') { approvals.get(m.id)?.(m); approvals.delete(m.id); } });
  let killing;
  const killGroup = () => {
    if (killing) return;
    killing = setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 10000);
    try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  };
  process.on('SIGTERM', () => { for (const resolve of approvals.values()) resolve({ decision: 'deny' }); });
  process.on('disconnect', killGroup);
  process.once('message', async m => {
  // Independent watchdog also covers an abruptly killed or hung coordinator.
  setTimeout(killGroup, Math.max(0, m.deadline - Date.now()));
  try { const summary = await (m.executor === 'codex' ? codex(m) : claude(m)); send({ type: 'finished', status: 'done', summary }); }
  catch (e) { send({ type: 'finished', status: 'failed', summary: e.message }); }
  });
}
