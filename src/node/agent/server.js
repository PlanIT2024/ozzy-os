import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AgentManager } from './manager.js';
import { dataDir } from './policy.js';
import { socketPath } from './local.js';

export async function startCoordinator({ directory = dataDir, socketFile = socketPath, manager = new AgentManager() } = {}) {
  const lock = path.join(directory, 'agent-coordinator.lock');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Fail closed on stale locks: they can indicate orphaned executors after a crash.
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (e) { await manager.close(); throw e; }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  try { fs.unlinkSync(socketFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const clients = new Map();
  const deliver = (m, owner) => { const socket = clients.get(owner); if (socket && !socket.destroyed) socket.write(JSON.stringify(m) + '\n'); };
  manager.on('message', deliver);
  const server = net.createServer(socket => {
    const owner = randomUUID(); clients.set(owner, socket);
    let buffered = 0, nodeClient = false;
    socket.on('data', b => { buffered += b.length; if (buffered > 200000) socket.destroy(); });
    socket.on('error', () => {});
    readline.createInterface({ input: socket }).on('line', async line => {
      buffered = 0; let m;
      const reply = value => { if (!socket.destroyed) socket.write(JSON.stringify({ type: 'reply', id: m.id, ...value }) + '\n'); };
      try {
        m = JSON.parse(line);
        if (!m || typeof m !== 'object' || !Number.isSafeInteger(m.id)) { socket.destroy(); return; }
        if (m.method === 'local.connection') { nodeClient = true; manager.connection(owner, m.params?.online === true); return reply({ result: true }); }
        if (m.method === 'local.shutdown') { await manager.stopAll(); return reply({ result: true }); }
        if (m.method === 'local.disable') { await manager.stopAll(); return reply({ result: true }); }
        reply({ result: await manager.request(m.method, m.params, owner) });
      } catch (e) { if (m) reply({ error: e.message }); else socket.destroy(); }
    });
    socket.on('close', () => {
      clients.delete(owner);
      if (nodeClient || [...manager.runs.values()].some(r => r.owner === owner)) manager.connection(owner, false, nodeClient);
    });
  });
  let closing;
  const close = () => closing ??= (async () => {
    await manager.close();
    manager.off('message', deliver);
    for (const socket of clients.values()) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(lock, { recursive: true, force: true });
  })();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketFile, resolve); });
    fs.chmodSync(socketFile, 0o600);
  } catch (e) { await close(); throw e; }
  return { manager, server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const coordinator = await startCoordinator();
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => void coordinator.close());
  } catch { process.exitCode = 1; }
}
