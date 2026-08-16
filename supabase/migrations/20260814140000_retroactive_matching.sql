-- ===========================================================================
-- 19. RETROACTIVE MATCHING
-- ===========================================================================
-- Somebody attends four events before they pay. Each time, they are not on
-- the roster, so they use the free-text path submit_checkin() already offers:
-- they type their name and email, and a real attendance_records row is filed
-- with member_id null, claimed_name and claimed_email holding what they
-- typed, and an unmatched_name flag. That part is unchanged.
--
-- What was missing is what happens when they finally join. An officer adds
-- them to the roster, and their four earlier check-ins do not follow: nothing
-- connects a new members row to the claimed_name sitting in four unrelated
-- attendance_records rows, so each one waits for an officer to remember it
-- exists and resolve it by hand, one resolve_unmatched() call at a time.
--
-- The old Google Sheets system did this automatically: the name went on the
-- master sheet and a lookup counted every row carrying it. That mechanism is
-- deliberately not reproduced here. A blind name lookup is exactly the
-- failure this schema exists to avoid: two members named Priya Sharma is not
-- a hypothetical (see the merge-vs-collision handling in migration 14), and a
-- lookup that hands one of them the other's attendance would be silent about
-- it, discovered only when somebody's total looks wrong months later.
--
-- SO THIS IS OFFERED, NEVER AUTOMATIC. fn_retroactive_match_candidates(member)
-- finds the unresolved check-ins that might belong to a given roster row and
-- returns them for an officer to look at. Nothing is written by looking.
-- link_retroactive_matches(member, record_ids[]) does the writing, and it
-- takes the exact rows the officer confirmed, not a name to go match again.
--
-- THAT SECOND POINT IS THE WHOLE DESIGN. A function that re-ran the match
-- inside itself, given only a member id, could link a record the officer
-- never saw on their screen: the candidate list and the write would be two
-- separate computations of "which records match", and nothing would force
-- them to agree from one call to the next (a setting changed in between, a
-- new attendance record filed after the preview loaded). Taking the id array
-- as the only source of truth for what gets linked closes that gap the same
-- way an explicit allowlist always does: the function trusts what the caller
-- already decided, and computes nothing on its own about who these records
-- belong to.
--
-- EMAIL EXACT FIRST, THEN FUZZY NAME. members.email and attendance_records
-- carry an identity question and a resemblance question, and they are not the
-- same confidence. fn_normalise_email() (migration 14) collapses a +tag and
-- interior dots, so two spellings that reach one inbox count as the same
-- address; a match on it is reported as 'exact_email' and scored 1.000, the
-- same convention v_possible_duplicate_members uses for its exact tiers. A
-- name is not an identity: two different people can share one, so a name
-- match is reported as 'name_match' with a trigram score, and the officer is
-- shown a suggestion rather than a fact. There is deliberately no third
-- reason for a normalised-exact name match sitting between the two: migration
-- 14 splits exact_name from close_name because it ranks candidate PAIRS
-- against each other and needs the finer order. Here the officer already
-- knows which member they are looking at; a normalised-exact name is still
-- just a name, so it is the strongest possible name_match (score 1.000) and
-- not a different kind of match.
--
-- THE SIMILARITY FLOOR is 0.3, not one of the two settings migration 14
-- already defines. duplicate_person_similarity (0.55) and its variant answer
-- "are these two ROSTER ROWS one human", tuned against a 355-name roster
-- where a flood of suggestions is the failure to avoid. This is a different
-- question: "does this one typed string match this one specific member I am
-- already looking at". That is exactly the question web/src/roster.js's CSV
-- import preview asks, and its FUZZY_FLOOR is 0.3, set from "Abby Cato"
-- scoring 0.333 against "Abigail Catto" (see that file's comment). Reused
-- here as the retroactive_name_similarity setting, same value, same reason.
--
-- ONE DELIBERATE DEVIATION from how migration 14 calls similarity(): it
-- compares two members.display_name values, which are both properly cased
-- roster entries, so it compares them raw. claimed_name is whatever an
-- attendee typed on their phone, in whatever case they used, so both sides
-- are passed through fn_normalise_name() first here. Comparing raw would
-- silently mis-score "JOHN SMITH" against "John Smith", which is not a
-- resemblance question, it is the same person typing in caps lock.
--
-- INVARIANT 6, THE ONE TO HOLD HERE. link_retroactive_matches() links records
-- to a member. It does not approve them. resolve_unmatched() draws exactly
-- this line and says why in its own comment: resolving who somebody is and
-- deciding whether they get credit are two different judgements, and the
-- design says every attendance record is approved by a person. Linked
-- records stay 'pending' and go through review_records() like every other
-- record in the queue, four times over instead of once.
--
-- A CONFIRMATION IS PER RECORD, NOT AN AGGREGATE. An officer looking at a
-- candidate list decided about specific rows: this one, yes; that one, no.
-- A function that reported back a single count could not be asked "which
-- ones", and a batch id list is exactly the shape where "some of it worked"
-- is not an answer. link_retroactive_matches() therefore returns one row per
-- distinct id requested, each carrying its own outcome, the same contract
-- upsert_members_and_enroll() (migration 17) already keeps for a batch: a
-- caller reads the outcome off the row it asked about and never has to infer
-- what happened to one id from a total that covers all of them. The outcome
-- vocabulary is linked, already_linked, not_pending, wrong_year, not_found,
-- and conflict; see the function body for what forces each one, conflict
-- least of all.
--
-- NOT_PENDING IS CHECKED AT WRITE TIME, NOT ONLY AT PREVIEW TIME, because the
-- gap between the two is real: an officer opens the candidate list, another
-- officer rejects one of the records it shows through review_records(), and
-- the first officer presses Confirm on a list that is now stale. The write
-- below is a single guarded UPDATE whose WHERE clause re-reads member_id and
-- status at the moment it runs, so a record rejected in that gap is refused
-- there rather than linked on the strength of a screen that was already
-- wrong. This is the ordinary way a guarded UPDATE is race-safe: it takes
-- Postgres's row lock and re-evaluates its predicate against whatever the
-- latest committed row says, waiting out any transaction that is still
-- writing it. No SELECT ... FOR UPDATE is needed ahead of it for that
-- reason, only for the target member below, where the check and the write
-- are two separate statements and nothing else holds them together.
--
-- THE TARGET MEMBER IS RESOLVED AND LOCKED before either function does
-- anything else, in the walk review_member_claim() (migration 18, section
-- 18.6) already uses and for the same two reasons:
--
--   ARCHIVED: REFUSED. An officer archiving a member is saying this is not
--   somebody the club tracks. Offering a screen of retroactive matches for
--   them, or attaching new records to them, strands that attendance on an
--   identity nobody is looking at again.
--
--   MERGED: FOLLOWED, to the survivor, because merge_members() already moved
--   every one of that member's records there. Sending a fresh link to the
--   tombstone instead would strand it exactly where the rest of that
--   person's history is not. Both functions report resolved_member_id and
--   followed_merge, the way review_member_claim() reports member_id and
--   followed_merge, so a caller that asked about a tombstone is told where
--   the answer actually landed rather than left to notice later.
--
-- link_retroactive_matches() takes the row-level lock the walk implies
-- (`for update`, exactly as 18.6 does) because it follows the walk with a
-- write in the same transaction, and 18.11 is exactly the reason that lock
-- has to be taken before the write, not assumed from an earlier read.
-- fn_retroactive_match_candidates() walks the same chain unlocked: it never
-- writes anything afterward, so there is no write for a lock to protect, and
-- read-only SELECTs elsewhere in this schema (resolve_unmatched()'s own
-- member lookup, upsert_member_and_enroll()'s tombstone walk) do not take
-- one either.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 19.1 The similarity floor
-- ---------------------------------------------------------------------------

insert into app_settings (key, value) values
  ('retroactive_name_similarity', '0.3'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 19.2 fn_retroactive_match_candidates(member_id)
-- ---------------------------------------------------------------------------
-- Read-only. SECURITY DEFINER for the same two reasons fn_duplicate_member_pairs
-- (migration 14) is: migration 11 revoked EXECUTE on pg_trgm's similarity()
-- from authenticated, and this has to read claimed_name and claimed_email off
-- every pending, unmatched attendance_records row regardless of whose policy
-- would otherwise show it to the caller.
--
-- "Unresolved" is member_id is null and status = 'pending'. A rejected
-- unmatched row is not offered: nobody is deciding whether to link something
-- an officer already looked at and turned down without also reviewing it.
-- A row already linked to somebody, or an approved row, is excluded by the
-- same member_id is null test the whole design relies on.
--
-- THE ENROLLMENT-YEAR FILTER is not a nicety, it is what keeps this
-- consistent with what the rest of the schema already does with credit.
-- v_member_status (migration 09) is driven from member_enrollments: it joins
-- one row per (member, academic_year) the member actually has, and sums
-- v_member_category_totals only for that pairing. A linked record whose
-- event falls in a year with no member_enrollments row for this member would
-- sit in attendance_records approved and simply never be summed into any
-- year's total, an orphaned credit nobody would think to look for. Filtering
-- it out here means the candidate list never offers a link that could not
-- ever count, which is a truer answer than technically permitting it.
--
-- THE TARGET IS RESOLVED BEFORE ANYTHING ELSE RUNS: archived is refused,
-- merged is followed to the survivor. See the migration header for why, and
-- why this walk is unlocked where link_retroactive_matches()'s is not.
-- resolved_member_id and followed_merge are carried on every returned row so
-- a caller that asked about a tombstone can tell whose candidates these
-- actually are without a second call.
create or replace function fn_retroactive_match_candidates(p_member_id uuid)
returns table (
  record_id           uuid,
  event_id            uuid,
  event_title         text,
  occurred_on         date,
  claimed_name        text,
  claimed_email       citext,
  reason              text,
  score               numeric,
  resolved_member_id  uuid,
  followed_merge      boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_member    members;
  v_target    uuid;
  v_followed  boolean;
  v_floor     numeric;
  v_norm_name text;
  v_norm_email text;
begin
  if not coalesce(fn_is_officer(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  -- The same bounded walk review_member_claim() (migration 18, 18.6) uses,
  -- unlocked: this function only ever reads.
  v_target := p_member_id;
  for i in 1..10 loop
    select * into v_member from members m where m.id = v_target;
    exit when v_member.id is null;
    exit when v_member.merged_into_id is null;
    v_target := v_member.merged_into_id;
  end loop;

  if v_member.id is null then
    raise exception 'Unknown member.' using errcode = 'PDS03';
  end if;
  if v_member.merged_into_id is not null then
    raise exception 'That members record cannot be resolved.' using errcode = 'PDS03';
  end if;
  if v_member.archived_at is not null then
    raise exception 'That member is archived.' using errcode = 'PDS03';
  end if;

  v_target   := v_member.id;
  v_followed := v_target <> p_member_id;

  v_floor      := fn_setting_numeric('retroactive_name_similarity', 0.3);
  v_norm_name  := fn_normalise_name(v_member.display_name);
  v_norm_email := fn_normalise_email(v_member.email);

  return query
  with candidate as (
    -- Tier 1: the claimed email, normalised the same way member.email would
    -- be, reaches the same inbox as this member's address. An identity, not
    -- a resemblance.
    select a.id as record_id, e.id as event_id, e.title as event_title,
           e.occurred_on, a.claimed_name, a.claimed_email,
           1 as priority, 'exact_email'::text as reason, 1.000::numeric as score
    from attendance_records a
    join events e on e.id = a.event_id
    where a.member_id is null
      and a.status = 'pending'
      and v_norm_email is not null
      and fn_normalise_email(a.claimed_email) = v_norm_email
      and exists (
        select 1 from member_enrollments me
        where me.member_id = v_target and me.academic_year_id = e.academic_year_id
      )

    union all

    -- Tier 2: the claimed name resembles this member's name closely enough
    -- to suggest, not close enough to assert. Both sides are normalised
    -- before scoring: see the header for why claimed_name cannot be trusted
    -- to arrive in any particular case.
    select a.id, e.id, e.title, e.occurred_on, a.claimed_name, a.claimed_email,
           2, 'name_match'::text,
           least(round(similarity(fn_normalise_name(a.claimed_name), v_norm_name)::numeric, 3), 1.000)
    from attendance_records a
    join events e on e.id = a.event_id
    where a.member_id is null
      and a.status = 'pending'
      and v_norm_name is not null
      and fn_normalise_name(a.claimed_name) is not null
      and similarity(fn_normalise_name(a.claimed_name), v_norm_name) >= v_floor
      and exists (
        select 1 from member_enrollments me
        where me.member_id = v_target and me.academic_year_id = e.academic_year_id
      )
  )
  -- A record matched by both tiers (a claimed email that resolves to this
  -- member AND a similar name) collapses to its strongest reason, the same
  -- way fn_duplicate_member_pairs folds a pair matched twice.
  select c.record_id, c.event_id, c.event_title, c.occurred_on,
         c.claimed_name, c.claimed_email, c.reason, c.score,
         v_target, v_followed
  from (
    select distinct on (candidate.record_id) *
    from candidate
    order by candidate.record_id, candidate.priority, candidate.score desc
  ) c
  order by c.score desc, c.occurred_on desc;
end
$$;

comment on function fn_retroactive_match_candidates(uuid) is
  'Unresolved (member_id null, status pending) check-ins that might belong to this member, restricted to years they are enrolled in. Refuses an archived member (PDS03) and follows a merged one to the survivor, reporting resolved_member_id and followed_merge on every row. reason is exact_email (an identity, score 1.000) or name_match (a resemblance, scored by trigram similarity on normalised names); the officer confirms which records to link with link_retroactive_matches().';

-- ---------------------------------------------------------------------------
-- 19.3 link_retroactive_matches(member_id, record_ids[])
-- ---------------------------------------------------------------------------
-- The write half. Takes exactly the record ids the officer confirmed and
-- links each one, or reports why it did not, the way resolve_unmatched()
-- links one record at a time but for a batch a confirmation actually is:
-- one entry per id, never a total standing in for all of them. Deliberately
-- does NOT call fn_retroactive_match_candidates() internally to re-derive
-- who matches: see the migration header for why a function that re-ran the
-- match would defeat the point of asking the officer at all.
--
-- OUTCOMES, one per requested id, duplicates in the input collapsed to one:
--
--   linked          written: member_id set, unmatched_name cleared
--   already_linked  member_id was not null already, whoever it belonged to
--   not_pending     status was not 'pending' at the moment of the write,
--                   most likely rejected between the preview and this call
--   wrong_year      the event's academic year has no member_enrollments row
--                   for the resolved member
--   not_found       no attendance_records row has that id
--   conflict        every check above passed, but writing would have
--                   collided with one_live_record_per_member_event: the
--                   resolved member already holds a live record for that
--                   event, either from before this call or from an earlier
--                   id in the same batch that landed on the same event.
--                   Caught rather than let the batch abort on a 23505, for
--                   the same non-atomic reason as every other outcome here.
--
-- NOT ATOMIC, ON PURPOSE. migration 17 makes the same choice for the same
-- reason: one stale id (already linked, rejected out from under the
-- preview, a genuine duplicate booking) must not cost the officer their
-- other confirmations. Each id is evaluated and written independently; nine
-- successes and one refusal is nine records off the queue, not zero.
--
-- IDEMPOTENT BY CONSTRUCTION. A record this call already linked reports
-- already_linked on a second call, whether that is a genuine retry or a
-- double click, and nothing about it changes further.
--
-- THE TARGET MEMBER IS RESOLVED, VALIDATED AND LOCKED FIRST, the same walk
-- fn_retroactive_match_candidates() uses but with `for update` on every row
-- it passes through, the way review_member_claim() (migration 18, 18.6)
-- does: the lock is what stops the member being archived or merged again
-- between this check and the writes below, and 18.11 is what makes reading
-- merged_into_id off a locked row trustworthy at all.
create or replace function link_retroactive_matches(
  p_member_id  uuid,
  p_record_ids uuid[]
) returns table (
  record_id           uuid,
  outcome             text,
  resolved_member_id  uuid,
  followed_merge      boolean
)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_member   members;
  v_target   uuid;
  v_followed boolean;
  v_ids      uuid[];
  v_id       uuid;
  v_rec      attendance_records;
  v_outcome  text;
  v_results  jsonb := '[]'::jsonb;
begin
  if not coalesce(fn_is_officer(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  -- Locked at every hop, so the row this lands on cannot be archived or
  -- merged again between here and the writes below.
  v_target := p_member_id;
  for i in 1..10 loop
    select * into v_member from members m where m.id = v_target for update;
    exit when v_member.id is null;
    exit when v_member.merged_into_id is null;
    v_target := v_member.merged_into_id;
  end loop;

  if v_member.id is null then
    raise exception 'Unknown member.' using errcode = 'PDS03';
  end if;
  if v_member.merged_into_id is not null then
    raise exception 'That members record cannot be resolved.' using errcode = 'PDS03';
  end if;
  if v_member.archived_at is not null then
    raise exception 'That member is archived.' using errcode = 'PDS03';
  end if;

  v_target   := v_member.id;
  v_followed := v_target <> p_member_id;

  -- Distinct and ordered, so a duplicate id in the input reports once and so
  -- two officers linking overlapping batches take their row locks in the
  -- same order, the way merge_members() orders its two member locks for the
  -- same reason (migration 18, 18.11).
  v_ids := array(select distinct u from unnest(p_record_ids) u order by u);

  foreach v_id in array v_ids loop
    begin
      -- The guard IS the race fix: this UPDATE re-reads member_id and status
      -- off the current row as it writes, waiting out any transaction still
      -- holding it, so a record rejected after the officer's preview loaded
      -- is refused here rather than linked on stale information.
      update attendance_records ar
      set member_id = v_target,
          flags     = array_remove(ar.flags, 'unmatched_name')
      where ar.id = v_id
        and ar.member_id is null
        and ar.status = 'pending'
        and exists (
          select 1 from events e
          join member_enrollments me
            on me.member_id = v_target and me.academic_year_id = e.academic_year_id
          where e.id = ar.event_id
        );

      if found then
        v_outcome := 'linked';
      else
        -- Not written. Read the current row, unlocked, only to explain why:
        -- the UPDATE above already made the one decision that matters.
        select * into v_rec from attendance_records where id = v_id;
        if not found then
          v_outcome := 'not_found';
        elsif v_rec.member_id is not null then
          v_outcome := 'already_linked';
        elsif v_rec.status <> 'pending' then
          v_outcome := 'not_pending';
        else
          v_outcome := 'wrong_year';
        end if;
      end if;
    exception when unique_violation then
      v_outcome := 'conflict';
    end;

    record_id          := v_id;
    outcome             := v_outcome;
    resolved_member_id := v_target;
    followed_merge      := v_followed;
    v_results := v_results || jsonb_build_object('record_id', v_id, 'outcome', v_outcome);
    return next;
  end loop;

  -- What actually happened, not what was asked for: every id's real outcome,
  -- not the requested array standing in for it. A call that linked nothing
  -- still leaves a row saying an officer tried, the way review_records()
  -- audits an empty batch rather than skipping the write.
  perform fn_audit('link_retroactive_matches', 'attendance_record', null,
                   jsonb_build_object('member_id', p_member_id,
                                      'resolved_member_id', v_target,
                                      'followed_merge', v_followed,
                                      'results', v_results));
end
$$;

comment on function link_retroactive_matches(uuid, uuid[]) is
  'Links each given attendance_records id to a member and clears unmatched_name, or reports why not. Does not re-derive matches: the caller supplies the ids an officer already confirmed. Refuses an archived member (PDS03) and follows a merged one to the survivor. Returns one row per distinct requested id: record_id, outcome (linked, already_linked, not_pending, wrong_year, not_found, conflict), resolved_member_id, followed_merge. Not atomic: one refused id does not affect the others. Does not approve: linked records stay pending for review_records(), per invariant 6.';

-- ---------------------------------------------------------------------------
-- 19.4 Privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC, and migration 11's
-- blanket revoke ran only over the functions that existed then. Same note as
-- migrations 14, 15, 17 and 18: each function created since carries its own
-- revoke, or it is reachable by anon.
-- ---------------------------------------------------------------------------

revoke all on function fn_retroactive_match_candidates(uuid)    from public, anon, authenticated;
revoke all on function link_retroactive_matches(uuid, uuid[])   from public, anon, authenticated;

grant execute on function fn_retroactive_match_candidates(uuid)  to authenticated, service_role;
grant execute on function link_retroactive_matches(uuid, uuid[]) to authenticated, service_role;
