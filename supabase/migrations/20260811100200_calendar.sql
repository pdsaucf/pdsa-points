-- ===========================================================================
-- 02. CALENDAR
-- ===========================================================================
-- Academic years scope events, enrollments and requirement sets. Terms are
-- optional and exist so a rule can say "3 GBMs per semester" without any code
-- change (requirement_nodes.term_id).
-- ===========================================================================

create table academic_years (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,            -- '2026-2027'
  starts_on   date not null,
  ends_on     date not null,
  is_current  boolean not null default false,
  created_at  timestamptz not null default now(),
  check (ends_on > starts_on)
);

-- At most one current year. Postgres indexes only the rows where the
-- predicate holds, so any number of past years can coexist.
create unique index one_current_year on academic_years (is_current) where is_current;

create table terms (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years on delete cascade,
  label            text not null,              -- 'Fall 2026'
  starts_on        date not null,
  ends_on          date not null,
  sort_order       int  not null default 0,
  unique (academic_year_id, label),
  check (ends_on > starts_on)
);

create index terms_year on terms (academic_year_id);

comment on table academic_years is
  'One row per academic year. Year rollover is a new row plus a new set of member_enrollments, never a data migration.';
comment on table terms is
  'Optional subdivision of a year. Referenced by requirement_nodes.term_id to scope a threshold to one semester.';
