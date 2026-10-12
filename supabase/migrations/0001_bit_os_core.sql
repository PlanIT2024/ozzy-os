-- =============================================================
-- bIT OS — core schema (migration 0001)
-- Target: Supabase (Postgres 15+). Run in the SQL editor or as
-- supabase/migrations/0001_bit_os_core.sql
--
-- Covers: accounts, workspaces + roles, projects, goals, tasks
-- (incl. Inbox), nodes (machines/devices), leases, approvals,
-- action log, spending. Phase 1 uses the first half; the lease,
-- approval and event tables are here now so the model stays stable.
--
-- Trust model:
--   * Apps and agents sign in as a real user (anon key + login).
--   * bIT Core on OZZY-AI uses the service_role key, which bypasses
--     RLS. That key never ships inside the desktop agent.
--   * approvals and task_events have no INSERT policy on purpose:
--     only bIT Core writes them.
-- =============================================================

-- ---------- Enums ----------
create type workspace_role  as enum ('owner', 'admin', 'member', 'viewer');
create type node_kind       as enum ('computer', 'phone', 'printer', 'camera', 'smart_home', 'shop_tool');
create type node_status     as enum ('online', 'offline', 'sleeping');
create type task_status     as enum ('inbox', 'planned', 'running', 'waiting_on_you', 'done', 'cancelled');
create type task_source     as enum ('typed', 'voice', 'pulled', 'bit');
create type autonomy_mode   as enum ('supervised', 'autonomous');
create type lease_level     as enum ('watch', 'control');
create type approval_status as enum ('pending', 'approved', 'denied', 'expired');
create type risk_class      as enum ('risky', 'destructive', 'production', 'spend', 'message_as_user', 'physical');

