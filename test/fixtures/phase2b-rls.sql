-- Run after migrations in a disposable database with phase2b-auth.sql.
begin;
grant usage on schema public, auth to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
insert into auth.users(id,email) values
 ('00000000-0000-0000-0000-000000000001','owner@test'),
 ('00000000-0000-0000-0000-000000000002','member@test'),
 ('00000000-0000-0000-0000-000000000003','viewer@test');
insert into workspaces(id,name,created_by) values ('10000000-0000-0000-0000-000000000001','test','00000000-0000-0000-0000-000000000001');
insert into workspace_members(workspace_id,user_id,role) values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member'),
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','viewer');
insert into nodes(id,name,owner_id) values ('20000000-0000-0000-0000-000000000001','MACBOOK','00000000-0000-0000-0000-000000000001');
insert into node_shares values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
insert into tasks(id,title,workspace_id) values ('30000000-0000-0000-0000-000000000001','test','10000000-0000-0000-0000-000000000001');
insert into approvals(id,task_id,node_id,action_summary,risk) values ('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','test','risky');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
insert into agent_runs(id,task_id,node_id,executor,folder_alias,prompt,lease_minutes) values ('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','codex','sandbox','test',5);
do $$ begin
 update agent_runs set stop_requested=true;
 if found then raise exception 'member stopped owner node'; end if;
 begin
  update approvals set status='approved', decided_by='00000000-0000-0000-0000-000000000001';
  raise exception 'spoof accepted';
 exception when raise_exception then if sqlerrm='spoof accepted' then raise; end if; end;
 begin
  update approvals set action_detail='{"run_id":"spoof"}', status='approved',decided_by=auth.uid();
  raise exception 'mutation accepted';
 exception when raise_exception then if sqlerrm='mutation accepted' then raise; end if; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
do $$ begin
 begin
  update agent_runs set prompt='changed'; raise exception 'prompt accepted';
 exception when raise_exception then if sqlerrm='prompt accepted' then raise; end if; end;
 update agent_runs set stop_requested=true;
 if not found then raise exception 'owner could not stop'; end if;
 begin
  update agent_runs set stop_requested=false; raise exception 'unstop accepted';
 exception when raise_exception then if sqlerrm='unstop accepted' then raise; end if; end;
 update approvals set status='approved',decided_by=auth.uid(),decided_at='2000-01-01';
 if not exists(select 1 from approvals where decided_at=now()) then raise exception 'timestamp not stamped'; end if;
 begin
  update approvals set status='denied',decided_by=auth.uid();raise exception 'redecision accepted';
 exception when raise_exception then if sqlerrm='redecision accepted' then raise; end if; end;
 delete from agent_runs;
 if found then raise exception 'delete accepted'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
do $$ begin
 if (select count(*) from agent_runs)<>1 then raise exception 'viewer cannot read'; end if;
 begin
 insert into agent_runs(id,task_id,node_id,executor,folder_alias,prompt,lease_minutes) values ('40000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','codex','sandbox','test',5);
 raise exception 'viewer inserted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set local request.jwt.claim.role = 'service_role';
update agent_runs set status='done';
update approvals set status='pending',expires_at=now()-interval '1 second';
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
do $$ begin
 begin
 update approvals set status='approved',decided_by=auth.uid();raise exception 'expired accepted';
 exception when raise_exception then if sqlerrm='expired accepted' then raise; end if; end;
end $$;
rollback;
