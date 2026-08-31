-- Event attendance pasted one name per line. A batch may mix enrolled members
-- with names that are not on the roster yet. Matched records are reviewed by
-- the officer in this transaction. Unmatched records remain pending for the
-- existing retroactive matching flow.

create or replace function add_officer_attendance_batch(
  p_event_id        uuid,
  p_entries         jsonb,
  p_submitted_value numeric default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event          events;
  v_entry          jsonb;
  v_ordinal        bigint;
  v_line           int;
  v_name           text;
  v_norm_name      text;
  v_disposition    text;
  v_member_id      uuid;
  v_member         members;
  v_record_id      uuid;
  v_existing_id    uuid;
  v_wants_value    boolean;
  v_recheck        boolean;
  v_results        jsonb := '[]'::jsonb;
  v_approve_ids    uuid[] := '{}';
  v_seen_members   uuid[] := '{}';
  v_seen_names     text[] := '{}';
  v_added          int := 0;
  v_waiting        int := 0;
  v_approved       int;
  v_batch_key      text;
begin
  perform fn_assert_officer();

  if p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) = 0 then
    raise exception 'Paste at least one name.' using errcode = 'PDS03';
  end if;
  if jsonb_array_length(p_entries) > 500 then
    raise exception 'Paste no more than 500 names at once.' using errcode = 'PDS03';
  end if;
  v_batch_key := nullif(p_entries->0->>'batch_key', '');

  select * into v_event from events e where e.id = p_event_id for update;
  if v_event.id is null then
    raise exception 'Unknown event.' using errcode = 'PDS03';
  end if;

  perform 1 from event_categories ec where ec.event_id = p_event_id for update;
  select exists (
    select 1 from event_categories ec
    where ec.event_id = p_event_id and ec.credit_mode = 'from_submission'
  ) into v_wants_value;

  if v_wants_value and p_submitted_value is null then
    raise exception 'This event asks the member for a number, so one is required.'
      using errcode = 'PDS03';
  end if;
  if not v_wants_value and p_submitted_value is not null then
    raise exception 'This event does not collect a number.' using errcode = 'PDS03';
  end if;
  if p_submitted_value is not null
     and (p_submitted_value < 0 or p_submitted_value = 'NaN'::numeric) then
    raise exception 'Type a number that is zero or greater.' using errcode = 'PDS03';
  end if;

  for v_entry, v_ordinal in
    select value, ordinality
    from jsonb_array_elements(p_entries) with ordinality
  loop
    begin
      v_line := coalesce(nullif(v_entry->>'line', '')::int, v_ordinal::int);
    exception when others then
      v_line := v_ordinal::int;
    end;
    v_name := regexp_replace(trim(coalesce(v_entry->>'claimed_name', '')), '\s+', ' ', 'g');
    v_norm_name := fn_normalise_name(v_name);
    v_disposition := coalesce(v_entry->>'disposition', 'invalid');
    v_member_id := null;
    v_record_id := null;
    v_existing_id := null;

    if v_disposition = 'repeated' then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'line', v_line, 'claimed_name', v_name, 'outcome', 'repeated',
        'record_id', null, 'member_id', null
      ));
      continue;
    end if;

    if v_disposition = 'invalid' or coalesce(v_norm_name, '') = ''
       or coalesce(array_length(regexp_split_to_array(v_norm_name, '\s+'), 1), 0) < 2 then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'line', v_line, 'claimed_name', v_name, 'outcome', 'invalid',
        'record_id', null, 'member_id', null
      ));
      continue;
    end if;

    if v_disposition not in ('member', 'unmatched') then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'line', v_line, 'claimed_name', v_name, 'outcome', 'invalid',
        'record_id', null, 'member_id', null
      ));
      continue;
    end if;

    if v_disposition = 'member' then
      begin
        v_member_id := nullif(v_entry->>'member_id', '')::uuid;
      exception when others then
        v_member_id := null;
      end;

      select * into v_member
      from members m
      where m.id = v_member_id
        and m.archived_at is null
        and m.merged_into_id is null
        and exists (
          select 1 from member_enrollments me
          where me.member_id = m.id
            and me.academic_year_id = v_event.academic_year_id
        )
      for share;

      if v_member.id is null then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'line', v_line, 'claimed_name', v_name, 'outcome', 'invalid',
          'record_id', null, 'member_id', v_member_id
        ));
        continue;
      end if;

      if v_member_id = any(v_seen_members) then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'line', v_line, 'claimed_name', v_name, 'outcome', 'repeated',
          'record_id', null, 'member_id', v_member_id
        ));
        continue;
      end if;
      v_seen_members := array_append(v_seen_members, v_member_id);

      -- A free-text record can survive roster enrollment on purpose. Do not
      -- create and approve a second row when that preserved record is the one
      -- an officer needs to link and review.
      select a.id into v_existing_id
      from attendance_records a
      where a.event_id = p_event_id
        and a.member_id is null
        and a.status <> 'rejected'
        and fn_normalise_name(a.claimed_name) = v_norm_name
      order by a.submitted_at desc
      limit 1
      for update;

      if v_existing_id is not null then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'line', v_line, 'claimed_name', v_name, 'outcome', 'already_recorded',
          'record_id', v_existing_id, 'member_id', v_member_id
        ));
        continue;
      end if;

      select a.id into v_existing_id
      from attendance_records a
      where a.event_id = p_event_id
        and a.member_id = v_member_id
        and a.status <> 'rejected'
      limit 1
      for update;

      if v_existing_id is not null then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'line', v_line, 'claimed_name', v_name, 'outcome', 'already_recorded',
          'record_id', v_existing_id, 'member_id', v_member_id
        ));
        continue;
      end if;

      begin
        insert into attendance_records
          (event_id, member_id, claimed_name, source, submitted_value)
        values
          (p_event_id, v_member_id, v_name, 'officer_entry', p_submitted_value)
        returning id into v_record_id;
      exception when unique_violation then
        select a.id into v_record_id
        from attendance_records a
        where a.event_id = p_event_id
          and a.member_id = v_member_id
          and a.status <> 'rejected'
        limit 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'line', v_line, 'claimed_name', v_name, 'outcome', 'already_recorded',
          'record_id', v_record_id, 'member_id', v_member_id
        ));
        continue;
      end;

      v_approve_ids := array_append(v_approve_ids, v_record_id);
      v_added := v_added + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'line', v_line, 'claimed_name', v_name, 'outcome', 'added',
        'record_id', v_record_id, 'member_id', v_member_id
      ));
      continue;
    end if;

    if v_norm_name = any(v_seen_names) then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'line', v_line, 'claimed_name', v_name, 'outcome', 'repeated',
        'record_id', null, 'member_id', null
      ));
      continue;
    end if;
    v_seen_names := array_append(v_seen_names, v_norm_name);

    select a.id into v_existing_id
    from attendance_records a
    where a.event_id = p_event_id
      and a.member_id is null
      and a.status <> 'rejected'
      and fn_normalise_name(a.claimed_name) = v_norm_name
    order by a.submitted_at desc
    limit 1
    for update;

    if v_existing_id is not null then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'line', v_line, 'claimed_name', v_name, 'outcome', 'already_recorded',
        'record_id', v_existing_id, 'member_id', null
      ));
      continue;
    end if;

    insert into attendance_records
      (event_id, member_id, claimed_name, source, status, submitted_value, flags)
    values
      (p_event_id, null, v_name, 'officer_entry', 'pending',
       p_submitted_value, array['unmatched_name'])
    returning id into v_record_id;

    v_waiting := v_waiting + 1;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'line', v_line, 'claimed_name', v_name, 'outcome', 'waiting_for_member_link',
      'record_id', v_record_id, 'member_id', null
    ));
  end loop;

  select exists (
    select 1 from event_categories ec
    where ec.event_id = p_event_id and ec.credit_mode = 'from_submission'
  ) into v_recheck;
  if v_recheck <> v_wants_value then
    raise exception 'That event changed while this was being filed. Try again.'
      using errcode = 'PDS03';
  end if;

  if cardinality(v_approve_ids) > 0 then
    v_approved := review_records(v_approve_ids, 'approve', null);
    if v_approved <> cardinality(v_approve_ids) then
      raise exception 'Those records could not all be approved.' using errcode = 'PDS03';
    end if;
  end if;

  perform fn_audit('add_officer_attendance_batch', 'attendance_record', null,
                   jsonb_build_object('event_id', p_event_id,
                                      'batch_key', v_batch_key,
                                      'submitted_value', p_submitted_value,
                                      'added', v_added,
                                      'waiting', v_waiting,
                                      'outcomes', v_results));
  return v_results;
