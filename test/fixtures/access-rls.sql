begin;
grant usage on schema public,auth to authenticated,service_role;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
grant select on task_events to authenticated;
grant select,insert,update on nodes,tasks,projects,workspaces,workspace_members,approvals to authenticated;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000001','access-owner@test'),('00000000-0000-0000-0000-000000000002','access-other@test');
insert into workspaces(id,name,created_by) values ('10000000-0000-0000-0000-000000000001','access','00000000-0000-0000-0000-000000000001');
insert into workspace_members(workspace_id,user_id,role) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member');
insert into nodes(id,name,owner_id) values ('20000000-0000-0000-0000-000000000001','OZZY-AI','00000000-0000-0000-0000-000000000001');
insert into tasks(id,title,workspace_id) values ('30000000-0000-0000-0000-000000000001','access task','10000000-0000-0000-0000-000000000001');
insert into conversations(id,workspace_id,owner_id) values ('60000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
insert into approvals(id,task_id,node_id,action_summary,risk) values ('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Existing approval','risky');
set local role service_role;
set local request.jwt.claim.role='service_role';
update nodes set metadata='{"remote_grants":{"screen":true,"control":true,"screenMinutes":5,"controlMinutes":3}}';
reset role;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
insert into access_requests(id,workspace_id,conversation_id,owner_id,node_id,kind,reason,requested_minutes,expires_at) values
 ('80000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',auth.uid(),'20000000-0000-0000-0000-000000000001','control','Open an editor',5,now()+interval '5 minutes');
do $$ begin
 begin update access_requests set status='approved',decided_by=auth.uid(),granted_minutes=4;raise exception 'policy cap bypass';exception when check_violation then null;end;
 begin update access_requests set status='approved',decided_by=auth.uid(),granted_minutes=16;raise exception 'absolute cap bypass';exception when check_violation then null;end;
 begin update access_requests set status='approved',decided_by='00000000-0000-0000-0000-000000000002',granted_minutes=1;raise exception 'decider spoof accepted';exception when insufficient_privilege then null;end;
 begin update nodes set metadata='{"remote_grants":{"screen":true,"control":true,"screenMinutes":15,"controlMinutes":10}}';raise exception 'client widened local policy';exception when insufficient_privilege then null;end;
 begin insert into access_requests(workspace_id,conversation_id,owner_id,node_id,kind,reason,requested_minutes) values ('10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',auth.uid(),'20000000-0000-0000-0000-000000000001','input','forged input',1);raise exception 'client forged step card';exception when insufficient_privilege then null;end;
end $$;
-- Second workspace member cannot decide either the new or existing card.
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000002';
do $$ begin
 update access_requests set status='approved',decided_by=auth.uid(),granted_minutes=1;if found then raise exception 'member decided grant';end if;
 update approvals set status='approved',decided_by=auth.uid();if found then raise exception 'member decided existing approval';end if;
end $$;
-- Exercise the triggers as well as RLS: temporarily broaden RLS and grants.
reset role;
create policy test_approval_broad on approvals for update to authenticated using(true) with check(true);
create policy test_access_read on access_requests for select to authenticated using(true);
create policy test_access_broad on access_requests for update to authenticated using(true) with check(true);
grant update on access_requests to authenticated;
set local role authenticated;
do $$ begin
 begin update access_requests set status='approved',decided_by=auth.uid(),granted_minutes=1;raise exception 'access owner trigger bypass';exception when insufficient_privilege then null;end;
 begin update approvals set status='approved',decided_by=auth.uid();raise exception 'existing approval owner trigger bypass';exception when insufficient_privilege then null;end;
end $$;
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
do $$ begin
 begin update access_requests set requested_minutes=10,status='approved',decided_by=auth.uid(),granted_minutes=2;raise exception 'request widened with decision';exception when insufficient_privilege then null;end;
 begin update access_requests set expires_at=now()+interval '1 day',status='approved',decided_by=auth.uid(),granted_minutes=2;raise exception 'expiry widened with decision';exception when insufficient_privilege then null;end;
 begin update access_requests set action_detail='{"skip":true}',status='approved',decided_by=auth.uid(),granted_minutes=2;raise exception 'input mutated with decision';exception when insufficient_privilege then null;end;
end $$;
update access_requests set status='approved',decided_by=auth.uid(),granted_minutes=2;
update approvals set status='approved',decided_by=auth.uid();
do $$ begin
 if not exists(select 1 from access_requests where status='approved' and decided_at is not null and granted_minutes=2) then raise exception 'owner decision failed';end if;
 begin update access_requests set status='denied',decided_by=auth.uid(),granted_minutes=null;raise exception 'approval replay accepted';exception when insufficient_privilege then null;end;
 begin insert into access_grants(id,request_id,workspace_id,conversation_id,owner_id,node_id,kind,status,expires_at) select id,id,workspace_id,conversation_id,owner_id,node_id,'control','active',now()+interval '2 minutes' from access_requests;raise exception 'client minted active grant';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role service_role;
set local request.jwt.claim.role='service_role';
insert into access_grants(id,request_id,workspace_id,conversation_id,owner_id,node_id,kind,status,expires_at) select id,id,workspace_id,conversation_id,owner_id,node_id,'control','active',now()+interval '2 minutes' from access_requests;
insert into task_events(kind,summary,payload) values ('access','grant started','{"conversation_id":"60000000-0000-0000-0000-000000000001"}');
reset role;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
update access_grants set stop_requested=true;
do $$ begin if not found then null;end if;
 if not exists(select 1 from task_events where kind='access') then raise exception 'conversation access audit hidden';end if;
 begin update access_grants set stop_requested=false;raise exception 'stop cleared';exception when insufficient_privilege then null;end;
end $$;
rollback;
