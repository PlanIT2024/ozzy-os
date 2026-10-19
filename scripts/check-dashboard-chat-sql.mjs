// Explicit local integration check: node scripts/check-phase2b-sql.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const name=`bitos-chat-sql-${randomUUID()}`;
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
 const files=['test/fixtures/phase2b-auth.sql',...['0001_bit_os_core','0002_executor_and_refs','0003_replay_safe_writes','0004_agent_runs','0005_bit_presence','0006_bit_presence_access_and_realtime','0007_dashboard_chat','0007_dashboard_chat'].map(n=>`supabase/migrations/${n}.sql`),'docs/dashboard-chat-verification.sql','test/fixtures/dashboard-chat-rls.sql'];
 docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],['create role anon nologin;',...files.map(f=>readFileSync(new URL(`../${f}`,import.meta.url),'utf8'))].join('\n'));
 const migration=readFileSync(new URL('../supabase/migrations/0008_conversation_titles.sql',import.meta.url),'utf8');
 docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],`insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000087','legacy@test');
 insert into workspaces(id,name,created_by) values ('10000000-0000-0000-0000-000000000087','legacy','00000000-0000-0000-0000-000000000087');
 insert into conversations(id,workspace_id,owner_id,title) values ('60000000-0000-0000-0000-000000000087','10000000-0000-0000-0000-000000000087','00000000-0000-0000-0000-000000000087',repeat('l',120));`+'\n'+migration+`\ndo $$ begin if not exists(select 1 from conversations where id='60000000-0000-0000-0000-000000000087' and title=repeat('l',120) and title_set_by_owner) then raise exception 'legacy title not preserved';end if;end $$;`+'\n'+readFileSync(new URL('../test/fixtures/conversation-titles-rls.sql',import.meta.url),'utf8'));
 // Replaying 0008 must not promote automatic titles to owner-set titles.
 const seed=`insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000088','replay@test');
 insert into workspaces(id,name,created_by) values ('10000000-0000-0000-0000-000000000088','replay','00000000-0000-0000-0000-000000000088');
 insert into conversations(id,workspace_id,owner_id,title) values ('60000000-0000-0000-0000-000000000088','10000000-0000-0000-0000-000000000088','00000000-0000-0000-0000-000000000088','Automatic title');`;
 docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],seed+'\n'+migration+`\ndo $$ begin if exists(select 1 from conversations where id='60000000-0000-0000-0000-000000000088' and title_set_by_owner) then raise exception 'replay promoted auto title';end if;end $$;`+'\n'+readFileSync(new URL('../docs/conversation-titles-verification.sql',import.meta.url),'utf8'));
 console.log('Migrations 0001–0008, 0007/0008 replay, chat RLS and title ownership/trigger assertions passed.');
} finally {
 spawnSync('docker',['stop',name],{stdio:'ignore'});
}
