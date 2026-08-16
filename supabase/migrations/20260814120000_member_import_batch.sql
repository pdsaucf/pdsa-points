-- ===========================================================================
-- 17. IMPORTING A ROSTER IN ONE REQUEST INSTEAD OF 355
-- ===========================================================================
-- The roster screen imported a CSV by calling upsert_member_and_enroll() once
-- per row. The real file is 355 rows (docs/00-spreadsheet-findings.md), so the
-- August import was 355 sequential HTTPS round trips from a laptop on campus
-- wifi, each one waiting for the last. Every one of those round trips is also
-- a fresh chance for the run to stop halfway, and the officer watching it had
-- no way to tell a slow import from a stalled one.
--
-- upsert_members_and_enroll() takes the rows as an array and does the same
-- work in one request. Four properties of the single-row function are load
-- bearing here, and each one is kept rather than reproduced.
--
-- IT DOES NOT REIMPLEMENT THE RESOLUTION. Every row calls
-- upsert_member_and_enroll(). The match tiers, the tombstone walk, the
-- archived check and the per-row audit row therefore have exactly one
-- implementation, and a fix to migration 15 is a fix to both paths. A second
-- copy of that logic would drift, and the way it would drift is by quietly
-- creating a second person for somebody the club already has, which is the
-- failure this whole area of the schema exists to prevent. The nested call is
-- SECURITY DEFINER inside SECURITY DEFINER, which does not disturb auth.uid():
-- the inner officer check still sees the real caller and fn_audit() still
-- stamps them as the actor.
--
-- EACH ROW IS STILL INDEPENDENTLY ATOMIC. The per-row call sits in its own
-- `begin ... exception` block, and a plpgsql block with an exception handler
-- is a subtransaction. A row that raises rolls back to the savepoint and
-- nothing else in the batch is discarded. Without that, one archived member in
-- an officer's file, or one 23505 from two officers importing at the same
-- instant, would throw away the other 354 rows that were fine. What the
-- officer gets back instead is "349 written, 6 refused, and here is why",
-- which is a list they can act on.
--
-- Everything the loop reads out of a row happens inside that block, including
-- the line number. A value the caller controls must not be able to raise where
-- nothing catches it: a single `{"row": 1e100}` parsed one block too early
-- aborts the call with a 22003 and rolls back every row already written, which
-- is the one thing this function promises not to do.
--
-- FOUR ERRORS ARE NOT PER-ROW ERRORS. query_canceled, admin_shutdown,
-- serialization_failure and deadlock_detected say something about the whole
-- transaction, not about the row that happened to be running when they
-- arrived. Catching those and carrying on would turn a statement timeout into
-- 355 identical "refused" lines, and would fight the retry that a
-- serialization failure is asking for. They are re-raised.
--
-- THE YEAR IS ONE ARGUMENT FOR THE WHOLE CALL. An import is one year by
-- definition, and putting the year on each row would make a mixed-year batch
-- expressible, which is a thing no caller wants and every reader would have to
-- reason about.
--
-- THE BATCH IS CAPPED AT 500. The real file is 355. A cap keeps an unbounded
-- request from being something the server has to hold a write transaction open
-- for while it works through it, and the frontend chunks at 100 anyway
-- (web/src/roster.js), so the cap is a backstop rather than a limit anybody
-- meets. It is deliberately not a setting: nothing about it changes per club.
-- ===========================================================================

