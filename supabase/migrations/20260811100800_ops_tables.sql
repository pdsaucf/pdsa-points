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
  kind             text   not null default 'evidence',
  -- Null for an orphaned-upload reclaim, where a retention window is not the
  -- thing being applied.
  retention_months int,
  evidence_count   int    not null,
  bytes_freed      bigint not null,
  event_ids        uuid[] not null default '{}',
  check (kind in ('evidence', 'orphaned_uploads')),
  check (kind <> 'evidence' or retention_months is not null)
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

-- ---------------------------------------------------------------------------
-- Defaults. Every one of these is meant to be changed from the admin UI, and
-- every rate ceiling below is a row here rather than a constant in a function
-- so raising one is a settings edit and not a migration.
--
-- THE ARITHMETIC BEHIND THE CHECK-IN CEILINGS
--
-- From docs/00-spreadsheet-findings.md and the 2025-2026 workbook:
--   roster                                    355
--   largest single event (Fall GBM 2)         167 attendees
--   second largest                            155 attendees
--
-- Those 167 people scan the same QR code within a few minutes of each other,
-- so the peak minute plausibly carries most of them. A realistic attendee
-- costs one context load, roughly three to ten searches while autocompleting
-- their own name, and one submission, plus retries on venue wifi.
--
-- The ceilings are therefore sized per client first and per event second. A
-- single ceiling on a token every attendee shares cannot both throttle abuse
-- and admit 167 people: whatever number admits the crowd is useless against
-- an attacker, and whatever number stops an attacker locks out the crowd.
--
-- Where a choice remained, it was made in favour of admitting a real member.
-- Turning away somebody who actually showed up is the failure this system
-- exists to end, and it is far worse than serving an extra few thousand
-- name-only searches.
-- ---------------------------------------------------------------------------
insert into app_settings (key, value) values
  ('evidence_retention_months',            '12'::jsonb),
  ('storage_warn_percent',                 '75'::jsonb),
  ('storage_quota_bytes',                  '1073741824'::jsonb),
  ('checkin_grace_minutes',                '60'::jsonb),
  ('duplicate_name_similarity',            '0.62'::jsonb),

  -- How long a client nonce and an upload grant stay usable. A nonce lasts a
  -- long event; a grant is a single photo about to be sent.
  ('checkin_nonce_ttl_minutes',            '240'::jsonb),
  ('evidence_grant_ttl_minutes',           '30'::jsonb),

  -- Nonce issuance, per event token per minute. One per attendee page load,
  -- so 167 at peak. 600 is roughly 3.5x that, which covers everybody
  -- reloading twice, and still bounds how many rate-limit buckets one token
  -- can mint.
  ('checkin_nonce_max_per_min',            '600'::jsonb),

  -- search_members. This returns names only, which docs/01-data-model.md
  -- section 8 already accepts as the cost of identifying yourself without
  -- logging in, and which is strictly less exposure than today's Google Form
  -- dropdown. Throttling it therefore protects very little and breaks check-in
  -- if set anywhere near the crowd size.
  --
  -- DO NOT "HARDEN" THE EVENT-WIDE NUMBER DOWNWARD. It is an anti-runaway
  -- backstop, not a security control. 167 attendees x 10 searches each is
  -- 1,670 in the peak minute; 20,000 is an order of magnitude above that and
  -- deliberately so. The per-nonce limit is what constrains one bad client.
  ('search_members_max_per_nonce_per_min',  '60'::jsonb),
  ('search_members_max_per_event_per_min',  '20000'::jsonb),

  -- submit_checkin writes rows, so the per-client number is tight: one real
  -- submission plus retries. The event-wide number is 1,500, roughly 9x the
  -- 167 peak, because being turned away here means losing credit for an event
  -- you attended.
  ('submit_checkin_max_per_nonce_per_min',  '10'::jsonb),
  ('submit_checkin_max_per_event_per_min',  '1500'::jsonb),

  -- Unmatched submissions are the one genuinely unbounded write path. A
  -- matched member can only ever create one live row per event, because the
  -- partial unique index says so. An unmatched one has no such bound: every
  -- submission is a new row with a typed-in name.
  --
  -- IT IS TEMPTING TO SET THE EVENT CEILING LOW HERE. DO NOT. On a mature
  -- roster unmatched submissions are rare, but that is not the condition this
  -- system launches in:
  --
  --   * The database ships with ZERO members. If nobody runs
  --     scripts/import_roster.py before the first event, every single attendee
  --     is unmatched. A ceiling of 30 would turn away 137 of a 167-person GBM.
  --   * Even with a roster loaded, the first GBM of the year is a recruiting
  --     event, so a large share of the room is genuinely new. That is the
  --     launch condition, not an edge case.
  --
  -- So this is layered like every other ceiling: tight per client, generous
  -- per event. One real person submits once, maybe twice on a retry, so three
  -- per nonce is already loose. The event ceiling is 1,000, roughly 6x the
  -- 167-attendee peak.
  --
  -- WORST CASE, spelled out. A flooder can mint nonces, so the per-client
  -- limit alone does not bound them:
  --     600 nonces/min (checkin_nonce_max_per_min)
  --   x   3 unmatched submissions per nonce
  --   = 1,800 attempted
  --   bounded by 1,000 (this setting)
  --   and separately by 1,500 (submit_checkin_max_per_event_per_min, which
  --   counts every submission, matched or not)
  --   => 1,000 junk rows per minute, worst case.
  --
  -- Those rows are all `pending` and flagged `unmatched_name`. They are a
  -- nuisance in the review queue, never credit, and an officer can reject them
  -- in bulk. Weigh that against turning away a room full of new recruits at the
  -- launch event, which is the exact failure this system exists to end.
  ('submit_unmatched_max_per_nonce_per_min', '3'::jsonb),
  ('submit_unmatched_max_per_event_per_min', '1000'::jsonb),

  -- create_evidence_upload is the storage exhaustion vector: each grant is a
  -- licence to write up to 8 MB into a 1 GB bucket. This is the one place a
  -- tight limit is the right answer, so it is bounded by rate AND by how many
  -- grants may be outstanding and unconsumed at once.
  --
  -- "outstanding_per_member" is per PERSON, not per member row: unmatched
  -- attendees are separated by their client nonce, because on an empty roster
  -- they all share a null member_id and would otherwise share one allowance of
  -- three between the whole room. See create_evidence_upload().
  ('evidence_upload_max_per_nonce_per_min', '6'::jsonb),
  ('evidence_upload_max_per_event_per_min', '600'::jsonb),
  ('evidence_grants_outstanding_per_member', '3'::jsonb),
  -- 400 was the third instance of the same mistake, caught by auditing rather
  -- than by an incident. It sat BELOW the worst legitimate case: 167 attendees
  -- entitled to 3 outstanding grants each is 501, so a busy photo event could
  -- have hit it with nobody misbehaving.
  --
  -- It is now 1,200, which puts the per-client cap back in charge and leaves
  -- this purely a backstop. That costs nothing in storage terms, because an
  -- outstanding grant is not a stored byte and the real bound on bytes is the
  -- rate limit above: at most 600 grants a minute can be issued at all, and a
  -- grant only becomes an object if somebody actually uploads against it.
  -- Abandoned ones are reclaimed by purge_orphaned_uploads().
  ('evidence_grants_outstanding_per_event',  '1200'::jsonb)
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
-- Client nonces
-- ---------------------------------------------------------------------------
-- A rate limit keyed on the check-in token is a limit shared by everybody at
-- the event, because the token is printed on the QR code they all scanned. One
-- runaway browser retrying in a loop would spend the whole crowd's allowance,
-- and the crowd is the thing being protected.
--
-- So get_checkin_context() hands each page load an opaque random nonce, and
-- the limiter keys on token plus nonce when one is presented. A runaway client
-- then burns its own allowance and nobody else's.
--
-- THREE THINGS THIS IS NOT.
--
-- 1. It is NOT an authorization token. It confers nothing. Every RPC still
--    validates the check-in token, the window, the member and the evidence
--    exactly as before, and no code path anywhere reads this table to decide
--    whether an action is permitted. It selects a counter bucket, full stop.
--
-- 2. It is NOT trusted input. A caller that invents a nonce, or replays an
--    expired one, does not get a private bucket: fn_checkin_nonce_bucket()
--    only honours a nonce this database issued for this event and has not
--    expired, and otherwise falls back to the shared token bucket. Without
--    that check, an attacker would simply send a new random string per
--    request and have no limit at all.
--
-- 3. It is NOT unbounded. Minting nonces is itself rate limited per token, so
--    the number of buckets one event can have is capped.
-- ---------------------------------------------------------------------------

