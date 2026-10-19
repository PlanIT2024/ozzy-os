-- Read-only verification AFTER the owner manually applies 0009.
select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('access_requests','access_grants');
select tablename,policyname,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('access_requests','access_grants','approvals') order by tablename,policyname;
select tgrelid::regclass,tgname,tgenabled,pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and tgname in ('access_requests_guard','access_grants_guard','approvals_guard','nodes_remote_policy_guard','nodes_remote_policy_insert_guard');
select pg_get_functiondef('public.guard_access_decision()'::regprocedure);
select pg_get_functiondef('public.guard_approval_decision()'::regprocedure);
-- Expected request UPDATE columns: status, decided_by, granted_minutes only.
select column_name,has_column_privilege('authenticated','public.access_requests',column_name,'UPDATE') as can_update from information_schema.columns where table_schema='public' and table_name='access_requests' order by ordinal_position;
-- Expected grant UPDATE: stop_requested only. No client INSERT/DELETE.
select has_table_privilege('authenticated','public.access_grants','INSERT') as can_insert_grants,has_table_privilege('authenticated','public.access_grants','DELETE') as can_delete_grants;
select column_name,has_column_privilege('authenticated','public.access_grants',column_name,'UPDATE') as can_update from information_schema.columns where table_schema='public' and table_name='access_grants' order by ordinal_position;
select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('access_requests','access_grants');
-- Local policy mirrors are advisory for UI/SQL. The node enforces its own file.
select name,capabilities,metadata->'remote_grants' as remote_policy from public.nodes;
select id,node_id,conversation_id,kind,status,granted_minutes,decided_by,decided_at from public.access_requests order by requested_at desc limit 20;
select id,node_id,conversation_id,kind,status,expires_at,stop_requested,end_reason from public.access_grants order by issued_at desc limit 20;
