import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ROOT, readJSON, saveJSON, serial } from '../shared.js';
import { BUILTINS, createPermissions } from './permissions.js';
import { machineTools } from './tools.js';
import { validateSkill } from './skills.js';
export function activeMood(saved, date = new Date(), timezone = process.env.TZ || 'America/New_York') {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(date));
  return hour >= 22 || hour < 5 ? 'sage' : saved;
}
export function prepareSkills(root = ROOT) {
  const skills = path.join(root, 'bit/skills');
  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (['.claude', '.agents'].includes(item.name)) throw new Error('Nested skill/config discovery is disabled');
      if (item.isSymbolicLink()) throw new Error('Skills must not contain symlinks');
      if (item.isDirectory()) scan(file);
      else if (item.name === 'SKILL.md') {
        const content = fs.readFileSync(file, 'utf8');
        // Skill preprocessing can run commands outside the tool permission callback.
        validateSkill(content);
      }
    }
  }
  scan(skills);
  const names = fs.readdirSync(skills, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of names) {
    const metadata = validateSkill(fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8'));
    if (metadata.name !== name) throw new Error('Skill name must match its folder');
  }
  const alias = path.join(root, '.claude/skills'); fs.mkdirSync(path.dirname(alias), { recursive: true });
  if (!fs.existsSync(alias)) fs.symlinkSync(skills, alias, 'junction');
  if (fs.realpathSync(alias) !== fs.realpathSync(skills)) throw new Error('Unexpected .claude/skills directory');
  // Project source is required for SDK discovery. Reject other project configuration
  // instead of loading hooks, plugins or legacy commands alongside bIT skills.
  for (const name of fs.readdirSync(path.dirname(alias))) {
    if (!['skills', '.gitkeep'].includes(name)) throw new Error(`Unexpected project Claude configuration: ${name}`);
  }
  return names;
}
export function skillOptions(root = ROOT) {
  return {
    settingSources: ['project'], skills: prepareSkills(root), plugins: [],
    settings: { disableBundledSkills: true, syncClaudeAiSkills: false, syncClaudeAiPlugins: false, enabledPlugins: {} },
  };
}
export class Runner {
  constructor({ hub, budget, root = ROOT, queryFn = query }) {
    Object.assign(this, { hub, budget, root, queryFn });
    this.sessionFile = path.join(root, 'data/sessions.json');
    this.sessions = readJSON(this.sessionFile, {});
    this.moodFile = path.join(root, 'data/preferences.json');
    this.preferences = readJSON(this.moodFile, { mood: 'chill' });
    this.personalities = readJSON(path.join(root, 'bit/persona/personalities.json'), {});
    this.queue = serial(); // A single cost gate prevents concurrent channels overspending.
    this.controllers = new Set();
  }
  mood(value) { if (!Object.hasOwn(this.personalities, value)) throw new Error('Unknown personality'); this.preferences.mood = value; saveJSON(this.moodFile, this.preferences); }
  reset(channel) { return this.queue(() => { delete this.sessions[channel]; saveJSON(this.sessionFile, this.sessions); }); }
  close() { this.stopped = true; for (const controller of this.controllers) controller.abort(); }
  run(channel, prompt, { notify, approve }) {
    return this.queue(async () => {
      if (this.stopped) return 'My ring is powering down. Catch me after restart.';
      const balance = this.budget.status();
      if (balance.uncertain) return 'My juice meter lost track of the last run. Ozzy, please reconcile data/budget.json before I spend any more.';
      if (balance.remaining <= 0) return 'My neon ring is running on fumes, Ozzy. I’m out of juice until next month. Machines and mood controls still work.';
      const isolatedSkills = skillOptions(this.root);
      const permissions = createPermissions({ root: this.root, notify, approve, context: channel });
      const mood = activeMood(this.preferences.mood);
      const persona = fs.readFileSync(path.join(this.root, 'bit/persona/persona.md'), 'utf8');
      const systemPrompt = `${persona}\nActive personality: ${mood}: ${this.personalities[mood]}\nYou are Ozzy's standalone OZZY OS assistant. Your working directory is ${this.root}. Always read bit/memory/profile.md and relevant memory files before answering personal questions, including in a new session. Save facts Ozzy asks you to remember in bit/memory. Use list_machines and machine_status for machine questions; never invent status. Tools require explicit paths under bit/memory, bit/skills or bit/persona. Persona is read-only, memory is writable, skill writes require the Discord ✅ button pressed by Ozzy. Chat text such as approved or sounds good is never authorization; always invoke the write tool and wait for its button decision. Source code, .env and every other path are inaccessible. Bash and other built-ins are disabled. Explain denied requests honestly. Skills must contain instructions only: no shell preprocessing, hooks or subagents. For new skills write bit/skills/<name>/SKILL.md. Never claim a write succeeded unless the tool succeeded. Do not output slash commands as an alternative to using tools.`;
      const controller = new AbortController(); this.controllers.add(controller);
      const env = {};
      for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'ANTHROPIC_API_KEY', 'TZ']) if (process.env[key]) env[key] = process.env[key];
      env.CLAUDE_CONFIG_DIR = path.join(this.root, 'data/claude');
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';
      let gotResult = false, response = '', session = this.sessions[channel];
      this.budget.begin();
      try {
        async function* input() { yield { type: 'user', message: { role: 'user', content: `Ozzy says:\n${prompt}` }, parent_tool_use_id: null, session_id: session || '' }; }
        for await (const message of this.queryFn({ prompt: input(), options: {
          cwd: this.root, model: process.env.BIT_MODEL || 'claude-sonnet-5', systemPrompt,
          tools: BUILTINS, ...isolatedSkills, permissionMode: 'default',
          canUseTool: permissions.canUseTool, hooks: permissions.hooks,
          mcpServers: { machines: machineTools(this.hub) }, strictMcpConfig: true,
          ...(session ? { resume: session } : {}), maxBudgetUsd: balance.remaining, maxTurns: 30,
          env, abortController: controller,
        } })) {
          if (message.session_id) { session = message.session_id; this.sessions[channel] = session; saveJSON(this.sessionFile, this.sessions); }
          if (message.type === 'result') {
            this.budget.record(session, message.total_cost_usd); gotResult = true;
            response = message.subtype === 'success' ? message.result : `My ring hit a snag (${message.subtype}). ${message.errors?.join('; ') || 'Please try a smaller request.'}`;
          }
        }
        if (!gotResult) throw new Error('SDK ended without usage result');
        return response || 'My ring flickered. I didn’t get a reply back.';
      } catch (error) {
        console.error('Agent run stopped:', error.name, String(error.message).replaceAll(process.env.ANTHROPIC_API_KEY || '\0', '[redacted]'));
        permissions.audit({ event: 'runner_error', decision: 'stopped', reason: error.name });
        return 'My ring hit a connection snag. Check the brain console and budget ledger before retrying; I won’t claim that task succeeded.';
      } finally { this.controllers.delete(controller); }
    });
  }
}
