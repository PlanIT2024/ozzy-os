alter table task_events add column client_event_id uuid;
create unique index on task_events (client_event_id);

create or replace function enforce_one_active_lease() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from leases where id = new.id) then
    return new;
  end if;

  if exists (
    select 1 from leases l
    where l.node_id = new.node_id and l.revoked_at is null and l.expires_at > now()
  ) then
    raise exception 'Node % already has an active lease', new.node_id;
  end if;
  return new;
end $$;
