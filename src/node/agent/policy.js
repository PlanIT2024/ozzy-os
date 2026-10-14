import fs from 'node:fs';
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
    if (/\b(?:eval|exec|source|ssh|scp|sftp|osascript)\b|(?:^|[;&|]\s*)\.\s|\b(?:python[\d.]*|node|ruby|perl|sh|bash|zsh)\s+-(?:c|e)\b/.test(command)) return 'Indirect command execution is forbidden';
    if (/\bgit\b/.test(command) && /(?:--git-dir|--work-tree|\s-C\s|\s-c\s|\b(?:config|worktree|checkout|switch|clean|reset)\b)/.test(command)) return 'Git checkout or configuration mutation is forbidden';
    // Inspect every shell word, including redirection targets and relative symlinks.
    const words = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|<>]+/g) || [];
    for (let word of words) {
      word = word.replace(/^["']|["']$/g, '').replace(/^(?:--?)?[\w.-]+=/, '');
      if (word.startsWith('-')) continue;
      if (unsafePath(word)) return 'Access outside the worktree or to sensitive paths is forbidden';
    }

  }
  return null;
}
export function wireText(value, projects = []) {
  let s = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  for (const p of projects) s = s.split(p.absolutePath).join(`[${p.alias}]`);
  // Preserve relative filenames and branch names while removing absolute paths.
  return s.replace(/(^|[\s"'(=:\[])((?:~\/|\/)[^\s"'<>\\]*)/g, '$1[path]').slice(0, 12000);
}
