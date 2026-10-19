-- Disposable local database only. No hosted database writes.
begin;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000081','titles-owner@test'),('00000000-0000-0000-0000-000000000082','titles-other@test');
insert into workspaces(id,name,created_by) values ('10000000-0000-0000-0000-000000000081','titles','00000000-0000-0000-0000-000000000081');
insert into workspace_members(workspace_id,user_id,role) values ('10000000-0000-0000-0000-000000000081','00000000-0000-0000-0000-000000000082','member');
insert into conversations(id,workspace_id,owner_id) values ('60000000-0000-0000-0000-000000000081','10000000-0000-0000-0000-000000000081','00000000-0000-0000-0000-000000000081');
grant usage on schema public,auth to authenticated,service_role;
set local role service_role;
set local request.jwt.claim.role='service_role';
update conversations set title=repeat('a',40) where id='60000000-0000-0000-0000-000000000081' and not title_set_by_owner;
do $$ begin
 if not exists(select 1 from conversations where id='60000000-0000-0000-0000-000000000081' and title=repeat('a',40) and not title_set_by_owner) then raise exception 'Auto title failed';end if;
 begin update conversations set title=repeat('a',41) where id='60000000-0000-0000-0000-000000000081';raise exception 'long auto title accepted';exception when check_violation then null;end;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000081';
update conversations set title=repeat('b',80),title_set_by_owner=true where id='60000000-0000-0000-0000-000000000081';
do $$ begin
 if not exists(select 1 from conversations where title=repeat('b',80) and title_set_by_owner) then raise exception 'Owner rename failed';end if;
 begin update conversations set title=repeat('b',81),title_set_by_owner=true;raise exception 'long owner title accepted';exception when check_violation then null;end;
 begin update conversations set title=repeat(' ',80)||'x',title_set_by_owner=true;raise exception 'padded long title accepted';exception when check_violation then null;end;
 begin update conversations set title=' ',title_set_by_owner=true;raise exception 'empty title accepted';exception when check_violation then null;end;
 begin update conversations set title_set_by_owner=false;raise exception 'owner flag cleared';exception when check_violation then null;end;
end $$;
-- Verify the trigger, not just column grants: temporarily grant broad UPDATE.
reset role;
grant update on conversations to authenticated;
set local role authenticated;
do $$ declare col text; val text; begin
 for col,val in select * from (values
  ('id',quote_literal('60000000-0000-0000-0000-000000000099')||'::uuid'),
  ('workspace_id',quote_literal('10000000-0000-0000-0000-000000000099')||'::uuid'),
  ('owner_id',quote_literal('00000000-0000-0000-0000-000000000082')||'::uuid'),
  ('created_at',quote_literal('2000-01-01')||'::timestamptz'),
  ('updated_at',quote_literal('2000-01-01')||'::timestamptz')) v(col,val)
 loop
  begin
   execute format('update conversations set %I=%s,title=%L,title_set_by_owner=true where id=%L',col,val,'smuggled','60000000-0000-0000-0000-000000000081');
   raise exception 'forbidden column % accepted',col;
  exception when insufficient_privilege then null;
  end;
 end loop;
end $$;
-- Owner can rename again, even to the default name, without releasing the lock.
update conversations set title='New chat',title_set_by_owner=true where id='60000000-0000-0000-0000-000000000081';
set local request.jwt.claim.sub='00000000-0000-0000-0000-000000000082';
do $$ begin
 update conversations set title='stolen',title_set_by_owner=true where id='60000000-0000-0000-0000-000000000081';
 if found then raise exception 'Other owner renamed conversation';end if;
end $$;
reset role;
set local role service_role;
set local request.jwt.claim.role='service_role';
do $$ begin
 update conversations set title='Late automatic title' where id='60000000-0000-0000-0000-000000000081' and not title_set_by_owner;
 if found then raise exception 'Auto CAS overwrote owner';end if;
 begin update conversations set title='Unconditional auto title' where id='60000000-0000-0000-0000-000000000081';raise exception 'unguarded overwrite accepted';exception when insufficient_privilege then null;end;
 begin update conversations set title_set_by_owner=false where id='60000000-0000-0000-0000-000000000081';raise exception 'service cleared owner flag';exception when insufficient_privilege then null;end;
 update conversations set updated_at=now() where id='60000000-0000-0000-0000-000000000081';
 if not found then raise exception 'Brain recency update broken';end if;
end $$;
rollback;
