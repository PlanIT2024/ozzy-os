import readline from 'node:readline/promises';
import { runHarness } from '../src/node/agent/harness.js';
import { parseArgs } from 'node:util';
import { readPolicy, writePolicy, executors } from '../src/node/agent/policy.js';
import { connectAgent, connect } from '../src/node/agent/local.js';

const command = process.argv[2];
let terminal, client;
try {
  if (command === 'enable') {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.SSH_CONNECTION || process.env.SSH_TTY) throw new Error('Enable must run interactively on this machine, outside SSH');
    terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    const selected = (await terminal.question('Executors (comma separated) [claude_code,codex]: ')).trim() || executors.join(',');
    const projects = [];
    do {
      const alias = (await terminal.question('Project alias: ')).trim();
      const absolutePath = (await terminal.question('Existing git repository absolute path: ')).trim();
      projects.push({ alias, absolutePath });
    } while (/^y$/i.test((await terminal.question('Add another project? [y/N] ')).trim()));
    const maxConcurrent = Number((await terminal.question('Maximum concurrent runs [2, max 4]: ')).trim() || 2);
    const maxLeaseMinutes = Number((await terminal.question('Maximum lease minutes [60, max 120]: ')).trim() || 60);
    writePolicy({ enabled: true, executors: selected.split(',').map(s => s.trim()), projects, maxConcurrent, maxLeaseMinutes });
    console.log('Local agent execution enabled. Policy saved with mode 0600.');
  } else if (command === 'disable') {
    writePolicy({ enabled: false });
    try { client = await connect(); await client.request('local.disable'); } catch (e) { if (!['ENOENT','ECONNREFUSED'].includes(e.code)) throw e; }
    console.log('Agent execution disabled; running agents stopped.');
  } else if (command === 'try') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { executor: { type: 'string' }, folder: { type: 'string' }, prompt: { type: 'string' }, lease: { type: 'string', default: '5' } } });
    if (!readPolicy().enabled) throw new Error('Run npm run agent:enable locally first');
    client = await connectAgent();
    terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    const status = await runHarness({ client, terminal, ...values });
    process.exitCode = status === 'done' ? 0 : 1;
  } else throw new Error('Expected enable, disable or try');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { terminal?.close(); client?.close(); }
