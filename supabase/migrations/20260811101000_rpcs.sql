-- ===========================================================================
-- 10. RPCs
-- ===========================================================================
-- The anonymous check-in page touches no table. It calls four SECURITY
-- DEFINER functions, and none of them lets the caller choose a status.
--
-- Officer operations are RPCs too, so each one is a single audited
-- transaction rather than a sequence of table writes that a half-finished UI
-- could leave inconsistent.
--
-- Error codes, so a client can tell these apart without string matching:
--   PDS01  unknown, rotated or unpublished check-in token
--   PDS02  check-in is not open (too early, or past the grace period)
--   PDS03  bad argument (search too short, missing required value, ...)
--   PDS04  required evidence missing or an upload grant is not valid
--   PDS05  already checked in to this event
--   PDS06  cannot approve a record that is not linked to a member
--   PDS07  caller lacks the required role
--   PDS08  unknown requirement set
--   PDS09  rate limited
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 10.0 Shared token resolution
-- ---------------------------------------------------------------------------

create or replace function fn_checkin_event(p_token text, p_enforce_window boolean)
returns events
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event   events;
  v_grace   int;
begin
  select * into v_event
  from events e
  where e.checkin_token = p_token and e.is_published;

  if v_event.id is null then
    raise exception 'That check-in link is not valid.' using errcode = 'PDS01';
  end if;

  if p_enforce_window then
    if v_event.checkin_opens_at is not null and now() < v_event.checkin_opens_at then
      raise exception 'Check-in for this event has not opened yet.' using errcode = 'PDS02';
    end if;
    if v_event.checkin_closes_at is not null and now() > v_event.checkin_closes_at then
      raise exception 'Check-in for this event has closed.' using errcode = 'PDS02';
    end if;
  else
    -- submit_checkin() is more forgiving than get_checkin_context(): somebody
    -- who opened the page thirty seconds before the deadline should still get
    -- through, flagged rather than turned away. Past the grace period it is a
    -- hard refusal, so a photographed QR code is not usable next week.
    v_grace := fn_setting_int('checkin_grace_minutes', 60);
    if v_event.checkin_opens_at is not null and now() < v_event.checkin_opens_at then
      raise exception 'Check-in for this event has not opened yet.' using errcode = 'PDS02';
    end if;
    if v_event.checkin_closes_at is not null
       and now() > v_event.checkin_closes_at + make_interval(mins => v_grace) then
      raise exception 'Check-in for this event has closed.' using errcode = 'PDS02';
    end if;
  end if;

  return v_event;
end
$$;

-- ---------------------------------------------------------------------------
-- 10.1 get_checkin_context(token)
-- ---------------------------------------------------------------------------
-- Everything the check-in page needs to render itself, and nothing else. No
-- roster, no attendee list, no member emails.
-- ---------------------------------------------------------------------------

