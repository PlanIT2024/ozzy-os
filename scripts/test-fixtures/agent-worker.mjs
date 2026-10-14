import fs from 'node:fs';
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
process.once('message', m => {
  if (m.prompt === 'process-tree') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync('child.pid', String(child.pid));
    process.send({ type: 'event', summary: 'tree ready' });
  } else if (m.prompt === 'edit') {
    fs.writeFileSync('tracked.txt', 'changed\n');
    fs.writeFileSync('new.txt', 'new\n');
    process.send({ type: 'finished', status: 'done', summary: `finished in ${m.cwd}` });
  } else if (m.prompt.startsWith('approval:')) {
    process.send({ type: 'approval', id: 1, ...JSON.parse(m.prompt.slice(9)) });
    process.on('message', answer => {
      if (answer.type === 'decision') { fs.writeFileSync('decision.json', JSON.stringify(answer)); process.send({ type: 'event', summary: 'decision received' }); }
    });
  }
});
setInterval(() => {}, 1000);