create table checkin_client_nonces (
  nonce      text primary key default encode(gen_random_bytes(16), 'hex'),
  event_id   uuid not null references events on delete cascade,
  issued_at  timestamptz not null default now(),
  expires_at timestamptz not null
);

create index checkin_client_nonces_expiry on checkin_client_nonces (expires_at);

-- Returns the limiter bucket suffix for a caller: the nonce when it is one we
-- issued for this event and it is still live, and otherwise nothing, which
-- puts the caller back in the shared per-event bucket.
create or replace function fn_checkin_nonce_bucket(p_event_id uuid, p_nonce text)
returns text
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce((
    select ':' || n.nonce
    from checkin_client_nonces n
    where n.nonce = p_nonce
      and n.event_id = p_event_id
      and n.expires_at > now()
  ), '')
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
  -- Which client asked for this grant, when they presented a nonce this
  -- database actually issued. It is what lets the outstanding-grant cap be
  -- per person for unmatched attendees, who all share a null member_id and
  -- would otherwise share one allowance between the whole room. Null means
  -- the caller had no valid nonce, and those callers share a bucket.
  --
  -- Only ever set from a VALIDATED nonce. Storing whatever string the caller
  -- sent would let them invent a fresh one per request and bypass the cap
  -- entirely, which is the same trap the rate limiter avoids.
  client_nonce text references checkin_client_nonces (nonce) on delete set null,
  kind         evidence_kind_t not null,
  bucket_id    text not null default 'evidence',
  object_path  text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  -- Set by purge_orphaned_uploads() when an operator reclaims an abandoned
  -- upload. The row is kept rather than deleted: it is the only record that
  -- an object was ever written to that path, and deleting it would make a
  -- leftover object invisible forever.
  reclaimed_at timestamptz,
  purge_run_id uuid references purge_runs on delete set null
);

