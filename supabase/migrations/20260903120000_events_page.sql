-- ===========================================================================
-- 29. THE PUBLIC EVENTS PAGE
-- ===========================================================================
-- docs/05-events-page.md. A public route, /events, that replaces the Notion
-- page listing what is coming up: date, time, location, attire, sign-up and a
-- short description, per event, with no name typed and no login.
--
-- Three facts have nowhere to live yet.
--
--   location    Migration 25 dropped this column, on the stated grounds that
--               the club does not use it. The club uses it. It comes back.
--   attire      New. Whatever the Notion column holds: a dress code, or
--               nothing.
--   signup      New. A form URL, a line of text, or nothing. Rendering a URL
--               as a button versus text as a sentence is a client decision;
--               this column just holds whichever the officer typed.
--
-- description is also new and is member-facing. events.notes is deliberately
-- NOT reused for it: notes is officer-side and RLS-protected (only staff may
-- read it), and a public page reading it would leak the first internal note
-- anybody ever typed there.
--
-- Two things make an event visible on the page, independent of each other:
-- an officer publishing it by hand, and a global Monday-morning drop for
-- events dated soon. Both are described in the doc; the arithmetic for the
-- second is worked out in fn_event_release_at() below.
--
-- EVERY OTHER PLACE is_published WAS READ WAS CHECKED AGAINST THIS FLIP.
-- fn_checkin_event() and v_config_warnings (two clauses) needed a change and
-- got one; both are covered below with their own comments. request_missing_
-- credit() in 20260814130000_member_portal.sql:850 also filters on
-- e.is_published, but that path requires a signed-in member account, and
-- invariant 8 says a member has no account, so it is unreachable dead code.
-- Reviewed and deliberately left alone rather than touched for its own sake.
-- v_attendance_credit, v_member_category_totals and v_member_status do not
-- filter on is_published at all, so points and honorary status are
-- unaffected by any of this.
-- ===========================================================================

alter table events
  add column location    text,
  add column attire      text,
  add column signup      text,
  add column description text;

comment on column events.location is
  'Where the event is held. Dropped in migration 25 on the stated grounds that the club does not use it. The club uses it: restored for the public events page.';

comment on column events.attire is
  'Dress code text for the public events page, exactly as an officer types it. Null renders as nothing.';

comment on column events.signup is
  'A sign-up form URL, a line of text ("Sign up at GBM"), or null. An http(s) URL renders as a button; anything else renders as text. Never validated here: the client decides how to draw it.';

comment on column events.description is
  'Member-facing summary for the public events page. Separate from events.notes on purpose: notes is officer-side and RLS-protected, and reusing it would leak an internal note the first time somebody typed one there.';

-- ---------------------------------------------------------------------------
-- Publish becomes an officer action, not a default state
-- ---------------------------------------------------------------------------
-- Every row that exists today was created before this page existed and is
-- already the club's real, already-announced event history: it is backfilled
-- to true implicitly, because the column default up to this migration WAS
-- true, and that default is exactly what every existing row already carries.
-- No UPDATE is needed and none is written: an UPDATE that sets every row to
-- the value it already holds is a no-op that only costs a table rewrite.
alter table events alter column is_published set default false;

-- ---------------------------------------------------------------------------
-- Check-in does not read is_published, and never did in any way that mattered
-- ---------------------------------------------------------------------------
-- The obvious follow-on question: did flipping this default just break
-- check-in for every new event? No, and the reasoning is worth writing down
-- because a future reader diffing fn_checkin_event() against its previous
-- definition will otherwise assume the `and e.is_published` term was dropped
-- by accident.
--
-- The check-in token is already the access control. It is 64 bits of secret
-- printed on the QR code taped up at the venue, and checkin_opens_at /
-- checkin_closes_at are what bound when that token works. is_published was
-- never a second gate in practice: web/src/events.js's own header says the
-- admin form has never written it, so it was true on every event this
-- product has ever had, and this term has not actually refused a check-in
-- since the table was created. What is_published means AS OF THIS MIGRATION
-- is "announced on the public /events page", which is a different question
-- from "can the person standing at the event record attendance".
-- Switching this term to fn_event_is_visible() instead of dropping it would
-- reintroduce the exact bug the default flip just created, one Monday-drop
-- cycle later: a queued event's QR would work again only once it happened to
-- get auto-released, which is not why anybody prints a QR code.
--
-- This is fn_checkin_event() from migration 24 (20260824124000), unchanged
-- apart from removing that one term from the where clause.
create or replace function fn_checkin_event(p_token text, p_enforce_window boolean)
returns events
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event events;
  v_grace int;
begin
  select * into v_event
  from events e
  where e.checkin_token = p_token
  for share;

  if v_event.id is null then
    raise exception 'That check-in link is not valid.' using errcode = 'PDS01';
  end if;

  if p_enforce_window then
    if v_event.checkin_opens_at is not null and now() < v_event.checkin_opens_at then
      raise exception 'Check-in for this event has not opened yet.' using errcode = 'PDS02';
    end if;
    if v_event.checkin_closes_at is not null and now() > v_event.checkin_closes_at then
      raise exception 'Check-in for this event has closed.' using errcode = 'PDS10';
    end if;
  else
    v_grace := fn_setting_int('checkin_grace_minutes', 60);
    if v_event.checkin_opens_at is not null and now() < v_event.checkin_opens_at then
      raise exception 'Check-in for this event has not opened yet.' using errcode = 'PDS02';
    end if;
    if v_event.checkin_closes_at is not null
       and now() > v_event.checkin_closes_at + make_interval(mins => v_grace) then
      raise exception 'Check-in for this event has closed.' using errcode = 'PDS10';
    end if;
  end if;

  return v_event;
