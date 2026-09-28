import fs from 'node:fs';
import path from 'node:path';

export function acquireBrainLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      let identity;
      try { fs.writeFileSync(fd, String(process.pid)); identity = fs.fstatSync(fd); }
      finally { fs.closeSync(fd); }
      return () => {
        try {
          const current = fs.statSync(file);
          if (current.ino === identity.ino && current.dev === identity.dev && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      const identity = fs.statSync(file);
      const raw = fs.readFileSync(file, 'utf8').trim();
      const pid = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Brain lock contains an invalid PID; refusing to remove it automatically.');
      try { process.kill(pid, 0); }
      catch (error) {
        // EPERM means the process exists but we cannot signal it. Only ESRCH is stale.
        if (error.code !== 'ESRCH') throw new Error(`Cannot verify brain lock PID ${pid}; keeping lock.`, { cause: error });
        const current = fs.statSync(file);
        if (current.ino === identity.ino && current.dev === identity.dev && fs.readFileSync(file, 'utf8').trim() === raw) fs.unlinkSync(file);
        continue;
      }
      throw new Error(`Brain already running (PID ${pid}); keeping data/brain.lock.`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Brain lock changed repeatedly; try starting again.');
}

export function installShutdown(unlock, shutdown, runtime = process) {
  let stopping = false;
  runtime.once('exit', unlock);
  const stop = async () => {
    if (stopping) return; stopping = true;
    let code = 0;
    try { await shutdown(); }
    catch (error) { code = 1; console.error('Brain shutdown failed:', error); }
    finally {
      try { unlock(); }
      catch (error) { code = 1; console.error('Brain lock cleanup failed:', error); }
      runtime.exit(code);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) runtime.once(signal, () => { void stop(); });
}