-- ---------- Shared trigger: updated_at ----------
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- Profiles (1:1 with auth.users) ----------
create table profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- Workspaces + membership ----------
create table workspaces (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  monthly_ai_cap_cents integer not null default 2000 check (monthly_ai_cap_cents >= 0),
  created_by           uuid not null default auth.uid() references profiles,
  created_at           timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces on delete cascade,
  user_id      uuid not null references profiles on delete cascade,
  role         workspace_role not null default 'member',
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Creator becomes owner automatically.
create function add_creator_as_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end $$;

create trigger on_workspace_created
  after insert on workspaces
  for each row execute function add_creator_as_owner();

-- Role helpers (security definer avoids RLS recursion on workspace_members).
create function role_rank(r workspace_role) returns int
language sql immutable as $$
  select case r when 'owner' then 4 when 'admin' then 3 when 'member' then 2 else 1 end
$$;

create function has_ws_role(ws uuid, min_role workspace_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and role_rank(m.role) >= role_rank(min_role)
  )
$$;

-- ---------- Projects + goals ----------
create table projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name         text not null,
  description  text,
  status       text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_by   uuid default auth.uid() references profiles on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on projects (workspace_id);
create trigger projects_updated before update on projects
  for each row execute function set_updated_at();

-- A goal with no target_date is a "dream": visible, but not on this week's plate.
create table goals (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects on delete cascade,
  title       text not null,
  description text,
  target_date date,
  status      text not null default 'open' check (status in ('open', 'achieved', 'dropped')),
  created_at  timestamptz not null default now()
);
create index on goals (project_id);

-- ---------- Nodes (machines and devices) ----------
-- Nodes belong to a person, and are shared into workspaces.
create table nodes (
  id                       uuid primary key default gen_random_uuid(),
  owner_id                 uuid not null default auth.uid() references profiles on delete cascade,
  name                     text not null,                 -- e.g. 'OZZY-AI', 'OptiPlex', 'MacBook', 'Windows PC'
  kind                     node_kind not null default 'computer',
  os                       text,                          -- 'linux' | 'macos' | 'windows' | 'ios' | null
  capabilities             text[] not null default '{}',  -- e.g. {screen,input,shell,files,local_ai}
  remote_grantable         boolean not null default false,
  max_remote_lease_minutes integer not null default 60 check (max_remote_lease_minutes between 1 and 240),
  status                   node_status not null default 'offline',
  last_seen_at             timestamptz,
  agent_version            text,
  wake_via_node_id         uuid references nodes on delete set null, -- Windows PC -> woken by OptiPlex
  metadata                 jsonb not null default '{}',   -- e.g. {"mac_address": "..."} for Wake-on-LAN
  created_at               timestamptz not null default now(),
  unique (owner_id, name)
);

create table node_shares (
  node_id      uuid not null references nodes on delete cascade,
  workspace_id uuid not null references workspaces on delete cascade,
  primary key (node_id, workspace_id)
);

create function can_see_node(n uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from nodes where id = n and owner_id = auth.uid())
      or exists (select 1 from node_shares s where s.node_id = n and has_ws_role(s.workspace_id, 'viewer'))
$$;

-- ---------- Tasks (Inbox items are tasks with status 'inbox') ----------
create table tasks (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces on delete cascade,
  project_id       uuid references projects on delete set null,  -- null while in the Inbox
  goal_id          uuid references goals on delete set null,
  title            text not null,
  description      text,
  status           task_status not null default 'inbox',
  source           task_source not null default 'typed',
  assignee_user_id uuid references profiles on delete set null,
  assigned_to_bit  boolean not null default false,
  node_id          uuid references nodes on delete set null,
  autonomy         autonomy_mode not null default 'supervised',
  lease_minutes    integer check (lease_minutes between 1 and 240),
  due_date         date,
  cost_cents       numeric(12, 4) not null default 0,
  created_by       uuid default auth.uid() references profiles on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on tasks (workspace_id, status);
create index on tasks (node_id) where node_id is not null;
create trigger tasks_updated before update on tasks
  for each row execute function set_updated_at();

-- ---------- Leases (timed permission for bIT on a node) ----------
-- The agent on the machine enforces expiry on its own; this table is
-- the record and the source the agent syncs from.
create table leases (
  id             uuid primary key default gen_random_uuid(),
  node_id        uuid not null references nodes on delete cascade,
  task_id        uuid references tasks on delete set null,
  level          lease_level not null,
  granted_by     uuid not null default auth.uid() references profiles,
  remote         boolean not null default false,
  starts_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text,          -- 'panic_key' | 'user' | 'expired' | 'task_done' ...
  check (expires_at > starts_at and expires_at <= starts_at + interval '4 hours')
);
create index on leases (node_id, expires_at);

create function enforce_one_active_lease() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from leases l
    where l.node_id = new.node_id and l.revoked_at is null and l.expires_at > now()
  ) then
    raise exception 'Node % already has an active lease', new.node_id;
  end if;
  return new;
end $$;

create trigger leases_one_active before insert on leases
  for each row execute function enforce_one_active_lease();

-- ---------- Approvals (the gate carried over from agent-ops-bot) ----------
create table approvals (
  id                         uuid primary key default gen_random_uuid(),
  task_id                    uuid not null references tasks on delete cascade,
  node_id                    uuid references nodes on delete set null,
  action_summary             text not null,            -- what bIT wants to do, in plain words
  action_detail              jsonb not null default '{}',
  risk                       risk_class not null,
  requires_physical_presence boolean not null default false, -- CNC / laser starts
  status                     approval_status not null default 'pending',
  requested_at               timestamptz not null default now(),
  expires_at                 timestamptz not null default now() + interval '30 minutes',
  decided_by                 uuid references profiles,
  decided_at                 timestamptz
);
create index on approvals (task_id);
create index on approvals (status) where status = 'pending';

-- ---------- Action log ----------
create table task_events (
  id              bigint generated always as identity primary key,
  task_id         uuid references tasks on delete cascade,
  node_id         uuid references nodes on delete set null,
  lease_id        uuid references leases on delete set null,
  kind            text not null,   -- 'shell' | 'input' | 'screenshot' | 'model_call' | 'status' | 'note'
  summary         text,
  payload         jsonb not null default '{}',
  screenshot_path text,            -- path in the private 'screenshots' storage bucket
  model           text,
  cost_cents      numeric(12, 4) not null default 0,
  created_at      timestamptz not null default now()
);
create index on task_events (task_id, created_at);

-- Spend per workspace per month, checked by Core against monthly_ai_cap_cents.
create view workspace_monthly_spend with (security_invoker = true) as
select t.workspace_id,
       date_trunc('month', e.created_at) as month,
       sum(e.cost_cents)                 as cost_cents
from task_events e
join tasks t on t.id = e.task_id
group by 1, 2;

-- =============================================================
-- Row Level Security
-- =============================================================
alter table profiles          enable row level security;
alter table workspaces        enable row level security;
alter table workspace_members enable row level security;
alter table projects          enable row level security;
alter table goals             enable row level security;
alter table nodes             enable row level security;
alter table node_shares       enable row level security;
alter table tasks             enable row level security;
alter table leases            enable row level security;
alter table approvals         enable row level security;
alter table task_events       enable row level security;

-- Profiles: yourself, plus people you share a workspace with.
create policy profiles_select on profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from workspace_members a
    join workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = profiles.id
  )
);
create policy profiles_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Workspaces
create policy ws_select on workspaces for select to authenticated
  using (created_by = auth.uid() or has_ws_role(id, 'viewer'));
create policy ws_insert on workspaces for insert to authenticated
  with check (created_by = auth.uid());
create policy ws_update on workspaces for update to authenticated
  using (has_ws_role(id, 'admin'));
create policy ws_delete on workspaces for delete to authenticated
  using (has_ws_role(id, 'owner'));

