-- Read-only checks after manually applying 0008. No credentials needed here.
-- Expected: boolean, NOT NULL, default false.
select column_name,data_type,is_nullable,column_default
from information_schema.columns
where table_schema='public' and table_name='conversations' and column_name='title_set_by_owner';

-- Expected: both UPDATE triggers enabled; guard sorts before server timestamp.
select t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition
from pg_trigger t where t.tgrelid='public.conversations'::regclass and not t.tgisinternal order by t.tgname;
select pg_get_functiondef('public.guard_conversation_update()'::regprocedure);

-- Expected: UPDATE only on title and title_set_by_owner for authenticated.
select column_name,has_column_privilege('authenticated','public.conversations',column_name,'UPDATE') as client_can_update
from information_schema.columns where table_schema='public' and table_name='conversations' order by ordinal_position;

-- Expected: RLS true; owner/workspace-scoped policies from 0007 remain.
select relrowsecurity from pg_class where oid='public.conversations'::regclass;
select policyname,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename='conversations' order by policyname;
select pubname,tablename from pg_publication_tables
where pubname='supabase_realtime' and schemaname='public' and tablename='conversations';

-- Inspect titles and flags without reading private messages. Legacy names can
-- exceed the new limits; they are preserved. New auto titles must be <=40;
-- new manual names must be <=80 and have title_set_by_owner=true.
select id,title,title_set_by_owner,char_length(title) as characters,updated_at
from public.conversations order by updated_at desc limit 20;
