-- Minimal stand-in for the parts of Supabase that the migrations depend on,
-- so RLS can be tested on a plain local Postgres. NOT deployed.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  phone text unique,
  email text,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Vault stub (plaintext — test only)
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
create function vault.create_secret(p_secret text, p_name text default null, p_description text default null)
returns uuid language sql as $$
  insert into vault.secrets (name, description, secret) values (p_name, p_description, p_secret) returning id
$$;
create function vault.update_secret(p_id uuid, p_secret text) returns void language sql as $$
  update vault.secrets set secret = p_secret where id = p_id
$$;
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;

-- Supabase's default privileges on the public schema
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
