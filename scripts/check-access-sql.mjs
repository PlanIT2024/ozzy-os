import { spawnSync } from 'node:child_process';
import { readFileSync,readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const name=`bitos-access-${randomUUID()}`;
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.error?.message||r.stdout);return r.stdout;}
const read=file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
try{
 docker(['run','--rm','-d','--name',name,'-e','POSTGRES_PASSWORD=local-test','postgres:16']);
 let ready=false;for(let i=0;i<60;i++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'ignore'}).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,500));}if(!ready)throw Error('Local PostgreSQL startup failed');
 const migrations=readdirSync(new URL('../supabase/migrations',import.meta.url)).filter(f=>/^000[1-9]_.*\.sql$/.test(f)).sort().map(f=>'supabase/migrations/'+f);
 const migration=migrations.find(f=>f.includes('0009_'));
 docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],['create role anon nologin;',read('test/fixtures/phase2b-auth.sql'),...migrations.map(read),read(migration),read('test/fixtures/access-rls.sql'),read('docs/access-verification.sql')].join('\n'));
 console.log('Disposable PostgreSQL: migrations 0001–0009, 0009 replay, access and existing approval owner/RLS/trigger tests passed.');
}finally{spawnSync('docker',['stop',name],{stdio:'ignore'});}
