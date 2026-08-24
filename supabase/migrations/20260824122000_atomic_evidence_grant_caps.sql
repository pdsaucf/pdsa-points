-- create_evidence_upload checks outstanding grants before inserting. Without
-- a stable lock, concurrent calls can all observe room and overshoot both
-- caps. A trigger is the narrowest backstop because it also protects any
-- future grant-writing path, without copying the long upload RPC.
--
-- An advisory lock serializes only grant issuance for that event. It stays
-- separate from the event row lock held by fn_checkin_event(), avoiding a
-- concurrent SHARE-to-UPDATE lock upgrade. After it is held, both counts are
-- checked again against committed rows.

create or replace function fn_enforce_evidence_grant_caps()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_outstanding int;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('evidence-grants:' || new.event_id::text, 724602)
  );

  if new.member_id is not null then
    select count(*) into v_outstanding
    from evidence_upload_grants g
    where g.event_id = new.event_id
      and g.member_id = new.member_id
      and g.consumed_at is null
      and g.reclaimed_at is null
      and g.expires_at > now();
  else
    select count(*) into v_outstanding
    from evidence_upload_grants g
    where g.event_id = new.event_id
      and g.member_id is null
      and g.client_nonce is not distinct from new.client_nonce
      and g.consumed_at is null
      and g.reclaimed_at is null
      and g.expires_at > now();
  end if;

  if v_outstanding >= fn_setting_int('evidence_grants_outstanding_per_member', 3) then
    raise exception
      'There are already several photo uploads pending for you at this event. Finish or abandon one before starting another.'
      using errcode = 'PDS04';
  end if;

  select count(*) into v_outstanding
  from evidence_upload_grants g
  where g.event_id = new.event_id
    and g.consumed_at is null
    and g.reclaimed_at is null
    and g.expires_at > now();

  if v_outstanding >= fn_setting_int('evidence_grants_outstanding_per_event', 1200) then
    raise exception 'Too many photo uploads are pending for this event. Please try again shortly.'
      using errcode = 'PDS04';
  end if;

  return new;
end
$$;

drop trigger if exists evidence_grant_caps_before_insert on evidence_upload_grants;
create trigger evidence_grant_caps_before_insert
before insert on evidence_upload_grants
for each row execute function fn_enforce_evidence_grant_caps();

revoke all on function fn_enforce_evidence_grant_caps() from public, anon, authenticated;

comment on function fn_enforce_evidence_grant_caps() is
  'Serializes evidence grant issuance per event and atomically enforces the outstanding per-person and per-event caps.';
