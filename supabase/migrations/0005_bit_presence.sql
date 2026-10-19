-- One ephemeral presence row, written only by the brain service role.
create table public.bit_presence (
  id text primary key check (id = 'ozzy'),
  owner_id uuid not null references auth.users(id),
  presence jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.bit_presence enable row level security;
revoke all on public.bit_presence from anon, authenticated;
grant select on public.bit_presence to authenticated;
grant all on public.bit_presence to service_role;
create policy "Owner reads bIT presence" on public.bit_presence for select to authenticated using (owner_id = auth.uid());
alter publication supabase_realtime add table public.bit_presence;
