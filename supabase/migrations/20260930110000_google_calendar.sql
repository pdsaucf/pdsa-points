-- ===========================================================================
-- 31. THE MEMBER CALENDAR
-- ===========================================================================
-- docs/10-google-calendar.md. Every event that goes live on /events is posted
-- to the club's public Google Calendar, kept in step when it is edited, and
-- taken off when it is unpublished or deleted. Nobody copies events across by
-- hand any more.
--
-- THE CALENDAR IS A SETTING, NOT A SECRET. Each board makes a new calendar
-- for its year. Settings, Connections holds which calendar events go to, and
-- switching it moves the upcoming events across on the next run; events that
-- already happened stay on the old calendar as that year's record. Only the
-- service account's key is a server secret, and it is set up once.
--
-- THE SYNC IS COMPUTED. Nothing is queued. calendar_sync_plan() compares
-- what is live now with what was last posted (calendar_posted_to and the
-- config_version posted) and answers what to add, change and remove. The
-- sync-calendar Edge Function runs it every five minutes, does the Google
-- side, and reports back. A run that dies halfway is simply finished by the
-- next one: Google event ids are derived from the event id, so posting the
-- same event twice updates it rather than duplicating it.
begin;
set local search_path = public, extensions, pg_temp;

alter table events
  add column calendar_posted_to      text,
  add column calendar_synced_version bigint,
  add column calendar_synced_at      timestamptz;

comment on column events.calendar_posted_to is
  'The Google Calendar this event is on, or null. Written only by the sync.';

-- Removals still owed: an event deleted while on a calendar, or an event
-- moved to a new calendar that still has to come off the old one. One row per
-- event and calendar, kept until Google confirms the removal, so a failed
-- removal is retried on every run rather than forgotten.
create table calendar_removals (
  event_id    uuid not null,
  calendar_id text not null,
  created_at  timestamptz not null default now(),
  primary key (event_id, calendar_id)
);

-- Writes in flight: recorded before the sync calls Google and cleared when
-- the write is acknowledged. One left behind means Google may hold an event
-- the database never heard about (the run died after Google accepted it).
-- After ten minutes it is treated as a removal owed; if the event is still
-- live on that calendar, the same run posts it again straight after.
create table calendar_pending (
  event_id    uuid not null,
  calendar_id text not null,
  created_at  timestamptz not null default now(),
  primary key (event_id, calendar_id)
);

alter table calendar_pending enable row level security;
revoke all on calendar_pending from public, anon, authenticated;
grant all on calendar_pending to service_role;

alter table calendar_removals enable row level security;
revoke all on calendar_removals from public, anon, authenticated;
grant all on calendar_removals to service_role;

create function fn_event_calendar_removal_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if old.calendar_posted_to is not null then
    insert into calendar_removals (event_id, calendar_id)
    values (old.id, old.calendar_posted_to)
    on conflict do nothing;
  end if;
  -- A write in flight to any calendar may have landed: owed too.
  insert into calendar_removals (event_id, calendar_id)
  select event_id, calendar_id from calendar_pending where event_id = old.id
  on conflict do nothing;
  delete from calendar_pending where event_id = old.id;
  return old;
end
$$;

revoke all on function fn_event_calendar_removal_after_delete() from public, anon, authenticated;

create trigger events_calendar_removal_after_delete
  after delete on events
  for each row execute function fn_event_calendar_removal_after_delete();

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
-- google_calendar_id       which calendar, as a JSON string ('' for none)
-- google_calendar_enabled  posting on or off
-- calendar_status          written by the sync on every run
-- email_status             written by send-signup-emails on every run
insert into app_settings (key, value) values
  ('google_calendar_id', '""'::jsonb),
  ('google_calendar_enabled', 'false'::jsonb),
  ('calendar_status', '{}'::jsonb),
  ('email_status', '{}'::jsonb)
on conflict (key) do nothing;

