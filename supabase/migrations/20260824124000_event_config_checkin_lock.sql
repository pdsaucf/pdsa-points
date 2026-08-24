-- Every check-in RPC resolves its event through this function. A SHARE lock
-- held for the RPC transaction makes the event configuration one snapshot:
-- save_event_config takes FOR UPDATE on the same row and must wait until the
-- check-in has validated its value and evidence and filed its attendance.

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
  where e.checkin_token = p_token and e.is_published
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
  'Resolves and locks one published check-in event for the caller transaction, then enforces either the exact window or the submission grace window.';
