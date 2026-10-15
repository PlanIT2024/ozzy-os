-- User requests are data, never authorization to execute.
create table agent_runs (
 id uuid primary key,
 task_id uuid not null references tasks on delete cascade,
 node_id uuid not null references nodes,
 executor task_executor not null check (executor in ('claude_code','codex')),
 folder_alias text not null,
 prompt text not null check (char_length(prompt) between 1 and 8000),
 lease_minutes integer not null check (lease_minutes between 1 and 120),
 status text not null default 'requested' check (status in ('requested','awaiting_approval','approved','dispatched','running','done','failed','stopped','expired','denied')),
 requested_by uuid not null default auth.uid() references profiles,
 stop_requested boolean not null default false,
 branch text, summary text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index on agent_runs(task_id);
create index on agent_runs(status);
alter table agent_runs enable row level security;
create policy runs_select on agent_runs for select to authenticated using (
 exists(select 1 from tasks t where t.id = task_id and has_ws_role(t.workspace_id,'viewer'))
);
create policy runs_insert on agent_runs for insert to authenticated with check (
 requested_by = auth.uid() and status = 'requested' and not stop_requested
 and branch is null and summary is null and can_see_node(node_id)
 and exists(select 1 from tasks t where t.id = task_id and has_ws_role(t.workspace_id,'member'))
);
create policy runs_stop on agent_runs for update to authenticated using (
 exists(select 1 from nodes n where n.id = node_id and n.owner_id = auth.uid())
) with check (exists(select 1 from nodes n where n.id = node_id and n.owner_id = auth.uid()));
create function guard_agent_run_update() returns trigger language plpgsql as $$
begin
 if coalesce(auth.role(),'') <> 'service_role' then
  if old.stop_requested or not new.stop_requested
   or (to_jsonb(new) - 'stop_requested') is distinct from (to_jsonb(old) - 'stop_requested')
   or not exists(select 1 from nodes where id = old.node_id and owner_id = auth.uid()) then
   raise exception 'Only node owner stop_requested false to true is allowed';
  end if;
 end if;
 new.updated_at := now();
 return new;
end $$;
create trigger agent_runs_guard before update on agent_runs for each row execute function guard_agent_run_update();
create function guard_approval_decision() returns trigger language plpgsql as $$
begin
 if coalesce(auth.role(),'') <> 'service_role' then
  if old.status <> 'pending' or new.status not in ('approved','denied')
   or new.decided_by is distinct from auth.uid() or old.expires_at <= now()
   or (to_jsonb(new) - array['status','decided_by','decided_at']) is distinct from
      (to_jsonb(old) - array['status','decided_by','decided_at']) then
   raise exception 'Only an unexpired pending approval may be decided';
  end if;
  new.decided_at := now();
 end if;
 return new;
end $$;
create trigger approvals_guard before update on approvals for each row execute function guard_approval_decision();
alter publication supabase_realtime add table agent_runs;
