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
-- Error codes, so a client can tell these apart WITHOUT string matching:
--   PDS01  unknown, rotated or unpublished check-in token
--   PDS02  check-in has not opened yet (too early)
--   PDS03  bad argument (search too short, missing required value, ...)
--   PDS04  required evidence missing or an upload grant is not valid
--   PDS05  already checked in to this event
--   PDS06  cannot approve a record that is not linked to a member
--   PDS07  caller lacks the required role
--   PDS08  unknown requirement set
--   PDS09  rate limited
--   PDS10  check-in has closed (too late, past any grace period)
--   PDS11  requirement tree is not a tree (a cycle, or a parent in another set)
--   PDS12  requirement set failed validation, so it was not published
--
-- PDS02 AND PDS10 ARE DELIBERATELY SEPARATE CODES. They were one code, and
-- the page had to read the message text to tell them apart, which meant
-- rewording a sentence here would silently show the wrong screen with no test
-- failing anywhere. They need different screens because they need different
-- actions from the member: "come back at five" against "find an officer".
--
-- Every message below is copy for a person holding a phone, so treat it as
-- freely rewritable. The CODE is the contract. If you ever need a further
-- distinction, add another code rather than another sentence.
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
      raise exception 'Check-in for this event has closed.' using errcode = 'PDS10';
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
      raise exception 'Check-in for this event has closed.' using errcode = 'PDS10';
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
volatile                       -- it now mints a nonce, so it writes
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event events;
  v_out   jsonb;
  v_nonce text;