end
$$;

revoke all on function add_officer_attendance_batch(uuid, jsonb, numeric) from public, anon;
grant execute on function add_officer_attendance_batch(uuid, jsonb, numeric) to authenticated;

comment on function add_officer_attendance_batch(uuid, jsonb, numeric) is
  'Files one mixed event-attendance paste in a transaction. Enrolled members are approved through review_records(); unmatched names remain pending for retroactive linking. Returns one outcome per input line.';

create or replace function recover_officer_attendance_batch(
  p_event_id uuid,
  p_batch_key text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_outcomes jsonb;
begin
  perform fn_assert_officer();

  if p_event_id is null or nullif(trim(p_batch_key), '') is null then
    raise exception 'A batch key and event are required.' using errcode = 'PDS03';
  end if;

  select al.detail->'outcomes' into v_outcomes
  from audit_log al
  where al.actor_user_id = auth.uid()
    and al.action = 'add_officer_attendance_batch'
    and al.detail->>'event_id' = p_event_id::text
    and al.detail->>'batch_key' = p_batch_key
  order by al.created_at desc, al.id desc
  limit 1;

  return v_outcomes;
end
$$;

revoke all on function recover_officer_attendance_batch(uuid, text) from public, anon;
grant execute on function recover_officer_attendance_batch(uuid, text) to authenticated;

comment on function recover_officer_attendance_batch(uuid, text) is
  'Returns this officer own committed attendance-paste outcome for one event and batch key.';
