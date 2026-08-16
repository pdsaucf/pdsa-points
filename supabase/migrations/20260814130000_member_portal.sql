-- ===========================================================================
-- 18. THE MEMBER PORTAL
-- ===========================================================================
-- docs/04-member-ui.md asks for four things: a member signs in, sees their own
-- progress, sees their own records, and says "I think this one is missing".
--
-- Three of those need nothing new. v_member_status, v_member_category_totals
-- and fn_member_requirement_status() are already security_invoker or already
-- assert fn_can_view_member(), and attendance_read_own and evidence_read_own
-- already show a member their own pending and rejected rows with the
-- review_note an officer typed. A member reading any of those gets their own
-- numbers and nobody elses, from the same definitions the officer board uses.
-- Adding a member-facing copy of any of it would be a second implementation of
-- the honorary rule, which invariant 2 exists to prevent.
--
-- WHAT IS ACTUALLY MISSING IS THE FRONT DOOR, and it is missing in four
-- places, each of which is something the portal cannot do with the tables it
-- is allowed to touch:
--
--   1. A signed-in account with no profiles row reads nothing, and nothing in
--      this schema creates one. Magic-link sign-in leaves every new account in
--      exactly that state (migration 16), so the portal has to be able to
--      bootstrap itself.
--   2. Picking yourself out of the roster requires reading the roster, and a
--      member cannot. That is not an oversight: docs/04 says there is no
--      member-visible roster and no leaderboard.
--   3. Confirming a claim means writing profiles.member_id, and
--      profiles_write_admin means an OFFICER cannot. web/src/claims.js
--      documents that gap in its own header: an officers Confirm today records
--      a decision it cannot carry out.
--   4. Filing a missing-credit request means inserting into
--      attendance_records, which a member cannot do and must never be able to
--      do directly, because the status column is what invariant 6 protects.
--
-- So this migration is one column, one column that keeps it honest, and six
-- SECURITY DEFINER functions, each of which owns exactly one of those writes.
-- Nothing here computes credit, evaluates a requirement, or decides anything.
-- The one function that files an attendance record files it `pending`, with no
-- argument by which the caller could ask for anything else, and it lands in
-- the same review queue as a scanned check-in.
--
-- TWO NEW ERROR CODES, and the reason there are two rather than one message
-- with two sentences in it. Migration 10 says the code is the contract and a
-- further distinction should be a further code. Filing a claim can fail in two
-- ways that look identical to the database and are not remotely identical to
-- the person: their own claim is already waiting (they are done, they should
-- stop pressing the button), or somebody else already claimed that person
-- (they picked the wrong row, or there is a duplicate on the roster, and
-- either way an officer has to look). Those need different screens.
--
--   PDS13  this account already has a live claim, or is already linked
--   PDS14  that member is already claimed by, or linked to, another account
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 18.1 The members own words
-- ---------------------------------------------------------------------------
-- A missing-credit request carries a sentence from the member, and there is
-- nowhere to put it. review_note is the officers field: review_records()
-- writes it, and docs/04 has the portal show it back to the member as the
-- reason a record was declined. A members note sitting in that column would be
-- read back to them as if an officer had typed it.
-- ---------------------------------------------------------------------------

alter table attendance_records add column member_note text;

comment on column attendance_records.member_note is
  'The members own words on a missing-credit request. Deliberately not review_note: that column is the officers, review_records() writes it, and the portal shows it back to the member as the reason a record was declined, so a members note left there would be read as an officers.';

-- ---------------------------------------------------------------------------
-- 18.2 The same split, on a claim
-- ---------------------------------------------------------------------------
-- member_claims.note is already the members: web/src/claims.js renders it as a
-- quotation on the officers card. Declining a claim needs a reason, and
-- writing it into that same column would overwrite what the member said with
-- what the officer said about them. One column per author, for the reason
-- 18.1 gives.
-- ---------------------------------------------------------------------------

alter table member_claims add column review_note text;

-- A CAP ENFORCED IN ONE WRITE PATH IS NOT A CAP. file_member_claim() refuses a
-- note over 500 characters, and claims_insert_own (migration 11) lets any
-- signed-in account POST a member_claims row straight to PostgREST without
-- going near that function. The constraint is where the two paths meet.
--
-- file_member_claim() keeps its own check rather than deferring to this one,
-- so a member who writes too much gets a sentence they can act on instead of a
-- constraint violation.
--
-- attendance_records.member_note deliberately has no matching constraint.
-- request_missing_credit() is its only writer: a member cannot insert into
-- attendance_records at all, because attendance_write_officer is the only
-- INSERT policy on that table. The reason for a constraint here is the second
-- write path, not a general preference for capping text columns, and adding
-- one where no second path exists would say the opposite.
alter table member_claims
  add constraint member_claims_note_length check (length(note) <= 500);

comment on column member_claims.review_note is
  'Why an officer decided a claim. member_claims.note is the members own words and is shown back to them, so a decline reason cannot go there. Same split as attendance_records.member_note against review_note.';

