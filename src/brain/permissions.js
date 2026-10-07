import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../shared.js';
import { publicURL } from './web.js';
import { validateSchedule } from './scheduler.js';
import { proposedContent, reviewDiff } from './reviewDiff.js';
import { validateSkill } from './skills.js';
export const BUILTINS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'WebSearch', 'WebFetch'];
export const CUSTOM = ['mcp__machines__list_machines', 'mcp__machines__machine_status', 'mcp__reminders__set_reminder', 'mcp__reminders__list_reminders', 'mcp__reminders__cancel_reminder'];
const writes = new Set(['Write', 'Edit']);
const inside = (base, file) => file === base || file.startsWith(base + path.sep);
export function createPermissions({ root = ROOT, approve = async () => false, notify = async () => {}, afterWrite = async () => {}, context = '', web, sessionKey = context, resolve, reminders, webAllowed = true, screen, control } = {}) {
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
    if (path.relative(root, target).split(path.sep).some(part => ['.claude', '.agents'].includes(part))) throw new Error('Claude configuration paths are denied');
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
      if (name === 'mcp__computer__computer') {
        if (!control) throw new Error('Computer control unavailable; tainted and scheduled runs are forbidden.');
        await control.authorize(input, { signal });
        result = { behavior: 'allow', updatedInput: input };
      } else if (name === 'mcp__screens__screenshot') {
        if (!screen) throw new Error('Screenshot access unavailable; scheduled jobs cannot capture screens.');
        await screen.authorize(input.machine, { signal });
        result = { behavior: 'allow', updatedInput: input };
      } else if (name === 'mcp__reminders__set_reminder') {
        if (!reminders) throw new Error('Reminder store unavailable');
        const proposal = reminders.proposal(input.when, input.text);
        if (web?.session(sessionKey).tainted) {
          if (!await approve({ tool: name, action: 'Reminder', description: proposal.resolved, input: { ...input, due: proposal.due }, signal })) throw new Error('Reminder denied or approval timed out');
        }
        result = { behavior: 'allow', updatedInput: { ...input, when: proposal.due } };
      } else if (CUSTOM.includes(name)) result = { behavior: 'allow', updatedInput: input };
      else {
        if (!BUILTINS.includes(name)) throw new Error('Tool is disabled');
        if (name === 'WebSearch' || name === 'WebFetch') {
          if (!webAllowed) throw new Error('This schedule does not explicitly request web tools.');
          if (!web) throw new Error('Web policy unavailable');
          if (name === 'WebFetch') {
            await publicURL(input.url, resolve);
            if (!web.session(sessionKey).urls.includes(input.url)) {
              if (!await approve({ tool: name, url: input.url, input, signal })) throw new Error('URL denied or approval timed out');
              await publicURL(input.url, resolve);
              audit({ tool: name, url: input.url, decision: 'approved', tainted: web.session(sessionKey).tainted });
            }
          } else if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('Missing search query');
          web.reserve(name);
          result = { behavior: 'allow', updatedInput: input };
        } else if (name === 'Skill') {
          if (typeof input.skill !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.skill)) throw new Error('Only local bIT skills are allowed');
          const file = safePath(`bit/skills/${input.skill}/SKILL.md`);
          if (!fs.existsSync(file)) throw new Error('Unknown bIT skill');
          const content = fs.readFileSync(file, 'utf8');
          validateSkill(content);
          result = { behavior: 'allow', updatedInput: input };
        } else {
          const field = name === 'Glob' || name === 'Grep' ? 'path' : 'file_path';
          const target = safePath(input[field]);
          const area = ['memory', 'skills', 'schedules', 'persona'].find(a => inside(path.join(root, 'bit', a), target));
          if (!area) throw new Error('Only bit/memory, bit/skills, bit/schedules and bit/persona are accessible; source, .env and other paths are denied');
          if (name === 'Glob') {
            if (typeof input.pattern !== 'string' || path.isAbsolute(input.pattern) || input.pattern.includes('..') || input.pattern.includes('\\')) throw new Error('Glob pattern must stay inside its explicit path');
          }
          if (name === 'Grep' || name === 'Glob') checkTree(target);
          if (writes.has(name)) {
            if (area === 'persona') throw new Error('Persona is read-only');
            if (area === 'skills' || area === 'schedules' || (area === 'memory' && web?.session(sessionKey).tainted)) {
              const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
              const after = proposedContent(name, input, before);
              if (area === 'skills' && path.basename(target) === 'SKILL.md') validateSkill(after);
              if (area === 'schedules') {
                const relative = path.relative(path.join(root, 'bit/schedules'), target);
                if (!/^[a-z0-9][a-z0-9_-]{0,63}\.md$/.test(relative)) throw new Error('Schedules must be bit/schedules/<name>.md');
                validateSchedule(after, relative.slice(0, -3));
              }
              const diff = reviewDiff(path.relative(root, target), before, after);
              if (!await approve({ tool: name, file: path.relative(root, target), input, diff, signal })) throw new Error('Change denied or approval timed out');
              safePath(target);
              if ((fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '') !== before) throw new Error('File changed during approval; review again');
              // Recheck after the ten-minute approval window.
              safePath(target);
            }
          }
          result = { behavior: 'allow', updatedInput: { ...input, [field]: target } };
        }
      }
    } catch (e) { result = { behavior: 'deny', message: e.message }; }
    // Log web queries/URLs for owner review, never file contents or replacement text.
    if (['mcp__screens__screenshot','mcp__computer__computer'].includes(name)) audit({ tool: name, decision: result.behavior });
    else audit({ tool: name, path: input?.file_path || input?.path, skill: input?.skill, query: input?.query, url: input?.url, tainted: web?.session(sessionKey).tainted || false, decision: result.behavior, reason: result.message });
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
        if (['WebSearch','WebFetch'].includes(event.tool_name)) {
          web.result(sessionKey, event.tool_name, event.tool_response);
          if (control) await control.end('thread tainted by web result');
          audit({ tool: event.tool_name, query: event.tool_input.query, url: event.tool_input.url, decision: 'completed', tainted: true });
          if (event.tool_name === 'WebFetch' && event.tool_response?.url) {
            try { await publicURL(event.tool_response.url, resolve); } catch (error) { return { decision: 'block', reason: error.message }; }
          }
        } else audit({ tool: event.tool_name, decision: 'completed' });
        if (writes.has(event.tool_name)) {
          const file = safePath(event.tool_input.file_path);
          if (inside(path.join(root, 'bit/memory'), file)) await notify(`📝 noted: ${path.relative(root, file)}`);
          await afterWrite(file);
        }
        return {};
      }] }],
      PostToolUseFailure: [{ hooks: [async event => { approved.delete(event.tool_use_id); audit({ tool: event.tool_name, ...(['mcp__screens__screenshot','mcp__computer__computer'].includes(event.tool_name) ? {} : { query: event.tool_input?.query, url: event.tool_input?.url }), tainted: web?.session(sessionKey).tainted || false, decision: 'failed' }); return {}; }] }],
    },
  };
}
