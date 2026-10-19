begin;

-- Local policy is mirrored only by the authenticated brain. A client may never
-- forge the policy snapshot used by the database decision guard.
create or replace function public.guard_node_remote_policy() returns trigger language plpgsql as $$
begin
 if coalesce(auth.role(),'')<>'service_role' and
 (new.metadata->'remote_grants') is distinct from (old.metadata->'remote_grants') then
  raise exception 'Remote grant policy is machine-local' using errcode='42501';
 end if;
 return new;
end $$;
drop trigger if exists nodes_remote_policy_guard on public.nodes;
create trigger nodes_remote_policy_guard before update on public.nodes for each row execute function public.guard_node_remote_policy();
-- INSERT cannot bootstrap a forged machine policy either.
create or replace function public.guard_node_remote_policy_insert() returns trigger language plpgsql as $$
begin
 if coalesce(auth.role(),'')<>'service_role' and new.metadata ? 'remote_grants' then raise exception 'Remote grant policy is machine-local' using errcode='42501';end if;
 return new;
end $$;
drop trigger if exists nodes_remote_policy_insert_guard on public.nodes;
create trigger nodes_remote_policy_insert_guard before insert on public.nodes for each row execute function public.guard_node_remote_policy_insert();

create table if not exists public.access_requests (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 conversation_id uuid not null,
 owner_id uuid not null references auth.users(id),
 node_id uuid not null references public.nodes(id),
 kind text not null check(kind in ('screen','control','input')),
 reason text not null check(char_length(reason) between 1 and 4000),
 policy_generation bigint not null default 0 check(policy_generation>=0),
 requested_minutes integer not null check(requested_minutes between 1 and 15),
 -- Only the brain creates input-step requests; exact proposed input is immutable.
 action_detail jsonb not null default '{}',
 status text not null default 'pending' check(status in ('pending','approved','denied','expired','unavailable')),
 requested_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '10 minutes',
 decided_by uuid references auth.users(id), decided_at timestamptz,
 granted_minutes integer,
 foreign key(conversation_id,workspace_id,owner_id) references public.conversations(id,workspace_id,owner_id) on delete cascade
);
create table if not exists public.access_grants (
 id uuid primary key,
 request_id uuid not null unique references public.access_requests(id),
 workspace_id uuid not null references public.workspaces(id),
 conversation_id uuid not null,
 owner_id uuid not null references auth.users(id),
 node_id uuid not null references public.nodes(id),
 kind text not null check(kind in ('screen','control')),
 status text not null check(status in ('starting','active','ended','failed')),
 issued_at timestamptz not null default now(), expires_at timestamptz not null,
 stop_requested boolean not null default false,
 ended_at timestamptz, end_reason text,
 foreign key(conversation_id,workspace_id,owner_id) references public.conversations(id,workspace_id,owner_id) on delete cascade
);
create index if not exists access_requests_pending on public.access_requests(status,expires_at);
create index if not exists access_grants_conversation on public.access_grants(conversation_id,status);
alter table public.access_requests enable row level security;
alter table public.access_grants enable row level security;
revoke all on public.access_requests,public.access_grants from public,anon,authenticated;
grant select,insert on public.access_requests to authenticated;
grant update(status,decided_by,granted_minutes) on public.access_requests to authenticated;
grant select on public.access_grants to authenticated;
grant update(stop_requested) on public.access_grants to authenticated;
grant all on public.access_requests,public.access_grants to service_role;

drop policy if exists access_requests_read on public.access_requests;
create policy access_requests_read on public.access_requests for select to authenticated using(owner_id=auth.uid() and has_ws_role(workspace_id,'viewer') and exists(select 1 from nodes n where n.id=node_id and n.owner_id=auth.uid()));
drop policy if exists access_requests_insert on public.access_requests;
create policy access_requests_insert on public.access_requests for insert to authenticated with check (
 owner_id=auth.uid() and has_ws_role(workspace_id,'viewer') and kind in ('screen','control') and status='pending'
 and decided_by is null and decided_at is null and granted_minutes is null and action_detail='{}'::jsonb
 and expires_at>now() and expires_at<=now()+interval '10 minutes'
 and exists(select 1 from nodes n where n.id=node_id and n.owner_id=auth.uid())
);
drop policy if exists access_requests_decide on public.access_requests;
create policy access_requests_decide on public.access_requests for update to authenticated using(owner_id=auth.uid() and has_ws_role(workspace_id,'viewer') and exists(select 1 from nodes n where n.id=node_id and n.owner_id=auth.uid())) with check(decided_by=auth.uid());
drop policy if exists access_grants_read on public.access_grants;
create policy access_grants_read on public.access_grants for select to authenticated using(owner_id=auth.uid() and has_ws_role(workspace_id,'viewer') and exists(select 1 from nodes n where n.id=node_id and n.owner_id=auth.uid()));
drop policy if exists access_grants_stop on public.access_grants;
create policy access_grants_stop on public.access_grants for update to authenticated using(owner_id=auth.uid() and exists(select 1 from nodes n where n.id=node_id and n.owner_id=auth.uid())) with check(owner_id=auth.uid());