-- ---------------------------------------------------------------------------
-- 18.3 Starting a portal session
-- ---------------------------------------------------------------------------
-- The first call the portal makes, and the only one that can be made by an
-- account this schema has never seen. It answers "who am I, and which screen
-- am I on", and it creates the profiles row that every member-scoped policy
-- keys on.
--
-- IT IS NOT NAMED get_ ANYTHING. Every get_ in this schema is a read. This
-- writes: it can create a profiles row and it can link an account to a member.
--
-- THE ROLE IS WRITTEN OUT, NOT LEFT TO THE COLUMN DEFAULT. profiles.role
-- defaults to `viewer`, and a viewer is read-only STAFF: fn_is_staff() is true
-- for them, which is the whole club, every members progress and the roster.
-- Defaulting a stranger who completed a magic-link sign-in to that is a
-- privilege bug, not a naming detail, so this inserts 'member' explicitly and
-- does not rely on the default staying what it is.
--
-- WHAT AN OFFICER WITH NO PROFILES ROW GETS, because that case is real and the
-- answer should be deliberate: a profiles row with role member. They do not
-- come out an officer, and nothing here could safely make them one, because
-- "this person is an officer" is a fact only an admin holds and this function
-- has no way to ask. That is not a demotion either: an account with no
-- profiles row is not an officer as far as fn_current_role() is concerned, so
-- it had no officer rights to lose. What it does change is the shape of the
-- fix: the admin who was going to INSERT their profiles row now has to UPDATE
-- the role on the row that already exists. profiles_write_admin covers both,
-- so nothing is blocked, and the alternative (refusing to bootstrap an account
-- in case somebody meant to make it an officer later) would break the ordinary
-- member for the sake of the rare one.
--
-- AN EXISTING PROFILE IS NEVER UPGRADED. The insert is `on conflict do
-- nothing`, so an officer, admin or viewer who reaches the portal comes out
-- with the role they already had.
--
-- THE AUTO-LINK IS THE COMMON PATH, and docs/04 is explicit about why: once
-- officers collect emails on new members, the address someone signs in with
-- matches their roster row and nobody waits for a confirmation. members.email
-- is citext UNIQUE, so "matches exactly one live member" is enforced by the
-- index rather than hoped for; the query still spells out the three exclusions
-- that matter. An archived or merged row is not a person to link to, and a row
-- some other profile already holds is somebody elses record.
--
-- It links whatever role the caller has, not only members. docs/01 already
-- describes profiles.member_id as "optional: officer who is also a member",
-- and linking only ever grants access to the callers own row.
-- ---------------------------------------------------------------------------

create or replace function start_portal_session()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   citext;
  v_profile profiles;
  v_member  uuid;
  v_rows    int;
  v_created boolean := false;
  v_linked  boolean := false;
begin
  -- Not fn_assert_officer()'s shape and not a role check at all: this is the
  -- one function in the schema whose whole job is to serve a caller who has no
  -- role yet. All it needs is an end user.
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = 'PDS07';
  end if;

  select nullif(btrim(coalesce(u.email, '')), '')::citext
    into v_email
  from auth.users u
  where u.id = v_uid;

  insert into profiles (user_id, role)
  values (v_uid, 'member')
  on conflict (user_id) do nothing;
  get diagnostics v_rows = row_count;
  v_created := v_rows > 0;

  select * into v_profile from profiles p where p.user_id = v_uid;

  if v_profile.member_id is null and v_email is not null then
    select m.id into v_member
    from members m
    where m.email = v_email
      and m.archived_at is null
      and m.merged_into_id is null
      and not exists (select 1 from profiles o where o.member_id = m.id);

    if v_member is not null then
      begin
        update profiles set member_id = v_member where user_id = v_uid;
      exception when unique_violation then
        -- profiles.member_id is UNIQUE. The select above already excluded a
        -- member another profile holds, so reaching this means a second
        -- session linked the same member between the two statements. The
        -- honest answer is the one the officer flow gives.
        raise exception 'That member is already linked to another account.'
          using errcode = 'PDS14';
      end;
      v_profile.member_id := v_member;
      v_linked := true;
    end if;
  end if;

  -- Audited only when something changed. The portal calls this on every load,
  -- and an audit row per page view would bury the rows that mean something.
  -- An account being linked is exactly such a row: it is how somebody came to
  -- be able to read a members record, and an officer asking that question
  -- later should not have to infer it.
  if v_created or v_linked then
    perform fn_audit('start_portal_session', 'profile', null,
                     jsonb_build_object('created_profile', v_created,
                                        'auto_linked', v_linked,
                                        'member_id', v_profile.member_id));
  end if;

  return jsonb_build_object(
    'user_id',     v_uid,
    'role',        v_profile.role,
    'member_id',   v_profile.member_id,
    'member_name', (select m.display_name from members m where m.id = v_profile.member_id),
    'auto_linked', v_linked,
    -- The most recent claim in any status, because a rejected one is a screen
    -- too. At most one can be live: one_live_claim_per_user says so.
    'claim', (
      select jsonb_build_object(
               'id',           c.id,
               'status',       c.status,
               'member_id',    c.member_id,
               'member_name',  m.display_name,
               'requested_at', c.requested_at,
               'review_note',  c.review_note
             )
      from member_claims c
      join members m on m.id = c.member_id
      where c.user_id = v_uid
      order by c.requested_at desc, c.id
      limit 1
    )
  );
end
$$;

