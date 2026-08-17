-- ===========================================================================
-- 20. THE NAME IS THE IDENTITY
-- ===========================================================================
-- A member has no email address any more. Nothing collects one: the check-in
-- page asks for a name, the roster screen has no address field, the CSV import
-- ignores the column, and the member portal is not an account. members.email
-- stays where it is, holding what was imported years ago, and is read by
-- nothing.
--
-- That takes the ground out from under one specific promise in migration 15.
-- upsert_member_and_enroll() resolved a row by p_matched_member_id, then by
-- email, then by ucf_nid, and otherwise created somebody. It deliberately had
-- no name tier, on the grounds that matching two live people by name is a
-- decision an officer should make in the import preview and hand back as
-- p_matched_member_id.
--
-- With no address, that leaves the function unable to recognise ANYBODY it did
-- not create in this call, and the idempotence the whole design rests on
-- ("re-running an interrupted import writes nothing for the rows that already
-- landed") was carried entirely by the email tier. What replaces it cannot be
-- the preview: the preview is a snapshot the client took before the run, and
-- the case that matters is precisely the one where the client's snapshot is out
-- of date, because the first attempt wrote rows it never heard back about.
-- Measured rather than assumed: with the email tier gone and no name tier,
-- re-importing a two-row file after a dropped response created both people a
-- second time.
--
-- So the name tier moves here, and it is the last tier rather than the first:
--
--   1. p_matched_member_id. An officer's answer still outranks everything.
--   2. email, then ucf_nid. Kept for scripts/import_roster.py and for rows
--      that still carry an address from before this migration.
--   3. the normalised name, among LIVE members only, oldest first.
--   4. nobody: create them.
--
-- Both spellings of the name are compared, the display name and first plus
-- last, so a member whose preferred name is on their row ("Abby Catto" for
-- Abigail) is found by either. fn_normalise_name() is the same comparison the
-- duplicate view and the import script use, so the three agree.
--
-- WHAT THIS GIVES UP, SAID PLAINLY. Two live members who genuinely share a name
-- can no longer both be created through this function: the second attempt finds
-- the first. That limit is not new to the product, it is only new here. The
-- roster screen has matched an exact name to an existing member since it was
-- written, and with no address there is nothing left that could tell two people
-- with one name apart. The way through remains what it has always been:
-- v_possible_duplicate_members raises the pair, and an officer merges them or
-- dismisses it.
--
-- Oldest first, so the tier is deterministic. A club that already holds two
-- rows for one name has a duplicate to resolve, and this must not quietly add
-- a third one to the pile every time that name is imported again.
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
  v_name     text;
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
  v_name  := fn_normalise_name(v_first || ' ' || v_last);

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
    -- The name tier. Live rows only: an archived member is not somebody an
    -- import should silently re-enrol, and a tombstone is not a person. Both
    -- reach the raise below when they are found by an id or an address, which
    -- is a caller naming them outright rather than this function guessing.
    if v_member is null and v_name is not null then
      select id into v_member
      from members
      where archived_at is null
        and merged_into_id is null
        and (fn_normalise_name(display_name) = v_name
             or fn_normalise_name(first_name || ' ' || last_name) = v_name)
      order by created_at, id
      limit 1;
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
  'Officer only. Finds or creates a member and enrolls them for the year, in one transaction. Resolves by p_matched_member_id, then email or student id, then the normalised name among live members, oldest first. Idempotent: enrolling somebody already enrolled is a no-op, and re-running an interrupted import finds the rows it already wrote.';
