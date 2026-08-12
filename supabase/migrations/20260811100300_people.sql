-- ===========================================================================
-- 03. PEOPLE
-- ===========================================================================
-- members       the roster, independent of whether anyone has an account
-- profiles      an auth user, its application role, and its optional link to
--               a roster row
-- member_claims the flow that establishes that link (docs/04-member-ui.md)
-- ===========================================================================

create table members (
  id             uuid primary key default gen_random_uuid(),
  first_name     text not null,
  last_name      text not null,
  preferred_name text,
  email          citext unique,
  ucf_nid        citext unique,
  display_name   text generated always as
                   (coalesce(preferred_name, first_name) || ' ' || last_name) stored,
  notes          text,
  merged_into_id uuid references members on delete restrict,  -- tombstone after a merge
  created_at     timestamptz not null default now(),
  archived_at    timestamptz,
  check (merged_into_id is null or merged_into_id <> id),
  check (length(btrim(first_name)) > 0),
  check (length(btrim(last_name))  > 0)
);

create index members_name_trgm on members using gin (display_name gin_trgm_ops);
create index members_active     on members (display_name) where archived_at is null and merged_into_id is null;

-- Normalised full name, used to spot duplicates the way a human would:
-- case, punctuation and repeated whitespace do not make two people different.
create or replace function fn_normalise_name(p_name text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g')), '')
$$;

comment on function fn_normalise_name(text) is
  'Lowercases, strips punctuation and collapses whitespace. Used for duplicate detection and by scripts/import_roster.py.';

create table member_merges (
  id               uuid primary key default gen_random_uuid(),
  from_member_id   uuid not null references members on delete restrict,
  into_member_id   uuid not null references members on delete restrict,
  moved_records    int  not null,
  dropped_records  int  not null default 0,   -- per-event collisions the survivor already had
  performed_by     uuid references auth.users,
  performed_at     timestamptz not null default now(),
  check (from_member_id <> into_member_id)
);

create table member_enrollments (
  member_id        uuid not null references members        on delete cascade,
  academic_year_id uuid not null references academic_years on delete cascade,
  status           text not null default 'active',
  joined_on        date not null default current_date,
  primary key (member_id, academic_year_id),
  check (status in ('active', 'inactive', 'alumni'))
);

create index member_enrollments_year on member_enrollments (academic_year_id);

comment on table member_enrollments is
  'This years roster. Last years members keep their history in members; they simply have no row here for the new year.';

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create type app_role as enum ('admin', 'officer', 'viewer', 'member');

create table profiles (
  user_id    uuid primary key references auth.users on delete cascade,
  member_id  uuid unique references members on delete set null,
  full_name  text,
  role       app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

comment on column profiles.member_id is
  'Null until an account claim is approved. Every member-scoped policy keys on this, so an unclaimed account sees nothing.';

create table member_claims (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  member_id    uuid not null references members    on delete cascade,
  status       text not null default 'pending',
  note         text,
  requested_at timestamptz not null default now(),
  reviewed_by  uuid references auth.users,
  reviewed_at  timestamptz,
  check (status in ('pending', 'approved', 'rejected'))
);

create unique index one_live_claim_per_user   on member_claims (user_id)   where status <> 'rejected';
create unique index one_live_claim_per_member on member_claims (member_id) where status <> 'rejected';

comment on index one_live_claim_per_member is
  'Two people cannot both hold a live claim on the same roster row.';