comment on function start_portal_session() is
  'Any signed-in account. Creates the callers profiles row when it is absent, with role member rather than the viewer column default, and links it to a member when the accounts email matches exactly one live unclaimed roster row. Never changes a role that already exists, never moves a member_id that is already set, and never links a member another profile holds. Returns {user_id, role, member_id, member_name, auto_linked, claim}, which is everything the portal needs to choose a screen. An officer whose account has no profiles row comes out a member: an admin then updates the role rather than inserting it.';

-- ---------------------------------------------------------------------------
-- 18.4 Finding yourself on a roster you cannot read
-- ---------------------------------------------------------------------------
-- The claim path in docs/04, made possible: "which of these is you", answered
-- by an account that is not allowed to read members. So it is a definer
-- function, and it is bounded on all four sides that matter.
--
--   WHO. A signed-in account that has a profiles row and is not yet linked.
--   That is exactly the population that needs it, and it is a population of
--   one screen: the moment the claim is approved the caller is refused. The
--   check is "not linked" rather than "is a member", so an officer whose own
--   account is not linked to a roster row can call it too. That is deliberate.
--   An officer already reads members through members_read_staff, so refusing
--   them here would protect nothing, and an officer who is also a member has
--   to be able to claim their own row like anybody else.
--
--   WHAT. id and display_name. No email, no NID, no join date, no totals,
--   nothing about progress. The same answer search_members() gives the
--   anonymous check-in page, and for the same reason.
--
--   HOW MUCH. Ten rows, three letters minimum, the same as search_members().
--   A shared minimum matters: a one-letter query is a way to walk the roster
--   alphabetically, and the check-in page settled that argument already.
--
--   HOW OFTEN. fn_rate_limit_check() keyed on the caller. Not on a check-in
--   token and not through fn_rate_limit_checkin(), because there is no event
--   and no crowd here: the caller is one signed-in account, so the account is
--   the bucket and there is nobody to share it with.
--
-- IT ALSO HIDES ANYBODY ALREADY SPOKEN FOR. A member another profile holds, or
-- one with a live claim on them, cannot be picked. Two people would otherwise
-- both pick Abigail Catto, one_live_claim_per_member would refuse the second,
-- and the refusal would arrive after they had already chosen. Filtering them
-- out of the list is the same rule stated earlier, where it reads as "not on
-- the list" instead of as an error.
-- ---------------------------------------------------------------------------

create or replace function search_roster_for_claim(p_q text)
returns table (id uuid, display_name text)
language plpgsql
volatile                       -- the limiter writes a counter row
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_profile profiles;
  v_q       text := btrim(coalesce(p_q, ''));
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = 'PDS07';
  end if;

  select * into v_profile from profiles p where p.user_id = v_uid;

  -- start_portal_session() creates that row, and the portal calls it before it
  -- can render the claim screen. A caller with no row has not come through the
  -- front door, and there is no reason to hand them the roster on the way past
  -- it.
  if v_profile.user_id is null then
    raise exception 'Start a portal session first.' using errcode = 'PDS07';
  end if;

  if v_profile.member_id is not null then
    raise exception 'This account is already linked to a member.' using errcode = 'PDS07';
  end if;

  if length(v_q) < 3 then
    raise exception 'Type at least three letters of your name.' using errcode = 'PDS03';
  end if;

  perform fn_rate_limit_check(
    'claim_search:' || v_uid::text,
    fn_setting_int('claim_search_max_per_min', 30)
  );

  return query
    select m.id, m.display_name
    from members m
    where m.archived_at is null
      and m.merged_into_id is null
      and not exists (select 1 from profiles o where o.member_id = m.id)
      and not exists (
        select 1 from member_claims c
        where c.member_id = m.id and c.status <> 'rejected'
      )
      and (m.display_name ilike '%' || v_q || '%'
           or m.display_name % v_q)
    order by
      -- exact prefix first, then trigram closeness, then alphabetical. Same
      -- ordering as search_members(), so the two name searches in this product
      -- rank the same way.
      (lower(m.display_name) like lower(v_q) || '%') desc,
      similarity(m.display_name, v_q) desc,
      m.display_name
    limit 10;
end
$$;

comment on function search_roster_for_claim(text) is
  'A signed-in account that is not yet linked to a member. Names and ids only, at most ten rows, at least three letters, rate limited per caller. Excludes archived, merged, already-linked and already-claimed rows, so a name on this list is a name that can be claimed. Never returns an email address, a student id, a join date or any total.';

-- ---------------------------------------------------------------------------
-- 18.5 Filing the claim
-- ---------------------------------------------------------------------------
-- The two partial unique indexes from migration 03 are the real guard, and
-- this function does not try to be a second one. It inserts, and it turns the
-- 23505 into something a person can act on.
--
-- WHY TWO MESSAGES AND TWO CODES. The two indexes describe two different
-- situations. one_live_claim_per_user means the caller already asked and is
-- waiting, which is not a mistake and needs no action from them.
-- one_live_claim_per_member means somebody else is already claiming that
-- person, which is either the wrong row picked or two roster rows for one
-- human, and an officer has to look. Collapsing those into "that did not work"
-- would leave the member with no idea which of the two they are in.
--
-- READ FROM constraint_name RATHER THAN PRE-CHECKED. A select-then-insert
-- would report the same two cases most of the time and lose the race the rest
-- of the time, and the index is what decides the outcome either way. Reading
-- which index fired is reading the actual answer.
--
-- NOT RATE LIMITED, deliberately. one_live_claim_per_user means a caller can
-- have exactly one row in flight; a second is refused until an officer rejects
-- the first. The write path is bounded by an officers attention rather than by
-- a counter, so a limiter here would only add a way to fail.
-- ---------------------------------------------------------------------------

