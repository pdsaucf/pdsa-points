-- ===========================================================================
-- 06. ATTENDANCE
-- ===========================================================================
-- One table with a status, not a submissions queue plus an attendance ledger.
-- Un-approving is then symmetric with approving, a rejection keeps its reason,
-- and an officer-entered row has exactly the same shape as a scanned one.
-- `source` is what tells them apart.
-- ===========================================================================

create type attendance_status_t as enum ('pending', 'approved', 'rejected');
create type attendance_source_t as enum
  ('self_checkin', 'officer_entry', 'import', 'member_request');

create table attendance_records (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events  on delete restrict,
  member_id       uuid references members on delete restrict,   -- null until matched
  claimed_name    text,          -- what they typed when they could not find themselves
  claimed_email   citext,
  status          attendance_status_t not null default 'pending',
  source          attendance_source_t not null default 'self_checkin',
  submitted_value numeric(6,2),  -- hours or points when credit_mode = 'from_submission'
  flags           text[] not null default '{}',
  submitted_at    timestamptz not null default now(),
  reviewed_by     uuid references auth.users,
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz not null default now(),

  -- Either we know who this is, or we know what they typed. Never neither.
  check (member_id is not null or claimed_name is not null),

  -- An unmatched row can be rejected, but it can never be approved. This is
  -- what forces resolve_unmatched() to happen before any credit exists.
  check (status <> 'approved' or member_id is not null),

  -- The triage vocabulary. A typo here would silently break the review queues
  -- flagged/routine split, which is the one thing that makes it usable.
  check (flags <@ array[
    'unmatched_name',
    'possible_duplicate_person',
    'duplicate_photo',
    'missing_evidence',
    'outside_window',
    'not_enrolled',
    'previously_rejected',
    'member_requested'
  ]::text[])
);

-- Stops a double check-in, while still allowing a fresh submission after a
-- rejection. `rejected` rows are deliberately outside the index.
create unique index one_live_record_per_member_event
  on attendance_records (event_id, member_id)
  where member_id is not null and status <> 'rejected';

create index attendance_member  on attendance_records (member_id);
create index attendance_event   on attendance_records (event_id);
create index attendance_pending on attendance_records (submitted_at desc) where status = 'pending';
create index attendance_flagged on attendance_records using gin (flags);

create table attendance_evidence (
  id                   uuid primary key default gen_random_uuid(),
  attendance_record_id uuid not null references attendance_records on delete cascade,
  kind                 evidence_kind_t not null,
  provider             text not null default 'supabase',   -- 'supabase' | 'gdrive'
  object_path          text,        -- storage key inside the bucket
  drive_file_id        text,        -- populated only if the archival path is built
  content_type         text,
  byte_size            int,
  sha256               text,
  uploaded_at          timestamptz not null default now(),
  archived_at          timestamptz,
  purged_at            timestamptz,
  check (provider in ('supabase', 'gdrive'))
);

create index evidence_sha256 on attendance_evidence (sha256);
create index evidence_record on attendance_evidence (attendance_record_id);

comment on column attendance_evidence.provider is
  'Storage location is a row value, not a code assumption. Adding the Google Drive archival path later needs no migration of existing rows and no reader changes.';
comment on column attendance_evidence.sha256 is
  'Hash of the compressed upload. Cheaply catches one photo submitted against two different events.';
