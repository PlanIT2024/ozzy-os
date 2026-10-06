import { LinuxScreen } from './linux.js';
export class UnsupportedScreen {
  async available() { return false; }
  async capture() { throw new Error('Screen capture not supported yet on this platform'); }
  close() {}
}
export function createScreen({ platform = process.platform, enabled = process.env.SCREEN_ENABLED === 'true', ...options } = {}) {
  const backend = platform === 'linux' ? new LinuxScreen(options) : new UnsupportedScreen();
  return {
    async available(options) { return enabled && await backend.available(options); },
    async capture() { if (!enabled) throw new Error('Screen capture is disabled'); if (backend instanceof UnsupportedScreen) return backend.capture(); if (!await backend.available()) throw new Error('Screen capture unavailable in this graphical session'); return backend.capture(); },
    close() { backend.close(); },
  };
}