end
$$;

comment on function fn_checkin_event(text, boolean) is
  'Resolves and locks one check-in event for the caller transaction by token alone, then enforces either the exact window or the submission grace window. Deliberately not gated on is_published: see the comment above this function.';

-- ---------------------------------------------------------------------------
-- The Monday drop
-- ---------------------------------------------------------------------------
-- One global toggle. Not a per-event column: an exemptible fairness rule is
-- not one, and every queued event either drops at 8:00 AM America/New_York
-- on Monday or it does not, together.
insert into app_settings (key, value) values
  ('events_auto_publish', 'true'::jsonb)
on conflict (key) do nothing;

-- Belt: this row specifically can never be written as anything but a JSON
-- boolean. app_settings.value is arbitrary jsonb for every other key, so the
-- constraint is scoped to this one key rather than the whole table.
alter table app_settings
  add constraint events_auto_publish_is_boolean
  check (key <> 'events_auto_publish' or jsonb_typeof(value) = 'boolean');

-- Braces: fn_setting_bool must never raise, whatever is actually sitting in
-- the row, because portal_events() and every visibility-dependent
-- portal_attendance() call reads it on the anonymous path, and one bad row
-- would take the whole public surface down with an uncaught cast error. The
-- constraint above stops THIS key from being written wrong; this is what
-- keeps a pre-existing bad row (a manual edit, a restored backup predating
-- the constraint) from becoming an outage instead of a fallback.
--
-- fn_setting_int and fn_setting_numeric already exist (migration 08) and
-- both cast unconditionally, which is exactly the failure mode this avoids:
-- (value #>> '{}')::boolean throws outright on '2', '"garbage"' or an
-- object. The fix is to check jsonb_typeof() BEFORE ever attempting the
-- cast: the where clause below only lets a row through to the cast when it
-- is already known to be a JSON boolean, so the cast itself can never fail.
-- Anything else, including a missing row or a JSON null, falls through to
-- p_default via the empty subquery.
create or replace function fn_setting_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    (select (value #>> '{}')::boolean
     from app_settings
     where key = p_key and jsonb_typeof(value) = 'boolean'),
    p_default
  )
$$;

revoke all on function fn_setting_bool(text, boolean) from public, anon;
grant execute on function fn_setting_bool(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_event_release_at: the instant a queued event becomes visible
-- ---------------------------------------------------------------------------
-- max(A, B):
--   A = the first Monday 08:00 America/New_York on or after (occurred_on - 14 days)
--   B = the first Monday 08:00 America/New_York strictly after created_at
--
-- A is the fairness window: nothing drops more than two weeks ahead of the
-- event. B is what stops an event created today for a date three months out
-- from being instantly visible (it has not had its first Monday yet), and
-- what stops a backdated event from being released retroactively (created_at
-- itself moves the earliest possible release into the future).
--
-- Both terms are built by constructing the LOCAL wall-clock timestamp for
-- 08:00 on the chosen date and then applying `at time zone 'America/New
-- York'` to turn that local reading into a UTC instant. That is what keeps
-- 08:00 correct across a DST transition: a fixed UTC offset would read as
-- 07:00 or 09:00 local on the wrong side of the change.
--
-- Not immutable: `at time zone` with a named zone reads tzdata, which can
-- change (a jurisdiction moving its DST rules) without the function's own
-- text changing.
create or replace function fn_event_release_at(p_occurred_on date, p_created_at timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_a_date              date;
  v_a                   timestamptz;
  v_b_date              date;
  v_b                   timestamptz;
  v_created_local_date  date;
begin
  -- Term A. Monday's isodow is 1, so `(8 - isodow) % 7` is the number of days
  -- to the next Monday on or after the date, and 0 when the date already is
  -- one.
  v_a_date := (p_occurred_on - 14)
    + ((8 - extract(isodow from (p_occurred_on - 14))::int) % 7);
  v_a := (v_a_date + time '08:00') at time zone 'America/New_York';

  -- Term B. Anchored on created_at's own America/New_York calendar date, so
  -- the same Monday-finding arithmetic as term A applies. That alone finds
  -- the first Monday ON OR AFTER created_at's date, which is not yet "strictly
  -- after the instant": if created_at itself falls on that Monday at or past
  -- 08:00, the candidate has to move a further week out.
  v_created_local_date := (p_created_at at time zone 'America/New_York')::date;
  v_b_date := v_created_local_date
    + ((8 - extract(isodow from v_created_local_date)::int) % 7);
  v_b := (v_b_date + time '08:00') at time zone 'America/New_York';
  if v_b <= p_created_at then
    v_b_date := v_b_date + 7;
    v_b := (v_b_date + time '08:00') at time zone 'America/New_York';
  end if;

  return greatest(v_a, v_b);
end
$$;

comment on function fn_event_release_at(date, timestamptz) is
  'The instant a queued event becomes visible under the Monday drop: the later of two weeks before the event and the first Monday after it was created. Pure arithmetic: does not read is_published, the auto-publish toggle, or events.release_at. Called by the two triggers below at write time, and directly by test/events_page.test.mjs. See fn_event_is_visible() for the predicate a read actually filters on.';

revoke all on function fn_event_release_at(date, timestamptz) from public, anon;
grant execute on function fn_event_release_at(date, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- events.release_at: stored, not recomputed, so visibility is monotonic
-- ---------------------------------------------------------------------------
-- THE BUG THIS FIXES. The first version of this migration had
-- fn_event_is_visible() call fn_event_release_at(occurred_on, created_at)
-- live, on every read. That is not monotonic: postponing an already-visible
-- event (an officer moves a GBM from next week to three months out, which is
-- an ordinary thing for a club to do) recomputes term A from the new date
-- and can push the release instant back into the future, silently
-- un-announcing an event members have already seen on the page.
--
-- The fix is to compute the release once, in a trigger, store it, and only
-- ever let it move forward before the event has actually dropped. After
-- that, it is frozen: rescheduling a released event can never hide it again.
alter table events add column release_at timestamptz;

-- Backfilled before the triggers below exist, so this runs once as plain
-- arithmetic over the rows that predate this migration rather than through
-- the trigger machinery. created_at is each row's real one: these are
-- historical rows, not inserts happening now, so there is no server-clock
-- "now" from the original creation to reuse.
update events set release_at = fn_event_release_at(occurred_on, created_at);

alter table events alter column release_at set not null;

comment on column events.release_at is
  'The instant this event becomes visible under the Monday drop. Stored and monotonic rather than recomputed: see fn_event_release_at_before_insert() and fn_event_release_at_before_update(). Independent of is_published.';

-- Sets the initial release the moment a row is created. Uses now(), the
-- actual server clock, rather than new.created_at: created_at is just
-- another column on the row being inserted, and a caller (an import script,
-- a hand-written insert) could set it to any value it likes. Anchoring on
-- now() instead means a backdated created_at cannot buy an event an earlier
-- release than the moment it was actually written, which is the other half
-- of what "cannot be released retroactively" needs to mean.
create or replace function fn_event_release_at_before_insert()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  new.release_at := fn_event_release_at(new.occurred_on, now());
  return new;
end
$$;

revoke all on function fn_event_release_at_before_insert() from public, anon, authenticated;

create trigger events_release_at_before_insert
before insert on events
for each row execute function fn_event_release_at_before_insert();

-- THE MONOTONIC LATCH. Recomputes release_at only while OLD.release_at, the
-- release already in effect before this update, is still ahead of now(): in
-- other words, only while the event has not yet actually been released.
-- Once now() has passed it, the release is history, and no later edit,
-- including moving occurred_on, may pull it back into the future. Do not
-- "simplify" this by recomputing unconditionally: that is the exact bug
-- this trigger exists to prevent, described above.
--
-- While still queued, recomputing from THIS update's now() (matching the
-- insert trigger, not the row's original created_at) is deliberate:
-- rescheduling a queued event is a fresh decision about when it may be
-- announced, so its release is free to move, forward or back, right up
-- until the moment it actually drops.
create or replace function fn_event_release_at_before_update()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if old.release_at > now() then
    new.release_at := fn_event_release_at(new.occurred_on, now());
  end if;
  return new;
end
$$;

revoke all on function fn_event_release_at_before_update() from public, anon, authenticated;

create trigger events_release_at_before_update
before update on events
for each row execute function fn_event_release_at_before_update();

-- ---------------------------------------------------------------------------
-- fn_event_is_visible: the one predicate every read filters on
-- ---------------------------------------------------------------------------
-- Reads the STORED release_at rather than recomputing it, which is what
-- makes this predicate itself monotonic once the two triggers above own the
-- column: an event that is visible now was never, at any point in the past,
-- shown as visible and then hidden again by this function changing its mind.
--
-- The signature changed (occurred_on and created_at are gone, release_at
-- replaces them), which CREATE OR REPLACE cannot do across argument types:
-- the old three-argument overload has to be dropped explicitly or it is
-- left behind as dead, still-granted code nothing calls.
drop function if exists fn_event_is_visible(boolean, date, timestamptz);

create or replace function fn_event_is_visible(p_is_published boolean, p_release_at timestamptz)
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select p_is_published
    or (fn_setting_bool('events_auto_publish', true) and now() >= p_release_at)
$$;

comment on function fn_event_is_visible(boolean, timestamptz) is
  'Whether an event may be shown to a member or the public: published by hand, or dropped by the Monday auto-publish rule, using the stored release_at rather than recomputing it. There is no per-event opt-out of the drop by design.';

revoke all on function fn_event_is_visible(boolean, timestamptz) from public, anon;
grant execute on function fn_event_is_visible(boolean, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- PostgREST computed column, so the admin screen never re-derives this
-- ---------------------------------------------------------------------------
-- release_at used to be a computed column here too, but it is now a real
-- column on events (see above) and selects identically as one:
-- `select=*,release_at` already works with no function behind it. Only
-- is_visible remains a function, since whether an event is visible right
-- now is a function of release_at and the auto-publish toggle, not a stored
-- fact.
--
-- Granted to authenticated only, not anon: this exists for the officer
-- event list, which needs to show a solid versus dashed card border without
-- recomputing the toggle logic in the browser. The public page reads
-- portal_events(), which has already applied the same predicate
-- server-side.
create or replace function is_visible(e events)
returns boolean
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select fn_event_is_visible(e.is_published, e.release_at)
$$;

comment on function is_visible(events) is
  'PostgREST computed column: select=*,is_visible. Whether this event is visible to a member right now, published or dropped.';

revoke all on function is_visible(events) from public, anon;
grant execute on function is_visible(events) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_event_config_version_before_update: the four new fields are configuration
-- ---------------------------------------------------------------------------
-- Editing location, attire, sign-up or the description is an event config
-- change like any other and has to bump config_version, or a stale editor
-- open in a second tab could overwrite one of these fields with what it last
-- loaded. This is the full definition from migration 24 with the four new
-- columns added to the watched list; everything else is unchanged.
create or replace function fn_event_config_version_before_update()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if new.config_version = old.config_version and (
       new.academic_year_id is distinct from old.academic_year_id
    or new.term_id is distinct from old.term_id
    or new.title is distinct from old.title
    or new.occurred_on is distinct from old.occurred_on
    or new.notes is distinct from old.notes
    or new.review_policy is distinct from old.review_policy
    or new.checkin_token is distinct from old.checkin_token
    or new.checkin_opens_at is distinct from old.checkin_opens_at
    or new.checkin_closes_at is distinct from old.checkin_closes_at
    or new.token_rotated_at is distinct from old.token_rotated_at
    or new.is_published is distinct from old.is_published
    or new.starts_at is distinct from old.starts_at
    or new.ends_at is distinct from old.ends_at
    or new.location is distinct from old.location
    or new.attire is distinct from old.attire
    or new.signup is distinct from old.signup
    or new.description is distinct from old.description
  ) then
    new.config_version := old.config_version + 1;
  end if;
  return new;
end
$$;

revoke all on function fn_event_config_version_before_update() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- save_event_config: read and write the four new fields
-- ---------------------------------------------------------------------------
-- The current definition (migration 24, unchanged since by migrations 24c and
-- 24d) plus location, attire, signup and description on both the insert and
-- update paths. Empty strings normalise to null the same way an unset field
-- does, so a form that clears a value writes null rather than ''. This
-- function does not touch is_published: publishing is a separate action
-- (set_event_published() below), on purpose, which is why it is not a field
-- on this form.
create or replace function save_event_config(
  p_event_id               uuid,
  p_academic_year_id       uuid,
  p_event                  jsonb,
  p_categories             jsonb default '[]'::jsonb,
  p_evidence               jsonb default null,
  p_expected_config_version bigint default null,
  p_create                 boolean default false
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event          events;
  v_title          text := btrim(coalesce(p_event ->> 'title', ''));
  v_occurred       date;
  v_starts         timestamptz;
  v_ends           timestamptz;
  v_closes         timestamptz;
  v_term           uuid;
  v_location       text := nullif(btrim(coalesce(p_event ->> 'location', '')), '');
  v_attire         text := nullif(btrim(coalesce(p_event ->> 'attire', '')), '');
  v_signup         text := nullif(btrim(coalesce(p_event ->> 'signup', '')), '');
  v_description    text := nullif(btrim(coalesce(p_event ->> 'description', '')), '');
  v_category_count int;
  v_next_version   bigint;
  v_old_value_set  uuid[];
  v_new_value_set  uuid[];
begin
  perform fn_assert_officer();

  if p_event_id is null or p_academic_year_id is null then
    raise exception 'Event id and academic year are required.' using errcode = 'PDS03';
  end if;
  if v_title = '' then
    raise exception 'Type a title.' using errcode = 'PDS03';
  end if;
  if jsonb_typeof(coalesce(p_categories, '[]'::jsonb)) <> 'array' then
    raise exception 'Event categories must be a list.' using errcode = 'PDS03';
  end if;
  if p_evidence is not null and jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'The photo requirement is not valid.' using errcode = 'PDS03';
  end if;

  begin
    v_occurred := nullif(p_event ->> 'occurred_on', '')::date;
    v_starts := nullif(p_event ->> 'starts_at', '')::timestamptz;
    v_ends := nullif(p_event ->> 'ends_at', '')::timestamptz;
    v_closes := nullif(p_event ->> 'checkin_closes_at', '')::timestamptz;
    v_term := nullif(p_event ->> 'term_id', '')::uuid;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'The event date or time is not valid.' using errcode = 'PDS03';
  end;

  if v_occurred is null then
    raise exception 'Pick a date.' using errcode = 'PDS03';
  end if;
  if (v_starts is null) <> (v_ends is null) or (v_starts is not null and v_ends <= v_starts) then
    raise exception 'Enter both event times, with the end after the start.' using errcode = 'PDS03';
  end if;
  if not exists (select 1 from academic_years y where y.id = p_academic_year_id) then
    raise exception 'Unknown academic year.' using errcode = 'PDS03';
  end if;
  if v_term is not null and not exists (
    select 1 from terms t where t.id = v_term and t.academic_year_id = p_academic_year_id
  ) then
    raise exception 'That term does not belong to this academic year.' using errcode = 'PDS03';
  end if;

  -- The advisory lock also covers a not-yet-existing row. Two create retries
  -- carrying the same caller-generated UUID therefore cannot both observe an
  -- empty slot and race into the primary key. Hash collisions only serialize
  -- unrelated event saves; they cannot change either result.
  perform pg_advisory_xact_lock(
    hashtextextended('event-config:' || p_event_id::text, 724603)
  );

  -- This row lock is the serialization point shared with fn_checkin_event().
  select * into v_event from events e where e.id = p_event_id for update;

  if p_create and v_event.id is not null then
    if v_event.academic_year_id <> p_academic_year_id then
      raise exception 'That event belongs to another academic year.' using errcode = 'PDS03';
    end if;
    -- A committed create whose HTTP response was lost returns the one event
    -- already written under the caller-generated id. The first call was
    -- atomic, so there is no partial configuration to repair here.
    return jsonb_build_object('id', v_event.id,
                              'checkin_token', v_event.checkin_token,
                              'config_version', v_event.config_version,
                              'created', true);
  end if;

  if not p_create then
    if v_event.id is null then
      raise exception 'Unknown event.' using errcode = 'PDS03';
    end if;
    if v_event.academic_year_id <> p_academic_year_id then
      raise exception 'That event belongs to another academic year.' using errcode = 'PDS03';
    end if;
    if p_expected_config_version is null
       or p_expected_config_version <> v_event.config_version then
      raise exception 'This event changed after you opened it. Reload it before saving.'
        using errcode = 'PDS15';
    end if;
  end if;

  select count(*) into v_category_count
  from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
       as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric);

  if v_category_count <> (
    select count(distinct c.category_id)
    from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
         as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
  ) then
    raise exception 'Choose each category once.' using errcode = 'PDS03';
  end if;

  -- A retired category may stay on the event it already belongs to, but its
  -- mode and credit are frozen. It cannot be attached to another event.
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
         as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
    left join categories cat on cat.id = c.category_id
    where c.category_id is null or c.credit_mode is null or c.fixed_credit is null
       or cat.id is null
       or (cat.archived_at is not null and not exists (
         select 1 from event_categories old
         where old.event_id = p_event_id
           and old.category_id = c.category_id
           and old.credit_mode = c.credit_mode
           and old.fixed_credit = c.fixed_credit
       ))
  ) then
    raise exception 'One of those categories cannot be used.' using errcode = 'PDS03';
  end if;

  if (
    select count(*)
    from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
         as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
    where c.credit_mode = 'from_submission'
  ) > 1 then
    raise exception 'Only one category can use member-entered points.' using errcode = 'PDS03';
  end if;

  -- Once submissions exist, changing which category reads submitted_value
  -- would reinterpret already stored values. Fixed credit remains editable
  -- and intentionally updates derived totals retroactively.
  if not p_create and exists (
    select 1 from attendance_records a where a.event_id = p_event_id
  ) then
    select array(
      select ec.category_id from event_categories ec
      where ec.event_id = p_event_id and ec.credit_mode = 'from_submission'
      order by ec.category_id
    ) into v_old_value_set;
    select array(
      select c.category_id
      from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
           as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric)
      where c.credit_mode = 'from_submission'
      order by c.category_id
    ) into v_new_value_set;
    if v_old_value_set is distinct from v_new_value_set then
      raise exception 'Member-entered points cannot be changed after check-ins exist.'
        using errcode = 'PDS03';
    end if;
  end if;

  if p_create then
    insert into events (
      id, academic_year_id, title, occurred_on, starts_at, ends_at,
      term_id, checkin_closes_at, created_by, config_version,
      location, attire, signup, description
    ) values (
      p_event_id, p_academic_year_id, v_title, v_occurred, v_starts, v_ends,
      v_term, v_closes, auth.uid(), 1,
      v_location, v_attire, v_signup, v_description
    ) returning * into v_event;
    v_next_version := 1;
  else
    v_next_version := v_event.config_version + 1;
    update events
    set title = v_title,
        occurred_on = v_occurred,
        starts_at = v_starts,
        ends_at = v_ends,
        term_id = v_term,
        checkin_closes_at = v_closes,
        location = v_location,
        attire = v_attire,
        signup = v_signup,
        description = v_description,
        config_version = v_next_version
    where id = p_event_id;
  end if;

  delete from event_categories where event_id = p_event_id;
  insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
  select p_event_id, c.category_id, c.credit_mode, c.fixed_credit
  from jsonb_to_recordset(coalesce(p_categories, '[]'::jsonb))
       as c(category_id uuid, credit_mode credit_mode_t, fixed_credit numeric);

  delete from event_evidence_requirements where event_id = p_event_id;
  if p_evidence is not null then
    insert into event_evidence_requirements (event_id, kind, is_required, prompt)
    values (p_event_id,
            (p_evidence ->> 'kind')::evidence_kind_t,
            true,
            nullif(btrim(coalesce(p_evidence ->> 'prompt', '')), ''));
  end if;

  -- Child triggers may have advanced the revision several times inside this
  -- still-invisible transaction. The whole save is one logical revision.
  update events set config_version = v_next_version where id = p_event_id;

  perform fn_audit(
    case when p_create then 'create_event' else 'save_event' end,
    'event',
    p_event_id,
    jsonb_build_object('category_count', v_category_count,
                       'has_evidence', p_evidence is not null,
                       'config_version', v_next_version)
  );

  select * into v_event from events e where e.id = p_event_id;
  return jsonb_build_object('id', v_event.id,
                            'checkin_token', v_event.checkin_token,
                            'config_version', v_event.config_version,
                            'created', p_create);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'The event configuration is not valid.' using errcode = 'PDS03';
end
$$;

revoke all on function save_event_config(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean)
  from public, anon;
grant execute on function save_event_config(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean)
  to authenticated;

comment on function save_event_config(uuid, uuid, jsonb, jsonb, jsonb, bigint, boolean) is
  'Officer only and audited. Atomically saves an events fields, categories and evidence after a locked revision check. A caller-generated id makes create retry idempotent. Retired links may only be preserved unchanged. Does not touch is_published: see set_event_published().';

-- ---------------------------------------------------------------------------
-- set_event_published: publishing is a separate action from saving
-- ---------------------------------------------------------------------------
-- Configuration and publish state change for different reasons and on
-- different cadences (an officer tunes the description a dozen times before
-- ever touching Publish), so this is its own RPC rather than a field on
-- save_event_config's p_event, and it carries no revision check: whichever
-- officer presses Publish last wins, the same as flipping any other single
-- flag.
create or replace function set_event_published(p_event_id uuid, p_published boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event events;
begin
  perform fn_assert_officer();

  if p_event_id is null or p_published is null then
    raise exception 'Choose a publish state.' using errcode = 'PDS03';
  end if;

  update events
  set is_published = p_published
  where id = p_event_id
  returning * into v_event;

  if v_event.id is null then
    raise exception 'Unknown event.' using errcode = 'PDS03';
  end if;

  perform fn_audit('set_event_published', 'event', p_event_id,
                   jsonb_build_object('is_published', v_event.is_published));

  -- The stored column, not a fresh fn_event_release_at() call: this update
  -- has already gone through the before-update trigger, which is the one
  -- place release_at is allowed to change, so v_event.release_at here is
  -- already whatever the latch decided it should be.
  return jsonb_build_object(
    'is_published', v_event.is_published,
    'release_at',   v_event.release_at
  );
end
$$;

comment on function set_event_published(uuid, boolean) is
  'Officer only and audited. Sets whether an event is published by hand, independent of the Monday auto-publish drop. Returns the new state and the stored drop instant so the caller can redraw without a second request.';

revoke all on function set_event_published(uuid, boolean) from public, anon;
grant execute on function set_event_published(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- portal_attendance: your own PAST history is never hidden by publish state
-- ---------------------------------------------------------------------------
-- The full definition from migration 25, with its `and e.is_published` filter
-- replaced by the bounded visibility-or-past-attendance check below (see the
-- comment at the where clause for the full reasoning, including why the
-- bound to already-happened events is load-bearing and not a nicety).
-- Everything else, including the grants, is unchanged: a member's own
-- attendance on an event that has already happened should not grow a hole
-- in it, whether that event became visible by an officer's publish, by the
-- Monday rule, or is a record against an event that never got announced at
-- all.
create or replace function portal_attendance(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_year   uuid := fn_portal_year();
  v_member record;
  v_events jsonb;
begin
  if v_year is null then
    raise exception 'No academic year is set up yet.' using errcode = 'PDS03';
  end if;

  select m.id, m.display_name
    into v_member
  from members m
  join member_enrollments me
    on me.member_id = m.id
   and me.academic_year_id = v_year
  where m.id = p_member_id
    and m.archived_at is null
    and m.merged_into_id is null;

  if v_member.id is null then
    raise exception 'Nobody by that name is on this years roster.' using errcode = 'PDS03';
  end if;

  with mine as (
    select distinct on (a.event_id)
           a.event_id,
           a.id as attendance_id,
           a.status
    from attendance_records a
    join events e on e.id = a.event_id
    where a.member_id = v_member.id
      and e.academic_year_id = v_year
    order by a.event_id,
             (a.status <> 'rejected') desc,
             a.submitted_at desc
  )
  select coalesce(jsonb_agg(event_row order by occurred_on desc, title, event_id), '[]'::jsonb)
    into v_events
  from (
    select e.id as event_id,
           e.title,
           e.occurred_on,
           jsonb_build_object(
             'id',          e.id,
             'title',       e.title,
             'occurred_on', e.occurred_on,
             'starts_at',   e.starts_at,
             'ends_at',     e.ends_at,
             'status',      case
                              when mine.status = 'approved' then 'attended'
                              when mine.status = 'pending'  then 'waiting'
                              when mine.status = 'rejected' then 'declined'
                              when e.occurred_on > current_date
                                or (e.checkin_closes_at is not null
                                    and e.checkin_closes_at > now())
                                then 'upcoming'
                              else 'none'
                            end,
             'categories', coalesce(categories.items, '[]'::jsonb)
           ) as event_row
    from events e
    left join mine on mine.event_id = e.id
    left join lateral (
      select jsonb_agg(
               jsonb_build_object(
                 'id',     c.id,
                 'name',   c.name,
                 'credit', case when mine.status = 'approved' then vc.credit else null end
               ) order by c.sort_order, c.name
             ) as items
      from event_categories ec
      join categories c on c.id = ec.category_id
      left join v_attendance_credit vc
        on vc.attendance_id = mine.attendance_id
       and vc.category_id = ec.category_id
      where ec.event_id = e.id
    ) categories on true
    where e.academic_year_id = v_year
      -- Visibility gates whether the club has ANNOUNCED an event to a
      -- member who has not engaged with it. It has no business hiding the
      -- record of something they actually did: the credit views
      -- (v_attendance_credit, v_member_category_totals, v_member_status)
      -- never filter on is_published, so an approved attendance already
      -- counts toward the members point total and honorary status
      -- regardless of visibility. Filtering this list on visibility alone
      -- would let an event stay silently invisible here (the "publishes
      -- after the event" case is exactly this: never auto-released, and if
      -- nobody publishes it by hand, it never appears) while its points
      -- keep counting, which is a total with no row anywhere to explain it.
      -- So an event this member has a live attendance row against is part
      -- of their own history and appears once it has actually happened,
      -- regardless of announcement; an event they have no record against
      -- appears only once the club has announced it. This asymmetry is
      -- deliberate, not a gap, and it does not widen what the portal
      -- exposes: a member could already see every one of their own
      -- attendance rows, and portal_events() below stays filtered on
      -- visibility alone.
      --
      -- THE SECOND HALF, e.occurred_on <= today, IS LOAD-BEARING AND NOT
      -- OPTIONAL. Check-in has no gate on occurred_on: a member can check
      -- into a queued event dated next week the moment the QR code exists
      -- (see fn_checkin_event() above). portal_attendance() is callable by
      -- anon with any member_id, and portal_leaderboard() hands out every
      -- member_id there is, so "or mine.attendance_id is not null" with no
      -- date bound would let anyone read next week's unannounced event off
      -- of whoever's attendance record exists for it, which defeats the
      -- Monday-drop fairness rule this whole feature exists to enforce.
      -- Bounding the own-record branch to events that have already
      -- happened closes that leak while still fixing the reconciliation
      -- problem above, because that problem only ever concerns an event
      -- that is already in the past.
      and (
        fn_event_is_visible(e.is_published, e.release_at)
        or (
          mine.attendance_id is not null
          and e.occurred_on <= (now() at time zone 'America/New_York')::date
        )
      )
  ) rows_for_year;

  return jsonb_build_object(
    'year', (select jsonb_build_object('id', y.id, 'label', y.label)
             from academic_years y where y.id = v_year),
    'member', jsonb_build_object('id', v_member.id,
                                 'display_name', v_member.display_name),
    -- The export-ready scorecard is evaluated inside this stable RPC call, so
    -- it shares the statement snapshot with the attendance rows. The client
    -- may draw portal_scorecard() first for speed, but replaces it with this
    -- copy before enabling the download.
    'scorecard', portal_scorecard(v_member.id),
    'events', v_events
  );
end
$$;

comment on function portal_attendance(uuid) is
  'Public. One row per visible event of the current academic year, plus any already-past event this member has a live attendance record against regardless of its publish state, with actual times, member status, grouped category credit and an atomic public scorecard snapshot. A future, unannounced event this member checked into stays hidden until its date passes, so an anonymous caller who only has a member id cannot read next weeks queued event off of it. No private member or review fields.';

revoke all on function portal_attendance(uuid) from public, anon, authenticated;

grant execute on function portal_attendance(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- portal_events: the public /events page, no name typed, no login
-- ---------------------------------------------------------------------------
-- Invariant 3 holds here exactly as it does for every other portal function:
-- this touches no table directly, and an anonymous caller reaches it only
-- through this SECURITY DEFINER RPC. It answers a narrower question than
-- portal_attendance() and asks for nothing to answer it: every visible event
-- of the current academic year that has not already happened, the eight
-- facts the page shows, and nothing about any member.
create or replace function portal_events()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_year   uuid := fn_portal_year();
  v_events jsonb;
begin
  if v_year is null then
    raise exception 'No academic year is set up yet.' using errcode = 'PDS03';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',          e.id,
             'title',       e.title,
             'occurred_on', e.occurred_on,
             'starts_at',   e.starts_at,
             'ends_at',     e.ends_at,
             'location',    e.location,
             'attire',      e.attire,
             'signup',      e.signup,
             'description', e.description,
             'categories',  coalesce(categories.items, '[]'::jsonb)
           )
           order by e.occurred_on asc, e.starts_at asc nulls last, e.title
         ), '[]'::jsonb)
    into v_events
  from events e
  left join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'id',           c.id,
               'name',         c.name,
               'credit_mode',  ec.credit_mode,
               'fixed_credit', ec.fixed_credit
             ) order by c.sort_order, c.name
           ) as items
    from event_categories ec
    join categories c on c.id = ec.category_id
    where ec.event_id = e.id
  ) categories on true
  where e.academic_year_id = v_year
    and fn_event_is_visible(e.is_published, e.release_at)
    and e.occurred_on >= (now() at time zone 'America/New_York')::date;

  return jsonb_build_object(
    'year', (select jsonb_build_object('id', y.id, 'label', y.label)
             from academic_years y where y.id = v_year),
    'events', v_events
  );
end
$$;

comment on function portal_events() is
  'Public, no name required. Every visible event of the current academic year dated today or later: the eight facts the /events page shows, plus its categories. No member, no attendance, no note, no token, and no unpublished event.';

revoke all on function portal_events() from public, anon, authenticated;
grant execute on function portal_events() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- v_config_warnings: two clauses were gating on the wrong thing
-- ---------------------------------------------------------------------------
-- Both event_without_category and event_without_enrolled_members filtered on
-- e.is_published, back when every event carried it true and the clause was a
-- no-op. Now that is_published means "announced on the public page", that
-- filter would silence both warnings for exactly the events that need them
-- most: a queued event with no categories still earns its attendees nothing,
-- and a queued event days out against an empty roster is the empty-roster
-- case event_without_enrolled_members exists for, whether or not an officer
-- has clicked Publish yet. Whether an event has been announced has no
-- bearing on either failure, so the condition is dropped from both rather
-- than swapped for fn_event_is_visible(), which would only reintroduce the
-- same silence for a queued, not-yet-dropped event.
--
-- Full view redefinition: CREATE OR REPLACE VIEW needs the whole query, and
-- this is every other clause unchanged from migration 09
-- (20260811100900_views_and_functions.sql). The message on
-- event_without_category also drops "Published", which stopped being
-- accurate, and is shortened to match house style.
create or replace view v_config_warnings with (security_invoker = true) as
  -- An active category that no published rule measures. This is the shape of
  -- "we added a category and forgot to give it a requirement".
  select 'category_without_rule'::text as code,
         'warning'::text               as severity,
         'category'::text              as subject_type,
         c.id                          as subject_id,
         c.name                        as subject_label,
         'Active category with no rule in the current years published requirement set.'::text as detail
  from categories c
  cross join lateral (select id from academic_years where is_current limit 1) ay
  where c.archived_at is null
    and not exists (
      select 1
      from requirement_node_categories rnc
      join requirement_nodes n  on n.id = rnc.node_id
      join requirement_sets  rs on rs.id = n.requirement_set_id
      where rnc.category_id = c.id
        and rs.academic_year_id = ay.id
        and rs.status = 'published'
    )

  union all

  -- A published rule still pointing at a category somebody archived. This is
  -- the #REF! tab, caught before anyone notices a wrong total.
  select 'rule_on_archived_category', 'error', 'requirement_node', n.id, n.label,
         'Requirement node measures category "' || c.name || '", which is archived.'
  from requirement_nodes n
  join requirement_node_categories rnc on rnc.node_id = n.id
  join categories       c  on c.id  = rnc.category_id
  join requirement_sets rs on rs.id = n.requirement_set_id
  where c.archived_at is not null
    and rs.status = 'published'

  union all

  -- An event nobody gets credit for. Not conditioned on is_published: a
  -- queued event with no categories will still earn its attendees nothing
  -- the moment it is published or dropped, so it needs the warning now.
  select 'event_without_category', 'error', 'event', e.id, e.title,
         'No categories: attending this event earns nothing.'
  from events e
  where not exists (select 1 from event_categories ec where ec.event_id = e.id)

  union all

  -- Asking for a photo and then not looking at it.
  select 'auto_approve_with_evidence', 'warning', 'event', e.id, e.title,
         'Event requires evidence but is set to auto-approve, so nobody will ever look at it.'
  from events e
  where e.review_policy = 'auto_approve'
    and exists (
      select 1 from event_evidence_requirements r
      where r.event_id = e.id and r.is_required
    )

  union all

  -- A year that cannot compute honorary status at all.
  select 'year_without_published_ruleset', 'error', 'academic_year', ay.id, ay.label,
         'Current academic year has no published requirement set, so nobody can qualify.'
  from academic_years ay
  where ay.is_current
    and fn_published_requirement_set(ay.id) is null

  union all

  -- A group with no children passes vacuously, which is almost never intended.
  select 'empty_group_node', 'warning', 'requirement_node', n.id, n.label,
         'Group node has no children, so it passes for everybody.'
  from requirement_nodes n
  join requirement_sets rs on rs.id = n.requirement_set_id
  where n.type = 'group'
    and rs.status = 'published'
    and not exists (select 1 from requirement_nodes k where k.parent_id = n.id)

  union all

  -- An event about to happen against an empty roster. The system ships with
  -- no members, so this is the state it starts in, and the failure it causes
  -- is silent: check-in still works, but every attendee falls through "I don't
  -- see my name" and lands in the review queue as an unmatched row for an
  -- officer to resolve by hand, one at a time, afterwards.
  --
  -- Telling them beforehand costs one banner. Discovering it afterwards costs
  -- an evening. Not conditioned on is_published, for the same reason as
  -- event_without_category above: a queued event three days out against an
  -- empty roster is exactly the case this warning exists for.
  select 'event_without_enrolled_members', 'error', 'event', e.id, e.title,
         'Nobody is enrolled in this events academic year, so every attendee will '
         || 'check in as an unmatched name. Load the roster with scripts/import_roster.py '
         || 'before the event.'
  from events e
  where (
      -- check-in is open now
      (e.checkin_opens_at is not null and e.checkin_opens_at <= now()
        and (e.checkin_closes_at is null or e.checkin_closes_at >= now()))
      -- or the event is coming up soon, including one with no window set yet
      or e.occurred_on between current_date and current_date + 7
    )
    and not exists (
      select 1 from member_enrollments me
      where me.academic_year_id = e.academic_year_id and me.status = 'active'
    )

  union all

  -- Storage being consumed by uploads nothing points at. One aggregate row
  -- rather than one per object, because the operator action is a single
  -- button and the per-object detail lives in v_orphaned_uploads.
  select 'orphaned_uploads', 'warning', 'storage', null,
         count(*)::text || ' abandoned upload(s)',
         'Photos were uploaded but never submitted, so no attendance record points at them. '
         || 'Run purge_orphaned_uploads() to reclaim them.'
  from v_orphaned_uploads
  where object_exists
  having count(*) > 0;

comment on view v_config_warnings is
  'Live configuration problems an officer should fix, computed rather than checked at save time. event_without_category and event_without_enrolled_members are deliberately not gated on is_published: whether an event has been announced has no bearing on whether it will fail either way.';