create or replace function public.guard_access_decision() returns trigger language plpgsql set search_path=public as $$
declare p jsonb; lim integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then
  if old.status<>'pending' or old.expires_at<=now() or new.status not in ('approved','denied')
   or new.decided_by is distinct from auth.uid()
   or not exists(select 1 from nodes n where n.id=old.node_id and n.owner_id=auth.uid())
   or old.owner_id is distinct from auth.uid()
   or (to_jsonb(new)-array['status','decided_by','granted_minutes']) is distinct from (to_jsonb(old)-array['status','decided_by','granted_minutes']) then
   raise exception 'Only the machine owner may decide an unexpired access request' using errcode='42501';
  end if;
  if new.status='approved' then
   select metadata->'remote_grants' into p from nodes where id=old.node_id;
   if old.policy_generation<>coalesce((p->>'generation')::bigint,0) then raise exception 'Machine policy changed; request access again' using errcode='42501';end if;
   if coalesce(p->>'screen','false')<>'true' or (old.kind in ('control','input') and coalesce(p->>'control','false')<>'true') then raise exception 'Remote access not enabled at machine' using errcode='42501';end if;
   lim:=least(old.requested_minutes,15,(p->>'screenMinutes')::integer);
   if old.kind in ('control','input') then lim:=least(lim,10,(p->>'controlMinutes')::integer);end if;
   if new.granted_minutes is null or new.granted_minutes<1 or new.granted_minutes>lim or p->>'screenMinutes' is null or (old.kind in ('control','input') and p->>'controlMinutes' is null) then raise exception 'Granted duration exceeds request or machine policy' using errcode='23514';end if;
  elsif new.granted_minutes is not null then raise exception 'Denied requests have no duration' using errcode='23514';end if;
  new.decided_at:=now();
 end if;
 return new;
end $$;
drop trigger if exists access_requests_guard on public.access_requests;
create trigger access_requests_guard before update on public.access_requests for each row execute function public.guard_access_decision();
create or replace function public.guard_access_stop() returns trigger language plpgsql as $$
begin
 if coalesce(auth.role(),'')<>'service_role' and (old.stop_requested or not new.stop_requested or (to_jsonb(new)-'stop_requested') is distinct from (to_jsonb(old)-'stop_requested') or not exists(select 1 from public.nodes where id=old.node_id and owner_id=auth.uid())) then raise exception 'Only machine owner stop is allowed' using errcode='42501';end if;return new;
end $$;
drop trigger if exists access_grants_guard on public.access_grants;
create trigger access_grants_guard before update on public.access_grants for each row execute function public.guard_access_stop();

-- Close the existing workspace-member approval gap without relaxing immutability.
create or replace function public.guard_approval_decision() returns trigger language plpgsql set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then
  if old.status<>'pending' or new.status not in ('approved','denied') or old.expires_at<=now()
   or new.decided_by is distinct from auth.uid()
   or not exists(select 1 from nodes n where n.id=old.node_id and n.owner_id=new.decided_by)
   or (to_jsonb(new)-array['status','decided_by','decided_at']) is distinct from (to_jsonb(old)-array['status','decided_by','decided_at']) then
   raise exception 'Only the machine owner may decide an unexpired approval' using errcode='42501';end if;
  new.decided_at:=now();
 end if;return new;
end $$;
drop policy if exists approvals_decide on public.approvals;
create policy approvals_decide on public.approvals for update to authenticated
 using(exists(select 1 from nodes n where n.id=node_id and n.owner_id=auth.uid()) and exists(select 1 from tasks t where t.id=task_id and has_ws_role(t.workspace_id,'member')))
 with check(decided_by=auth.uid() and exists(select 1 from nodes n where n.id=node_id and n.owner_id=auth.uid()));

drop policy if exists events_select on public.task_events;
create policy events_select on public.task_events for select to authenticated using (
 exists(select 1 from tasks t where t.id=task_id and has_ws_role(t.workspace_id,'viewer'))
 or (kind='access' and exists(select 1 from conversations c where c.id::text=payload->>'conversation_id' and c.owner_id=auth.uid() and has_ws_role(c.workspace_id,'viewer')))
);

do $$ declare tbl text;begin
 foreach tbl in array array['access_requests','access_grants'] loop
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=tbl) then execute format('alter publication supabase_realtime add table public.%I',tbl);end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
