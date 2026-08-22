-- ===========================================================================
-- 25. ACTUAL EVENT TIMES AND ONE-ROW ATTENDANCE HISTORY
-- ===========================================================================
-- Actual event times are separate from the check-in window. They are optional
-- because existing events have no verified schedule to backfill, and duration
-- is display-only: no credit, requirement or honorary calculation reads it.
-- Location is removed because the club does not use it.

alter table events
  add column starts_at timestamptz,
  add column ends_at timestamptz;

alter table events
  add constraint event_times_both_or_neither check (
    (starts_at is null and ends_at is null)
    or (starts_at is not null and ends_at is not null)
  ),
  add constraint event_ends_after_start check (
    starts_at is null or ends_at > starts_at
  );

alter table events drop column location;

comment on column events.starts_at is
  'Verified actual event start. Separate from the check-in window and never used for credit or eligibility.';

comment on column events.ends_at is
  'Verified actual event end. Separate from the check-in window and never used for credit or eligibility.';

-- get_checkin_context previously selected events.location. This is the current
-- definition with that unused field removed. Its volatility, definer rights,
-- pinned search path, nonce limits and grant remain unchanged.
create or replace function get_checkin_context(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event events;
  v_out   jsonb;
  v_nonce text;
begin
  v_event := fn_checkin_event(p_token, true);

  perform fn_rate_limit_check(
    'nonce:' || p_token,
    fn_setting_int('checkin_nonce_max_per_min', 600)
  );

  insert into checkin_client_nonces (event_id, expires_at)
  values (v_event.id,
          now() + make_interval(mins => fn_setting_int('checkin_nonce_ttl_minutes', 240)))
  returning nonce into v_nonce;

  delete from checkin_client_nonces where expires_at < now() - interval '1 day';

  select jsonb_build_object(
    'client_nonce', v_nonce,
    'event', jsonb_build_object(
      'id',          v_event.id,
      'title',       v_event.title,
      'occurred_on', v_event.occurred_on,
      'closes_at',   v_event.checkin_closes_at
    ),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',   c.id,
               'name', c.name
             ) order by c.sort_order, c.name)
      from event_categories ec
      join categories c on c.id = ec.category_id
      where ec.event_id = v_event.id
    ), '[]'::jsonb),
    'collect_value', (
      select jsonb_build_object(
               'category_id', c.id,
               'category',    c.name
             )
      from event_categories ec
      join categories c on c.id = ec.category_id
      where ec.event_id = v_event.id and ec.credit_mode = 'from_submission'
      limit 1
    ),
    'evidence_requirements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind',        r.kind,
               'is_required', r.is_required,
               'prompt',      r.prompt
             ) order by r.kind)
      from event_evidence_requirements r
      where r.event_id = v_event.id
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end
$$;

comment on function get_checkin_context(text) is
  'Anonymous. Everything the check-in page draws for one token: the event, its categories, collected value and evidence requirements. Never a member or total.';

-- One event appears once. Categories and their approved credit are embedded in
-- that event row, which keeps multi-category credit visible without duplicating
-- the event or its duration.
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
      and e.is_published
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
  'Public. One row per published event in the current academic year, with actual times, member status, grouped category credit and an atomic public scorecard snapshot. No private member or review fields.';

revoke all on function get_checkin_context(text) from public, anon, authenticated;
revoke all on function portal_attendance(uuid) from public, anon, authenticated;

grant execute on function get_checkin_context(text) to anon, authenticated;
grant execute on function portal_attendance(uuid) to anon, authenticated, service_role;
