import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../shared.js';
import { validateSkill } from './skills.js';
export const BUILTINS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'];
export const CUSTOM = ['mcp__machines__list_machines', 'mcp__machines__machine_status'];
const writes = new Set(['Write', 'Edit']);
const inside = (base, file) => file === base || file.startsWith(base + path.sep);
export function createPermissions({ root = ROOT, approve = async () => false, notify = async () => {}, context = '' } = {}) {
  root = fs.realpathSync(root);
  const auditFile = path.join(root, 'data/audit.log');
  fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
  function audit(event) { fs.appendFileSync(auditFile, JSON.stringify({ time: new Date().toISOString(), context, ...event }) + '\n', { mode: 0o600 }); }
  function safePath(raw) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.split(/[\\/]/).includes('..')) throw new Error('Missing path or traversal denied');
    let target = path.resolve(root, raw);
    // Only this host-created SDK discovery alias may resolve through a symlink.
    const alias = path.join(root, '.claude/skills');
    if (inside(alias, target)) {
      if (fs.realpathSync(alias) !== path.join(root, 'bit/skills')) throw new Error('Invalid skills alias');
      target = path.join(root, 'bit/skills', path.relative(alias, target));
    }
    if (!inside(root, target)) throw new Error('Outside OZZY OS');
    let cursor = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) throw new Error('Symlinks denied');
        if (stat.isFile() && stat.nlink > 1) throw new Error('Hard links denied');
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('Special files denied');
        if (!inside(root, fs.realpathSync(cursor))) throw new Error('Path escapes project');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return target;
  }
  // Grep/Glob can walk descendants: checking only their starting path is insufficient.
  function checkTree(dir) {
    safePath(dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    for (const entry of fs.readdirSync(dir)) {
      const file = safePath(path.join(dir, entry));
      if (fs.statSync(file).isDirectory()) checkTree(file);
    }
  }
  async function decide(name, input, { signal } = {}) {
    let result;
    try {
      if (signal?.aborted) throw new Error('Request cancelled');
      if (CUSTOM.includes(name)) result = { behavior: 'allow', updatedInput: input };
      else {
        if (!BUILTINS.includes(name)) throw new Error('Tool is disabled in Phase 1');
        if (name === 'Skill') {
          if (typeof input.skill !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.skill)) throw new Error('Only local bIT skills are allowed');
          const file = safePath(`bit/skills/${input.skill}/SKILL.md`);
          if (!fs.existsSync(file)) throw new Error('Unknown bIT skill');
          const content = fs.readFileSync(file, 'utf8');
          validateSkill(content);
          result = { behavior: 'allow', updatedInput: input };
        } else {
          const field = name === 'Glob' || name === 'Grep' ? 'path' : 'file_path';
          const target = safePath(input[field]);
          const area = ['memory', 'skills', 'persona'].find(a => inside(path.join(root, 'bit', a), target));
          if (!area) throw new Error('Only bit/memory, bit/skills and bit/persona are accessible; source, .env and other paths are denied');
          if (name === 'Glob') {
            if (typeof input.pattern !== 'string' || path.isAbsolute(input.pattern) || input.pattern.includes('..') || input.pattern.includes('\\')) throw new Error('Glob pattern must stay inside its explicit path');
          }
          if (name === 'Grep' || name === 'Glob') checkTree(target);
          if (writes.has(name)) {
            if (area === 'persona') throw new Error('Persona is read-only');
            if (area === 'skills') {
              if (path.basename(target) === 'SKILL.md') {
                let proposed = input.content;
                if (name === 'Edit') {
                  const before = fs.readFileSync(target, 'utf8');
                  proposed = input.replace_all ? before.replaceAll(input.old_string, input.new_string) : before.replace(input.old_string, input.new_string);
                }
                validateSkill(proposed);
              }
              if (!await approve({ tool: name, file: path.relative(root, target), input, signal })) throw new Error('Skill change denied or approval timed out');
              // Recheck after the ten-minute approval window.
              safePath(target);
            }
          }
          result = { behavior: 'allow', updatedInput: { ...input, [field]: target } };
        }
      }
    } catch (e) { result = { behavior: 'deny', message: e.message }; }
    // Do not log file contents, replacement text, tokens, or search text.
    audit({ tool: name, path: input?.file_path || input?.path, skill: input?.skill, decision: result.behavior, reason: result.message });
    return result;
  }
  const approved = new Map();
  return {
    audit,
    canUseTool: async (name, input, options = {}) => {
      const prior = approved.get(options.toolUseID);
      if (prior && prior.name === name && JSON.stringify(prior.input) === JSON.stringify(input)) return prior.result;
      return decide(name, input, options);
    },
    hooks: {
      PreToolUse: [{ timeout: 660, hooks: [async (event, id, options) => {
        const result = await decide(event.tool_name, event.tool_input, options);
        if (result.behavior === 'allow' && id) approved.set(id, { name: event.tool_name, input: result.updatedInput, result });
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.behavior, permissionDecisionReason: result.message || 'bIT path policy approved', ...(result.behavior === 'allow' ? { updatedInput: result.updatedInput } : {}) } };
      }] }],
      PostToolUse: [{ hooks: [async event => {
        approved.delete(event.tool_use_id);
        audit({ tool: event.tool_name, decision: 'completed' });
        if (writes.has(event.tool_name)) {
          const file = safePath(event.tool_input.file_path);
          if (inside(path.join(root, 'bit/memory'), file)) await notify(`📝 noted: ${path.relative(root, file)}`);
        }
        return {};
      }] }],
      PostToolUseFailure: [{ hooks: [async event => { approved.delete(event.tool_use_id); audit({ tool: event.tool_name, decision: 'failed' }); return {}; }] }],
    },
  };
}
