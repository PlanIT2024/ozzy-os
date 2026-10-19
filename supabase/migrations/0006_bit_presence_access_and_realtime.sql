-- Safe to apply whether 0005 ran or the API schema cache missed its DDL.
-- Apply to the project used by both the brain and dashboard.
begin;

create table if not exists public.bit_presence (
  id text primary key check (id = 'ozzy'),
  owner_id uuid not null references auth.users(id),
  presence jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.bit_presence enable row level security;

-- Replace all policies on this dedicated table so no older permissive policy
-- can expose presence to another authenticated account or permit client writes.
do $$
declare
  existing_policy record;
begin
  for existing_policy in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'bit_presence'
  loop
    execute format('drop policy %I on public.bit_presence', existing_policy.policyname);
  end loop;
end;
$$;

revoke all on table public.bit_presence from public, anon, authenticated;
grant select on table public.bit_presence to authenticated;
grant all on table public.bit_presence to service_role;

-- Only the brain service role inserts the singleton and supplies the existing
-- BITOS_OWNER_USER_ID. Clients cannot write or change that owner binding.
create policy "Owner reads bIT presence"
  on public.bit_presence for select to authenticated
  using (id = 'ozzy' and owner_id = (select auth.uid()));

do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'bit_presence'
  ) then
    alter publication supabase_realtime add table public.bit_presence;
  end if;
end;
$$;

-- Delivered after commit so PostgREST sees the committed table and grants.
notify pgrst, 'reload schema';
commit;

-- Verification output for the SQL editor; this query does not expose presence.
select
  c.relrowsecurity as rls_enabled,
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'bit_presence'
  ) as realtime_published,
  has_table_privilege('authenticated', 'public.bit_presence', 'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated', 'public.bit_presence', 'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated', 'public.bit_presence', 'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated', 'public.bit_presence', 'DELETE') as authenticated_can_delete,
  has_table_privilege('anon', 'public.bit_presence', 'SELECT') as anonymous_can_select,
  has_table_privilege('service_role', 'public.bit_presence', 'INSERT') as brain_can_insert,
  has_table_privilege('service_role', 'public.bit_presence', 'UPDATE') as brain_can_update
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'bit_presence';

select policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'bit_presence';