create index evidence_upload_grants_live
  on evidence_upload_grants (object_path) where consumed_at is null;

-- Finding an event's outstanding grants is a hot path: create_evidence_upload()
-- counts them on every call, once for the caller and once for the event.
create index evidence_upload_grants_outstanding
  on evidence_upload_grants (event_id, member_id, client_nonce, expires_at)
  where consumed_at is null and reclaimed_at is null;

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
-- Coarse and per-minute. The database cannot see a caller's IP address through
-- the connection pooler, so this is NOT a substitute for a gateway rate limit,
-- and the API gateway remains the right place for attack-volume telemetry
-- because it sees every request including the ones rejected here.
--
-- What this buys is a bound on what one check-in token, and one client holding
-- that token, can do to the database.
--
-- ON CHECKING BEFORE INCREMENTING
--
-- The obvious implementation increments first and raises if the new value is
-- over the ceiling. That is wrong in a way that is easy to miss: the raise
-- aborts the transaction, so the increment that triggered it rolls back too.
-- The counter therefore sticks at exactly the maximum no matter how much
-- traffic arrives, and an operator reading it cannot tell a busy event from an
-- attack.
--
-- Checking first fixes the meaning of the number. call_count is now exactly
-- "requests admitted in this window", it is never inflated by requests that
-- were refused, and it stops climbing when the ceiling is reached instead of
-- hovering one above it.
--
-- What this deliberately does NOT try to do is count refused requests. Doing
-- that durably would need the write to survive the rollback, which in plain
-- Postgres means an autonomous transaction (dblink or pg_background), and
-- neither is worth adding to the anonymous check-in hot path. Refused requests
-- are visible in the Supabase API logs, which is where request-volume
-- questions belong anyway.
-- ---------------------------------------------------------------------------

create table rpc_call_counters (
  bucket_key   text        not null,
  window_start timestamptz not null,
  call_count   int         not null default 0,
  primary key (bucket_key, window_start)
);

comment on column rpc_call_counters.call_count is
  'Requests ADMITTED in this window, never requests attempted. Refused requests are not counted here: see the note above the function, and the API gateway logs.';

create or replace function fn_rate_limit_check(p_key text, p_max_per_minute int)
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
  select coalesce(c.call_count, 0) into v_count
  from rpc_call_counters c
  where c.bucket_key = p_key and c.window_start = v_window;

  if coalesce(v_count, 0) >= p_max_per_minute then
    raise exception 'Too many requests. Please wait a moment and try again.'
      using errcode = 'PDS09';
  end if;

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
end
$$;

-- Applies the two ceilings every anonymous check-in RPC has: a tight one for
-- this client, and a loose backstop for the event as a whole. The per-client
-- key falls back to the per-event key when the caller presented no valid
-- nonce, in which case the caller is simply sharing the event bucket.
create or replace function fn_rate_limit_checkin(
  p_operation      text,
  p_token          text,
  p_nonce_bucket   text,
  p_max_per_client int,
  p_max_per_event  int
) returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if p_nonce_bucket <> '' then
    perform fn_rate_limit_check(p_operation || ':' || p_token || p_nonce_bucket,
                                p_max_per_client);
  end if;
  perform fn_rate_limit_check(p_operation || ':' || p_token, p_max_per_event);
end
$$;
