import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
const rows = [];
function record(check, pass, detail = '') { rows.push({ Check: check, Result: pass ? 'PASS' : 'FAIL', Detail: detail }); }
async function passwordPrompt() {
 if (!stdin.isTTY) throw new Error('Use an interactive terminal for the password prompt.');
 stdout.write('Password (hidden): '); stdin.setRawMode(true); stdin.resume();
 return new Promise((resolve, reject) => {
  let value = '';
  const finish = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
  function onData(chunk) {
   for (const char of chunk.toString()) {
    if (char === '\u0003') { finish(); reject(new Error('Cancelled')); return; }
    if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
    if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
    else if (char >= ' ') value += char;
   }
  }
  stdin.on('data', onData);
 });
}
let client, taskId;
try {
 const content = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
 const env = Object.fromEntries(content.split(/\r?\n/).map(line => line.match(/^\s*(VITE_SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(match => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
 if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY) throw new Error('Missing dashboard environment configuration');
 client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
 for (const table of ['nodes', 'tasks', 'workspaces']) {
  const { data, error } = await client.from(table).select('id');
  record(`Signed out: ${table}`, !error && data?.length === 0, error ? `Query error (${error.code || 'unknown'})` : `${data?.length ?? '?'} rows`);
 }
 const prompt = createInterface({ input: stdin, output: stdout });
 const email = await prompt.question('Email: '); prompt.close();
 let password = await passwordPrompt();
 const login = await client.auth.signInWithPassword({ email, password }); password = '';
 record('Email/password sign-in', !login.error);
 if (login.error) throw new Error('Sign-in failed');
 const nodes = await client.from('nodes').select('name');
 record('OZZY-AI visible', !nodes.error && nodes.data?.some(node => node.name === 'OZZY-AI'));
 const memberships = await client.from('workspace_members').select('workspace_id,role').eq('user_id', login.data.user.id);
 const choices = (memberships.data || []).filter(member => member.role !== 'viewer');
 if (memberships.error || !choices.length) throw new Error('No writable workspace membership found');
 let workspace = choices[0].workspace_id;
 if (choices.length > 1) {
  console.table(choices.map((choice, index) => ({ Choice: index + 1, Workspace: choice.workspace_id, Role: choice.role })));
  const pick = createInterface({ input: stdin, output: stdout });
  const answer = await pick.question('Workspace number [1]: '); pick.close();
  const index = answer.trim() ? Number(answer) - 1 : 0;
  if (!Number.isInteger(index) || !choices[index]) throw new Error('Invalid workspace selection');
  workspace = choices[index].workspace_id;
 }
 const inserted = await client.from('tasks').insert({ workspace_id: workspace, title: 'Dashboard RLS smoke test', status: 'inbox', source: 'typed' }).select('id').single();
 taskId = inserted.data?.id;
 record('Insert inbox task', !inserted.error && !!taskId);
 if (!taskId) throw new Error('Cannot continue without smoke task');
 for (const [table, payload] of [['task_events', { task_id: taskId, kind: 'note', summary: 'RLS smoke test' }], ['approvals', { task_id: taskId, action_summary: 'RLS smoke test', risk: 'risky' }]]) {
  const result = await client.from(table).insert(payload);
  record(`Insert ${table} denied by RLS`, result.error?.code === '42501', result.error ? `Error code ${result.error.code}` : 'Unexpected successful insert');
 }
} catch {
 record('Smoke test completed', false, 'Unable to complete; check configuration, credentials and connectivity.');
} finally {
 if (client && taskId) {
  const removed = await client.from('tasks').delete().eq('id', taskId).select('id');
  record('Delete smoke task', !removed.error && removed.data?.length === 1, removed.error ? 'Cleanup failed; remove the Dashboard RLS smoke test task manually.' : '');
 }
 if (client) await client.auth.signOut();
 console.table(rows);
 if (rows.some(row => row.Result === 'FAIL')) process.exitCode = 1;
}
