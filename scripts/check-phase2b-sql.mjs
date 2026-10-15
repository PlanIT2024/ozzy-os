// Explicit local integration check: node scripts/check-phase2b-sql.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const name=`bitos-sql-${randomUUID()}`;
function docker(args,input) {
 const r=spawnSync('docker',args,{input,encoding:'utf8'});
 if(r.status!==0)throw Error(r.stderr||r.error?.message||r.stdout);
 return r.stdout;
}
try {
 docker(['run','--rm','-d','--name',name,'-e','POSTGRES_PASSWORD=local-test','postgres:16']);
 let ready=false;
 for(let i=0;i<60;i++){
  const r=spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'ignore'});
  if(r.status===0){ready=true;break;}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!ready)throw Error('Local Postgres did not start');
 const files=['test/fixtures/phase2b-auth.sql',...['0001_bit_os_core','0002_executor_and_refs','0003_replay_safe_writes','0004_agent_runs'].map(n=>`supabase/migrations/${n}.sql`),'test/fixtures/phase2b-rls.sql'];
 docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],files.map(f=>readFileSync(new URL(`../${f}`,import.meta.url),'utf8')).join('\n'));
 console.log('Migrations 0001–0004 and Phase 2b RLS/trigger assertions passed.');
} finally {
 spawnSync('docker',['stop',name],{stdio:'ignore'});
}
