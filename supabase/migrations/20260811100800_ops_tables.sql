-- ===========================================================================
-- 08. OPERATIONS TABLES
-- ===========================================================================
-- Photo purges, application settings, the audit trail, the one-shot upload
-- grants that back create_evidence_upload(), and a coarse rate-limit counter
-- for the anonymous RPCs.
-- ===========================================================================

create table purge_runs (
  id               uuid primary key default gen_random_uuid(),
  performed_by     uuid references auth.users,
  performed_at     timestamptz not null default now(),
  retention_months int    not null,
  evidence_count   int    not null,
  bytes_freed      bigint not null,
  event_ids        uuid[] not null default '{}'
);

alter table attendance_evidence
  add column purge_run_id uuid references purge_runs on delete set null;

comment on table purge_runs is
  'Every photo clear-out, attributed. Purging is an operator action, never a timer: a scheduled deletion is the one background job whose failure mode is silent and unrecoverable.';

-- ---------------------------------------------------------------------------

create table app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references auth.users,
  updated_at timestamptz not null default now()
);

-- Defaults. Every one of these is meant to be changed from the admin UI.
insert into app_settings (key, value) values
  ('evidence_retention_months',   '12'::jsonb),
  ('storage_warn_percent',        '75'::jsonb),
  ('storage_quota_bytes',         '1073741824'::jsonb),
  ('checkin_grace_minutes',       '60'::jsonb),
  ('duplicate_name_similarity',   '0.62'::jsonb),
  ('search_members_max_per_min',  '60'::jsonb),
  ('submit_checkin_max_per_min',  '120'::jsonb)
on conflict (key) do nothing;

comment on column app_settings.value is
  'JSON so a setting can grow from a number into an object without a migration.';

create or replace function fn_setting_int(p_key text, p_default int)
returns int
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce((select value #>> '{}' from app_settings where key = p_key)::int, p_default)
$$;

create or replace function fn_setting_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce((select value #>> '{}' from app_settings where key = p_key)::numeric, p_default)
$$;

-- ---------------------------------------------------------------------------

create table audit_log (
  id            bigserial primary key,
  actor_user_id uuid references auth.users,
  action        text not null,          -- 'review_records', 'merge_members', ...
  entity_type   text,                   -- 'attendance_record', 'member', ...
  entity_id     uuid,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_created on audit_log (created_at desc);
create index audit_log_entity  on audit_log (entity_type, entity_id);

create or replace function fn_audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_detail      jsonb default '{}'::jsonb
) returns void
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  insert into audit_log (actor_user_id, action, entity_type, entity_id, detail)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_detail, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- One-shot upload grants
-- ---------------------------------------------------------------------------
-- docs/01-data-model.md describes create_evidence_upload() as returning "a
-- signed one-shot Storage upload URL". SQL cannot mint a Supabase signed URL:
-- that signature is produced by the Storage service, not the database.
--
-- So the RPC mints the other half of the same idea. It validates that the
-- event really requires the evidence kind being offered, reserves a single
-- object path, and records a grant. The storage RLS policy in migration 12
-- then permits an anonymous PUT to exactly that path, once, before it
-- expires. submit_checkin() consumes the grant when it files the record.
--
-- The security property is the same one the doc was after: an anonymous
-- caller can only write the one object the database told it to write.
-- ---------------------------------------------------------------------------

create table evidence_upload_grants (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique default encode(gen_random_bytes(16), 'hex'),
  event_id     uuid not null references events on delete cascade,
  member_id    uuid references members on delete cascade,
  kind         evidence_kind_t not null,
  bucket_id    text not null default 'evidence',
  object_path  text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);

create index evidence_upload_grants_live
  on evidence_upload_grants (object_path) where consumed_at is null;

-- The storage policy in migration 12 has to ask "is there a live grant for
-- this object path". A policy expression is evaluated with the privileges of
-- whoever is running the query, and anon has no privilege on this table by
-- design, so the question has to be asked through a definer function rather
-- than by selecting from the table inside the policy. The function answers
-- one boolean and never reveals a grant.
create or replace function fn_upload_grant_is_live(p_bucket_id text, p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from evidence_upload_grants g
    where g.object_path = p_object_path
      and g.bucket_id   = p_bucket_id
      and g.consumed_at is null
      and g.expires_at  > now()
  )
$$;

-- ---------------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------------
-- Coarse, per-minute, keyed by check-in token. The database cannot see a
-- caller's IP address through the connection pooler, so this is not a
-- substitute for a gateway rate limit. What it does buy is a ceiling on how
-- fast one leaked QR token can be used to enumerate the roster through
-- search_members(), which is the specific risk docs/01-data-model.md flags.
-- ---------------------------------------------------------------------------

create table rpc_call_counters (
  bucket_key   text        not null,
  window_start timestamptz not null,
  call_count   int         not null default 0,
  primary key (bucket_key, window_start)
);

create or replace function fn_rate_limit_hit(p_key text, p_max_per_minute int)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_window timestamptz := date_trunc('minute', now());
  v_count  int;
begin
  insert into rpc_call_counters (bucket_key, window_start, call_count)
  values (p_key, v_window, 1)
  on conflict (bucket_key, window_start)
    do update set call_count = rpc_call_counters.call_count + 1
  returning call_count into v_count;

  -- Opportunistic cleanup, cheap because the table only ever holds a few
  -- minutes of rows.
  if v_count = 1 then
    delete from rpc_call_counters where window_start < v_window - interval '10 minutes';
  end if;

  if v_count > p_max_per_minute then
    raise exception 'Too many requests. Please wait a moment and try again.'
      using errcode = 'PDS09';
  end if;
end
$$;
