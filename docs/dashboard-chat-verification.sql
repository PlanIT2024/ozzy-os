-- Read-only verification after manually applying 0007.
select c.relname, c.relrowsecurity as rls_enabled,
 exists(select 1 from pg_publication_tables p where p.pubname='supabase_realtime' and p.schemaname='public' and p.tablename=c.relname) as realtime,
 has_table_privilege('authenticated',c.oid,'SELECT') as client_read,
 has_table_privilege('authenticated',c.oid,'INSERT') as client_insert,
 has_table_privilege('authenticated',c.oid,'UPDATE') as client_update,
 has_table_privilege('authenticated',c.oid,'DELETE') as client_delete,
 has_table_privilege('anon',c.oid,'SELECT') as anonymous_read,
 has_table_privilege('service_role',c.oid,'INSERT') as brain_insert
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('conversations','chat_messages');
select tablename,policyname,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename in ('conversations','chat_messages','agent_runs');
select column_name,data_type,is_nullable,column_default from information_schema.columns
where table_schema='public' and table_name='agent_runs' and column_name='started_at';
select pg_get_functiondef('public.guard_agent_run_update()'::regprocedure);
select has_column_privilege('authenticated','public.conversations','title','UPDATE') as can_rename,
 has_column_privilege('authenticated','public.conversations','owner_id','UPDATE') as can_change_owner;
-- Expected: both chat tables RLS/realtime/read/insert/brain_insert true;
-- client_update/delete and anonymous_read false (title-only UPDATE is separate).
-- started_at nullable YES, default NULL; runs_insert requires started_at IS NULL.
-- can_rename true, can_change_owner false.

select has_function_privilege('authenticated','public.chat_apply_task(uuid,uuid,uuid,uuid,jsonb,boolean,timestamptz)','EXECUTE') as client_task_rpc,
 has_function_privilege('service_role','public.chat_apply_task(uuid,uuid,uuid,uuid,jsonb,boolean,timestamptz)','EXECUTE') as brain_task_rpc;
-- Expected: false, true. Task writes + chat audit insert are atomic in this RPC.
