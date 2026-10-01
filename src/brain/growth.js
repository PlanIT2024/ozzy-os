import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, readJSON, saveJSON, serial } from '../shared.js';
const exec = promisify(execFile);
export class Growth {
  constructor({ root = ROOT, push = process.env.AUTO_PUSH === 'true', notify = async () => {}, log = console.error, now = () => Date.now(), run = (args, options) => exec('git', args, options) } = {}) {
    Object.assign(this, { root, push, notify, log, now, run }); this.queue = serial();
    this.stateFile = path.join(root, 'data/growth.json'); this.state = readJSON(this.stateFile, { lastMemory: now() });
    saveJSON(this.stateFile, this.state);
    this.timer = setInterval(() => { void this.memory(); }, 60000); this.timer.unref();
  }
  git(args) { return this.run(['-c', 'core.hooksPath=' + path.join(this.root, 'data/empty-hooks'), ...args], { cwd: this.root, timeout: 30000, maxBuffer: 1024 * 1024 }); }
  validate(folder) {
    if (folder !== 'bit/memory' && !/^bit\/skills\/[a-z0-9_-]+$/i.test(folder)) throw new Error('Auto-commit path denied');
    let current = this.root;
    for (const part of folder.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Auto-commit symlink denied'); }
    const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { if (item.isSymbolicLink() || item.name === '.git') throw new Error('Auto-commit symlink/nested repo denied'); if (item.isFile() && fs.statSync(path.join(dir, item.name)).nlink > 1) throw new Error('Auto-commit hard link denied'); if (item.isDirectory()) walk(path.join(dir, item.name)); } }; walk(current);
  }
  report(error) { this.log('bIT growth commit/push failed:', error.message); try { fs.appendFileSync(path.join(this.root, 'data/audit.log'), JSON.stringify({ time: new Date().toISOString(), event: 'growth_error', error: error.message }) + '\n', { mode: 0o600 }); } catch {} }
  async commit(folder, message) {
    this.validate(folder);
    await this.git(['add', '--', folder]);
    const diff = await this.git(['diff', '--cached', '--name-only', '--', folder]);
    if (!diff.stdout.trim()) return false;
    // --only prevents unrelated changes already in the user's index from entering this commit.
    await this.git(['commit', '--only', '-m', message, '--', folder]);
    if (this.push) { try { await this.git(['push']); } catch (error) { this.report(error); } }
    return true;
  }
  written(file) {
    const relative = path.relative(this.root, path.resolve(this.root, file)).split(path.sep).join('/');
    if (relative.startsWith('bit/memory/')) return Promise.resolve(); // Timer batches these changes.
    const match = /^bit\/skills\/([a-z0-9_-]+)\//i.exec(relative);
    if (!match) return Promise.resolve();
    return this.queue(async () => {
      try {
        const folder = `bit/skills/${match[1]}`; this.validate(folder);
        let exists = false; try { await this.git(['cat-file', '-e', `HEAD:${folder}`]); exists = true; } catch (error) { if (error.code !== 128) throw error; }
        const message = `bIT: ${exists ? 'update' : 'add'} skill ${match[1]}`;
        if (await this.commit(folder, message)) await this.notify(`🧠 ${message}`);
      } catch (error) { this.report(error); }
    });
  }
  memory() {
    return this.queue(async () => {
      if (this.now() - this.state.lastMemory < 3600000) return;
      try {
        await this.commit('bit/memory', `bIT: memory notes ${new Date(this.now()).toISOString().slice(0, 10)}`);
        this.state.lastMemory = this.now(); saveJSON(this.stateFile, this.state);
      } catch (error) { this.report(error); }
    });
  }
  close() { clearInterval(this.timer); return this.queue(async () => {}); }
}