alter table app_settings
  add constraint google_calendar_id_is_text
    check (key <> 'google_calendar_id' or (jsonb_typeof(value) = 'string' and length(value #>> '{}') <= 300)),
  add constraint google_calendar_enabled_is_boolean
    check (key <> 'google_calendar_enabled' or jsonb_typeof(value) = 'boolean'),
  add constraint integration_status_is_object
    check (key not in ('calendar_status', 'email_status') or jsonb_typeof(value) = 'object');

-- ---------------------------------------------------------------------------
-- What the sync should do now
-- ---------------------------------------------------------------------------
-- upserts   live events of the current year, today or later, not yet on the
--           chosen calendar or changed since they were posted.
-- deletes   events on a calendar that are no longer live, and every removal
--           still owed (deleted events, and old calendars after a switch).
-- Past events are left exactly where they are.
create function calendar_sync_plan()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_enabled  boolean := fn_setting_bool('google_calendar_enabled', false);
  v_calendar text := nullif(btrim(coalesce((select value #>> '{}' from app_settings where key = 'google_calendar_id'), '')), '');
  v_today    date := (now() at time zone 'America/New_York')::date;
  v_year     uuid := fn_portal_year();
begin
  if not v_enabled or v_calendar is null then
    return jsonb_build_object('enabled', false, 'calendar_id', v_calendar,
                              'upserts', '[]'::jsonb, 'deletes', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'enabled', true,
    'calendar_id', v_calendar,
    'upserts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id',          e.id,
               'version',           e.config_version,
               'title',             e.title,
               'occurred_on',       e.occurred_on,
               'starts_at',         e.starts_at,
               'ends_at',           e.ends_at,
               'location',          e.location,
               'attire',            e.attire,
               'description',       e.description,
               'members_only',      e.members_only,
               'signups_enabled',   e.signups_enabled
             ) order by e.occurred_on)
      from events e
      where e.academic_year_id = v_year
        and e.occurred_on >= v_today
        and fn_event_is_visible(e.is_published, e.release_at)
        and (e.calendar_posted_to is distinct from v_calendar
             or e.calendar_synced_version is distinct from e.config_version)
    ), '[]'::jsonb),
    'deletes', coalesce((
      select jsonb_agg(d) from (
        select jsonb_build_object('event_id', e.id, 'calendar_id', e.calendar_posted_to) as d
        from events e
        where e.calendar_posted_to is not null
          and e.occurred_on >= v_today
          and not fn_event_is_visible(e.is_published, e.release_at)
        union all
        select jsonb_build_object('event_id', r.event_id, 'calendar_id', r.calendar_id)
        from calendar_removals r
        union all
        select jsonb_build_object('event_id', p.event_id, 'calendar_id', p.calendar_id)
        from calendar_pending p
        where p.created_at < now() - interval '10 minutes'
      ) rows
    ), '[]'::jsonb)
  );
end
$$;

-- Google accepted the event on p_calendar_id. If it was on another calendar
-- before, that one now owes a removal. If the event was deleted while it was
-- being posted, the calendar just written owes one instead.
create function calendar_sync_posted(p_event_id uuid, p_calendar_id text, p_version bigint)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_old text;
begin
  select calendar_posted_to into v_old from events where id = p_event_id for update;
  if not found then
    insert into calendar_removals (event_id, calendar_id) values (p_event_id, p_calendar_id)
    on conflict do nothing;
    delete from calendar_pending where event_id = p_event_id;
    return;
  end if;
  if v_old is not null and v_old <> p_calendar_id then
    insert into calendar_removals (event_id, calendar_id) values (p_event_id, v_old)
    on conflict do nothing;
  end if;
  -- Posted here again after moving away and back: nothing owed here now.
  delete from calendar_removals where event_id = p_event_id and calendar_id = p_calendar_id;
  delete from calendar_pending where event_id = p_event_id and calendar_id = p_calendar_id;
  -- Writes to other calendars that never acknowledged are owed removals now.
  insert into calendar_removals (event_id, calendar_id)
  select event_id, calendar_id from calendar_pending where event_id = p_event_id
  on conflict do nothing;
  delete from calendar_pending where event_id = p_event_id;
  update events
  set calendar_posted_to = p_calendar_id,
      calendar_synced_version = p_version,
      calendar_synced_at = now()
  where id = p_event_id;
end
$$;

-- Google confirmed p_event_id is off p_calendar_id.
create function calendar_sync_removed(p_event_id uuid, p_calendar_id text)
returns void
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  delete from calendar_removals where event_id = p_event_id and calendar_id = p_calendar_id;
  delete from calendar_pending where event_id = p_event_id and calendar_id = p_calendar_id;
  update events
  set calendar_posted_to = null, calendar_synced_version = null, calendar_synced_at = now()
  where id = p_event_id and calendar_posted_to = p_calendar_id;
$$;

-- About to write p_event_id to p_calendar_id. Called before Google is.
create function calendar_sync_intent(p_event_id uuid, p_calendar_id text)
returns void
language sql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
  insert into calendar_pending (event_id, calendar_id) values (p_event_id, p_calendar_id)
  on conflict (event_id, calendar_id) do update set created_at = now();
$$;

-- The two background jobs say how their last run went, for Settings,
-- Connections. Never a key or a token: an address, a time, a count, an error.
create function report_integration_status(p_key text, p_status jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if p_key not in ('calendar_status', 'email_status') or jsonb_typeof(p_status) <> 'object' then
    raise exception 'Not a status.' using errcode = 'PDS03';
  end if;
  insert into app_settings (key, value, updated_at) values (p_key, p_status, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end
$$;

revoke all on function calendar_sync_plan() from public, anon, authenticated;
revoke all on function calendar_sync_posted(uuid, text, bigint) from public, anon, authenticated;
revoke all on function calendar_sync_removed(uuid, text) from public, anon, authenticated;
revoke all on function calendar_sync_intent(uuid, text) from public, anon, authenticated;
revoke all on function report_integration_status(text, jsonb) from public, anon, authenticated;
grant execute on function calendar_sync_plan() to service_role;
grant execute on function calendar_sync_posted(uuid, text, bigint) to service_role;
grant execute on function calendar_sync_removed(uuid, text) to service_role;
grant execute on function calendar_sync_intent(uuid, text) to service_role;
grant execute on function report_integration_status(text, jsonb) to service_role;

comment on function calendar_sync_plan() is
  'service_role only (the sync-calendar Edge Function). What to post to, change on and remove from the Member Calendar right now.';

commit;
