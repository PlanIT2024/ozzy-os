import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readPolicy, policyFile, git, minimalEnv, inside, denial, wireText } from './policy.js';

export class AgentManager extends EventEmitter {
  constructor({ file = policyFile, spawnWorker = (options) => fork(new URL('./worker.js', import.meta.url), [], options), graceMs = 10000, approvalMs = 600000, relayMs = 120000, minuteMs = 60000, pollMs = 1000 } = {}) {
    super(); Object.assign(this, { file, spawnWorker, graceMs, approvalMs, relayMs, minuteMs });
    this.runs = new Map(); this.seen = new Set(); this.closed = false;
    this.poll = setInterval(() => { if (!readPolicy(this.file).enabled) void this.stopAll(); }, pollMs); this.poll.unref();
  }
  capabilities() {
    const p = readPolicy(this.file);
    return p.enabled ? { executors: p.executors, folders: p.projects.map(p => p.alias), maxConcurrent: p.maxConcurrent, maxLeaseMinutes: p.maxLeaseMinutes } : null;
  }
  async request(method, params = {}, owner = 'local') {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid agent parameters');
    const p = readPolicy(this.file);
    if (!p.enabled || this.closed) throw new Error('Agent execution is disabled');
    if (method === 'agent.capabilities') return this.capabilities();
    if (method === 'agent.run') return this.run(params, p, owner);
    if (method === 'agent.stop') { if (!this.runs.has(params.runId)) throw new Error('Unknown run'); void this.stop(params.runId); return { stopped: true }; }
    if (method === 'agent.decide') {
      const a = this.runs.get(params.runId)?.approvals.get(params.requestId);
      if (!a || !['allow','deny'].includes(params.decision)) throw new Error('Unknown approval or invalid decision');
      a.resolve(params.decision); return { accepted: true };
    }
    throw new Error('Unsupported agent method');
  }
  emitRun(run, type, fields) { this.emit('message', { type, runId: run.id, ...fields }, run.owner); }
  run(v, p, owner) {
    const { runId, taskId, executor, folderAlias, prompt, leaseMinutes } = v;
    if (Object.keys(v).some(k => !['runId','taskId','executor','folderAlias','prompt','leaseMinutes'].includes(k))) throw new Error('Unexpected run fields; use folderAlias');
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId) || typeof taskId !== 'string' || taskId.length > 128 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw new Error('Invalid run');
    if (this.seen.has(runId)) throw new Error('Duplicate runId');
    const project = p.projects.find(x => x.alias === folderAlias);
    if (!project) throw new Error('Unknown folder alias');
    if (!p.executors.includes(executor)) throw new Error('Executor not allowed');
    if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0 || leaseMinutes > p.maxLeaseMinutes) throw new Error('Invalid lease');
    if (this.runs.size >= p.maxConcurrent) throw new Error('Concurrency limit reached');
    const ledger = path.join(path.dirname(this.file), 'agent-runs');
    fs.mkdirSync(ledger, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(path.join(ledger, runId), '', { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Duplicate runId'); throw new Error('Cannot reserve runId locally'); }
    const run = { id: runId, owner, executor, project, policy: p, branch: `bit/${runId}`, cwd: path.join(project.absolutePath, '.bit-worktrees', runId), approvals: new Map(), deadline: Date.now() + leaseMinutes * this.minuteMs };
    this.seen.add(runId); this.runs.set(runId, run);
    run.finished = new Promise(resolve => { run.resolve = resolve; });
    run.timer = setTimeout(() => void this.stop(runId, 'expired'), leaseMinutes * this.minuteMs);
    // Reserve before setup; all run requests share this coordinator.
    setImmediate(() => this.start(run, prompt));
    return { runId, branch: run.branch };
  }
  start(run, prompt) {
    if (run.ending) return;
    try {
      const repo = run.project.absolutePath;
      const base = path.dirname(run.cwd);
      if (fs.existsSync(base) && (!inside(repo, base) || fs.lstatSync(base).isSymbolicLink())) throw new Error('Unsafe worktree directory');
      fs.mkdirSync(base, { recursive: true });
      if (fs.existsSync(run.cwd)) throw new Error('Duplicate worktree');
      const exclude = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
      const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      if (!inside(common, exclude) || (fs.existsSync(exclude) && fs.lstatSync(exclude).isSymbolicLink())) throw new Error('Unsafe git exclude path');
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const old = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!old.split('\n').includes('.bit-worktrees/')) fs.appendFileSync(exclude, '\n.bit-worktrees/\n');
      run.base = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'worktree', 'add', '-b', run.branch, run.cwd, run.base);
      if (Date.now() >= run.deadline) { void this.stop(run.id, 'expired'); return; }
      if (!readPolicy(this.file).enabled || run.ending) { void this.stop(run.id); return; }
      const child = run.child = this.spawnWorker({ cwd: run.cwd, env: minimalEnv(), detached: true, stdio: ['ignore','ignore','ignore','ipc'] });
      child.on('message', m => {
        if (run.ending || !m || typeof m !== 'object') return;
        if (m.type === 'approval') void this.approve(run, m).catch(() => { if (run.child?.connected) run.child.send({ type: 'decision', id: m.id, decision: 'deny', reason: 'Invalid approval' }, () => {}); });
        if (m.type === 'event') this.emitRun(run, 'agent.event', { kind: 'progress', summary: wireText(m.summary, run.policy.projects) });
        if (m.type === 'finished') void this.stop(run.id, m.status === 'done' ? 'done' : 'failed', m.summary);
      });
      child.on('error', () => void this.stop(run.id, 'failed', 'Executor could not start'));
      child.on('exit', () => { if (!run.ending) void this.stop(run.id, 'failed', 'Executor exited before completion'); });
      child.send({ executor: run.executor, prompt, cwd: run.cwd, deadline: run.deadline }, () => {});
      this.emitRun(run, 'agent.event', { kind: 'started', summary: `Started ${run.executor} in ${run.project.alias} on ${run.branch}` });
    } catch { void this.stop(run.id, 'failed', 'Worktree or executor setup failed; inspect local repository'); }
  }
  async approve(run, m) {
    const reason = denial(m.action, m.detail, run.cwd);
    let decision = 'deny';
    if (reason) this.emitRun(run, 'agent.event', { kind: 'denied', summary: reason });
    else if (run.executor === 'claude_code' && ['Read','Glob','Grep'].includes(m.action)) decision = 'allow';
    else {
      const requestId = randomUUID();
      decision = await new Promise(resolve => {
        const finish = d => { clearTimeout(timer); run.approvals.delete(requestId); resolve(d); };
        const timer = setTimeout(() => finish('deny'), this.approvalMs);
        run.approvals.set(requestId, { resolve: finish });
        this.emitRun(run, 'agent.approval_request', { requestId, executor: run.executor, action: wireText(m.action, run.policy.projects), detail: wireText(m.detail, run.policy.projects) });
      });
    }
    if (run.child?.connected) run.child.send({ type: 'decision', id: m.id, decision, reason }, () => {});
  }
  async stop(id, status = 'stopped', summary = '') {
    const run = this.runs.get(id); if (!run) return;
    if (run.ending) return run.finished;
    run.ending = true; clearTimeout(run.timer);
    for (const a of run.approvals.values()) a.resolve('deny');
    const signal = sig => { if (run.child?.pid) { try { process.kill(-run.child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') this.emitRun(run, 'agent.event', { kind: 'error', summary: 'Process group termination failed' }); } } };
    signal('SIGTERM');
    // Keep the group and concurrency slot for the entire grace period, even if its leader exits.
    if (run.child?.pid) await new Promise(resolve => setTimeout(resolve, this.graceMs));
    signal('SIGKILL');
    let stat = '';
    try { stat = git(run.cwd, 'diff', '--no-ext-diff', '--no-textconv', '--stat', run.base); const untracked = git(run.cwd, 'ls-files', '--others', '--exclude-standard'); if (untracked) stat += `\nUntracked files:\n${untracked}`; } catch { stat = 'Diff unavailable (worktree setup did not complete)'; }
    this.emitRun(run, 'agent.finished', { status, branch: run.branch, summary: wireText(`${summary || status}\n${stat || 'No tracked changes'}`, run.policy.projects) });
    this.runs.delete(id); run.resolve(); return run.finished;
  }
  stopAll() { return Promise.all([...this.runs.keys()].map(id => this.stop(id))); }
  connection(owner, online, allRuns = true) {
    if (this.closed) return;
    this.lossTimers ??= new Map();
    if (online) { clearTimeout(this.lossTimers.get(owner)); this.lossTimers.delete(owner); }
    else if (!this.lossTimers.has(owner)) this.lossTimers.set(owner, setTimeout(() => {
      this.lossTimers.delete(owner);
      if (allRuns) void this.stopAll();
      else for (const r of this.runs.values()) if (r.owner === owner) void this.stop(r.id);
    }, this.relayMs).unref());
  }
  async close() { this.closed = true; clearInterval(this.poll); for (const t of this.lossTimers?.values() || []) clearTimeout(t); await this.stopAll(); }
}
