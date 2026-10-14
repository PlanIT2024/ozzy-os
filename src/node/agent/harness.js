import { randomUUID } from 'node:crypto';

// The CLI and tests use this same terminal adapter; execution remains in AgentManager.
export async function runHarness({ client, terminal, executor, folder, prompt, lease = 5, write = line => console.log(line), signals = process, runId = randomUUID() }) {
  let active = true, started = false, queue = Promise.resolve(), finish;
  const questions = new Set();
  const finished = new Promise(resolve => { finish = resolve; });
  const stop = () => { if (active && started) void client.request('agent.stop', { runId }).catch(() => {}); };
  const disconnected = () => { active = false; finish('failed'); };
  const message = m => {
    if (m.runId !== runId) return;
    if (m.type === 'agent.approval_request') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 600000);
      questions.add(controller);
      queue = queue.then(async () => {
        let answer = '';
        try { answer = await terminal.question(`${m.executor}: ${m.action}\n${m.detail}\nAllow? [y/N] `, { signal: controller.signal }); } catch {}
        clearTimeout(timer); questions.delete(controller);
        if (active) await client.request('agent.decide', { runId, requestId: m.requestId, decision: /^y$/i.test(answer.trim()) ? 'allow' : 'deny' }).catch(() => {});
      });
    } else {
      write(JSON.stringify(m));
      if (m.type === 'agent.finished') { active = false; finish(m.status); }
    }
  };
  client.on('message', message); client.on('closed', disconnected);
  terminal.on('SIGINT', stop); terminal.on('close', stop);
  for (const signal of ['SIGINT','SIGTERM']) signals.on(signal, stop);
  try {
    await client.request('agent.run', { runId, taskId: runId, executor, folderAlias: folder, prompt, leaseMinutes: Number(lease) });
    started = true;
    if (terminal.closed) stop();
    return await finished;
  } finally {
    active = false;
    for (const q of questions) q.abort();
    client.off('message', message); client.off('closed', disconnected);
    terminal.off('SIGINT', stop); terminal.off('close', stop);
    for (const signal of ['SIGINT','SIGTERM']) signals.off(signal, stop);
  }
}
