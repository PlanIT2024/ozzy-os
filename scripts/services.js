import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/shared.js';
const action = process.argv[2], nodeOnly = process.argv.includes('--node-only');
function run(command, args, optional = false) { const result = spawnSync(command, args, { stdio: 'inherit' }); if (!optional && (result.error || result.status !== 0)) throw result.error || new Error(`${command} exited ${result.status}`); }
if (!['install', 'status', 'logs', 'uninstall'].includes(action)) throw new Error('Choose install/status/logs/uninstall');
if (process.platform === 'linux') {
  if (ROOT !== path.join(os.homedir(), 'ozzy-os')) throw new Error('User units require checkout at ~/ozzy-os');
  const units = nodeOnly ? ['bit-node.service'] : ['bit-brain.service', 'bit-node.service'];
  const directory = path.join(os.homedir(), '.config/systemd/user');
  if (action === 'install') {
    fs.mkdirSync(directory, { recursive: true });
    for (const unit of units) {
      let content = fs.readFileSync(path.join(ROOT, 'deploy/systemd', unit), 'utf8').replace('/usr/bin/node', `"${process.execPath.replaceAll('%', '%%')}"`);
      if (nodeOnly) content = content.replace('After=bit-brain.service\nWants=bit-brain.service\n', 'After=network-online.target\nWants=network-online.target\n');
      fs.writeFileSync(path.join(directory, unit), content);
    }
    run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'reset-failed', ...units], true); run('systemctl', ['--user', 'enable', ...units]); run('systemctl', ['--user', 'restart', ...units]);
  } else if (action === 'uninstall') {
    run('systemctl', ['--user', 'disable', '--now', ...units], true);
    for (const unit of units) fs.rmSync(path.join(directory, unit), { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (action === 'status') run('systemctl', ['--user', 'status', ...units, '--no-pager']);
  else run('journalctl', ['--user', ...units.flatMap(unit => ['-u', unit]), '-f']);
} else if (process.platform === 'darwin') {
  const domain = `gui/${os.userInfo().uid}`, name = 'com.ozzy.bit-node', file = path.join(os.homedir(), 'Library/LaunchAgents', name + '.plist');
  if (action === 'install') {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true, mode: 0o700 });
    const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    fs.writeFileSync(file, fs.readFileSync(path.join(ROOT, 'deploy/launchd', name + '.plist'), 'utf8').replaceAll('__NODE__', xml(process.execPath)).replaceAll('__ROOT__', xml(ROOT)));
    run('launchctl', ['bootout', `${domain}/${name}`], true); run('launchctl', ['bootstrap', domain, file]); run('launchctl', ['kickstart', `${domain}/${name}`]);
  } else if (action === 'uninstall') { run('launchctl', ['bootout', `${domain}/${name}`], true); fs.rmSync(file, { force: true }); }
  else if (action === 'status') run('launchctl', ['print', `${domain}/${name}`]);
  else run('tail', ['-F', path.join(ROOT, 'data/node.log'), path.join(ROOT, 'data/node-error.log')]);
} else throw new Error('On Windows, use the documented Task Scheduler at-log-on task.');