create or replace function upsert_members_and_enroll(
  p_rows             jsonb,
  p_academic_year_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_row      jsonb;
  v_line     int;
  v_ordinal  int := 0;
  v_one      jsonb;
  v_num      numeric;
  v_results  jsonb := '[]'::jsonb;
  v_created  int := 0;
  v_enrolled int := 0;
  v_refused  int := 0;
  v_state    text;
  v_message  text;
begin
  -- Asserted once, before anything is written, so an unauthorized caller is
  -- refused rather than being told row by row. The inner function asserts it
  -- again per row, which is the check that actually guards the writes; this
  -- one exists so the answer arrives before the first of them.
  --
  -- Spelled positively for the reason migration 16 gives: fn_is_officer() is
  -- NULL, not false, for a caller with no profiles row.
  if not coalesce(fn_is_officer(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array.' using errcode = 'PDS03';
  end if;

  if jsonb_array_length(p_rows) > 500 then
    raise exception 'An import is at most 500 rows per call.' using errcode = 'PDS03';
  end if;

  -- Checked here as well as inside the inner function. An unknown year is
  -- wrong for every row in the batch, so it is a refusal of the call rather
  -- than 355 identical per-row failures.
  if p_academic_year_id is null
     or not exists (select 1 from academic_years where id = p_academic_year_id) then
    raise exception 'Unknown academic year.' using errcode = 'PDS03';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_ordinal := v_ordinal + 1;

    -- The ordinal is the fallback, and it is set outside the block because
    -- nothing about it can fail. Everything derived from the row itself is
    -- read INSIDE the block below, where a subtransaction is holding the line.
    v_line := v_ordinal;

    begin
      -- The caller's own line number when it sent a usable one, so a refusal
      -- points at a line in the officer's file rather than at a position in a
      -- chunk they never saw.
      --
      -- RANGE CHECKED RATHER THAN CAST AND CAUGHT. jsonb numbers are numeric,
      -- so `{"row": 1e100}` is a perfectly good JSON number and ::int refuses
      -- it with a 22003, as it refuses `{"row": 4.5}` with a 22P02. Catching
      -- those would work, but it would spend the row's one report on a bad
      -- line number and hide whatever was actually wrong with the row. A value
      -- that is not a whole number in int range is simply not used, and the
      -- ordinal stands. ::numeric cannot fail here: jsonb already parsed it as
      -- a number.
      --
      -- The assignment survives a later exception in this block on purpose:
      -- plpgsql rolls back the subtransaction's database changes, not its
      -- variables, so the handler still reports the line it resolved here.
      if jsonb_typeof(v_row) = 'object' and jsonb_typeof(v_row -> 'row') = 'number' then
        v_num := (v_row ->> 'row')::numeric;
        if v_num = trunc(v_num) and v_num between -2147483648 and 2147483647 then
          v_line := v_num::int;
        end if;
      end if;

      if jsonb_typeof(v_row) <> 'object' then
        raise exception 'Each row must be a JSON object.' using errcode = 'PDS03';
      end if;

      v_one := upsert_member_and_enroll(
        v_row ->> 'first_name',
        v_row ->> 'last_name',
        nullif(btrim(coalesce(v_row ->> 'email', '')), '')::citext,
        nullif(btrim(coalesce(v_row ->> 'ucf_nid', '')), '')::citext,
        p_academic_year_id,
        nullif(btrim(coalesce(v_row ->> 'matched_member_id', '')), '')::uuid
      );

      if (v_one ->> 'was_created')::boolean then v_created := v_created + 1; end if;
      if (v_one ->> 'was_enrolled')::boolean then v_enrolled := v_enrolled + 1; end if;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row',          v_line,
        'member_id',    v_one -> 'member_id',
        'was_created',  v_one -> 'was_created',
        'was_enrolled', v_one -> 'was_enrolled'
      ));

    exception
      when query_canceled or admin_shutdown
        or serialization_failure or deadlock_detected then
        raise;

      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
        v_refused := v_refused + 1;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'row',          v_line,
          'member_id',    null,
          'was_created',  false,
          'was_enrolled', false,
          'error',        v_state,
          'message',      v_message
        ));
    end;
  end loop;

  -- One row for the batch, on top of the per-row rows upsert_member_and_enroll()
  -- already writes. Those say who was written; this says an import happened,
  -- how big it was and how much of it was refused, which is the question asked
  -- afterwards when a roster looks short.
  perform fn_audit('upsert_members_and_enroll', 'member', null,
                   jsonb_build_object('academic_year_id', p_academic_year_id,
                                      'rows', v_ordinal,
                                      'created', v_created,
                                      'enrolled', v_enrolled,
                                      'refused', v_refused));

  return v_results;
end
$$;

comment on function upsert_members_and_enroll(jsonb, uuid) is
  'Officer only. Runs upsert_member_and_enroll() over an array of rows for one academic year, at most 500 per call. Each input object is {first_name, last_name, email, ucf_nid, matched_member_id, row}; names are required and the rest are optional. row is the callers own line number, echoed back on the result; a missing one, or one that is not a whole number in int range, is replaced by the 1-based position in the batch. Returns a JSON array in input order, one entry per input row: {row, member_id, was_created, was_enrolled}, and for a row that was refused {row, member_id: null, was_created: false, was_enrolled: false, error, message} where error is the SQLSTATE. A refused row does not discard the rest of the batch, so callers test for the error key rather than assuming the call either wrote everything or nothing.';

-- ---------------------------------------------------------------------------
-- 17.1 Privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC, and migration 11's
-- blanket revoke ran over the functions that existed then. Anything created
-- afterwards arrives reachable by anon, which for a SECURITY DEFINER function
-- that writes the roster is the whole hole. Same note as migrations 14 and 15,
-- and from migration 16 onwards test/privileges.test.mjs fails when a later
-- migration forgets these two lines.
-- ---------------------------------------------------------------------------

revoke all on function upsert_members_and_enroll(jsonb, uuid)
  from public, anon, authenticated;

grant execute on function upsert_members_and_enroll(jsonb, uuid)
  to authenticated, service_role;
