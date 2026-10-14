import fs from 'node:fs';
import { simpleCommands } from './shell.js';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const dataDir = fileURLToPath(new URL('../../../data/', import.meta.url));
export const policyFile = path.join(dataDir, 'agent-policy.json');
export const executors = ['claude_code', 'codex'];
export function minimalEnv(source = process.env) {
  return Object.fromEntries(['PATH','HOME','USER','LANG','TERM','SHELL','TMPDIR'].filter(k => typeof source[k] === 'string').map(k => [k, source[k]]));
}
export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: minimalEnv(), encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 15000 }).trim();
}
export function forbiddenPath(p) { return /(?:\.ssh|\.env|data[\\/]keys)/i.test(p); }
export function projectPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || forbiddenPath(p)) throw new Error('Refused project path');
  const real = fs.realpathSync(p);
  if (real === '/' || real === fs.realpathSync(os.homedir()) || forbiddenPath(real)) throw new Error('Refused project path');
  if (fs.realpathSync(git(real, 'rev-parse', '--show-toplevel')) !== real) throw new Error('Project must be a git repository root');
  if (forbiddenPath(fs.realpathSync(git(real, 'rev-parse', '--path-format=absolute', '--git-common-dir')))) throw new Error('Refused git metadata path');
  git(real, 'rev-parse', '--verify', 'HEAD');
  return real;
}
export function validatePolicy(p) {
  if (!p || typeof p.enabled !== 'boolean') throw new Error('Invalid policy');
  if (!p.enabled) return { enabled: false };
  if (!Array.isArray(p.executors) || !p.executors.length || p.executors.some(e => !executors.includes(e))) throw new Error('Invalid executors');
  if (!Number.isInteger(p.maxConcurrent) || p.maxConcurrent < 1 || p.maxConcurrent > 4 || !Number.isInteger(p.maxLeaseMinutes) || p.maxLeaseMinutes < 1 || p.maxLeaseMinutes > 120) throw new Error('Invalid limits');
  if (!Array.isArray(p.projects) || !p.projects.length) throw new Error('No projects');
  const aliases = new Set();
  const projects = p.projects.map(({ alias, absolutePath }) => {
    if (typeof alias !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(alias) || aliases.has(alias)) throw new Error('Invalid or duplicate alias');
    aliases.add(alias); return { alias, absolutePath: projectPath(absolutePath) };
  });
  return { enabled: true, executors: [...new Set(p.executors)], projects, maxConcurrent: p.maxConcurrent, maxLeaseMinutes: p.maxLeaseMinutes };
}
export function readPolicy(file = policyFile) {
  try {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid()) return { enabled: false };
    return validatePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { return { enabled: false }; }
}
// Only the terminal CLI calls this. It is deliberately absent from the RPC dispatcher.
export function writePolicy(value, file = policyFile) {
  const p = validatePolicy(value);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
export function resolvedPath(root, candidate) {
  if (typeof candidate !== 'string' || candidate.includes('\0')) throw new Error('Invalid path');
  let p = path.resolve(root, candidate);
  const tail = [];
  for (;;) {
    try { fs.lstatSync(p); break; } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(p); if (parent === p) throw e;
      tail.unshift(path.basename(p)); p = parent;
    }
  }
  return path.join(fs.realpathSync(p), ...tail);
}
export function inside(root, candidate) {
  try {
    const rel = path.relative(fs.realpathSync(root), resolvedPath(root, candidate));
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  } catch { return false; }
}
export function denial(action, detail, cwd) {
  if (typeof action !== 'string' || !detail || typeof detail !== 'object' || Array.isArray(detail)) return 'Malformed approval';
  const text = JSON.stringify(detail);
  if (forbiddenPath(text)) return 'Sensitive path access is forbidden';
  if (/\b(push|deploy|publish|sudo|railway|vercel|wrangler)\b/i.test(text)) return 'Push, deployment, publication and privilege escalation are forbidden';
  if (/\b(curl|wget)\b[\s\S]*\|[\s\S]*\b(sh|bash|zsh)\b/i.test(text)) return 'Downloaded shell execution is forbidden';
  if (/\brm\b[^\n]*(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)/i.test(text)) return 'Recursive forced removal is forbidden';
  if (/permissions\/requestApproval/.test(action)) return 'Permission widening is forbidden';
  const unsafePath = p => {
    try { return !inside(cwd, p) || forbiddenPath(resolvedPath(cwd, p)) || /(?:^|\/)\.git(?:\/|$)/.test(p); }
    catch { return true; }
  };
  const visit = value => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([k,v]) => {
      if (typeof v === 'string' && /^(path|file_path|filePath|cwd|grantRoot|target|destination)$/i.test(k)) return unsafePath(v);
      return visit(v);
    });
  };
  if (visit(detail)) return 'Access outside the worktree or to git metadata is forbidden';
  // Shell commands are opaque: refuse explicit outside paths and parent traversal.
  if (/command|Bash/i.test(action)) {
    const command = String(detail.command || '');
    if (!command) return 'Missing command';
    // Fail closed on shell indirection; a string filter cannot safely interpret it.
    if (/[$`\\]|(?:^|[\s"'=<>])~|(?:^|\/)\.\.(?:\/|$)/.test(command)) return 'Indirect or outside path access is forbidden';
    let commands;
    try { commands = simpleCommands(command); } catch (e) { return e.message; }
    if (!commands.length) return 'Missing command';
    for (const words of commands) {
      const simple = words.join(' ');
      // Re-check decoded words: quoting must not conceal a denied operation.
      if (forbiddenPath(simple)) return 'Sensitive path access is forbidden';
      if (/\b(push|deploy|publish|sudo|railway|vercel|wrangler)\b/i.test(simple)) return 'Push, deployment, publication and privilege escalation are forbidden';
      if (/\brm\b[^\n]*(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)/i.test(simple)) return 'Recursive forced removal is forbidden';
      if (/\b(?:eval|exec|source|ssh|scp|sftp|osascript)\b|^\.\s|\b(?:python[\d.]*|node|ruby|perl|sh|bash|zsh)\s+-(?:c|e)\b/.test(simple)) return 'Indirect command execution is forbidden';
      if (/\bgit\b/.test(simple) && /(?:--git-dir|--work-tree|\s-C\s|\s-c\s|\b(?:config|worktree|checkout|switch|clean|reset)\b)/.test(simple)) return 'Git checkout or configuration mutation is forbidden';
      for (let word of words) {
        word = word.replace(/^(?:--?)?[\w.-]+=/, '');
        if (word.startsWith('-')) continue;
        if (unsafePath(word)) return 'Access outside the worktree or to sensitive paths is forbidden';
      }
    }
  }
  return null;
}
export function wireText(value, cwd) {
  const root = cwd?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paths = new RegExp(`(["'])((?:~\\/|\\/)[^"'\\n]+)\\1|(^|[\\s(=:\\[])((?:${root ? `${root}(?=[/\\s"'<>),;]|$)|` : ''}~\\/|\\/)[^\\s"'<>\\\\),;]*)`, 'g');
  const render = (text, commands = true) => {
    // Match quoted paths as a whole (including spaces), or unquoted path tokens.
    const redact = token => {
      if (commands && /^\/(?:login|logout|help|status|clear|compact|resume|model|permissions)[.!?]?$/.test(token)) return token;
      if (cwd && path.isAbsolute(token) && inside(cwd, token)) return path.relative(fs.realpathSync(cwd), resolvedPath(cwd, token)) || '.';
      return '[path]';
    };
    return text.replace(paths,
      (match, quote, quoted, prefix, plain, offset, source) => {
        if (!quote && prefix === ':' && plain.startsWith('//') && /[a-z][a-z\d+.-]*$/i.test(source.slice(0, offset))) return match;
        return quote ? `${quote}${redact(quoted)}${quote}` : `${prefix}${redact(plain)}`;
      });
  };
  // Render string values before serializing, so JSON escaping cannot hide paths.
  const visit = (v, key = '') => typeof v === 'string' ? render(v, !/^(path|file_path|filePath|cwd|grantRoot|target|destination)$/i.test(key)) : Array.isArray(v) ? v.map(value => visit(value, key)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, val]) => [render(k), visit(val, k)])) : v;
  return (typeof value === 'string' ? render(value) : JSON.stringify(visit(value)) ?? '').slice(0, 12000);
}
