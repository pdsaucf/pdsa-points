-- A member-entered number is legitimate event credit, but it is never a
-- routine batch decision. The review UI keeps these rows out of Approve all.
-- This function check is the server backstop for a stale or bypassed client.
-- One record at a time remains approvable after the officer checks the value.

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

    if coalesce(cardinality(p_ids), 0) > 1 and exists (
      select 1
      from attendance_records a
      where a.id = any (p_ids)
        and a.submitted_value is not null
        and a.source in ('self_checkin', 'member_request')
    ) then
      raise exception 'Member-entered points must be reviewed one at a time.'
        using errcode = 'PDS03';
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

comment on function review_records(uuid[], text, text) is
  'Officer only, audited. Approves or rejects attendance records and stamps the reviewer. Approval refuses unmatched records (PDS06), duplicate live attendance (PDS05), and a multi-record batch containing member-entered points (PDS03). Member-entered points remain approvable one record at a time after individual review.';
