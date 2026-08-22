-- ===========================================================================
-- 25. FILING THE PAPER SIGN-IN SHEET, IN ONE TRANSACTION
-- ===========================================================================
-- The events screen lets an officer add attendance by hand: somebody signed a
-- sheet, or checked in on a friend's phone, and it has to go in. Until now
-- that was two HTTP calls from the client, an INSERT into attendance_records
-- followed by review_records(), and member.js still does it that way for a
-- single record.
--
-- TWO CALLS ARE TWO TRANSACTIONS, AND THE GAP BETWEEN THEM IS A BUG.
--
--   1. The insert commits. review_records() then fails: a raced member now
--      holds a live record and it raises PDS05, or the connection drops. The
--      approval rolls back and the inserted rows do not. The officer is told
--      the action failed, and N records they were never told about are
--      sitting in the review queue, pending. Nothing on the screen that
--      raised them accounts for that.
--
--   2. Worse, and the reason this is a migration rather than a client patch:
--      the CLIENT decides whether the event wants a typed number, from an
--      event row it read when the screen opened. If another officer switches
--      that event to `from_submission` in between, the client goes on
--      inserting submitted_value = NULL and approving it. A from_submission
--      link with no submitted value is worth zero, so those members are
--      awarded an approved record worth nothing, silently, and the screen
--      says the members were added. Nothing in the database refuses it,
--      because nothing in the database was asked.
--
-- So the decision moves to where the event's configuration actually lives.
-- This function reads event_categories itself, at the moment of the write,
-- and refuses the call rather than filing credit it knows is wrong.
--
-- INVARIANT 6 IS NOT WEAKENED BY THIS. "No auto-approval" means every record
-- is approved by a person, not that approving must cost a second round trip.
-- The officer pressing Add is that person, exactly as they were when the
-- client made the two calls itself. What changes is that the approval can no
-- longer be lost while the insert survives.
--
-- AND THE APPROVAL IS STILL review_records(). This function does not set
-- `status` itself. It inserts the rows pending and calls review_records() for
-- them, so the reviewer stamp, the audit row, and the refusal rules stay in
-- one place and cannot drift from what the review queue does.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 25.1 add_officer_attendance(event, members, value)
-- ---------------------------------------------------------------------------
-- Returns the ids of the records it filed and approved. Raises rather than
-- returning a partial result: either every member named is on the event with
-- the right credit, or nothing is.
--
-- p_submitted_value is required exactly when the event carries a
-- `from_submission` category link, and refused when it does not. Both are
-- PDS03, because both mean the caller is describing an event that is not the
-- event as it stands.
-- ---------------------------------------------------------------------------

create or replace function add_officer_attendance(
  p_event_id        uuid,
  p_member_ids      uuid[],
  p_submitted_value numeric default null
) returns uuid[]
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event        events;
  v_wants_value  boolean;
  v_recheck      boolean;
  v_ids          uuid[] := '{}';
  v_missing      int;
  v_approved     int;
