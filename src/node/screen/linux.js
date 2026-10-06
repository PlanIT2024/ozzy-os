import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { encodeCapture } from './image.js';
const exec = promisify(execFile);
const helper = fileURLToPath(new URL('./portal.py', import.meta.url));
const keys = ['WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','XDG_SESSION_TYPE','XDG_CURRENT_DESKTOP'];
export async function sessionEnvironment(env = process.env, run = exec) {
  const session = { ...env };
  try {
    const { stdout } = await run('/usr/bin/systemctl', ['--user','show-environment'], { timeout: 3000, maxBuffer: 65536, env });
    const manager = Object.fromEntries(stdout.split('\n').map(line => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }).filter(([k]) => keys.includes(k)));
    for (const key of keys) if (manager[key]) session[key] = manager[key];
  } catch { /* process environment is still checked by the portal helper */ }
  return session;
}
export class LinuxScreen {
  constructor({ env = process.env, run = exec, getEnvironment = sessionEnvironment } = {}) { Object.assign(this, { env, run, getEnvironment }); }
  async invoke(operation) {
    const env = await this.getEnvironment(this.env, this.run);
    if (!env.WAYLAND_DISPLAY || !env.DBUS_SESSION_BUS_ADDRESS) throw new Error('No reachable Wayland session; log in graphically and import its environment into systemd --user.');
    try {
      const { stdout } = await this.run('/usr/bin/python3', ['-B', helper, operation], { env, timeout: operation === 'capture' ? 115000 : 10000, maxBuffer: 48 * 1024 * 1024 });
      const result = JSON.parse(stdout);
      if (result.error) throw new Error('Portal operation failed');
      return result;
    } catch (error) {
      // execFile errors retain stdout. Never propagate them (capture stdout contains pixels).
      let code;
      try { code = JSON.parse(error.stdout || '{}').error; } catch {}
      const known = ['desktop_locked','portal_consent_denied','portal_consent_timeout','portal_capture_failed','notification_failed'];
      throw new Error(known.includes(code) ? `Screenshot unavailable: ${code}` : 'Screenshot portal unavailable; check the graphical session and portal installation.');
    }
  }
  async available() { try { return (await this.invoke('probe')).available === true; } catch { return false; } }
  async capture() {
    const result = await this.invoke('capture');
    return encodeCapture(Buffer.from(result.data, 'base64'), result);
  }
  close() {}
}