create or replace function file_member_claim(
  p_member_id uuid,
  p_note      text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_profile    profiles;
  v_member     members;
  v_note       text;
  v_claim_id   uuid;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = 'PDS07';
  end if;

  select * into v_profile from profiles p where p.user_id = v_uid;
  if v_profile.user_id is null then
    raise exception 'Start a portal session first.' using errcode = 'PDS07';
  end if;
  if v_profile.member_id is not null then
    raise exception 'This account is already linked to a member.' using errcode = 'PDS07';
  end if;

  select * into v_member
  from members m
  where m.id = p_member_id
    and m.archived_at is null
    and m.merged_into_id is null;

  if v_member.id is null then
    raise exception 'Unknown member.' using errcode = 'PDS03';
  end if;

  -- A bound on what one caller can write into a column an officer reads. The
  -- form asks for a sentence, not an essay.
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if length(v_note) > 500 then
    raise exception 'That note is too long.' using errcode = 'PDS03';
  end if;

  begin
    insert into member_claims (user_id, member_id, note)
    values (v_uid, p_member_id, v_note)
    returning id into v_claim_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'one_live_claim_per_user' then
      raise exception 'You already have a claim waiting.' using errcode = 'PDS13';
    elsif v_constraint = 'one_live_claim_per_member' then
      raise exception 'Somebody has already claimed that member.' using errcode = 'PDS14';
    else
      -- Some other unique index fired. Whatever it was, it is not one of the
      -- two cases above and must not be described as either.
      raise;
    end if;
  end;

  return jsonb_build_object(
    'claim_id',    v_claim_id,
    'status',      'pending',
    'member_id',   p_member_id,
    'member_name', v_member.display_name
  );
end
$$;

comment on function file_member_claim(uuid, text) is
  'A signed-in account that is not yet linked to a member. Files a pending claim on one live roster row, carrying the members own note. PDS13 when this account already has a claim waiting, PDS14 when somebody else already holds one on that member: two different situations, and only one of them is the callers mistake. Never sets status to anything but pending and never links anything.';

-- ---------------------------------------------------------------------------
-- 18.6 Settling the claim
-- ---------------------------------------------------------------------------
-- The gap web/src/claims.js documents in its own header. An officer can update
-- member_claims.status, because claims_review says so, and cannot write
-- profiles.member_id, because profiles_write_admin says only an admin may. So
-- an officers Confirm today records a decision it cannot carry out, and the
-- screen has to say so.
--
-- This function owns that one write, so an officer can finish the job. It does
-- NOT widen profiles_write_admin: an officer still cannot change anybodys
-- role, cannot unlink an account, and cannot write any other column. They can
-- do exactly one thing, to one row, as the result of one recorded decision.
--
-- THE MEMBER IS REVALIDATED HERE, NOT ONLY WHEN THE CLAIM WAS FILED.
-- file_member_claim() checks the roster row is live at the moment somebody
-- picks it. Approval can be days later: that gap is the design, because
-- docs/04 budgets one officer click per member spread over whenever each
-- person first signs in. The roster is not frozen for those days, and what
-- happens to it in the meantime is precisely archiving and merging. A fresh
-- import has just run, duplicates are being cleaned up, and the claims
-- arriving are from the people that import just added. So the two things that
-- can have happened to the member are the two most likely things in the
-- window, and they are answered differently because they mean different
-- things.
--
--   MERGED: FOLLOW IT. A merge does not mean the person stopped existing. It
--   means the row representing them moved, and merge_members() moved every
--   attendance record with it. The member said "I am Abigail Catto" and they
--   still are; the row that represents her is now the survivor, and the
--   survivor is where their history is. Refusing would leave a real person
--   unable to claim a real record for a reason that is pure bookkeeping, and
--   linking to the tombstone would hand them an empty portal. The walk is the
--   one upsert_member_and_enroll() already does, bounded the same way and for
--   the same reason: merges chain a few deep at most, and the cap guards a
--   cycle the schema does not permit rather than an expected depth.
--
--   ARCHIVED: REFUSE. Archived is an officer saying this is not somebody we
--   are tracking. search_roster_for_claim() already declines to offer them, so
--   approving one here would leave the two halves of one rule disagreeing.
--
-- The row that is landed on is locked FOR UPDATE, and so is every row walked
-- through to reach it, so the check and the write cannot be separated.
--
-- THAT LOCK IS ONLY WORTH SOMETHING BECAUSE OF 18.11 AT THE BOTTOM OF THIS
-- FILE. merge_members() tombstones the loser as its last write, so a merge in
-- flight used to look exactly like no merge at all: records already moved,
-- merged_into_id still null. Reading those two columns off a locked row proves
-- nothing unless the merge takes its own lock before it starts moving
-- anything, which is what 18.11 adds.
--
-- WHAT IS NOT REWRITTEN: the claim. member_claims.member_id still says what
-- the member actually picked. It is the record of an assertion a person made,
-- and editing it to point somewhere else would destroy that record in order to
-- tidy an index. Following is therefore reported instead: the return value and
-- the audit row both carry the claimed id and the resolved id, so an officer
-- can see that Confirm on one row linked another.
--
-- ONE REFUSAL IS A CHECK AND THE OTHER IS A CONSTRAINT, deliberately.
-- Approving must not overwrite a member_id that is already set, and must not
-- hand out a member another profile already holds. Nothing in the schema
-- enforces the first, so it is an explicit check. The second is exactly what
-- the UNIQUE constraint on profiles.member_id enforces, so the constraint
-- decides it and the handler translates the 23505 into PDS14.
--
-- That is not belt and braces, it is the removal of a belt that could not be
-- trusted. An exists() check followed by an insert is a read and a write with
-- a gap between them, and profiles.member_id has two other writers with no
-- interest in this function's gap: an admin patching profiles directly, and
-- another account auto-linking through start_portal_session(). The check would
-- pass, the constraint would fire anyway, and the caller would get a raw 23505
-- instead of the message. Letting the constraint answer removes the gap rather
-- than narrowing it, and it is the same choice file_member_claim() makes about
-- its two partial indexes, for the same stated reason. start_portal_session()
-- already translates this identical constraint the identical way.
--
-- The claim row is locked FOR UPDATE first, so two officers confirming the
-- same claim at the same moment resolve in a line rather than both writing.
--
-- REJECTING IS NOT A DEAD END. Both partial indexes exclude rejected rows, so
-- a declined claim frees the member and the account to try again, which is
-- what web/src/claims.js already tells the officer it does.
-- ---------------------------------------------------------------------------

create or replace function review_member_claim(
  p_claim_id uuid,
  p_decision text,
  p_note     text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_claim     member_claims;
  v_member    members;
  v_member_id uuid;
  v_profile   profiles;
  v_linked    uuid;
  v_status    text;
  v_note      text;
begin
  -- Spelled positively for the reason migration 16 gives: fn_is_officer() is
  -- NULL, not false, for a caller with no profiles row, and this function
  -- writes the column that decides who can read a members record.
  if not coalesce(fn_is_officer(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject.' using errcode = 'PDS03';
  end if;

  select * into v_claim from member_claims c where c.id = p_claim_id for update;
  if v_claim.id is null then
    raise exception 'Unknown claim.' using errcode = 'PDS03';
  end if;
  if v_claim.status <> 'pending' then
    raise exception 'That claim has already been decided.' using errcode = 'PDS03';
  end if;

  v_status := case p_decision when 'approve' then 'approved' else 'rejected' end;
  v_note   := nullif(btrim(coalesce(p_note, '')), '');

  if p_decision = 'approve' then
    -- Follow the tombstone, locking every row on the way, so the row this
    -- lands on cannot be merged or archived between the checks below and the
    -- write. Reading merged_into_id off the locked row is what makes the exit
    -- condition trustworthy.
    v_member_id := v_claim.member_id;
    for i in 1..10 loop
      select * into v_member from members m where m.id = v_member_id for update;
      exit when v_member.id is null;
      exit when v_member.merged_into_id is null;
      v_member_id := v_member.merged_into_id;
    end loop;

    -- member_claims.member_id references members on delete cascade, so a claim
    -- whose member is gone is gone too. Checked anyway: this function decides
    -- who reads whose record, and "the row I was about to link is not there"
    -- is not a question to answer by assumption.
    if v_member.id is null then
      raise exception 'Unknown member.' using errcode = 'PDS03';
    end if;

    -- Ten rows deep and still pointing somewhere else, which means a cycle or
    -- a chain longer than any real merge history. Refusing beats linking to
    -- whatever the walk happened to stop on.
    if v_member.merged_into_id is not null then
      raise exception 'That members record cannot be resolved.' using errcode = 'PDS03';
    end if;

    if v_member.archived_at is not null then
      raise exception 'That member is archived.' using errcode = 'PDS03';
    end if;

    -- Locked before it is read, so an admin patching profiles, or another
    -- account auto-linking through start_portal_session(), queues behind this
    -- decision instead of landing in the middle of it. A row that does not
    -- exist yet cannot be locked, which is what the postcondition below is
    -- for.
    select * into v_profile from profiles p where p.user_id = v_claim.user_id for update;

    if v_profile.member_id is not null and v_profile.member_id <> v_member.id then
      raise exception 'That account is already linked to a member.'
        using errcode = 'PDS13';
    end if;

    -- The insert half is not hypothetical. claims_insert_own lets any
    -- signed-in account file a claim through PostgREST without ever calling
    -- start_portal_session(), so the profiles row may genuinely not exist yet.
    -- Role comes out `member` on that path for the reason 18.3 gives, and the
    -- do-update branch never touches role, so an existing officer keeps theirs.
    --
    -- The only unique constraint this statement can violate is the one on
    -- profiles.member_id: a conflict on the primary key is what `on conflict
    -- (user_id)` handles, and the do-update branch is guarded so that
    -- re-approving a link that already exists is a no-op rather than an error.
    -- So unique_violation here has exactly one meaning, and it is the one the
    -- message gives.
    begin
      insert into profiles (user_id, member_id, role)
      values (v_claim.user_id, v_member.id, 'member')
      on conflict (user_id) do update
        set member_id = excluded.member_id
        where profiles.member_id is null
      returning member_id into v_linked;
    exception when unique_violation then
      raise exception 'That member is already linked to another account.'
        using errcode = 'PDS14';
    end;

    -- THE POSTCONDITION. The `where profiles.member_id is null` guard above
    -- can suppress the update silently: no row is written, no constraint is
    -- violated, and nothing about the statement says it did nothing. Without
    -- this check the function would then mark the claim approved and return
    -- linked = true having linked nobody, which is worse than any error code,
    -- because a wrong refusal gets retried and a wrong success does not.
    --
    -- No row came back means the statement changed nothing, and there are two
    -- reasons for that: the profile already holds this exact member, which is
    -- fine and is what re-approving an already-settled link looks like, or it
    -- holds somebody else. Reading the row is what tells them apart.
    --
    -- Setting the race aside entirely, this function exists to make one
    -- specific link. It should not be able to report success without having
    -- confirmed that link is the one that now exists.
    if v_linked is null then
      select p.member_id into v_linked from profiles p where p.user_id = v_claim.user_id;
    end if;

    if v_linked is distinct from v_member.id then
      raise exception 'That account is already linked to a member.'
        using errcode = 'PDS13';
    end if;
  end if;

  update member_claims
  set status      = v_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = coalesce(v_note, review_note)
  where id = p_claim_id;

  -- Both ids, always. On a reject they are the same and the row still reads
  -- correctly; on an approve that followed a merge, this is the only place
  -- that records that Confirm on one row linked another.
  perform fn_audit('review_member_claim', 'member_claim', p_claim_id,
                   jsonb_build_object('decision', p_decision,
                                      'user_id', v_claim.user_id,
                                      'claimed_member_id', v_claim.member_id,
                                      'member_id', coalesce(v_member.id, v_claim.member_id),
                                      'followed_merge',
                                        v_member.id is not null
                                        and v_member.id <> v_claim.member_id,
                                      'note', v_note));

  return jsonb_build_object(
    'claim_id',          p_claim_id,
    'status',            v_status,
    'user_id',           v_claim.user_id,
    'claimed_member_id', v_claim.member_id,
    'member_id',         coalesce(v_member.id, v_claim.member_id),
    'followed_merge',    v_member.id is not null and v_member.id <> v_claim.member_id,
    'linked',            p_decision = 'approve'
  );
end
$$;

comment on function review_member_claim(uuid, text, text) is
  'Officer only, audited. Approve links the account to the member and marks the claim approved; reject marks it rejected and keeps the reason in review_note, leaving the member and the account free to try again. The member is revalidated at approval rather than trusted from when the claim was filed: a merge is followed to the survivor, which is where merge_members() put their records, and an archived row is refused (PDS03). The claim keeps saying who the member picked; the return value and the audit row carry the claimed id and the resolved id both. Refuses to overwrite a member_id that is already set (PDS13), and the UNIQUE constraint on profiles.member_id refuses a member another profile already holds (PDS14). This is the only path by which an officer can write profiles.member_id, and it is the only column of profiles it writes.';

-- ---------------------------------------------------------------------------
-- 18.7 The claim queue, with the address they signed in with
-- ---------------------------------------------------------------------------
-- The second thing web/src/claims.js documents as impossible. The wireframe
-- leads each card with the address the person signed in with, that address
-- lives in auth.users.email, and PostgREST serves the `public` schema only. So
-- the screen leads with profiles.full_name instead, which is null for every
-- account that never set one, which is all of them.
--
-- One definer function fixes it. It returns the pending queue and nothing
-- else: no other account is visible through it, and the email it exposes
-- belongs to the person asking to be linked, to the officer who has to decide
-- whether they are who they say they are. That is the entire question the card
-- exists to answer.
-- ---------------------------------------------------------------------------

create or replace function list_pending_claims()
returns table (
  claim_id      uuid,
  user_id       uuid,
  account_email text,
  account_name  text,
  member_id     uuid,
  member_name   text,
  note          text,
  requested_at  timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not coalesce(fn_is_officer(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  -- Every column reference below is table-qualified. Unqualified ones would
  -- collide with the OUT parameter names above, which plpgsql resolves in
  -- favour of the variable.
  return query
    select c.id,
           c.user_id,
           u.email::text,
           p.full_name,
           c.member_id,
           m.display_name,
           c.note,
           c.requested_at
    from member_claims c
    join members m on m.id = c.member_id
    left join auth.users u on u.id = c.user_id
    left join profiles   p on p.user_id = c.user_id
    where c.status = 'pending'
    order by c.requested_at, c.id;
end
$$;

comment on function list_pending_claims() is
  'Officer only. The pending claim queue, carrying the address the account signed in with (auth.users.email, which PostgREST cannot serve) and the roster name being claimed. Read only.';

-- ---------------------------------------------------------------------------
-- 18.8 "Something is missing"
-- ---------------------------------------------------------------------------
-- docs/04: pick the event, add a note, submit. It files an ordinary
-- attendance_records row, pending, sourced member_request, flagged
-- member_requested, and it lands in the review queue beside the scanned
-- check-ins. web/src/review.js already reads that source and that flag.
--
-- INVARIANT 6 IS THE WHOLE DESIGN HERE. This is a request, not a credit.
-- Nothing about the arguments lets a caller reach the status column, and the
-- officer who approves it is doing the same action, in the same screen, as
-- approving a check-in. That is also why this is not a support inbox: an
-- inbox would need somebody to transcribe its contents into a record, and the
-- transcription is where things get lost.
--
-- WHAT IT REFUSES, AND WHY EACH ONE IS A REFUSAL RATHER THAN A FLAG.
-- submit_checkin() flags an unenrolled member and lets the record through,
-- because somebody physically standing at an event is evidence and an officer
-- can enroll them from the queue. Nobody is standing anywhere here, so an
-- event in a year the member is not on the roster for is a mistake at the
-- point of asking, and saying so immediately is better than filing a record
-- that will be declined later.
--
-- ONE FLAG, NOT SEVERAL. submit_checkin() computes a whole triage set;
-- this sets member_requested and stops. The flags a check-in computes are
-- statements about a submission made at an event, and adding, say,
-- previously_rejected here would change which flag the card leads with
-- (web/src/flags.js orders them) and headline a members request as somebody
-- elses earlier decision.
--
-- THE VALUE IS VALIDATED EXACTLY AS submit_checkin() VALIDATES IT, including
-- discarding a value nobody asked for, because the two paths write the same
-- column and v_attendance_credit reads it the same way from both.
-- ---------------------------------------------------------------------------

create or replace function request_missing_credit(
  p_event_id uuid,
  p_note     text,
  p_value    numeric default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid         uuid := auth.uid();
  v_profile     profiles;
  v_event       events;
  v_note        text;
  v_needs_value boolean;
  v_record_id   uuid;
  v_flags       text[] := array['member_requested'];
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = 'PDS07';
  end if;

  select * into v_profile from profiles p where p.user_id = v_uid;
  if v_profile.user_id is null or v_profile.member_id is null then
    raise exception 'This account is not linked to a member yet.' using errcode = 'PDS07';
  end if;

  -- Keyed on the caller, for the reason 18.4 gives: one signed-in account, no
  -- event token, nobody to share a bucket with. Placed here so that a caller
  -- cannot spend somebody elses allowance and cannot spend their own on
  -- arguments that were never going to be accepted.
  perform fn_rate_limit_check(
    'missing_credit:' || v_uid::text,
    fn_setting_int('missing_credit_max_per_min', 5)
  );

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is null then
    raise exception 'Say what is missing.' using errcode = 'PDS03';
  end if;
  if length(v_note) > 500 then
    raise exception 'That note is too long.' using errcode = 'PDS03';
  end if;

  select * into v_event from events e where e.id = p_event_id and e.is_published;
  if v_event.id is null then
    raise exception 'Unknown event.' using errcode = 'PDS03';
  end if;

  -- Same definition of enrolled that submit_checkin() uses for its
  -- not_enrolled flag, so the two paths agree about who is on this years
  -- roster.
  if not exists (
    select 1 from member_enrollments me
    where me.member_id        = v_profile.member_id
      and me.academic_year_id = v_event.academic_year_id
      and me.status           = 'active'
  ) then
    raise exception 'You are not on the roster for that year.' using errcode = 'PDS03';
  end if;

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

  begin
    insert into attendance_records (
      event_id, member_id, status, source, submitted_value, flags, member_note
    ) values (
      v_event.id,
      v_profile.member_id,
      'pending',          -- forced, never an argument
      'member_request',   -- forced, never an argument
      p_value,
      v_flags,
      v_note
    )
    returning id into v_record_id;
  exception when unique_violation then
    -- one_live_record_per_member_event. The member already has a live record
    -- for this event, which is usually the answer they were looking for: it is
    -- there, it is just not approved yet.
    raise exception 'You already have a record for that event.' using errcode = 'PDS05';
  end;

  return jsonb_build_object(
    'record_id', v_record_id,
    'status',    'pending',
    'flags',     to_jsonb(v_flags)
  );
end
$$;

comment on function request_missing_credit(uuid, text, numeric) is
  'A member linked to a roster row. Files one pending attendance record for a published event in a year they are enrolled for, source member_request, flagged member_requested, with their own words in member_note. Approves nothing: it lands in the same review queue as a scanned check-in, per invariant 6. Requires a value on an event whose category reads one, and ignores a value on an event that does not. PDS05 when a live record for that event already exists.';

-- ---------------------------------------------------------------------------
-- 18.9 Settings
-- ---------------------------------------------------------------------------
-- Both ceilings are per signed-in account per minute, so neither is shared
-- with anybody and neither has a crowd behind it. They are rows so that
-- raising one is a settings edit, like every other ceiling in this schema.
-- ---------------------------------------------------------------------------

insert into app_settings (key, value) values
  -- Somebody typing their own name into the claim screen, character by
  -- character, with each keystroke a request.
  ('claim_search_max_per_min',   '30'::jsonb),
  -- A member filing a missing-credit request is filling in a form, one event
  -- at a time. Five a minute is already several more than the screen can
  -- produce.
  ('missing_credit_max_per_min', '5'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 18.10 Privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC, and migration 11's
-- blanket revoke ran over the functions that existed then. Same note as
-- migrations 14, 15 and 17, and test/privileges.test.mjs fails when a
-- migration forgets these lines.
--
-- NONE OF THESE IS AN ANON FUNCTION. The anonymous surface is the four
-- check-in RPCs and nothing else, and every function above needs an end user:
-- five of them read auth.uid() as the caller they serve, and the sixth is
-- officer only. test/privileges.test.mjs pins that list from both sides, so
-- adding one of these to it would be a failure rather than an edit.
-- ---------------------------------------------------------------------------

revoke all on function start_portal_session()                          from public, anon, authenticated;
revoke all on function search_roster_for_claim(text)                   from public, anon, authenticated;
revoke all on function file_member_claim(uuid, text)                   from public, anon, authenticated;
revoke all on function review_member_claim(uuid, text, text)           from public, anon, authenticated;
revoke all on function list_pending_claims()                           from public, anon, authenticated;
revoke all on function request_missing_credit(uuid, text, numeric)     from public, anon, authenticated;

grant execute on function start_portal_session()                       to authenticated, service_role;
grant execute on function search_roster_for_claim(text)                to authenticated, service_role;
grant execute on function file_member_claim(uuid, text)                to authenticated, service_role;
grant execute on function review_member_claim(uuid, text, text)        to authenticated, service_role;
grant execute on function list_pending_claims()                        to authenticated, service_role;
grant execute on function request_missing_credit(uuid, text, numeric)  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 18.11 THE LOCK merge_members() WAS MISSING, WHICH 18.6 NOW DEPENDS ON
-- ---------------------------------------------------------------------------
-- review_member_claim() revalidates the member it is about to link and takes
-- FOR UPDATE on the row it lands on. That is only worth anything if a merge in
-- flight is visible as a merge in flight, and until now it was not.
--
-- WHAT merge_members() DOES, IN ORDER (migration 10): asserts officer, tests
-- both ids exist with an unlocked `select 1`, deletes the colliding attendance
-- rows, moves the rest to the survivor, copies and deletes the enrollments,
-- and only THEN sets merged_into_id on the loser. The tombstone is the last
-- write in the function.
--
-- So there is a long window in which every record and enrollment has already
-- moved to the survivor while members still describes the loser as an ordinary
-- live person. Any reader consulting members during that window sees a row
-- that is live, unmerged, and empty.
--
-- review_member_claim() is exactly such a reader:
--
--   merge:    moves every record and enrollment, has not yet tombstoned
--   approval: locks the loser, sees merged_into_id and archived_at null,
--             concludes it is live, links the account, commits
--   merge:    tombstones the loser, commits
--
-- The account is now linked to a tombstone whose records are all on the
-- survivor. The officer was told it worked and the member opens an empty
-- portal, which is the failure the merge-following in 18.6 exists to prevent,
-- arriving through a different door.
--
-- WHY THE LOCK IS AT THE TOP RATHER THAN BESIDE THE UPDATE IT PROTECTS.
-- Locking next to the tombstone would fix nothing: by then the records have
-- already moved and the reader has already decided. The lock has to be taken
-- before the first write, so that anybody consulting these two rows either
-- waits for the whole merge or sees the state as it was before it began.
--
-- LEAST AND GREATEST, IN TWO STATEMENTS, so the acquisition order is a
-- property of the code and not of a query plan. Two officers merging the same
-- pair with the arguments swapped would otherwise take the two locks in
-- opposite orders and deadlock. dismiss_duplicate_pair() (migration 14)
-- normalises its pair the same way, for the same reason.
--
-- A DEADLOCK IS STILL POSSIBLE against review_member_claim(), which walks a
-- merge chain and therefore locks in chain order rather than id order. It
-- requires a merge of exactly the two rows in one claim's chain at the same
-- instant. Postgres detects it and aborts one side; both functions are single
-- transactions, so the loser rolls back whole and the officer retries. That is
-- an acceptable outcome for two rare officer actions. Linking somebody to a
-- tombstone is not.
--
-- WHY THIS IS HERE AND NOT IN MIGRATION 10, where the ordering it fixes lives.
-- A migration log is append only. An edit to a migration that has already been
-- applied reaches no database that has already run it, so the fix would exist
-- in the repository and not in the world. Migration 16 settled this for this
-- project when it replaced fn_assert_officer() and fn_assert_admin() rather
-- than editing migration 09, and migrations 14, 15 and 17 all append.
--
-- NOTHING IN THE TEST SUITE COULD HAVE CAUGHT THE OTHER CHOICE. The harness
-- replays every migration from scratch into a fresh database, so an in-place
-- edit and an append produce the identical schema and the identical result. A
-- green run says nothing about which was done. This convention is held by
-- convention, or not at all.
--
-- `create or replace` keeps the existing ACL, so the grant migration 11 made
-- to `authenticated` survives and no privilege statement belongs here. That is
-- asserted in test/privileges.test.mjs rather than assumed.
--
-- The body below is migration 10's, unchanged except for the two locks.
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

  -- Ordered by id, not by which argument is which, so two officers merging the
  -- same pair the other way round queue instead of deadlocking. A missing id
  -- locks nothing here and is reported by the existence check below.
  perform 1 from members where id = least(p_from_id, p_into_id)    for update;
  perform 1 from members where id = greatest(p_from_id, p_into_id) for update;

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
