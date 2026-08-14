-- ===========================================================================
-- 15. ADDING SOMEBODY TO THE ROSTER, IN ONE TRANSACTION
-- ===========================================================================
-- The roster screen had two ways onto this year's list, Add and CSV import,
-- and both did the same two writes: insert the member, then insert the
-- enrollment. Two writes are two requests, and the gap between them is real.
-- A connection that drops after the first one leaves a member row with no
-- enrollment for the year. Nothing later repairs it: the roster is drawn from
-- member_enrollments, so that person is invisible on the screen that would
-- have shown the officer the problem, and their email address is now taken by
-- a row nobody can see, so the obvious fix (add them again) is refused by the
-- unique index.
--
-- upsert_member_and_enroll() is the single write path both use instead. It
-- resolves the member and enrolls them in one transaction, so there is no
-- half-finished state to be left in, and it is idempotent, so running the same
-- import twice is a no-op rather than a second Abigail Catto.
--
-- HOW THE MEMBER IS RESOLVED, AND WHY IN THAT ORDER
--
--   1. p_matched_member_id, when the caller passes one. That is an officer's
--      answer from the import preview: either an exact match or a fuzzy one
--      they pressed Link member on. A person's judgement outranks anything
--      this function could work out, which is the whole reason the preview
--      exists (docs/03-admin-ui.md).
--   2. email, then ucf_nid. Both are citext UNIQUE, so a match on either is an
--      identity rather than a resemblance. This is the tier that makes a
--      re-run of an interrupted import land on the row the first run created
--      instead of colliding with the unique index.
--   3. nobody: create them.
--
-- There is deliberately NO name tier here, though scripts/import_roster.py has
-- one. The script has nobody to ask; this function does. Matching two live
-- people by name alone is exactly the decision the preview puts in front of an
-- officer, and it arrives back as p_matched_member_id.
-- ===========================================================================

create or replace function upsert_member_and_enroll(
  p_first_name        text,
  p_last_name         text,
  p_email             citext,
  p_ucf_nid           citext,
  p_academic_year_id  uuid,
  p_matched_member_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_first    text;
  v_last     text;
  v_email    citext;
  v_nid      citext;
  v_member   uuid;
  v_next     uuid;
  v_created  boolean := false;
  v_enrolled boolean := false;
  v_rows     int;
begin
  -- Officer status is asserted POSITIVELY. fn_assert_officer() asks
  -- `if not fn_is_officer()`, and fn_is_officer() is NULL rather than false
  -- for a caller with no profiles row, so that helper does not raise on the
  -- one caller it most needs to. Everything below writes to the roster, so
  -- a caller whose role cannot be determined is refused.
  if not coalesce(fn_is_officer(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  v_first := btrim(coalesce(p_first_name, ''));
  v_last  := btrim(coalesce(p_last_name, ''));
  if v_first = '' or v_last = '' then
    raise exception 'A member needs a first name and a last name.' using errcode = 'PDS03';
  end if;

  if p_academic_year_id is null
     or not exists (select 1 from academic_years where id = p_academic_year_id) then
    raise exception 'Unknown academic year.' using errcode = 'PDS03';
  end if;

  -- An empty cell in a CSV is not an address. Left as '' it would be stored,
  -- and the second row with an empty cell would collide with the unique index.
  v_email := nullif(btrim(coalesce(p_email::text, '')), '')::citext;
  v_nid   := nullif(btrim(coalesce(p_ucf_nid::text, '')), '')::citext;

  if p_matched_member_id is not null then
    select id into v_member from members where id = p_matched_member_id;
    if v_member is null then
      raise exception 'Unknown member.' using errcode = 'PDS03';
    end if;
  else
    if v_email is not null then
      select id into v_member from members where email = v_email;
    end if;
    if v_member is null and v_nid is not null then
      select id into v_member from members where ucf_nid = v_nid;
    end if;
  end if;

  -- Follow a tombstone. merge_members() leaves the loser's address and NID on
  -- the merged row, so last year's file still resolves to it, and enrolling a
  -- tombstone would put a row on the roster that merged_into_id says is not a
  -- person. The cap is a guard against a cycle the schema does not permit
  -- rather than an expected depth: merges chain at most a few deep.
  for i in 1..10 loop
    exit when v_member is null;
    select merged_into_id into v_next from members where id = v_member;
    exit when v_next is null;
    v_member := v_next;
  end loop;

  if v_member is not null and exists (
       select 1 from members where id = v_member and archived_at is not null
     ) then
    raise exception 'That member is archived.' using errcode = 'PDS03';
  end if;

  if v_member is null then
    -- No on conflict clause: the lookups above already ran in this
    -- transaction, and email and ucf_nid are two separate unique indexes,
    -- which one clause cannot cover. Two officers importing the same file at
    -- the same instant is the case this leaves as a 23505, and re-running the
    -- import is what clears it, because the second run finds the row.
    insert into members (first_name, last_name, email, ucf_nid)
    values (v_first, v_last, v_email, v_nid)
    returning id into v_member;
    v_created := true;
  end if;

  insert into member_enrollments (member_id, academic_year_id)
  values (v_member, p_academic_year_id)
  on conflict (member_id, academic_year_id) do nothing;
  get diagnostics v_rows = row_count;
  v_enrolled := v_rows > 0;

  perform fn_audit('upsert_member_and_enroll', 'member', v_member,
                   jsonb_build_object('academic_year_id', p_academic_year_id,
                                      'was_created', v_created,
                                      'was_enrolled', v_enrolled));

  return jsonb_build_object('member_id', v_member,
                            'was_created', v_created,
                            'was_enrolled', v_enrolled);
end
$$;

comment on function upsert_member_and_enroll(text, text, citext, citext, uuid, uuid) is
  'Officer only. Finds or creates a member and enrolls them for the year, in one transaction. Idempotent: enrolling somebody already enrolled is a no-op. p_matched_member_id carries an officers answer from the import preview.';

-- ---------------------------------------------------------------------------
-- 15.1 Privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC, and migration 11's
-- blanket revoke ran over the functions that existed then. Anything created
-- afterwards arrives reachable by anon, which for a SECURITY DEFINER function
-- that writes the roster is the whole hole. See the same note in migration 14.
-- ---------------------------------------------------------------------------

revoke all on function upsert_member_and_enroll(text, text, citext, citext, uuid, uuid)
  from public, anon, authenticated;

grant execute on function upsert_member_and_enroll(text, text, citext, citext, uuid, uuid)
  to authenticated, service_role;
