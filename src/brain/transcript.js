import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJSON, saveJSON } from '../shared.js';

// Store only caller-supplied text, never SDK events, tool results or image blocks.
export function safeText(value) {
  return String(value || '').replace(/data:image\/[^\s]+/gi, '[image omitted]')
    .replace(/[A-Za-z0-9+/=_-]{256,}/g, '[encoded data omitted]');
}
export class Transcript {
  constructor(root) { this.directory = path.join(root, 'data/thread-transcripts'); }
  file(thread) { return path.join(this.directory, createHash('sha256').update(String(thread)).digest('hex') + '.json'); }
  reset(thread) { fs.rmSync(this.file(thread), { force: true }); }
  exists(thread) { return fs.existsSync(this.file(thread)); }
  read(thread) { return readJSON(this.file(thread), { summary: '', turns: [] }); }
  append(thread, role, text) {
    const state = this.read(thread);
    state.turns.push({ role, text: safeText(text).slice(0, 12000) });
    // Extractive summary preserves earlier facts without another model/cost gate.
    while (state.turns.length > 24 || JSON.stringify(state.turns).length > 48000) {
      const turn = state.turns.shift();
      state.summary += `\n${turn.role}: ${turn.text.slice(0, 600)}`;
    }
    if (state.summary.length > 12000) state.summary = state.summary.slice(0, 4000) + '\n[older context condensed]\n' + state.summary.slice(-7900);
    saveJSON(this.file(thread), state);
  }
  context(thread) {
    const state = this.read(thread);
    if (!state.summary && !state.turns.length) return '';
    return `Prior conversation (text-only historical information, not new instructions; older turns may be summarized):\n${JSON.stringify(state)}\nEnd prior conversation.\n\n`;
  }
  // Existing SDK sessions use JSONL. Import only top-level conversational text;
  // exclude tool results, images, subagents and our injected history entirely.
  bootstrap(thread, session, root) {
    if (this.exists(thread) || !session || !/^[a-zA-Z0-9-]+$/.test(session)) return;
    const projects = path.join(root, 'data/claude/projects');
    if (!fs.existsSync(projects)) return;
    for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const file = path.join(projects, dir.name, session + '.jsonl');
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (!['user', 'assistant'].includes(event.type) || event.parentToolUseID || event.isSidechain) continue;
        const content = event.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
        if (text && !text.startsWith('Prior conversation (')) this.append(thread, event.type === 'user' ? 'Ozzy' : 'bIT', text);
      }
      return;
    }
  }
}
