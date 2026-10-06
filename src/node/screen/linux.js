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
  constructor({ env = process.env, run = exec, getEnvironment = sessionEnvironment, log = console.log } = {}) { Object.assign(this, { env, run, getEnvironment, log }); }
  diagnostics(stderr, operation, exitCode) {
    if (operation !== 'capture' && !stderr) return;
    for (const line of String(stderr || '').split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line), record = {};
        for (const key of ['event','stage','interface','method','dbusError','message','errorType','errorCode','appId','sender','locked','responseCode','permission']) if (['string','number','boolean'].includes(typeof parsed[key])) record[key] = typeof parsed[key] === 'string' ? parsed[key].replace(/(?:data:image\/|file:\/\/)\S+|[A-Za-z0-9+/=]{256,}/g, '[redacted]').slice(0,1500) : parsed[key];
        this.log(`screen helper ${JSON.stringify(record)}`);
      } catch { this.log('screen helper stderr: [unstructured output omitted]'); }
    }
    this.log(`screen helper exit ${JSON.stringify({ operation, exitCode })}`);
  }
  async invoke(operation, diagnose = operation === 'capture') {
    const env = { ...await this.getEnvironment(this.env, this.run), BIT_SCREEN_DIAGNOSTICS: diagnose ? '1' : '0' };
    if (diagnose) this.log('screen capture attempt stage=session_environment');
    if (!env.WAYLAND_DISPLAY || !env.DBUS_SESSION_BUS_ADDRESS) {
      if (diagnose) this.log('screen capture failure stage=session_environment');
      throw new Error('No reachable Wayland session; log in graphically and import its environment into systemd --user.');
    }
    try {
      const { stdout, stderr } = await this.run('/usr/bin/python3', ['-B', helper, operation], { env, timeout: operation === 'capture' ? 115000 : 10000, maxBuffer: 48 * 1024 * 1024 });
      this.diagnostics(stderr, operation, 0);
      const result = JSON.parse(stdout);
      if (result.error) throw new Error('Portal operation failed');
      return result;
    } catch (error) {
      this.diagnostics(error.stderr, operation, typeof error.code === 'number' ? error.code : error.code || 'unknown');
      if (diagnose) this.log(`screen capture failure stage=helper signal=${error.signal || 'none'} killed=${Boolean(error.killed)}`);
      // execFile errors retain stdout. Never propagate them (capture stdout contains pixels).
      let code;
      try { code = JSON.parse(error.stdout || '{}').error; } catch {}
      const known = ['desktop_locked','portal_consent_denied','portal_consent_timeout','portal_capture_failed','notification_failed'];
      throw new Error(known.includes(code) ? `Screenshot unavailable: ${code}` : 'Screenshot portal unavailable; check the graphical session and portal installation.');
    }
  }
  async available({ diagnose = false } = {}) { try { return (await this.invoke('probe', diagnose)).available === true; } catch { return false; } }
  async capture() {
    const result = await this.invoke('capture');
    try {
      this.log('screen capture stage=encode');
      const encoded = await encodeCapture(Buffer.from(result.data, 'base64'), result);
      this.log(`screen capture success ${JSON.stringify({ original: encoded.original, scaled: encoded.scaled, capturedAt: encoded.capturedAt })}`);
      return encoded;
    } catch { this.log('screen capture failure stage=encode'); throw new Error('Screenshot image encoding failed'); }
  }
  close() {}
}
