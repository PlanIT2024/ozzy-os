create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean);
create publication supabase_realtime;
