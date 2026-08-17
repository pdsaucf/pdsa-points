-- ===========================================================================
-- 20. STORAGE SCREEN AND THE PURGE FLOW
-- ===========================================================================
-- P0 shipped purge_evidence() and purge_orphaned_uploads(): the eligibility
-- rules exist, the audit trail exists, nothing runs on a timer. What did not
-- exist is a screen an officer can actually press: docs/03-admin-ui.md
-- section 7 draws per-event checkboxes ("hold one event's evidence for an
-- ongoing dispute, clear the rest"), a preview before anything is destroyed,
-- and a usage bar against the quota. None of that was reachable.
--
-- Four things land here.
--
-- 1. purge_evidence() GAINS PER-EVENT SELECTION. `create or replace function`
--    cannot change an argument list, so the old purge_evidence(int) is
--    dropped explicitly and a new purge_evidence(int, uuid[]) takes its
--    place, re-granted in this same migration. A requested event id that is
--    no longer eligible (already purged, back to pending, never existed) is
--    reported back distinctly rather than silently dropped, the same rule
--    link_retroactive_matches() (migration 19) already keeps: a stale screen
--    must never read as a success.
--
-- 2. fn_purge_preview() drives the "N photos from M events... frees about X"
--    card, and the per-event checkboxes underneath it, both before anything
--    is destroyed. It takes the retention window as an argument rather than
--    reading the setting internally, because the window is a dropdown on the
--    same screen: an admin adjusting it has to see what THAT window would
--    purge, not what the last saved one would have.
--
-- 3. fn_storage_usage() is the usage bar: live count and bytes held (summed
--    from attendance_evidence.byte_size, never from storage.objects, see the
--    comment on the function for why), the quota, the warn threshold, and the
--    orphaned-upload count. Staff-gated (fn_is_staff()) rather than
--    officer-gated: a viewer reads the whole screen and presses nothing, and
--    the usage bar is the part of the screen that is pure information. The
--    per-event preview and the purge history stay officer-gated, because
--    those are the operationally sensitive detail a viewer has no button for
--    anyway; the screen shows a plain note in their place. See the P6 report
--    for the fuller version of this call.
--
-- 4. THE GAP THAT ACTUALLY NEEDED FIXING: deleting the bytes is a Storage API
--    call the browser makes AFTER purge_evidence() stamps purged_at and hands
--    back the object paths. If the browser dies in between, the rows already
--    read as purged and nothing ever asks Storage about those paths again:
--    the objects are stranded forever. purge_run_objects records the intended
--    deletions, per run, so a run can be finished later. finish_purge_run()
--    stamps the paths the client actually deleted, and
--    v_purge_runs_outstanding lists which runs still have some left.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 20.0 fn_assert_staff()
-- ---------------------------------------------------------------------------
-- The staff-gated sibling of fn_assert_officer()/fn_assert_admin()
-- (migration 09, patched for the NULL-role gap in migration 16). Nothing
-- needed it until fn_storage_usage(), which a viewer has to be able to call:
-- they read the whole screen and press nothing.
--
-- coalesce(..., false), not a bare `if not fn_is_staff()`, for the exact
-- reason migration 16 exists: a caller with no profiles row makes
-- fn_current_role() NULL, which makes fn_is_staff() NULL, and `not NULL` is
-- NULL, which plpgsql treats as false and does not raise. "I cannot tell" is
-- not a yes.
-- ---------------------------------------------------------------------------

create or replace function fn_assert_staff()
returns void
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
begin
  if not coalesce(fn_is_staff(), false) then
    raise exception 'This action requires an officer account.' using errcode = 'PDS07';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 20.1 purge_evidence(retention_months, event_ids): per-event selection
-- ---------------------------------------------------------------------------
-- THE HAZARD, spelled out because it is easy to get wrong: `create or
-- replace function purge_evidence(int)` followed by a NEW function
-- purge_evidence(int, uuid[]) would leave both signatures live, and a caller
-- sending one argument would suddenly be ambiguous between them. So the old
-- one is dropped explicitly, first.
-- ---------------------------------------------------------------------------

drop function if exists purge_evidence(int);

-- p_event_ids default null means every eligible event, exactly the old
-- behaviour. When given, it is intersected with the eligible set rather than
-- trusted: an id for an event that is not (or is no longer) eligible is left
-- out of what gets purged and reported back in ineligible_event_ids, never
-- silently purged and never silently ignored.
create or replace function purge_evidence(
  p_retention_months int default null,
  p_event_ids        uuid[] default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_months     int;
  v_run_id     uuid;
  v_count      int    := 0;
  v_bytes      bigint := 0;
  v_paths      text[] := '{}';
  v_events     uuid[] := '{}';
  v_requested  uuid[] := '{}';
  v_ineligible uuid[] := '{}';
begin
  perform fn_assert_officer();

  v_months := coalesce(p_retention_months, fn_setting_int('evidence_retention_months', 12));
  if v_months < 1 then
    raise exception 'Retention window must be at least one month.' using errcode = 'PDS03';
  end if;

  -- LOCKED, so two purge runs racing for the same evidence row cannot both
  -- select it into their own eligible set before either has stamped
  -- purged_at. `for update of ae` (not the whole join) locks only the
  -- attendance_evidence rows, which is what this run is about to write;
  -- attendance_records and events stay unlocked, so review_records() and
  -- everything else that touches those tables is not blocked by a purge.
  --
  -- Plain `for update`, not `for update skip locked`, on purpose: a purge is
  -- an explicit, audited action an officer chose to press, and its whole
  -- point is a complete, honest answer for the window it names. Skipping a
  -- row that is merely locked by a second, momentary purge would report it
  -- as ineligible depending on nothing but timing, which is a worse answer
  -- than a brief wait. Once the first run commits, PostgreSQL's own
  -- EvalPlanQual re-checks this WHERE clause against the row's new values
  -- (purged_at is no longer null) before the second run's select proceeds,
  -- which is what keeps two racing calls from both recording the same
  -- object_path in purge_run_objects: the second one simply does not see the
  -- row as eligible anymore.
  create temporary table _purge_eligible on commit drop as
  select ae.id, ae.object_path, coalesce(ae.byte_size, 0) as byte_size, e.id as event_id
  from attendance_evidence ae
  join attendance_records ar on ar.id = ae.attendance_record_id
  join events e              on e.id  = ar.event_id
  where ae.purged_at is null
    and ae.object_path is not null
    and ar.status in ('approved', 'rejected')
    and e.occurred_on < (current_date - make_interval(months => v_months))
    and (p_event_ids is null or e.id = any(p_event_ids))
  for update of ae;

  select coalesce(array_agg(distinct event_id), '{}') into v_events from _purge_eligible;

  -- Anything asked for that produced no eligible row: unknown, not reviewed,
  -- inside the window, or already fully purged by an earlier run. Reported
  -- separately so the screen can say which events did not happen, the same
  -- contract link_retroactive_matches() (migration 19) keeps for a stale
  -- confirmation.
  if p_event_ids is not null then
    v_requested := array(select distinct u from unnest(p_event_ids) u);
    select coalesce(array_agg(x), '{}') into v_ineligible
    from unnest(v_requested) x
    where x <> all (v_events);
  end if;

  select count(*), coalesce(sum(byte_size), 0), coalesce(array_agg(object_path), '{}')
    into v_count, v_bytes, v_paths
  from _purge_eligible;

  insert into purge_runs (performed_by, retention_months, evidence_count, bytes_freed, event_ids)
  values (auth.uid(), v_months, v_count, v_bytes, v_events)
  returning id into v_run_id;

  update attendance_evidence ae
  set purged_at = now(), purge_run_id = v_run_id
  where ae.id in (select id from _purge_eligible);

  -- Every path this run intends to delete, recorded before the browser ever
  -- makes the Storage call. See 20.4 below for why.
  insert into purge_run_objects (purge_run_id, bucket, object_path)
  select v_run_id, 'evidence', object_path from _purge_eligible;

  drop table _purge_eligible;

  perform fn_audit('purge_evidence', 'purge_run', v_run_id,
                   jsonb_build_object('retention_months', v_months,
                                      'evidence_count', v_count,
                                      'bytes_freed', v_bytes,
                                      'requested_event_ids', to_jsonb(v_requested),
                                      'ineligible_event_ids', to_jsonb(v_ineligible)));

  return jsonb_build_object(
    'purge_run_id',          v_run_id,
    'evidence_count',        v_count,
    'bytes_freed',           v_bytes,
    'event_ids',             to_jsonb(v_events),
    'object_paths',          to_jsonb(v_paths),
    'ineligible_event_ids',  to_jsonb(v_ineligible)
  );
end
$$;

comment on function purge_evidence(int, uuid[]) is
  'Marks reviewed, past-window evidence purged and hands back the object paths for the browser to delete from Storage. p_event_ids null means every eligible event; given, it is intersected with the eligible set and any requested id that was not eligible comes back in ineligible_event_ids rather than being silently skipped or silently purged. Officer only.';

-- ---------------------------------------------------------------------------
-- 20.2 fn_purge_preview(retention_months)
-- ---------------------------------------------------------------------------
-- One row per event that purge_evidence() would touch at this window, before
-- anything is destroyed: the count and the confirmation dialog's per-event
-- checkboxes both come from this. Same eligibility criteria as
-- purge_evidence() by construction (the two queries are written to match), so
-- the preview cannot promise something the purge itself declines to do.
--
-- Takes the window as an argument rather than reading evidence_retention_
-- months itself, because the setting and the screen can disagree for a
-- moment: an admin turning the dropdown to 6 months wants to see what 6
-- months would purge before pressing anything that writes it.
-- ---------------------------------------------------------------------------

create or replace function fn_purge_preview(p_retention_months int default null)
returns table (
  event_id     uuid,
  event_title  text,
  occurred_on  date,
  photo_count  bigint,
  bytes        bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_months int;
begin
  perform fn_assert_officer();

  v_months := coalesce(p_retention_months, fn_setting_int('evidence_retention_months', 12));
  if v_months < 1 then
    raise exception 'Retention window must be at least one month.' using errcode = 'PDS03';
  end if;

  return query
  select e.id, e.title, e.occurred_on,
         count(ae.id)::bigint, coalesce(sum(ae.byte_size), 0)::bigint
  from attendance_evidence ae
  join attendance_records ar on ar.id = ae.attendance_record_id
  join events e              on e.id  = ar.event_id
  where ae.purged_at is null
    and ae.object_path is not null
    and ar.status in ('approved', 'rejected')
    and e.occurred_on < (current_date - make_interval(months => v_months))
  group by e.id, e.title, e.occurred_on
  order by e.occurred_on asc;
end
$$;

comment on function fn_purge_preview(int) is
  'One row per event eligible for purge_evidence() at this retention window: reviewed evidence only, event older than the window, not already purged. Read-only, officer gated. The window is an argument because the screen lets an admin try a different one before saving it.';

-- ---------------------------------------------------------------------------
-- 20.3 fn_storage_usage()
-- ---------------------------------------------------------------------------
-- The usage bar. bytes_held sums attendance_evidence.byte_size rather than
-- reading storage.objects, for a reason that matters beyond pglite: byte_size
-- is what THIS SYSTEM recorded at upload time (docs/02-storage.md's
-- compression spec), which is the number that is actually true of the
-- product's own bookkeeping, whereas storage.objects metadata is an external
-- fact this schema does not own and the test suite runs against a stubbed
-- storage schema that cannot furnish it anyway.
--
-- orphaned_count comes from v_orphaned_uploads, whose bytes are NOT summed
-- here: an orphan is an object nothing in this schema ever wrote a byte_size
-- for (see that view's comment), so folding an unknown into a known total
-- would misstate both. The screen says the count and says the bytes are
-- unknown, rather than implying they are counted.
--
-- SECURITY DEFINER, staff-gated by an inline check rather than by row-level
-- policy: v_orphaned_uploads sits over evidence_upload_grants, whose own RLS
-- (migration 11) is officer-only, and this function's whole point is to let a
-- viewer read the summary without widening that table's policy.
-- ---------------------------------------------------------------------------

create or replace function fn_storage_usage()
returns table (
  photo_count    bigint,
  bytes_held     bigint,
  quota_bytes    bigint,
  warn_percent   int,
  percent_used   numeric,
  orphaned_count bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_quota bigint;
begin
  perform fn_assert_staff();

  v_quota := fn_setting_int('storage_quota_bytes', 1073741824);

  return query
  select
    count(ae.id)::bigint,
    coalesce(sum(ae.byte_size), 0)::bigint,
    v_quota,
    fn_setting_int('storage_warn_percent', 75),
    case when v_quota = 0 then 0::numeric
         else round(100.0 * coalesce(sum(ae.byte_size), 0) / v_quota, 1)
    end,
    (select count(*) from v_orphaned_uploads)::bigint
  from attendance_evidence ae
  where ae.purged_at is null and ae.object_path is not null;
end
$$;

comment on function fn_storage_usage() is
  'Live photo count and bytes held (summed from attendance_evidence.byte_size, never storage.objects), the quota, the warn threshold, the percentage used, and the orphaned-upload count (bytes unknown, not included in bytes_held). Staff gated: a viewer reads the usage bar and presses nothing.';

-- ---------------------------------------------------------------------------
-- 20.4 purge_run_objects: deletions must not go missing
-- ---------------------------------------------------------------------------
-- THE GAP. purge_evidence() and purge_orphaned_uploads() mark rows purged and
-- hand back object paths; deleting the bytes is a Storage API call the
-- browser makes afterwards, because deleting an object is not something SQL
-- can do transactionally. If the browser dies between those two steps
-- (closed tab, lost wifi, a crash), the objects are stranded in the bucket
-- and nothing can ever find them again: purged_at is already stamped, so no
-- later purge run's eligibility query will surface them, and
-- v_orphaned_uploads only ever sees an abandoned UPLOAD grant, not an
-- abandoned DELETE.
--
-- So every intended deletion is recorded here, per run, at the moment the run
-- decides to make it (inside purge_evidence() and purge_orphaned_uploads()
-- themselves, in the same transaction as the purged_at stamp), and
-- finish_purge_run() lets an officer mark off the ones that actually
-- succeeded, whenever they get back to it. A run with rows still unmarked
-- here is a run that can be finished later; v_purge_runs_outstanding is the
-- list of which ones.
-- ---------------------------------------------------------------------------

create table purge_run_objects (
  id            uuid primary key default gen_random_uuid(),
  purge_run_id  uuid not null references purge_runs on delete cascade,
  bucket        text not null,
  object_path   text not null,
  deleted_at    timestamptz
);

create unique index purge_run_objects_unique
  on purge_run_objects (purge_run_id, bucket, object_path);

create index purge_run_objects_outstanding
  on purge_run_objects (purge_run_id) where deleted_at is null;

comment on table purge_run_objects is
  'The intended deletions for one purge run, so a browser that dies before deleting the bytes leaves a durable trail an officer can finish later rather than objects stranded in the bucket forever. Written by purge_evidence() and purge_orphaned_uploads(); stamped by finish_purge_run().';

alter table purge_run_objects enable row level security;

grant select on purge_run_objects to authenticated;

create policy purge_run_objects_read on purge_run_objects for select to authenticated
  using (fn_is_officer());

-- Writes go through finish_purge_run() (and the two purge RPCs, which are
-- SECURITY DEFINER) only. No insert, update or delete grant to authenticated
-- at all, the same pattern purge_runs itself already follows.

-- ---------------------------------------------------------------------------
-- purge_orphaned_uploads() also writes purge_run_objects now, for the objects
-- it actually found in the bucket (objects_to_delete: a grant nobody ever
-- uploaded against has nothing to delete, so it is not recorded here).
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

  -- Only the ones that actually exist in the bucket: a grant nobody uploaded
  -- against has no bytes to delete and no path worth tracking here.
  insert into purge_run_objects (purge_run_id, bucket, object_path)
  select v_run_id, 'evidence', object_path from _orphans where object_exists;

  drop table _orphans;

  perform fn_audit('purge_orphaned_uploads', 'purge_run', v_run_id,
                   jsonb_build_object('grants_reclaimed', v_count,
                                      'objects_to_delete', v_with_object));

  return jsonb_build_object(
    'purge_run_id',      v_run_id,
    'grants_reclaimed',  v_count,
    'objects_to_delete', v_with_object,
    'object_paths',      to_jsonb(v_paths)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 20.5 finish_purge_run(run_id, object_paths)
-- ---------------------------------------------------------------------------
-- Stamps the paths the browser actually deleted. Called once for a clean run
-- (every path succeeded) or again later for one that only partly did: this is
-- what "the client failed on some deletions, offer a finish path instead of a
-- clean success" (docs/03-admin-ui.md section 7) means in practice.
--
-- One outcome per requested path, the same contract link_retroactive_matches()
-- (migration 19) and finish_purge_run()'s own siblings keep for a batch: a
-- caller reads what happened to one path off its own row rather than
-- inferring it from a total. marked_deleted is the normal case; already_marked
-- covers a retry or a double click; unknown_object covers a path that was not
-- part of this run (a stale screen, or a typo) without raising and losing the
-- rest of the batch.
-- ---------------------------------------------------------------------------

create or replace function finish_purge_run(
  p_run_id        uuid,
  p_object_paths  text[]
)
returns table (
  object_path text,
  outcome     text
)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_ids  text[];
  v_path text;
  v_row  purge_run_objects;
begin
  perform fn_assert_officer();

  if not exists (select 1 from purge_runs where id = p_run_id) then
    raise exception 'Unknown purge run.' using errcode = 'PDS03';
  end if;

  v_ids := array(select distinct u from unnest(p_object_paths) u);

  foreach v_path in array v_ids loop
    select * into v_row from purge_run_objects pro
    where pro.purge_run_id = p_run_id and pro.object_path = v_path;

    object_path := v_path;
    if not found then
      outcome := 'unknown_object';
    elsif v_row.deleted_at is not null then
      outcome := 'already_marked';
    else
      update purge_run_objects set deleted_at = now() where id = v_row.id;
      outcome := 'marked_deleted';
    end if;
    return next;
  end loop;

  perform fn_audit('finish_purge_run', 'purge_run', p_run_id,
                   jsonb_build_object('object_paths', to_jsonb(v_ids)));
end
$$;

comment on function finish_purge_run(uuid, text[]) is
  'Stamps the object paths the browser actually deleted from Storage for one purge run. One outcome per distinct requested path: marked_deleted, already_marked, or unknown_object. Safe to call more than once for the same run, which is how a partially deleted run gets finished later.';

-- ---------------------------------------------------------------------------
-- 20.6 v_purge_runs_outstanding
-- ---------------------------------------------------------------------------
-- Which runs still have objects nobody has confirmed deleting. Empty is the
-- healthy state; a row here is a run the "Finish" path on the storage screen
-- has work left to do.
-- ---------------------------------------------------------------------------

create view v_purge_runs_outstanding with (security_invoker = true) as
  select pr.id           as purge_run_id,
         pr.kind,
         pr.performed_by,
         pr.performed_at,
         count(pro.id) filter (where pro.deleted_at is null) as outstanding_count,
         count(pro.id)                                        as total_count
  from purge_runs pr
  join purge_run_objects pro on pro.purge_run_id = pr.id
  group by pr.id, pr.kind, pr.performed_by, pr.performed_at
  having count(pro.id) filter (where pro.deleted_at is null) > 0;

comment on view v_purge_runs_outstanding is
  'Purge runs with at least one object nobody has confirmed deleting from Storage. Empty is the healthy state. See purge_run_objects for why this exists.';

-- ---------------------------------------------------------------------------
-- 20.7 Privileges
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC, and migration 11's
-- blanket revoke ran only over the functions that existed then. Same note as
-- every migration since: each function created here carries its own revoke.
-- ---------------------------------------------------------------------------

revoke all on function purge_evidence(int, uuid[]) from public, anon, authenticated;
revoke all on function fn_purge_preview(int)        from public, anon, authenticated;
revoke all on function fn_storage_usage()            from public, anon, authenticated;
revoke all on function finish_purge_run(uuid, text[]) from public, anon, authenticated;
revoke all on function fn_assert_staff()              from public, anon, authenticated;

grant execute on function purge_evidence(int, uuid[])  to authenticated;
grant execute on function fn_purge_preview(int)        to authenticated;
grant execute on function fn_storage_usage()            to authenticated;
grant execute on function finish_purge_run(uuid, text[]) to authenticated;
grant execute on function fn_assert_staff()              to authenticated;

grant select on v_purge_runs_outstanding to authenticated;

-- ---------------------------------------------------------------------------
-- 20.8 fn_keepalive(): a Postgres query .github/workflows/keepalive.yml can
-- actually call
-- ---------------------------------------------------------------------------
-- keepalive.yml existed to stop Supabase's free-tier auto-pause, but pinged
-- GoTrue's own /auth/v1/health, which touches no table. If auto-pause
-- triggers on Postgres inactivity specifically, not any API traffic, that
-- workflow could stay green forever while the project paused anyway, exactly
-- the silent-failure mode its own header warned about.
--
-- fn_keepalive() is the fix: a parameterless call that actually executes a
-- read against Postgres. No table, no PII, no write, no side effect beyond
-- proving the database answered. Not SECURITY DEFINER: it needs no elevated
-- right, `select now()` runs fine as whatever role calls it, and anon holds
-- no table privilege for it to need shielding from (README.md, "The security
-- model in one paragraph"). Anon callable, because that is what
-- keepalive.yml calls it as, the same unauthenticated way it calls every
-- other check-in RPC.
-- ---------------------------------------------------------------------------

create function fn_keepalive()
returns timestamptz
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select now();
$$;

comment on function fn_keepalive() is
  'Executes a trivial read against Postgres so a keepalive ping actually reaches the database, not just GoTrue. No table, no PII, no write. Anon callable: .github/workflows/keepalive.yml calls this instead of GoTrue''s /auth/v1/health.';

revoke all on function fn_keepalive() from public, anon, authenticated;
grant execute on function fn_keepalive() to anon, authenticated;
