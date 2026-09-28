import { parse } from 'yaml';
// Skill preprocessing can execute before ordinary tool permission callbacks.
// Phase 1 accepts instructional metadata only, even when YAML keys are quoted.
export function validateSkill(content) {
  if (/!\s*`/.test(content)) throw new Error('Skill shell preprocessing is disabled');
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!header) throw new Error('SKILL.md needs YAML frontmatter with name and description');
  const meta = parse(header[1], { maxAliasCount: 0 });
  const allowed = new Set(['name', 'description', 'argument-hint', 'disable-model-invocation', 'user-invocable']);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some(key => !allowed.has(key))) throw new Error('Skill metadata may only describe instructions; hooks, tool overrides and subagents are disabled');
  if (typeof meta.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(meta.name) || typeof meta.description !== 'string') throw new Error('Skill needs a simple name and description');
  return meta;
}
