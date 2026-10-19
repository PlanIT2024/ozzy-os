begin;

alter table public.agent_runs add column if not exists started_at timestamptz;
drop policy if exists runs_insert on public.agent_runs;
create policy runs_insert on public.agent_runs for insert to authenticated with check (
 requested_by = auth.uid() and status = 'requested' and not stop_requested
 and branch is null and summary is null and started_at is null and can_see_node(node_id)
 and exists(select 1 from tasks t where t.id = task_id and has_ws_role(t.workspace_id,'member'))
);
-- guard_agent_run_update compares the complete row, so started_at remains
-- brain-only on update without weakening the existing stop-only guard.

create table if not exists public.conversations (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 title text not null default 'New chat' check(char_length(title) between 1 and 200),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id, workspace_id, owner_id)
);
create table if not exists public.chat_messages (
 id uuid primary key default gen_random_uuid(),
 conversation_id uuid not null,
 workspace_id uuid not null,
 owner_id uuid not null,
 author text not null check(author in ('owner','bit')),
 body text not null default '',
 cards jsonb,
 status text not null default 'pending' check(status in ('pending','streaming','done','error')),
 created_at timestamptz not null default now(),
 foreign key(conversation_id, workspace_id, owner_id)
  references public.conversations(id, workspace_id, owner_id) on delete cascade
);
create index if not exists conversations_recent on public.conversations(owner_id, workspace_id, updated_at desc);
create index if not exists chat_messages_conversation on public.chat_messages(conversation_id, created_at, id);
create index if not exists chat_messages_owner_recent on public.chat_messages(owner_id, created_at) where author='owner';
drop trigger if exists conversations_updated on public.conversations;
create trigger conversations_updated before update on public.conversations for each row execute function public.set_updated_at();
alter table public.conversations enable row level security;
alter table public.chat_messages enable row level security;
do $$ declare p record; begin
 for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in ('conversations','chat_messages') loop
  execute format('drop policy %I on public.%I',p.policyname,p.tablename);
 end loop;
end $$;
revoke all on public.conversations, public.chat_messages from public, anon, authenticated;
grant select, insert on public.conversations, public.chat_messages to authenticated;
grant update(title) on public.conversations to authenticated;
grant all on public.conversations, public.chat_messages to service_role;
create policy chat_conversations_read on public.conversations for select to authenticated
 using(owner_id=(select auth.uid()) and has_ws_role(workspace_id,'viewer'));
create policy chat_conversations_insert on public.conversations for insert to authenticated
 with check(owner_id=(select auth.uid()) and has_ws_role(workspace_id,'viewer'));
create policy chat_conversations_title on public.conversations for update to authenticated
 using(owner_id=(select auth.uid()) and has_ws_role(workspace_id,'viewer'))
 with check(owner_id=(select auth.uid()) and has_ws_role(workspace_id,'viewer'));
create policy chat_messages_read on public.chat_messages for select to authenticated
 using(owner_id=(select auth.uid()) and has_ws_role(workspace_id,'viewer'));
create policy chat_messages_insert on public.chat_messages for insert to authenticated with check (
 owner_id=(select auth.uid()) and author='owner' and cards is null and status='pending'
 and char_length(body) between 1 and 8000 and has_ws_role(workspace_id,'viewer')
 and exists(select 1 from public.conversations c where c.id=conversation_id and c.workspace_id=chat_messages.workspace_id and c.owner_id=(select auth.uid()))
);
-- A task mutation and its audit event commit together. Service-only entry;
-- the model only receives the three narrow task tools, never arbitrary SQL/RPC.
create or replace function public.chat_apply_task(
 p_owner uuid, p_workspace uuid, p_conversation uuid, p_task uuid,
 p_fields jsonb, p_create boolean, p_expected timestamptz default null
) returns setof public.tasks language plpgsql set search_path=public as $$
declare old_task public.tasks; new_task public.tasks; before_fields jsonb := '{}';
begin
 if not exists(select 1 from workspace_members where workspace_id=p_workspace and user_id=p_owner and role in ('owner','admin','member'))
 or not exists(select 1 from conversations where id=p_conversation and workspace_id=p_workspace and owner_id=p_owner) then raise exception 'Workspace permission denied'; end if;
 if jsonb_typeof(p_fields)<>'object' or p_fields='{}'::jsonb or exists(select 1 from jsonb_object_keys(p_fields) k where k not in ('title','description','status','project_id','due_date','node_id')) then raise exception 'Invalid task fields'; end if;
 if p_fields->>'project_id' is not null and not exists(select 1 from projects where id=(p_fields->>'project_id')::uuid and workspace_id=p_workspace) then raise exception 'Foreign project'; end if;
 if p_fields->>'node_id' is not null and not exists(select 1 from nodes n where n.id=(p_fields->>'node_id')::uuid and (n.owner_id=p_owner or exists(select 1 from node_shares s where s.node_id=n.id and s.workspace_id=p_workspace))) then raise exception 'Foreign node'; end if;
 if p_create then
  insert into tasks(id,workspace_id,title,description,status,source,created_by,project_id,due_date,node_id)
  values(p_task,p_workspace,p_fields->>'title',p_fields->>'description','inbox','bit',p_owner,(p_fields->>'project_id')::uuid,(p_fields->>'due_date')::date,(p_fields->>'node_id')::uuid) returning * into new_task;
 else
  select * into old_task from tasks where id=p_task and workspace_id=p_workspace and updated_at=p_expected for update;
  if not found then raise exception 'Task changed or unavailable'; end if;
  select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) into before_fields from jsonb_each(to_jsonb(old_task)) e where p_fields ? e.key;
  new_task := jsonb_populate_record(old_task,p_fields);
  update tasks set title=new_task.title,description=new_task.description,status=new_task.status,project_id=new_task.project_id,due_date=new_task.due_date,node_id=new_task.node_id
  where id=p_task and workspace_id=p_workspace returning * into new_task;
 end if;
 insert into task_events(client_event_id,task_id,kind,summary,payload)
 values(gen_random_uuid(),p_task,'chat',case when p_create then 'Task created by bIT chat' else 'Task updated by bIT chat' end,
 jsonb_build_object('conversation_id',p_conversation,'owner_id',p_owner,'source','bit_chat','before',before_fields,'changed',p_fields));
 return next new_task;
end $$;
revoke all on function public.chat_apply_task(uuid,uuid,uuid,uuid,jsonb,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.chat_apply_task(uuid,uuid,uuid,uuid,jsonb,boolean,timestamptz) to service_role;

do $$ begin
 if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='conversations') then alter publication supabase_realtime add table public.conversations; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages') then alter publication supabase_realtime add table public.chat_messages; end if;
end $$;
notify pgrst, 'reload schema';
commit;
