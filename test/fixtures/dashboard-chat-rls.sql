begin;
do $$ begin
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('conversations','chat_messages') and not c.relrowsecurity) then raise exception 'RLS disabled';end if;
 if (select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('conversations','chat_messages'))<>2 then raise exception 'Realtime missing';end if;
 if has_table_privilege('authenticated','chat_messages','UPDATE') or has_table_privilege('authenticated','chat_messages','DELETE') or has_column_privilege('authenticated','conversations','owner_id','UPDATE') or not has_column_privilege('authenticated','conversations','title','UPDATE') then raise exception 'Unexpected client privilege';end if;
end $$;
grant usage on schema public, auth to authenticated, service_role;
grant select, insert, update, delete on tasks, projects, nodes, workspace_members, workspaces, approvals, agent_runs, node_shares to authenticated;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000001','owner@test'),('00000000-0000-0000-0000-000000000002','other@test');
insert into workspaces(id,name,created_by) values ('10000000-0000-0000-0000-000000000001','test','00000000-0000-0000-0000-000000000001');
insert into workspace_members(workspace_id,user_id,role) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member');
insert into nodes(id,name,owner_id) values ('20000000-0000-0000-0000-000000000001','MacBook','00000000-0000-0000-0000-000000000001');
insert into tasks(id,title,workspace_id,created_by) values ('30000000-0000-0000-0000-000000000001','test','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
insert into conversations(id,workspace_id,owner_id) values ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'),('60000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
insert into chat_messages(id,conversation_id,workspace_id,owner_id,author,body) values ('70000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',auth.uid(),'owner','Hello');
do $$ begin
 if (select count(*) from conversations)<>1 then raise exception 'other conversation exposed'; end if;
 begin insert into chat_messages(conversation_id,workspace_id,owner_id,author,body) values ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',auth.uid(),'bit','spoof'); raise exception 'bit insertion accepted'; exception when insufficient_privilege then null; end;
 begin insert into chat_messages(conversation_id,workspace_id,owner_id,author,body,cards) values ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',auth.uid(),'owner','spoof','[]'); raise exception 'cards insertion accepted'; exception when insufficient_privilege then null; end;
 begin insert into chat_messages(conversation_id,workspace_id,owner_id,author,body) values ('60000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',auth.uid(),'owner','spoof'); raise exception 'foreign conversation accepted'; exception when insufficient_privilege then null; end;
 begin insert into chat_messages(conversation_id,workspace_id,owner_id,author,body) values ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',auth.uid(),'owner',repeat('x',8001)); raise exception 'oversize accepted'; exception when insufficient_privilege then null; end;
 begin perform public.chat_apply_task(auth.uid(),'10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','{"title":"spoof"}',false,now());raise exception 'client RPC accepted';exception when insufficient_privilege then null;end;
 begin update chat_messages set body='changed'; raise exception 'message update accepted'; exception when insufficient_privilege then null; end;
 begin delete from chat_messages; raise exception 'message delete accepted'; exception when insufficient_privilege then null; end;
 begin insert into agent_runs(id,task_id,node_id,executor,folder_alias,prompt,lease_minutes,started_at) values ('40000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','codex','sandbox','test',5,now()); raise exception 'client start insertion accepted'; exception when insufficient_privilege then null; end;
end $$;
insert into agent_runs(id,task_id,node_id,executor,folder_alias,prompt,lease_minutes) values ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','codex','sandbox','test',5);
do $$ begin
 begin update agent_runs set started_at=now(),stop_requested=true;raise exception 'start update accepted';exception when raise_exception then if sqlerrm='start update accepted' then raise;end if;end;
 update agent_runs set stop_requested=true;
 if not found then raise exception 'stop path broken';end if;
 update tasks set status='cancelled';update tasks set title='Changed';update tasks set title='test';
end $$;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';
do $$ begin if exists(select 1 from chat_messages) then raise exception 'other owner messages exposed';end if;end $$;
reset role;
grant select,insert,update on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
create function test_audit_failure() returns trigger language plpgsql as $$ begin
 if new.payload->'changed'->>'title'='rollback audit' then raise exception 'audit insert failed';end if;return new;end $$;
create trigger test_audit_failure before insert on task_events for each row execute function test_audit_failure();
set local role service_role;
set local request.jwt.claim.role='service_role';
update agent_runs set started_at=now();
insert into chat_messages(conversation_id,workspace_id,owner_id,author,body,status) values ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','bit','Brain reply','done');
select * from chat_apply_task('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','{"title":"Atomic chat task"}',true);
do $$ begin
 if not exists(select 1 from tasks where title='Atomic chat task' and created_by='00000000-0000-0000-0000-000000000001') or not exists(select 1 from task_events where task_id='30000000-0000-0000-0000-000000000002' and payload->>'conversation_id'='60000000-0000-0000-0000-000000000001') then raise exception 'atomic task audit missing';end if;
 begin perform chat_apply_task('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003','{"title":"rollback audit"}',true);raise exception 'audit failure ignored';exception when raise_exception then if sqlerrm<>'audit insert failed' then raise;end if;end;
 if exists(select 1 from tasks where id='30000000-0000-0000-0000-000000000003') then raise exception 'unaudited mutation persisted';end if;
end $$;
select * from chat_apply_task('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','{"title":"Atomic update","description":"Full detail"}',false,(select updated_at from tasks where id='30000000-0000-0000-0000-000000000002'));
do $$ begin
 if not exists(select 1 from tasks where title='Atomic update' and description='Full detail') or not exists(select 1 from task_events where payload->'before'->>'title'='Atomic chat task' and payload->'changed'->>'title'='Atomic update') then raise exception 'Update audit missing';end if;
end $$;
update workspace_members set role='viewer' where user_id='00000000-0000-0000-0000-000000000002';
do $$ begin
 begin perform chat_apply_task('00000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000004','{"title":"Viewer write"}',true);raise exception 'Viewer mutation accepted';exception when raise_exception then if sqlerrm<>'Workspace permission denied' then raise;end if;end;
end $$;

rollback;