begin
  v_event := fn_checkin_event(p_token, true);

  -- Minting is bounded per token per minute, so the number of rate-limit
  -- buckets one event can have is itself capped. Without this, a caller could
  -- mint a fresh bucket per request and have no effective limit at all.
  perform fn_rate_limit_check(
    'nonce:' || p_token,
    fn_setting_int('checkin_nonce_max_per_min', 600)
  );

  insert into checkin_client_nonces (event_id, expires_at)
  values (v_event.id,
          now() + make_interval(mins => fn_setting_int('checkin_nonce_ttl_minutes', 240)))
  returning nonce into v_nonce;

  -- Cheap opportunistic cleanup of nonces nobody can use any more.
  delete from checkin_client_nonces where expires_at < now() - interval '1 day';

  select jsonb_build_object(
    -- Opaque, expiring, and worth nothing on its own. The client sends it back
    -- with search_members() and submit_checkin() so those calls are counted
    -- against this browser rather than against everybody at the event. It
    -- authorizes nothing: see the note in migration 08.
    'client_nonce', v_nonce,
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

create or replace function search_members(
  p_token        text,
  p_q            text,
  p_client_nonce text default null
)
returns table (id uuid, display_name text)
language plpgsql
volatile                       -- the limiter writes a counter row
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event  events;
  v_q      text := btrim(coalesce(p_q, ''));
  v_bucket text;
begin
  v_event := fn_checkin_event(p_token, true);

  if length(v_q) < 3 then
    raise exception 'Type at least three letters of your name.' using errcode = 'PDS03';
  end if;

  v_bucket := fn_checkin_nonce_bucket(v_event.id, p_client_nonce);

  -- The per-event ceiling here is a runaway backstop and nothing more. This
  -- endpoint returns names only, which the design already accepts as the price
  -- of identifying yourself without logging in, so throttling it protects
  -- almost nothing while a number anywhere near the crowd size would lock 167
  -- people out of their own check-in. The per-client ceiling is what actually
  -- constrains one misbehaving browser.
  perform fn_rate_limit_checkin(
    'search_members', p_token, v_bucket,
    fn_setting_int('search_members_max_per_nonce_per_min', 60),
    fn_setting_int('search_members_max_per_event_per_min', 20000)
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
  p_token        text,
  p_member_id    uuid,
  p_kind         evidence_kind_t,
  p_client_nonce text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event       events;
  v_grant       evidence_upload_grants;
  v_path        text;
  v_bucket      text;
  v_grant_nonce text;
  v_outstanding int;
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

  v_bucket := fn_checkin_nonce_bucket(v_event.id, p_client_nonce);

  -- Only a nonce this database issued, for this event, still live. Anything
  -- else is recorded as null, so a caller cannot mint themselves a private
  -- allowance by sending a fresh string each time.
  v_grant_nonce := case when v_bucket <> '' then p_client_nonce else null end;

  -- This is the storage exhaustion vector, so it is bounded twice over: by
  -- rate, and by how many grants may be outstanding at once. A grant is a
  -- licence to write up to 8 MB into a 1 GB bucket, and a rate limit alone
  -- does not bound the total: a patient caller can collect one grant a second
  -- all day and redeem them whenever it likes.
  perform fn_rate_limit_checkin(
    'create_evidence_upload', p_token, v_bucket,
    fn_setting_int('evidence_upload_max_per_nonce_per_min', 6),
    fn_setting_int('evidence_upload_max_per_event_per_min', 600)
  );

  -- Outstanding means issued, still live, and neither consumed by a submission
  -- nor reclaimed by an operator. One person retaking a blurry photo needs two
  -- or three; nobody legitimately needs more at one moment.
  --
  -- "One person" is the hard part. Keying this on member_id alone works for
  -- somebody on the roster and collapses completely for anybody who is not,
  -- because every unmatched attendee shares a null member_id and would share
  -- one allowance of three between the entire room. On an empty roster, which
  -- is how this system ships, that is the entire room. The fourth person to
  -- start a photo would be refused, fall through to the client's skip path,
  -- and file missing_evidence instead, so the evidence requirement would
  -- quietly stop working at exactly the event it exists for.
  --
  -- So unmatched callers are separated by their client nonce instead. A caller
  -- with no valid nonce shares a bucket with the other such callers, which is
  -- the honest fallback: it cannot be better than the shared case, and it
  -- cannot be bypassed by inventing a nonce, because v_grant_nonce is only
  -- ever set from one this database issued.
  if p_member_id is not null then
    select count(*) into v_outstanding
    from evidence_upload_grants g
    where g.event_id = v_event.id
      and g.member_id = p_member_id
      and g.consumed_at is null
      and g.reclaimed_at is null
      and g.expires_at > now();
  else
    select count(*) into v_outstanding
    from evidence_upload_grants g
    where g.event_id = v_event.id
      and g.member_id is null
      and g.client_nonce is not distinct from v_grant_nonce
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
  where g.event_id = v_event.id
    and g.consumed_at is null
    and g.reclaimed_at is null
    and g.expires_at > now();

  if v_outstanding >= fn_setting_int('evidence_grants_outstanding_per_event', 400) then
    raise exception 'Too many photo uploads are pending for this event. Please try again shortly.'
      using errcode = 'PDS04';
  end if;

  v_path := v_event.academic_year_id::text || '/' || v_event.id::text || '/'
            || p_kind::text || '/' || encode(gen_random_bytes(16), 'hex') || '.jpg';

  insert into evidence_upload_grants (event_id, member_id, client_nonce, kind,
                                      object_path, expires_at)
  values (v_event.id, p_member_id, v_grant_nonce, p_kind, v_path,
          now() + make_interval(mins => fn_setting_int('evidence_grant_ttl_minutes', 30)))
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
  p_evidence      jsonb   default '[]'::jsonb,
  p_client_nonce  text    default null
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
  v_bucket       text;
begin
  v_event := fn_checkin_event(p_token, false);

  v_bucket := fn_checkin_nonce_bucket(v_event.id, p_client_nonce);

  -- This endpoint writes rows, so the per-client ceiling is tight: one real
  -- submission plus retries. The per-event ceiling is far above the 167-person
  -- peak in the historical data, because a member turned away here loses
  -- credit for an event they actually attended.
  perform fn_rate_limit_checkin(
    'submit_checkin', p_token, v_bucket,
    fn_setting_int('submit_checkin_max_per_nonce_per_min', 10),
    fn_setting_int('submit_checkin_max_per_event_per_min', 1500)
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
    -- The unmatched path is the only unbounded write in this function, so it
    -- gets its own ceiling on top of the submission ceiling above.
    --
    -- A matched member cannot flood: one_live_record_per_member_event allows
    -- them exactly one live row per event, so a repeat is refused by the index.
    -- An unmatched submission has no such bound, since every call is a brand
    -- new row carrying a typed-in name.
    --
    -- Layered, not merely lowered. A single number here would have to choose
    -- between admitting a 167-person recruiting event where most of the room
    -- is legitimately new, and bounding a flooder. It cannot do both, and the
    -- empty-roster launch makes the first case the common one. See the
    -- arithmetic and the worst case in migration 08.
    perform fn_rate_limit_checkin(
      'submit_unmatched', p_token, v_bucket,
      fn_setting_int('submit_unmatched_max_per_nonce_per_min', 3),
      fn_setting_int('submit_unmatched_max_per_event_per_min', 1000)
    );

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

-- ---------------------------------------------------------------------------
-- 10.9 purge_orphaned_uploads()
-- ---------------------------------------------------------------------------
-- Reclaims abandoned uploads.
--
-- Uploading a photo and submitting the check-in are two separate steps, and a
-- member can do the first without the second: they get a grant, the browser
-- PUTs the image, and then they close the tab, lose signal, or wander off. The
-- object is in the bucket, but no attendance_evidence row was ever created for
-- it, so purge_evidence() cannot see it. It scans attendance_evidence, and
-- nothing points at that object. Left alone, those bytes accumulate in a 1 GB
-- bucket with no way for an operator to even learn they exist.
--
-- This is the path that finds them. It is the same bargain as purge_evidence:
-- the database identifies what is eligible and an operator presses the button.
-- Nothing here runs on a timer, per invariant 7.
--
-- The grant row is stamped rather than deleted, because it is the only record
-- that anything was ever written to that path. Deleting it would make a
-- leftover object permanently invisible, which is the bug being fixed.
-- ---------------------------------------------------------------------------

create or replace function purge_orphaned_uploads()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_run_id      uuid;
  v_count       int    := 0;
  v_with_object int    := 0;
  v_paths       text[] := '{}';
  v_events      uuid[] := '{}';
begin
  perform fn_assert_officer();

  create temporary table _orphans on commit drop as
  select g.id, g.object_path, g.event_id,
         exists (
           select 1 from storage.objects o
           where o.bucket_id = g.bucket_id and o.name = g.object_path
         ) as object_exists
  from evidence_upload_grants g
  where g.consumed_at  is null
    and g.reclaimed_at is null
    and g.expires_at   < now()
    and not exists (
      select 1 from attendance_evidence ae where ae.object_path = g.object_path
    );

  select count(*), count(*) filter (where object_exists),
         coalesce(array_agg(object_path) filter (where object_exists), '{}'),
         coalesce(array_agg(distinct event_id), '{}')
    into v_count, v_with_object, v_paths, v_events
  from _orphans;

  insert into purge_runs (performed_by, kind, retention_months,
                          evidence_count, bytes_freed, event_ids)
  values (auth.uid(), 'orphaned_uploads', null, v_with_object, 0, v_events)
  returning id into v_run_id;

  update evidence_upload_grants g
  set reclaimed_at = now(), purge_run_id = v_run_id
  where g.id in (select id from _orphans);

  drop table _orphans;

  perform fn_audit('purge_orphaned_uploads', 'purge_run', v_run_id,
                   jsonb_build_object('grants_reclaimed', v_count,
                                      'objects_to_delete', v_with_object));

  return jsonb_build_object(
    'purge_run_id',      v_run_id,
    'grants_reclaimed',  v_count,
    -- Only these actually exist in the bucket. The rest were grants nobody
    -- ever uploaded against, so there is nothing to delete for them.
    'objects_to_delete', v_with_object,
    'object_paths',      to_jsonb(v_paths)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 10.10 validate_requirement_set(set_id)
-- ---------------------------------------------------------------------------
-- Everything an officer can build in the editor that would not work, one row
-- per problem, nothing when the set is sound.
--
-- The `code` is the contract, the same bargain as the PDS codes above: the
-- editor pins a message to a node by matching on it, so codes are stable and a
-- new distinction means a new code rather than a reworded sentence.
--
-- Every row here BLOCKS publishing, so only real breakage belongs in it. A
-- rule that is merely unusual (a threshold of zero, a group needing none of
-- its children) is a lint, and lints live in v_config_warnings where they
-- inform without stopping anybody. What is listed below is a ruleset that
-- cannot be satisfied, cannot be evaluated, or is evaluated differently from
-- how it reads on screen.
--
--   no_root                     nothing at the top
--   multiple_roots              several tops, so "the" rule is ambiguous
--   root_not_group              the top is a threshold, so nothing under it counts
--   root_node_mismatch          the set does not point at its own top node,
--                               which is what v_member_status reads for honorary
--   orphan_node                 in the set but not under its root, so it counts
--                               toward nothing
--   cycle                       a requirement contains itself
--   foreign_parent              sits under a node from another ruleset
--   foreign_child               a node from another ruleset sits under this one,
--                               inflating this group's child count
--   threshold_without_category  measures nothing, so it can never be met
--   archived_category           measures a category nobody can earn any more
--   threshold_with_children     nodes nested under a threshold, which the
--                               evaluator never looks at
--   term_year_mismatch          counts a term from a different academic year,
--                               so no event can ever fall inside it
--   empty_group                 a group with nothing under it passes vacuously
--   group_min_exceeds_children  needs more children than it has
-- ---------------------------------------------------------------------------

create or replace function validate_requirement_set(p_set_id uuid)
returns table (code text, node_id uuid, message text)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_set    requirement_sets;
  v_anchor uuid;
begin
  perform fn_assert_officer();

  select * into v_set from requirement_sets rs where rs.id = p_set_id;
  if v_set.id is null then
    raise exception 'Unknown requirement set %.', p_set_id using errcode = 'PDS08';
  end if;

  -- Reachability is measured from the node the SET points at, because that is
  -- the node v_member_status reads to decide honorary. Anything the walk does
  -- not arrive at is not part of the verdict, whatever it looks like on screen.
  -- When the set points nowhere usable, fall back to the top-level nodes, so a
  -- set that has simply lost its root pointer reports that one problem rather
  -- than reporting every node in it as an orphan.
  select n.id into v_anchor
  from requirement_nodes n
  where n.id = v_set.root_node_id and n.requirement_set_id = p_set_id;

  return query
  with recursive reachable as (
    select n.id
    from requirement_nodes n
    where n.requirement_set_id = p_set_id
      and case when v_anchor is not null then n.id = v_anchor else n.parent_id is null end
    union
    select c.id
    from requirement_nodes c
    join reachable r on c.parent_id = r.id
    where c.requirement_set_id = p_set_id
  ),
  -- Every ancestor of every node, capped, so a cycle stops instead of running
  -- forever. A node that turns up among its own ancestors is in one.
  ancestry as (
    select n.id as start_id, n.parent_id as at, 1 as depth
    from requirement_nodes n
    where n.requirement_set_id = p_set_id and n.parent_id is not null
    union all
    select a.start_id, p.parent_id, a.depth + 1
    from ancestry a
    join requirement_nodes p on p.id = a.at
    where p.parent_id is not null and a.depth < 64
  ),
  cyclic as (
    select distinct a.start_id from ancestry a where a.at = a.start_id
  ),
  nodes as (
    select n.* from requirement_nodes n where n.requirement_set_id = p_set_id
  ),
  roots as (
    select n.id, n.label, n.type from nodes n where n.parent_id is null
  ),
  child_counts as (
    select n.id,
           (select count(*) from requirement_nodes k
             where k.parent_id = n.id and k.requirement_set_id = p_set_id) as children
    from nodes n
  )

  select 'no_root'::text, null::uuid,
         'This ruleset has nothing at the top. Add a group and put the requirements inside it.'::text
  where not exists (select 1 from roots)

  union all
  select 'multiple_roots', r.id,
         'Requirement "' || r.label || '" sits at the top alongside others. '
         || 'Everything must sit inside one group.'
  from roots r
  where (select count(*) from roots) > 1

  union all
  select 'root_not_group', r.id,
         'The top of this ruleset is a single requirement, not a group, '
         || 'so nothing else in it is counted.'
  from roots r
  where r.type <> 'group'

  union all
  select 'root_node_mismatch', (select r.id from roots r),
         'This ruleset does not point at its own top-level group, '
         || 'so nobody would come out honorary.'
  where (select count(*) from roots) = 1
    and v_set.root_node_id is distinct from (select r.id from roots r)

  union all
  select 'cycle', c.start_id,
         'Requirement "' || n.label || '" contains itself.'
  from cyclic c
  join nodes n on n.id = c.start_id

  union all
  select 'orphan_node', n.id,
         'Requirement "' || n.label || '" is not attached to the top-level group, '
         || 'so it is never counted.'
  from nodes n
  where not exists (select 1 from reachable r where r.id = n.id)
    and not exists (select 1 from cyclic c where c.start_id = n.id)

  union all
  select 'foreign_parent', n.id,
         'Requirement "' || n.label || '" sits under a group from a different ruleset.'
  from nodes n
  join requirement_nodes p on p.id = n.parent_id
  where p.requirement_set_id <> p_set_id

  union all
  select 'foreign_child', n.id,
         'A requirement from a different ruleset sits under "' || n.label || '", '
         || 'so this group counts something that is not part of it.'
  from nodes n
  where exists (
    select 1 from requirement_nodes k
    where k.parent_id = n.id and k.requirement_set_id <> p_set_id
  )

  union all
  select 'threshold_without_category', n.id,
         'Requirement "' || n.label || '" measures no categories, so nobody can meet it.'
  from nodes n
  where n.type = 'threshold'
    and not exists (
      select 1 from requirement_node_categories rnc where rnc.node_id = n.id
    )

  union all
  select 'archived_category', n.id,
         'Requirement "' || n.label || '" measures "' || c.name || '", which is archived.'
  from nodes n
  join requirement_node_categories rnc on rnc.node_id = n.id
  join categories c on c.id = rnc.category_id
  where c.archived_at is not null

  union all
  select 'threshold_with_children', n.id,
         'Requirement "' || n.label || '" has requirements nested under it. '
         || 'Only a group can hold other requirements.'
  from nodes n
  join child_counts cc on cc.id = n.id
  where n.type = 'threshold' and cc.children > 0

  union all
  select 'term_year_mismatch', n.id,
         'Requirement "' || n.label || '" counts only "' || t.label
         || '", which belongs to a different academic year, so nothing counts toward it.'
  from nodes n
  join terms t on t.id = n.term_id
  where t.academic_year_id <> v_set.academic_year_id

  union all
  select 'empty_group', n.id,
         'Group "' || n.label || '" has nothing in it, so it passes for everybody.'
  from nodes n
  join child_counts cc on cc.id = n.id
  where n.type = 'group' and cc.children = 0

  union all
  select 'group_min_exceeds_children', n.id,
         'Group "' || n.label || '" needs ' || n.min_children_passing || ' of '
         || cc.children || ', so nobody can meet it.'
  from nodes n
  join child_counts cc on cc.id = n.id
  where n.type = 'group'
    and n.min_children_passing is not null
    and n.min_children_passing > cc.children

  order by 1, 2;
end
$$;

comment on function validate_requirement_set(uuid) is
  'Every reason a ruleset would not work, one row per problem, none when it is sound. The code column is a stable contract the editor matches on.';

-- ---------------------------------------------------------------------------
-- 10.11 preview_requirement_set(set_id)
-- ---------------------------------------------------------------------------
-- "If I published this, who would qualify?" One row per node including the
-- root, so the editor can put a count against every line and not just the
-- bottom one.
--
-- It runs on a DRAFT, which is the whole point: the number has to be on screen
-- before anybody presses publish, not after. Nothing is written and nothing is
-- cached, so it reflects the attendance approved a second ago.
--
-- The denominator is the active roster for the set's own academic year.
-- Inactive and alumni enrollments are excluded: they are not people this
-- ruleset is deciding anything about, and counting them would make every
-- number look worse than it is.
-- ---------------------------------------------------------------------------

create or replace function preview_requirement_set(p_set_id uuid)
returns table (node_id uuid, label text, passing int, total int)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_year  uuid;
  v_total int;
begin
  perform fn_assert_officer();

  select rs.academic_year_id into v_year
  from requirement_sets rs
  where rs.id = p_set_id;

  if v_year is null then
    raise exception 'Unknown requirement set %.', p_set_id using errcode = 'PDS08';
  end if;

  select count(*) into v_total
  from member_enrollments me
  where me.academic_year_id = v_year and me.status = 'active';

  return query
  select n.id,
         n.label,
         coalesce(p.passing, 0)::int,
         v_total::int
  from requirement_nodes n
  left join (
    select f.node_id as nid,
           count(*) filter (where f.passed)::int as passing
    from member_enrollments me
    cross join lateral fn_member_requirement_status(me.member_id, p_set_id) f
    where me.academic_year_id = v_year and me.status = 'active'
    group by f.node_id
  ) p on p.nid = n.id
  where n.requirement_set_id = p_set_id
  order by n.sort_order, n.label;
end
$$;

comment on function preview_requirement_set(uuid) is
  'How many of this years active members would pass each node of a set, draft or published. The safety rail in front of the publish button.';

-- ---------------------------------------------------------------------------
-- 10.12 clone_requirement_set(set_id)
-- ---------------------------------------------------------------------------
-- Editing a published ruleset means copying it. This is that copy: a new draft
-- at the next version, carrying the whole tree and the categories attached to
-- it.
--
-- The tree is self-referential, so the copy is done in two passes over a map
-- of old id to new id. Pass one writes every node with no parent at all, which
-- means the order rows come back in does not matter and a detached node an
-- officer left mid-edit is copied rather than dropped. Pass two sets every
-- parent from the map.
--
-- The bug being avoided is a clone whose nodes still point at the ORIGINAL's
-- nodes. That is not a cosmetic mistake: parent_id can address any row in the
-- table, so a mis-remapped parent would make edits to the draft change the
-- child count of the published set, and members would silently be judged
-- against a ruleset nobody published. Migration 07's trigger now refuses such
-- a link outright, and this function never has to be trusted about it.
-- ---------------------------------------------------------------------------

create or replace function clone_requirement_set(p_set_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_src     requirement_sets;
  v_new_id  uuid;
  v_version int;
  v_map     jsonb := '{}'::jsonb;   -- old node id -> new node id
  v_new     uuid;
  r         record;
begin
  perform fn_assert_officer();

  select * into v_src from requirement_sets rs where rs.id = p_set_id;
  if v_src.id is null then
    raise exception 'Unknown requirement set %.', p_set_id using errcode = 'PDS08';
  end if;

  -- version + 1, taken from the highest version that exists rather than from
  -- the source, so cloning last year's published v3 twice does not collide
  -- with the draft v4 the first clone created.
  select coalesce(max(rs.version), 0) + 1 into v_version
  from requirement_sets rs
  where rs.academic_year_id = v_src.academic_year_id
    and rs.name = v_src.name;

  insert into requirement_sets (academic_year_id, name, version, status)
  values (v_src.academic_year_id, v_src.name, v_version, 'draft')
  returning id into v_new_id;

  for r in
    select n.* from requirement_nodes n where n.requirement_set_id = p_set_id
  loop
    v_new := gen_random_uuid();
    v_map := jsonb_set(v_map, array[r.id::text], to_jsonb(v_new));

    insert into requirement_nodes
      (id, requirement_set_id, parent_id, type, label, sort_order,
       min_children_passing, min_value, term_id)
    values
      (v_new, v_new_id, null, r.type, r.label, r.sort_order,
       r.min_children_passing, r.min_value, r.term_id);

    insert into requirement_node_categories (node_id, category_id)
    select v_new, rnc.category_id
    from requirement_node_categories rnc
    where rnc.node_id = r.id;
  end loop;

  update requirement_nodes c
  set parent_id = (v_map ->> src.parent_id::text)::uuid
  from requirement_nodes src
  where src.requirement_set_id = p_set_id
    and src.parent_id is not null
    and c.id = (v_map ->> src.id::text)::uuid;

  update requirement_sets s
  set root_node_id = (v_map ->> v_src.root_node_id::text)::uuid
  where s.id = v_new_id
    and v_src.root_node_id is not null;

  perform fn_audit('clone_requirement_set', 'requirement_set', v_new_id,
                   jsonb_build_object('cloned_from', p_set_id,
                                      'version', v_version,
                                      'nodes', jsonb_array_length(
                                        coalesce(jsonb_path_query_array(v_map, '$.keyvalue().key'),
                                                 '[]'::jsonb))));
  return v_new_id;
end
$$;

comment on function clone_requirement_set(uuid) is
  'Copies a set and its whole tree into a new draft at the next version, remapping every parent link. Cloning is how a published ruleset is edited.';

-- ---------------------------------------------------------------------------
-- 10.13 publish_requirement_set(set_id)
-- ---------------------------------------------------------------------------
-- Validate, archive the outgoing set, publish this one. One transaction, so
-- there is no instant at which the year has two published sets or none.
--
-- Admin only, matching the RLS in migration 11: an officer builds and edits
-- drafts, and publishing is the moment a ruleset starts deciding who is
-- honorary.
--
-- Refusing an invalid set is the point of the validation call. A ruleset with
-- an empty threshold or a group needing more children than it has is one
-- nobody can satisfy, and it would go unnoticed until an officer wondered why
-- the honorary list was empty in April.
-- ---------------------------------------------------------------------------

create or replace function publish_requirement_set(p_set_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_set      requirement_sets;
  v_problems text;
  v_archived uuid;
  v_at       timestamptz;
begin
  perform fn_assert_admin();

  select * into v_set from requirement_sets rs where rs.id = p_set_id;
  if v_set.id is null then
    raise exception 'Unknown requirement set %.', p_set_id using errcode = 'PDS08';
  end if;

  if v_set.status <> 'draft' then
    raise exception 'Only a draft can be published. That set is %.', v_set.status
      using errcode = 'PDS03';
  end if;

  select string_agg(distinct v.code, ', ' order by v.code) into v_problems
  from validate_requirement_set(p_set_id) v;

  if v_problems is not null then
    raise exception 'This ruleset cannot be published: %.', v_problems
      using errcode = 'PDS12';
  end if;

  -- Whatever was published for this year stops being published first, so the
  -- one-per-year index is never briefly violated. Archived, not deleted: it is
  -- the record of what members were judged against until now.
  update requirement_sets rs
  set status = 'archived'
  where rs.academic_year_id = v_set.academic_year_id
    and rs.status = 'published'
    and rs.id <> p_set_id
  returning rs.id into v_archived;

  v_at := now();

  update requirement_sets rs
  set status = 'published', published_at = v_at
  where rs.id = p_set_id;

  perform fn_audit('publish_requirement_set', 'requirement_set', p_set_id,
                   jsonb_build_object('version', v_set.version,
                                      'academic_year_id', v_set.academic_year_id,
                                      'archived_set_id', v_archived));

  return jsonb_build_object(
    'requirement_set_id', p_set_id,
    'version',            v_set.version,
    'published_at',       v_at,
    'archived_set_id',    v_archived
  );
end
$$;

comment on function publish_requirement_set(uuid) is
  'Validates, archives the years outgoing set and publishes this one in a single transaction. Admin only.';
