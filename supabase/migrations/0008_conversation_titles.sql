begin;

-- Run the legacy-title backfill only when the column is first introduced.
-- Replaying this migration must not turn automatic titles into owner titles.
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='conversations' and column_name='title_set_by_owner') then
  alter table public.conversations add column title_set_by_owner boolean not null default false;
  -- Legacy owner renames and client-generated titles are indistinguishable.
  -- Conservatively preserve every existing non-default name.
  update public.conversations set title_set_by_owner=true where title<>'New chat';
 end if;
end $$;

revoke update on public.conversations from authenticated;
grant update(title,title_set_by_owner) on public.conversations to authenticated;

create or replace function public.guard_conversation_update()
returns trigger language plpgsql set search_path=public as $$
begin
 if auth.role()='authenticated' then
  -- Compare the entire row so new columns are protected by default too.
  -- This guard runs before conversations_updated sets the server timestamp.
  if (to_jsonb(new)-array['title','title_set_by_owner']) is distinct from
     (to_jsonb(old)-array['title','title_set_by_owner']) then
   raise exception 'Clients may update only conversation title and title_set_by_owner' using errcode='42501';
  end if;
  if not new.title_set_by_owner or (char_length(new.title) not between 1 and 80 or btrim(new.title)='') then
   raise exception 'Owner titles require title_set_by_owner=true and 1–80 characters' using errcode='23514';
  end if;
 else
  if old.title_set_by_owner and (new.title is distinct from old.title or not new.title_set_by_owner) then
   raise exception 'Owner conversation title is locked' using errcode='42501';
  end if;
  if new.title is distinct from old.title and not new.title_set_by_owner and (char_length(new.title) not between 1 and 40 or btrim(new.title)='') then
   raise exception 'Automatic titles must be 1–40 characters' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists a_guard_conversation_update on public.conversations;
create trigger a_guard_conversation_update before update on public.conversations
 for each row execute function public.guard_conversation_update();

notify pgrst, 'reload schema';
commit;