-- Members
create policy wm_select on workspace_members for select to authenticated
  using (has_ws_role(workspace_id, 'viewer'));
create policy wm_insert on workspace_members for insert to authenticated
  with check (has_ws_role(workspace_id, 'admin') and role <> 'owner');
create policy wm_update on workspace_members for update to authenticated
  using (has_ws_role(workspace_id, 'admin')) with check (role <> 'owner' or has_ws_role(workspace_id, 'owner'));
create policy wm_delete on workspace_members for delete to authenticated
  using (has_ws_role(workspace_id, 'admin') or user_id = auth.uid());

-- Projects
create policy proj_select on projects for select to authenticated
  using (has_ws_role(workspace_id, 'viewer'));
create policy proj_write on projects for all to authenticated
  using (has_ws_role(workspace_id, 'member')) with check (has_ws_role(workspace_id, 'member'));

-- Goals (through their project)
create policy goals_select on goals for select to authenticated using (
  exists (select 1 from projects p where p.id = project_id and has_ws_role(p.workspace_id, 'viewer'))
);
create policy goals_write on goals for all to authenticated
  using (exists (select 1 from projects p where p.id = project_id and has_ws_role(p.workspace_id, 'member')))
  with check (exists (select 1 from projects p where p.id = project_id and has_ws_role(p.workspace_id, 'member')));

-- Nodes: owner manages; workspace members see shared ones.
create policy nodes_select on nodes for select to authenticated
  using (owner_id = auth.uid() or can_see_node(id));
create policy nodes_insert on nodes for insert to authenticated with check (owner_id = auth.uid());
create policy nodes_update on nodes for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy nodes_delete on nodes for delete to authenticated using (owner_id = auth.uid());

-- Node shares: owner shares into workspaces they belong to.
create policy shares_select on node_shares for select to authenticated using (
  has_ws_role(workspace_id, 'viewer')
  or exists (select 1 from nodes n where n.id = node_id and n.owner_id = auth.uid())
);
create policy shares_insert on node_shares for insert to authenticated with check (
  has_ws_role(workspace_id, 'member')
  and exists (select 1 from nodes n where n.id = node_id and n.owner_id = auth.uid())
);
create policy shares_delete on node_shares for delete to authenticated using (
  exists (select 1 from nodes n where n.id = node_id and n.owner_id = auth.uid())
  or has_ws_role(workspace_id, 'admin')
);

-- Tasks
create policy tasks_select on tasks for select to authenticated
  using (has_ws_role(workspace_id, 'viewer'));
create policy tasks_insert on tasks for insert to authenticated
  with check (has_ws_role(workspace_id, 'member'));
create policy tasks_update on tasks for update to authenticated
  using (has_ws_role(workspace_id, 'member')) with check (has_ws_role(workspace_id, 'member'));
create policy tasks_delete on tasks for delete to authenticated
  using (has_ws_role(workspace_id, 'admin') or created_by = auth.uid());

-- Leases: only the node's owner grants. Remote grants need the node to be
-- remote_grantable and within its max remote length.
create policy leases_select on leases for select to authenticated using (can_see_node(node_id));
create policy leases_insert on leases for insert to authenticated with check (
  granted_by = auth.uid()
  and exists (
    select 1 from nodes n
    where n.id = node_id
      and n.owner_id = auth.uid()
      and (not remote or (n.remote_grantable
           and expires_at <= starts_at + make_interval(mins => n.max_remote_lease_minutes)))
  )
);
-- Revoking (setting revoked_at) is open to the owner; the panic key on the
-- machine revokes locally first, then syncs here.
create policy leases_update on leases for update to authenticated
  using (exists (select 1 from nodes n where n.id = node_id and n.owner_id = auth.uid()));

-- Approvals: visible to the task's workspace; decided by members.
create policy approvals_select on approvals for select to authenticated using (
  exists (select 1 from tasks t where t.id = task_id and has_ws_role(t.workspace_id, 'viewer'))
);
create policy approvals_decide on approvals for update to authenticated
  using (exists (select 1 from tasks t where t.id = task_id and has_ws_role(t.workspace_id, 'member')))
  with check (decided_by = auth.uid());

-- Action log: read-only for people.
create policy events_select on task_events for select to authenticated using (
  exists (select 1 from tasks t where t.id = task_id and has_ws_role(t.workspace_id, 'viewer'))
);

-- =============================================================
-- Realtime: the dashboard subscribes to these.
-- =============================================================
alter publication supabase_realtime add table nodes, tasks, leases, approvals, task_events;

-- =============================================================
-- Storage: private bucket for screenshots (Core uploads with service_role).
-- =============================================================
insert into storage.buckets (id, name, public) values ('screenshots', 'screenshots', false)
on conflict (id) do nothing;
