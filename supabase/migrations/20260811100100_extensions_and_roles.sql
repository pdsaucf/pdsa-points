-- ===========================================================================
-- 01. EXTENSIONS AND ROLES
-- ===========================================================================
--
-- Extensions used by the schema:
--   pgcrypto  gen_random_bytes(), for check-in tokens
--   citext    case-insensitive email and NID columns
--   pg_trgm   fuzzy roster search and the possible_duplicate_person flag
--
-- These are created without an explicit schema, so they land in the first
-- writable schema on the search_path (public on a stock database). A Supabase
-- project may already have them installed in the `extensions` schema, in which
-- case `if not exists` makes this a no-op and the objects stay where they are.
--
-- That is why every SECURITY DEFINER function in this project pins
--   set search_path = public, extensions, pg_temp
-- rather than just `public`. Postgres silently ignores schemas in a
-- search_path that do not exist, so the same pin is correct on both a stock
-- database and a Supabase one.
-- ===========================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- Supabase creates these three roles for you. They are declared here so the
-- schema also applies to a plain Postgres database (which is how the test
-- suite runs it) without the policies below failing on an unknown grantee.
--
-- Note the split between database roles and application roles. There are only
-- ever three database roles. Every signed-in human is `authenticated`; whether
-- they are an admin, an officer, a viewer or a member is `profiles.role`, read
-- through the SECURITY DEFINER helpers in migration 09.
-- ---------------------------------------------------------------------------

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

grant usage on schema public to anon, authenticated, service_role;

-- Nothing in this project should ever be reachable because Postgres handed it
-- out by default. Table and function privileges are granted one at a time in
-- migration 11, after the policies that constrain them exist.
alter default privileges in schema public revoke execute on functions from public;