create or replace function get_checkin_context(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event events;
  v_out   jsonb;
begin
  v_event := fn_checkin_event(p_token, true);

  select jsonb_build_object(
    'event', jsonb_build_object(
      'id',          v_event.id,
      'title',       v_event.title,
      'occurred_on', v_event.occurred_on,
      'location',    v_event.location,
      'closes_at',   v_event.checkin_closes_at
    ),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',   c.id,
               'name', c.name,
               'unit', c.unit
             ) order by c.sort_order, c.name)
      from event_categories ec
      join categories c on c.id = ec.category_id
      where ec.event_id = v_event.id
    ), '[]'::jsonb),
    -- Non-null when the form has to collect a number, and it says which
    -- category the number is for and how to label the field.
    'collect_value', (
      select jsonb_build_object(
               'category_id', c.id,
               'category',    c.name,
               'unit',        c.unit,
               'unit_label',  coalesce(c.unit_label, c.unit::text)
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

-- ---------------------------------------------------------------------------
-- 10.2 search_members(token, q)
-- ---------------------------------------------------------------------------
-- Identify yourself by name without logging in. Returns id and display name
-- only, at most ten rows, and never an email address or the full roster.
-- ---------------------------------------------------------------------------

create or replace function search_members(p_token text, p_q text)
returns table (id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event events;
  v_q     text := btrim(coalesce(p_q, ''));
begin
  v_event := fn_checkin_event(p_token, true);

  if length(v_q) < 3 then
    raise exception 'Type at least three letters of your name.' using errcode = 'PDS03';
  end if;

  perform fn_rate_limit_hit(
    'search_members:' || p_token,
    fn_setting_int('search_members_max_per_min', 60)
  );

  return query
    select m.id, m.display_name
    from members m
    where m.archived_at is null
      and m.merged_into_id is null
      and (m.display_name ilike '%' || v_q || '%'
           or m.display_name % v_q)
    order by
      -- exact prefix first, then trigram closeness, then alphabetical
      (lower(m.display_name) like lower(v_q) || '%') desc,
      similarity(m.display_name, v_q) desc,
      m.display_name
    limit 10;
end
$$;

-- ---------------------------------------------------------------------------
-- 10.3 create_evidence_upload(token, member_id, kind)
-- ---------------------------------------------------------------------------
-- Validates that this event actually asks for this kind of evidence, then
-- reserves exactly one object path and returns a one-shot grant for it. See
-- the note in migration 08 for why this is a grant rather than a signed URL.
-- ---------------------------------------------------------------------------

create or replace function create_evidence_upload(
  p_token     text,
  p_member_id uuid,
  p_kind      evidence_kind_t
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event  events;
  v_grant  evidence_upload_grants;
  v_path   text;
begin
  v_event := fn_checkin_event(p_token, true);

  if not exists (
    select 1 from event_evidence_requirements r
    where r.event_id = v_event.id and r.kind = p_kind
  ) then
    raise exception 'This event does not collect that kind of photo.' using errcode = 'PDS04';
  end if;

  if p_member_id is not null and not exists (
    select 1 from members m
    where m.id = p_member_id and m.archived_at is null and m.merged_into_id is null
  ) then
    raise exception 'Unknown member.' using errcode = 'PDS03';
  end if;

  v_path := v_event.academic_year_id::text || '/' || v_event.id::text || '/'
            || p_kind::text || '/' || encode(gen_random_bytes(16), 'hex') || '.jpg';

  insert into evidence_upload_grants (event_id, member_id, kind, object_path, expires_at)
  values (v_event.id, p_member_id, p_kind, v_path, now() + interval '30 minutes')
  returning * into v_grant;

  return jsonb_build_object(
    'upload_token', v_grant.token,
    'bucket',       v_grant.bucket_id,
    'object_path',  v_grant.object_path,
    'expires_at',   v_grant.expires_at
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 10.4 submit_checkin(...)
-- ---------------------------------------------------------------------------
-- Files the record and computes its triage flags. Forces status = 'pending'
-- and source = 'self_checkin'. There is no argument by which a caller can
-- choose either one: that is the whole reason the anonymous page goes through
-- an RPC instead of an insert policy.
--
-- p_evidence is a JSON array of
--   { "upload_token": "...", "sha256": "...", "content_type": "...",
--     "byte_size": 12345 }
-- ---------------------------------------------------------------------------

create or replace function submit_checkin(
  p_token         text,
  p_member_id     uuid    default null,
  p_claimed_name  text    default null,
  p_claimed_email text    default null,
  p_value         numeric default null,
  p_evidence      jsonb   default '[]'::jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event        events;
  v_member       members;
  v_flags        text[] := '{}';
  v_record_id    uuid;
  v_needs_value  boolean;
  v_sim          numeric;
  v_ev           jsonb;
  v_grant        evidence_upload_grants;
  v_given_kinds  evidence_kind_t[] := '{}';
  v_missing      int;
begin
  v_event := fn_checkin_event(p_token, false);

  perform fn_rate_limit_hit(
    'submit_checkin:' || p_token,
    fn_setting_int('submit_checkin_max_per_min', 120)
  );

  -- ---- who is this -------------------------------------------------------
  if p_member_id is not null then
    select * into v_member from members m
    where m.id = p_member_id and m.archived_at is null and m.merged_into_id is null;

    if v_member.id is null then
      raise exception 'Unknown member.' using errcode = 'PDS03';
    end if;
  elsif btrim(coalesce(p_claimed_name, '')) = '' then
    raise exception 'Pick your name from the list, or tell us your full name.'
      using errcode = 'PDS03';
  else
    v_flags := v_flags || 'unmatched_name'::text;
  end if;

  -- ---- does this event collect a number ----------------------------------
  select exists (
    select 1 from event_categories ec
    where ec.event_id = v_event.id and ec.credit_mode = 'from_submission'
  ) into v_needs_value;

  if v_needs_value and p_value is null then
    raise exception 'This event needs a number (hours, for example) before it can be submitted.'
      using errcode = 'PDS03';
  end if;
  if v_needs_value and p_value < 0 then
    raise exception 'That value cannot be negative.' using errcode = 'PDS03';
  end if;
  if not v_needs_value then
    p_value := null;   -- ignore a value nobody asked for
  end if;

  -- ---- triage flags ------------------------------------------------------

  if v_event.checkin_closes_at is not null and now() > v_event.checkin_closes_at then
    v_flags := v_flags || 'outside_window'::text;
  end if;

  if v_member.id is not null then
    if not exists (
      select 1 from member_enrollments me
      where me.member_id = v_member.id
        and me.academic_year_id = v_event.academic_year_id
        and me.status = 'active'
    ) then
      v_flags := v_flags || 'not_enrolled'::text;
    end if;

    if exists (
      select 1 from attendance_records a
      where a.event_id = v_event.id and a.member_id = v_member.id and a.status = 'rejected'
    ) then
      v_flags := v_flags || 'previously_rejected'::text;
    end if;

    -- Somebody else on the roster whose name is close enough that the wrong
    -- one may well have been tapped.
    v_sim := fn_setting_numeric('duplicate_name_similarity', 0.62);
    if exists (
      select 1 from members o
      where o.id <> v_member.id
        and o.archived_at is null
        and o.merged_into_id is null
        and similarity(o.display_name, v_member.display_name) >= v_sim
    ) then
      v_flags := v_flags || 'possible_duplicate_person'::text;
    end if;
  end if;

  -- ---- the record itself -------------------------------------------------

  begin
    insert into attendance_records (
      event_id, member_id, claimed_name, claimed_email,
      status, source, submitted_value, flags
    ) values (
      v_event.id,
      v_member.id,
      nullif(btrim(coalesce(p_claimed_name, '')), ''),
      nullif(btrim(coalesce(p_claimed_email, '')), ''),
      'pending',          -- forced, never an argument
      'self_checkin',     -- forced, never an argument
      p_value,
      v_flags
    )
    returning id into v_record_id;
  exception when unique_violation then
    raise exception 'You are already checked in to this event.' using errcode = 'PDS05';
  end;

  -- ---- evidence ----------------------------------------------------------

  for v_ev in select * from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb))
  loop
    select * into v_grant
    from evidence_upload_grants g
    where g.token = (v_ev ->> 'upload_token')
      and g.event_id = v_event.id
      and g.consumed_at is null
      and g.expires_at > now()
    for update;

    if v_grant.id is null then
      raise exception 'That photo upload is no longer valid. Please retake it.'
        using errcode = 'PDS04';
    end if;

    update evidence_upload_grants set consumed_at = now() where id = v_grant.id;

    insert into attendance_evidence (
      attendance_record_id, kind, provider, object_path,
      content_type, byte_size, sha256
    ) values (
      v_record_id, v_grant.kind, 'supabase', v_grant.object_path,
      v_ev ->> 'content_type',
      nullif(v_ev ->> 'byte_size', '')::int,
      nullif(v_ev ->> 'sha256', '')
    );

    v_given_kinds := v_given_kinds || v_grant.kind;

    -- The same image, already submitted against a different event.
    if (v_ev ->> 'sha256') is not null and exists (
      select 1
      from attendance_evidence ae
      join attendance_records ar on ar.id = ae.attendance_record_id
      where ae.sha256 = (v_ev ->> 'sha256')
        and ar.event_id <> v_event.id
    ) then
      v_flags := array(select distinct unnest(v_flags || 'duplicate_photo'::text));
    end if;
  end loop;

  select count(*) into v_missing
  from event_evidence_requirements r
  where r.event_id = v_event.id
    and r.is_required
    and not (r.kind = any (v_given_kinds));

  if v_missing > 0 then
    v_flags := array(select distinct unnest(v_flags || 'missing_evidence'::text));
  end if;

  update attendance_records set flags = v_flags where id = v_record_id;

  return jsonb_build_object(
    'record_id', v_record_id,
    'status',    'pending',
    'flags',     to_jsonb(v_flags)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 10.5 review_records(ids, decision, note)
-- ---------------------------------------------------------------------------

create or replace function review_records(
  p_ids      uuid[],
  p_decision text,
  p_note     text default null
) returns int
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_status attendance_status_t;
  v_count  int;
  v_bad    int;
begin
  perform fn_assert_officer();

  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject.' using errcode = 'PDS03';
  end if;

  v_status := case p_decision when 'approve' then 'approved' else 'rejected' end;

  if v_status = 'approved' then
    select count(*) into v_bad
    from attendance_records a
    where a.id = any (p_ids) and a.member_id is null;

    if v_bad > 0 then
      raise exception
        'Cannot approve % record(s) that are not linked to a member. Resolve the unmatched name first.',
        v_bad using errcode = 'PDS06';
    end if;
  end if;

  begin
    with updated as (
      update attendance_records a
      set status      = v_status,
          reviewed_by = auth.uid(),
          reviewed_at = now(),
          review_note = coalesce(p_note, a.review_note)
      where a.id = any (p_ids)
      returning a.id
    )
    select count(*) into v_count from updated;
  exception when unique_violation then
    raise exception 'That member already has a live record for this event.'
      using errcode = 'PDS05';
  end;

  perform fn_audit('review_records', 'attendance_record', null,
                   jsonb_build_object('decision', p_decision,
                                      'count', v_count,
                                      'ids', to_jsonb(p_ids),
                                      'note', p_note));
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- 10.6 resolve_unmatched(record_id, member_id | new_member)
-- ---------------------------------------------------------------------------
-- Links a claimed name to a real member, or creates the member on the spot.
-- Deliberately does NOT approve the record: resolving who somebody is and
-- deciding whether they get credit are two different judgements, and the
-- design says every record is approved by a person.
-- ---------------------------------------------------------------------------

create or replace function resolve_unmatched(
  p_record_id  uuid,
  p_member_id  uuid  default null,
  p_new_member jsonb default null
) returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_record    attendance_records;
  v_event     events;
  v_member_id uuid;
begin
  perform fn_assert_officer();

  select * into v_record from attendance_records a where a.id = p_record_id;
  if v_record.id is null then
    raise exception 'Unknown attendance record.' using errcode = 'PDS03';
  end if;
  if v_record.member_id is not null then
    raise exception 'That record is already linked to a member.' using errcode = 'PDS03';
  end if;

  select * into v_event from events e where e.id = v_record.event_id;

  if p_member_id is not null then
    v_member_id := p_member_id;
    if not exists (select 1 from members m where m.id = v_member_id) then
      raise exception 'Unknown member.' using errcode = 'PDS03';
    end if;
  elsif p_new_member is not null then
    insert into members (first_name, last_name, email)
    values (
      btrim(p_new_member ->> 'first_name'),
      btrim(p_new_member ->> 'last_name'),
      nullif(btrim(coalesce(p_new_member ->> 'email', '')), '')::citext
    )
    returning id into v_member_id;
  else
    raise exception 'Give either an existing member id or the details for a new one.'
      using errcode = 'PDS03';
  end if;

  -- Whoever they turned out to be, they are on this year's roster now.
  insert into member_enrollments (member_id, academic_year_id)
  values (v_member_id, v_event.academic_year_id)
  on conflict do nothing;

  begin
    update attendance_records
    set member_id = v_member_id,
        flags     = array_remove(flags, 'unmatched_name')
    where id = p_record_id;
  exception when unique_violation then
    raise exception 'That member already has a live record for this event.'
      using errcode = 'PDS05';
  end;

  perform fn_audit('resolve_unmatched', 'attendance_record', p_record_id,
                   jsonb_build_object('member_id', v_member_id,
                                      'created_member', p_new_member is not null,
                                      'claimed_name', v_record.claimed_name));
  return v_member_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 10.7 merge_members(from_id, into_id)
-- ---------------------------------------------------------------------------
-- Moves every record to the survivor, drops the per-event collisions the
-- survivor already had, tombstones the loser and writes member_merges.
-- ---------------------------------------------------------------------------

create or replace function merge_members(p_from_id uuid, p_into_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_moved   int := 0;
  v_dropped int := 0;
  v_merge   uuid;
begin
  perform fn_assert_officer();

  if p_from_id = p_into_id then
    raise exception 'Cannot merge a member into themselves.' using errcode = 'PDS03';
  end if;
  if not exists (select 1 from members where id = p_from_id)
     or not exists (select 1 from members where id = p_into_id) then
    raise exception 'Unknown member.' using errcode = 'PDS03';
  end if;

  -- Collisions first: where the survivor already holds a live record for the
  -- same event, the duplicate cannot be moved, so it goes.
  with collisions as (
    delete from attendance_records a
    where a.member_id = p_from_id
      and a.status <> 'rejected'
      and exists (
        select 1 from attendance_records b
        where b.member_id = p_into_id
          and b.event_id = a.event_id
          and b.status <> 'rejected'
      )
    returning a.id
  )
  select count(*) into v_dropped from collisions;

  with moved as (
    update attendance_records a
    set member_id = p_into_id
    where a.member_id = p_from_id
    returning a.id
  )
  select count(*) into v_moved from moved;

  insert into member_enrollments (member_id, academic_year_id, status, joined_on)
  select p_into_id, me.academic_year_id, me.status, me.joined_on
  from member_enrollments me
  where me.member_id = p_from_id
  on conflict (member_id, academic_year_id) do nothing;

  delete from member_enrollments where member_id = p_from_id;

  update members
  set merged_into_id = p_into_id,
      archived_at    = coalesce(archived_at, now())
  where id = p_from_id;

  insert into member_merges (from_member_id, into_member_id, moved_records,
                             dropped_records, performed_by)
  values (p_from_id, p_into_id, v_moved, v_dropped, auth.uid())
  returning id into v_merge;

  perform fn_audit('merge_members', 'member', p_into_id,
                   jsonb_build_object('from_member_id', p_from_id,
                                      'moved', v_moved,
                                      'dropped', v_dropped));

  return jsonb_build_object('merge_id', v_merge, 'moved', v_moved, 'dropped', v_dropped);
end
$$;

-- ---------------------------------------------------------------------------
-- 10.8 purge_evidence(retention_months)
-- ---------------------------------------------------------------------------
-- Eligibility is deliberately narrow: a photo can only go when its record has
-- actually been reviewed, and its event is older than the window. An
-- unreviewed submission can never be purged out from under the queue, no
-- matter how old it gets.
--
-- This marks the rows and returns the object paths. Removing the bytes from
-- the bucket is the caller's job, because deleting an object is a Storage API
-- call and not something SQL can do transactionally. The purge_runs row is
-- the record that it was asked for, and purged_at is what stops a second run
-- reporting the same photos again.
-- ---------------------------------------------------------------------------

create or replace function purge_evidence(p_retention_months int default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_months int;
  v_run_id uuid;
  v_count  int    := 0;
  v_bytes  bigint := 0;
  v_paths  text[] := '{}';
  v_events uuid[] := '{}';
begin
  perform fn_assert_officer();

  v_months := coalesce(p_retention_months, fn_setting_int('evidence_retention_months', 12));
  if v_months < 1 then
    raise exception 'Retention window must be at least one month.' using errcode = 'PDS03';
  end if;

  create temporary table _purge_eligible on commit drop as
  select ae.id, ae.object_path, coalesce(ae.byte_size, 0) as byte_size, e.id as event_id
  from attendance_evidence ae
  join attendance_records ar on ar.id = ae.attendance_record_id
  join events e              on e.id  = ar.event_id
  where ae.purged_at is null
    and ae.object_path is not null
    and ar.status in ('approved', 'rejected')
    and e.occurred_on < (current_date - make_interval(months => v_months));

  select count(*), coalesce(sum(byte_size), 0),
         coalesce(array_agg(object_path), '{}'),
         coalesce(array_agg(distinct event_id), '{}')
    into v_count, v_bytes, v_paths, v_events
  from _purge_eligible;

  insert into purge_runs (performed_by, retention_months, evidence_count, bytes_freed, event_ids)
  values (auth.uid(), v_months, v_count, v_bytes, v_events)
  returning id into v_run_id;

  update attendance_evidence ae
  set purged_at = now(), purge_run_id = v_run_id
  where ae.id in (select id from _purge_eligible);

  drop table _purge_eligible;

  perform fn_audit('purge_evidence', 'purge_run', v_run_id,
                   jsonb_build_object('retention_months', v_months,
                                      'evidence_count', v_count,
                                      'bytes_freed', v_bytes));

  return jsonb_build_object(
    'purge_run_id',   v_run_id,
    'evidence_count', v_count,
    'bytes_freed',    v_bytes,
    'event_ids',      to_jsonb(v_events),
    'object_paths',   to_jsonb(v_paths)
  );
end
$$;
