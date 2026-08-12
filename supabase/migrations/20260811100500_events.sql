-- ===========================================================================
-- 05. EVENTS
-- ===========================================================================
-- An event is defined exactly once. Categories attach through
-- event_categories. There is deliberately no category_id column on events:
-- Soap Carving is one event that counts for both Clinical Workshops and
-- Socials, and in the spreadsheet that fact was recorded by hand-copying 69
-- attendees into a second tab.
-- ===========================================================================

create type review_policy_t as enum ('auto_approve', 'manual_review');
create type credit_mode_t   as enum ('fixed', 'from_submission');
create type evidence_kind_t as enum ('shirt_photo', 'receipt_photo', 'other_photo');

-- Check-in tokens are separate from the primary key so a leaked QR image can
-- be invalidated by rotating the token, without breaking any existing row.
-- 8 random bytes is 64 bits, rendered as 16 unambiguous hex characters.
create or replace function fn_new_checkin_token()
returns text
language sql
volatile
set search_path = public, extensions, pg_temp
as $$
  select encode(gen_random_bytes(8), 'hex')
$$;

create table events (
  id                uuid primary key default gen_random_uuid(),
  academic_year_id  uuid not null references academic_years on delete restrict,
  term_id           uuid references terms on delete set null,
  title             text not null,
  occurred_on       date not null,
  location          text,
  notes             text,
  review_policy     review_policy_t not null default 'manual_review',
  checkin_token     text not null unique default fn_new_checkin_token(),
  checkin_opens_at  timestamptz,
  checkin_closes_at timestamptz,
  token_rotated_at  timestamptz,
  is_published      boolean not null default true,
  created_by        uuid references auth.users,
  created_at        timestamptz not null default now(),
  check (length(btrim(title)) > 0),
  check (checkin_opens_at is null or checkin_closes_at is null
         or checkin_closes_at > checkin_opens_at)
);

create index events_year       on events (academic_year_id, occurred_on desc);
create index events_term       on events (term_id);

create table event_categories (
  event_id     uuid not null references events     on delete cascade,
  category_id  uuid not null references categories on delete restrict,
  credit_mode  credit_mode_t not null default 'fixed',
  fixed_credit numeric(6,2)  not null default 1,
  primary key (event_id, category_id)
);

create index event_categories_category on event_categories (category_id);

-- The check-in form collects at most one number, so at most one of an events
-- category links may be the one that reads it.
create unique index one_submitted_value_per_event
  on event_categories (event_id) where credit_mode = 'from_submission';

comment on column event_categories.fixed_credit is
  'Credit awarded per approved attendance. A double-credit GBM is 2. Negative values are permitted so an officer can record a correction without deleting history.';

create table event_evidence_requirements (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events on delete cascade,
  kind        evidence_kind_t not null,
  is_required boolean not null default true,
  prompt      text,                         -- 'Photo of you in your PDSA shirt'
  unique (event_id, kind)
);
