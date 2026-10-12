create type task_executor as enum ('bit','claude_code','codex','cowork');
alter table tasks add column executor task_executor not null default 'bit';
alter table tasks add column external_ref jsonb not null default '{}';
create index on tasks ((external_ref->>'discord_thread_id'));
