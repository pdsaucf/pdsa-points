-- ===========================================================================
-- TEST HARNESS ONLY. NOT A MIGRATION. NEVER APPLIED TO A REAL DATABASE.
-- ===========================================================================
-- PGlite is plain Postgres. Supabase adds a few objects that the migrations
-- legitimately depend on, so the harness supplies stand-ins for exactly those
-- and nothing more. Every stub below mirrors the real thing closely enough
-- that the migrations apply unmodified.
--
--   auth.users     the table that profiles, events.created_by, purge_runs and
--                  friends have foreign keys into
--   auth.uid()     Supabase reads the signed-in user out of the request JWT.
--                  Here it reads the same GUC name Supabase uses, which the
--                  test helper sets with set_config().
--   auth.role()    present for completeness
--   storage        the buckets and objects tables that migration 12 writes a
--                  bucket row into and creates policies on
--
-- The stub runs before the migrations, so it also creates the three database
-- roles. Migration 01 creates them too, behind the same `if not exists`
-- guard, so whichever runs first wins and the other is a no-op. They are
-- repeated here only because the storage grants at the bottom of this file
-- need the roles to already exist.
-- ===========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;

-- Supabase grants these itself. They matter: several helpers call auth.uid()
-- as the invoker rather than as the definer, so the caller needs to be able
-- to reach the auth schema. Without this, policies fail closed with
-- "permission denied for schema auth" instead of evaluating.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid()  to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
-- Column set matches the shape migration 12 relies on: buckets keyed by a
-- text id with public / file_size_limit / allowed_mime_types, and objects
-- with bucket_id and name.
-- ---------------------------------------------------------------------------

create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets,
  name       text,
  owner      uuid,
  created_at timestamptz not null default now(),
  metadata   jsonb
);

alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