begin
  perform fn_assert_officer();

  if p_member_ids is null or cardinality(p_member_ids) = 0 then
    raise exception 'Pick at least one member.' using errcode = 'PDS03';
  end if;

  select * into v_event from events e where e.id = p_event_id for update;
  if v_event.id is null then
    raise exception 'Unknown event.' using errcode = 'PDS03';
  end if;

  -- THE LOCK HAS TO BE ON THE LINKS, NOT ONLY ON THE EVENT. credit_mode lives
  -- on event_categories, and `for update` on the parent row does not block an
  -- UPDATE of a child table: locking `events` alone would leave exactly the
  -- race this function exists to close, one table over.
  --
  -- What this does not cover, said plainly: an event with no links yet locks
  -- no rows, so a concurrent INSERT of a from_submission link is still
  -- possible. That case is harmless, because a call against an event with no
  -- links carries no value and files none. What matters is that the mode is
  -- read here, at the write, rather than in a browser that has had the event
  -- on screen since the meeting started.
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

  -- Every named member has to exist and be live. A tombstoned or archived row
  -- would take the credit somewhere nobody is looking.
  --
  -- FOR SHARE, not a bare read. merge_members() takes FOR UPDATE on the loser
  -- to stamp merged_into_id, so without this the check can pass, the merge can
  -- commit, and the insert can then attach freshly approved credit to a member
  -- the merge has already emptied. The foreign key would allow it: the row
  -- still exists, it is just no longer anybody. Holding a share lock makes the
  -- merge wait for this transaction instead.
  perform 1 from members m where m.id = any (p_member_ids) for share;

  select count(*) into v_missing
  from unnest(p_member_ids) as wanted(id)
  where not exists (
    select 1 from members m
    where m.id = wanted.id and m.archived_at is null and m.merged_into_id is null
  );
  if v_missing > 0 then
    raise exception 'One of those members cannot be given credit.' using errcode = 'PDS03';
  end if;

  begin
    -- A CTE rather than RETURNING INTO: the latter keeps one row, and this
    -- insert writes as many rows as the officer ticked. What comes back is
    -- exactly the ids this statement created, never a re-query that could
    -- pick up somebody else's.
    with inserted as (
      insert into attendance_records (event_id, member_id, source, submitted_value)
      select p_event_id, wanted.id, 'officer_entry', p_submitted_value
      from unnest(p_member_ids) as wanted(id)
      returning id
    )
    select array_agg(id) into v_ids from inserted;
  exception when unique_violation then
    -- one_live_record_per_member_event. Somebody in the batch already has a
    -- live record for this event, which is the race the screen's own filter
    -- cannot close.
    raise exception 'One of those members already has a record for this event.'
      using errcode = 'PDS05';
  end;

  -- READ THE MODE AGAIN, AFTER THE INSERT.
  --
  -- The lock above holds the links that existed when this transaction started.
  -- It cannot hold a link that does not exist yet, so an officer adding a
  -- brand new from_submission category to this event, in the gap, is not
  -- blocked by it. At READ COMMITTED this second read sees that row once it
  -- has committed, and the whole transaction is thrown away rather than
  -- approving a null against it. Cheap, and it closes the one window the lock
  -- cannot.
  select exists (
    select 1 from event_categories ec
    where ec.event_id = p_event_id and ec.credit_mode = 'from_submission'
  ) into v_recheck;

  if v_recheck <> v_wants_value then
    raise exception 'That event changed while this was being filed. Try again.'
      using errcode = 'PDS03';
  end if;

  -- The same call the review queue makes, in the same transaction as the
  -- insert. Nothing here writes `status` directly.
  v_approved := review_records(v_ids, 'approve', null);
  if v_approved <> cardinality(v_ids) then
    raise exception 'Those records could not all be approved.' using errcode = 'PDS03';
  end if;

  perform fn_audit('add_officer_attendance', 'attendance_record', null,
                   jsonb_build_object('event_id', p_event_id,
                                      'member_ids', to_jsonb(p_member_ids),
                                      'submitted_value', p_submitted_value,
                                      'count', cardinality(v_ids)));
  return v_ids;
end
$$;

revoke all on function add_officer_attendance(uuid, uuid[], numeric) from public, anon;
grant execute on function add_officer_attendance(uuid, uuid[], numeric) to authenticated;

comment on function add_officer_attendance(uuid, uuid[], numeric) is
  'Files officer-entered attendance for one event and approves it in one transaction. Reads the events credit mode itself, so a client holding a stale copy cannot award zero-value credit.';

-- ---------------------------------------------------------------------------
-- 25.2 remove_attendance_record(record)
-- ---------------------------------------------------------------------------
-- Deleting one attendance record, when it carries a photo.
--
-- Decline is the ordinary answer to "this should not count": attendance_records
-- is one table with a status so that un-approving keeps the history and the
-- reason. Remove is for a row that should never have existed, and it is a real
-- delete. attendance_evidence goes with it, `on delete cascade`.
--
-- THE PHOTO IS IN A DIFFERENT SYSTEM, AND THERE IS NO TRANSACTION ACROSS THE
-- TWO. The client cannot make this safe by choosing an order, and the first
-- attempt at this screen proved it twice over:
--
--   object first  photo destroyed, record kept. Irreversible, and the record
--                 left behind still claims to have evidence.
--
--   record first  record gone, bytes left. This looked recoverable, and the
--                 argument was that purge_orphaned_uploads() would reclaim
--                 them. IT WOULD NOT. That function only considers grants with
--                 consumed_at IS NULL, and submit_checkin() stamps consumed_at
--                 on the grant the moment the check-in is filed. So the bytes
--                 of a real, submitted photo are invisible to it, and
--                 purge_evidence() cannot see them either because it reads
--                 attendance_evidence, which the cascade just deleted. They
--                 would sit in the bucket for the life of the project with no
--                 operator tool able to name them.
--
-- So the intent is written down BEFORE the delete, in the same transaction, in
-- the tables the storage screen already reads. A purge_runs row and its
-- purge_run_objects rows are exactly "these paths are meant to be gone", and
-- v_purge_runs_outstanding is exactly "and nobody has confirmed it yet". A
-- browser that dies between the delete and the bucket call leaves an
-- outstanding run, which the storage screen already lists and already knows how
-- to finish. Nothing new has to be built to recover it.
--
-- This is the same two-step handoff purge_evidence() uses, for the same reason.
--
-- WHAT THIS DELIBERATELY DOES NOT FIX. bytes_freed is written here, before
-- Storage has confirmed anything, and fn_storage_usage() stops counting the
-- evidence row as soon as it is gone. So between this call and the bucket
-- delete, usage reads lower than the bucket actually is and the history table
-- calls those bytes freed. That is a real inaccuracy and it is NOT new:
-- purge_evidence() has the same shape, writing bytes_freed and stamping
-- purged_at before the browser deletes a thing. Splitting planned bytes from
-- confirmed bytes is a change to how the whole storage screen accounts for a
-- purge, across all three kinds of run, and doing it inside a change to the
-- events screen would be the wrong place to decide it. The outstanding run is
-- what keeps the bytes recoverable in the meantime, which is the part that
-- would otherwise be data loss.
-- ---------------------------------------------------------------------------

-- 'record_removed' joins the two kinds a run could already be. The second
-- constraint stays as it was: only an 'evidence' run applies a retention
-- window, and this one does not.
-- Written to be safe to run twice, the way every function in this project is
-- `create or replace`. A bare `drop constraint` would fail on a re-run.
alter table purge_runs drop constraint if exists purge_runs_kind_check;
alter table purge_runs add constraint purge_runs_kind_check
  check (kind in ('evidence', 'orphaned_uploads', 'record_removed'));

create or replace function remove_attendance_record(p_record_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_record  attendance_records;
  v_paths   text[] := '{}';
  v_bytes   bigint := 0;
  v_run_id  uuid;
begin
  perform fn_assert_officer();

  select * into v_record from attendance_records a where a.id = p_record_id for update;
  if v_record.id is null then
    raise exception 'Unknown attendance record.' using errcode = 'PDS03';
  end if;

  -- Photos this record is the only thing holding. A row already purged has no
  -- bytes left to account for.
  select coalesce(array_agg(ae.object_path), '{}'),
         coalesce(sum(ae.byte_size), 0)
    into v_paths, v_bytes
  from attendance_evidence ae
  where ae.attendance_record_id = p_record_id
    and ae.object_path is not null
    and ae.purged_at is null;

  if cardinality(v_paths) > 0 then
    insert into purge_runs (performed_by, kind, retention_months,
                            evidence_count, bytes_freed, event_ids)
    values (auth.uid(), 'record_removed', null,
            cardinality(v_paths), v_bytes, array[v_record.event_id])
    returning id into v_run_id;

    insert into purge_run_objects (purge_run_id, bucket, object_path)
    select v_run_id, 'evidence', path from unnest(v_paths) as path;
  end if;

  -- attendance_evidence cascades. The intent above outlives it on purpose.
  delete from attendance_records where id = p_record_id;

  perform fn_audit('remove_attendance_record', 'attendance_record', p_record_id,
                   jsonb_build_object('event_id', v_record.event_id,
                                      'member_id', v_record.member_id,
                                      'status', v_record.status,
                                      'purge_run_id', v_run_id,
                                      'object_paths', to_jsonb(v_paths)));

  return jsonb_build_object(
    'purge_run_id', v_run_id,
    'object_paths', to_jsonb(v_paths)
  );
end
$$;

revoke all on function remove_attendance_record(uuid) from public, anon;
grant execute on function remove_attendance_record(uuid) to authenticated;

comment on function remove_attendance_record(uuid) is
  'Deletes one attendance record and records the intent to delete its photos as a purge run, in one transaction. The caller deletes the objects and calls finish_purge_run(); a caller that never does leaves an outstanding run the storage screen can finish.';
