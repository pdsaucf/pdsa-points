// The storage screen's database half: per-event purge selection, the preview
// that drives it, the usage numbers, and the purge-run object bookkeeping
// that keeps a half-finished deletion from stranding bytes in the bucket
// forever. Written against supabase/migrations/20260815100000_storage_ops.sql.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, USERS, YEAR_2026 } from './helpers/fixture.mjs';

let db;

// Five events, built once and reused with narrow, event-scoped assertions
// (never a bare "how many rows total") so the tests can share one fixture
// without stepping on each other.
const EV = {
  reviewedA: '55555555-0000-4000-a000-000000000001', // old, approved, 2 photos
  reviewedB: '55555555-0000-4000-a000-000000000002', // old, approved, 1 photo
  rejectedOld: '55555555-0000-4000-a000-000000000003', // old, rejected, 1 photo
  pendingOld: '55555555-0000-4000-a000-000000000004', // old, pending, 1 photo
  recent: '55555555-0000-4000-a000-000000000005', // inside the window, approved, 1 photo
};

const REC = {
  a1: '66666666-0000-4000-a000-000000000001',
  a2: '66666666-0000-4000-a000-000000000002',
  b: '66666666-0000-4000-a000-000000000003',
  rejected: '66666666-0000-4000-a000-000000000004',
  pending: '66666666-0000-4000-a000-000000000005',
  recent: '66666666-0000-4000-a000-000000000006',
};

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token) values
      ('${EV.reviewedA}',   '${YEAR_2026}', 'Storage Test Reviewed A', current_date - 800, 'tok-storage-a'),
      ('${EV.reviewedB}',   '${YEAR_2026}', 'Storage Test Reviewed B', current_date - 800, 'tok-storage-b'),
      ('${EV.rejectedOld}', '${YEAR_2026}', 'Storage Test Rejected',   current_date - 800, 'tok-storage-c'),
      ('${EV.pendingOld}',  '${YEAR_2026}', 'Storage Test Pending',    current_date - 800, 'tok-storage-d'),
      ('${EV.recent}',      '${YEAR_2026}', 'Storage Test Recent',     current_date - 60,  'tok-storage-e');

    insert into event_categories (event_id, category_id)
    select id, 'c0000000-0000-4000-a000-000000000005' from events where id in (
      '${EV.reviewedA}', '${EV.reviewedB}', '${EV.rejectedOld}', '${EV.pendingOld}', '${EV.recent}'
    );

    insert into attendance_records (id, event_id, member_id, status, source) values
      ('${REC.a1}', '${EV.reviewedA}',   '${MEMBERS.jasper}',  'approved', 'officer_entry'),
      ('${REC.a2}', '${EV.reviewedA}',   '${MEMBERS.greta}',   'approved', 'officer_entry'),
      ('${REC.b}',  '${EV.reviewedB}',   '${MEMBERS.fergus}',  'approved', 'officer_entry'),
      ('${REC.rejected}', '${EV.rejectedOld}', '${MEMBERS.hamish}', 'rejected', 'self_checkin'),
      ('${REC.pending}',  '${EV.pendingOld}',  '${MEMBERS.imogen}', 'pending',  'self_checkin'),
      ('${REC.recent}',   '${EV.recent}',      '${MEMBERS.edda}',   'approved', 'officer_entry');

    insert into attendance_evidence (attendance_record_id, kind, object_path, byte_size) values
      ('${REC.a1}', 'shirt_photo', 'storage/reviewed-a-1.jpg', 1000),
      ('${REC.a2}', 'shirt_photo', 'storage/reviewed-a-2.jpg', 2000),
      ('${REC.b}',  'shirt_photo', 'storage/reviewed-b.jpg',   4000),
      ('${REC.rejected}', 'shirt_photo', 'storage/rejected.jpg', 500),
      ('${REC.pending}',  'shirt_photo', 'storage/pending.jpg',  700),
      ('${REC.recent}',   'shirt_photo', 'storage/recent.jpg',   900);
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('a pending records photo is never eligible however old it is', async () => {
  await db.as('authenticated', USERS.officer);
  const rows = await db.q(`select * from fn_purge_preview(1)`);
  assert.ok(
    !rows.some((r) => r.event_id === EV.pendingOld),
    'the pending event should not appear in the preview at any window',
  );

  const res = await db.val(`select purge_evidence(1, $1::uuid[])`, [[EV.pendingOld]]);
  await db.asOwner();

  assert.equal(res.evidence_count, 0);
  assert.deepEqual(res.event_ids, []);
  assert.deepEqual(res.ineligible_event_ids, [EV.pendingOld]);

  const kept = await db.one(
    `select purged_at from attendance_evidence where object_path = 'storage/pending.jpg'`,
  );
  assert.equal(kept.purged_at, null);
});

test('an event inside the window is never eligible', async () => {
  await db.as('authenticated', USERS.officer);
  const rows = await db.q(`select * from fn_purge_preview(12)`);
  assert.ok(
    !rows.some((r) => r.event_id === EV.recent),
    'an event newer than the window should not appear in the preview',
  );

  const res = await db.val(`select purge_evidence(12, $1::uuid[])`, [[EV.recent]]);
  await db.asOwner();

  assert.equal(res.evidence_count, 0);
  assert.deepEqual(res.ineligible_event_ids, [EV.recent]);

  const kept = await db.one(
    `select purged_at from attendance_evidence where object_path = 'storage/recent.jpg'`,
  );
  assert.equal(kept.purged_at, null);
});

test('per-event selection clears only the chosen events', async () => {
  await db.as('authenticated', USERS.officer);
  const res = await db.val(`select purge_evidence(12, $1::uuid[])`, [[EV.reviewedA]]);
  await db.asOwner();

  assert.equal(res.evidence_count, 2, 'both of reviewedAs photos');
  assert.equal(res.bytes_freed, 3000);
  assert.deepEqual([...res.event_ids].sort(), [EV.reviewedA]);
  assert.deepEqual(res.ineligible_event_ids, []);
  assert.deepEqual(
    [...res.object_paths].sort(),
    ['storage/reviewed-a-1.jpg', 'storage/reviewed-a-2.jpg'],
  );

  // reviewedB and the rejected event were eligible too, but were not asked
  // for, so they are untouched.
  const untouched = await db.q(
    `select object_path, purged_at from attendance_evidence
      where object_path in ('storage/reviewed-b.jpg', 'storage/rejected.jpg')`,
  );
  assert.equal(untouched.length, 2);
  for (const row of untouched) assert.equal(row.purged_at, null);
});

test('a second run does not report the same photos again', async () => {
  // reviewedA was purged by the previous test. Asking for it again finds
  // nothing left to purge and says so distinctly rather than a quiet zero.
  await db.as('authenticated', USERS.officer);
  const res = await db.val(`select purge_evidence(12, $1::uuid[])`, [[EV.reviewedA]]);
  await db.asOwner();

  assert.equal(res.evidence_count, 0);
  assert.deepEqual(res.event_ids, []);
  assert.deepEqual(res.ineligible_event_ids, [EV.reviewedA]);
});

test('ids that are no longer eligible come back distinctly, in the same call as a live one', async () => {
  // reviewedA is already purged; reviewedB and the rejected event are not.
  // One call naming all three: the two live ones purge, the stale one is
  // reported separately rather than silently dropped or silently retried.
  await db.as('authenticated', USERS.officer);
  const res = await db.val(`select purge_evidence(12, $1::uuid[])`, [
    [EV.reviewedA, EV.reviewedB, EV.rejectedOld],
  ]);
  await db.asOwner();

  assert.equal(res.evidence_count, 2, 'reviewedB (1) plus the rejected event (1)');
  assert.equal(res.bytes_freed, 4500);
  assert.deepEqual([...res.event_ids].sort(), [EV.rejectedOld, EV.reviewedB].sort());
  assert.deepEqual(res.ineligible_event_ids, [EV.reviewedA]);
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('a non-officer is refused by every purge function, but fn_storage_usage stays staff readable', async () => {
  for (const [name, sql, params] of [
    ['purge_evidence', `select purge_evidence(12, null)`, []],
    ['fn_purge_preview', `select * from fn_purge_preview(12)`, []],
    ['finish_purge_run', `select * from finish_purge_run($1::uuid, $2::text[])`, [
      '00000000-0000-4000-a000-000000000000',
      [],
    ]],
  ]) {
    await db.as('authenticated', USERS.viewer);
    const err = await db.expectError(sql, params);
    await db.asOwner();
    assert.equal(err.code, 'PDS07', `${name} did not refuse a viewer: ${err.message}`);
  }

  // A viewer reads the whole screen and presses nothing (docs/03-admin-ui.md
  // section 7): the usage bar is the part that is pure information, so it is
  // staff gated rather than officer gated.
  await db.as('authenticated', USERS.viewer);
  const usage = await db.one(`select * from fn_storage_usage()`);
  await db.asOwner();
  assert.ok(usage, 'a viewer can read the usage summary');

  // A member holds neither role and is refused by both kinds of gate.
  await db.as('authenticated', USERS.adaAccount);
  const memberErr = await db.expectError(`select purge_evidence(12, null)`);
  assert.equal(memberErr.code, 'PDS07');
  const memberUsageErr = await db.expectError(`select * from fn_storage_usage()`);
  assert.equal(memberUsageErr.code, 'PDS07');
  await db.asOwner();
});

test('a retention window below one month is refused', async () => {
  await db.as('authenticated', USERS.officer);
  const purgeErr = await db.expectError(`select purge_evidence(0, null)`);
  assert.equal(purgeErr.code, 'PDS03');
  assert.match(purgeErr.message, /at least one month/i);

  const previewErr = await db.expectError(`select * from fn_purge_preview(0)`);
  assert.equal(previewErr.code, 'PDS03');
  await db.asOwner();
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test('the usage numbers: live bytes, the quota, and the orphaned count kept apart', async () => {
  // One abandoned upload grant, expired, nothing pointing at its path. Its
  // bytes are unknown by construction: it is counted, not summed.
  await db.exec(`
    insert into evidence_upload_grants
      (token, event_id, member_id, kind, object_path, expires_at)
    values
      ('storage-orphan-tok', '${EV.recent}', '${MEMBERS.edda}', 'shirt_photo',
       'storage/never-submitted.jpg', now() - interval '1 hour');
  `);

  await db.as('authenticated', USERS.officer);
  const usage = await db.one(`select * from fn_storage_usage()`);
  await db.asOwner();

  const live = await db.q(
    `select byte_size from attendance_evidence where purged_at is null and object_path is not null`,
  );
  const expectedBytes = live.reduce((sum, row) => sum + Number(row.byte_size ?? 0), 0);

  assert.equal(Number(usage.photo_count), live.length);
  assert.equal(Number(usage.bytes_held), expectedBytes);
  assert.equal(Number(usage.quota_bytes), 1073741824);
  assert.equal(Number(usage.warn_percent), 75);
  assert.equal(
    Number(usage.percent_used),
    Math.round((1000 * expectedBytes) / 1073741824) / 10,
  );
  assert.equal(Number(usage.orphaned_count), 1);

  await db.exec(`delete from evidence_upload_grants where token = 'storage-orphan-tok'`);
});

// ---------------------------------------------------------------------------
// Purge-run object bookkeeping
// ---------------------------------------------------------------------------

test('purge-run objects are recorded per run, and a partially deleted run can be finished later', async () => {
  // A fresh pair of events so this test does not depend on purge state left
  // by the eligibility tests above.
  const eventOne = '55555555-0000-4000-a000-0000000000a1';
  const eventTwo = '55555555-0000-4000-a000-0000000000a2';
  const recOne = '66666666-0000-4000-a000-0000000000a1';
  const recTwo = '66666666-0000-4000-a000-0000000000a2';

  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token) values
      ('${eventOne}', '${YEAR_2026}', 'Storage Test Bookkeeping 1', current_date - 800, 'tok-storage-f'),
      ('${eventTwo}', '${YEAR_2026}', 'Storage Test Bookkeeping 2', current_date - 800, 'tok-storage-g');
    insert into event_categories (event_id, category_id)
    values ('${eventOne}', 'c0000000-0000-4000-a000-000000000005'),
           ('${eventTwo}', 'c0000000-0000-4000-a000-000000000005');
    insert into attendance_records (id, event_id, member_id, status, source) values
      ('${recOne}', '${eventOne}', '${MEMBERS.cressida}', 'approved', 'officer_entry'),
      ('${recTwo}', '${eventTwo}', '${MEMBERS.barnaby}',  'approved', 'officer_entry');
    insert into attendance_evidence (attendance_record_id, kind, object_path, byte_size) values
      ('${recOne}', 'shirt_photo', 'storage/bookkeeping-1.jpg', 111),
      ('${recTwo}', 'shirt_photo', 'storage/bookkeeping-2.jpg', 222);
  `);

  await db.as('authenticated', USERS.officer);
  const res = await db.val(`select purge_evidence(12, $1::uuid[])`, [[eventOne, eventTwo]]);
  await db.asOwner();

  assert.equal(res.evidence_count, 2);
  const runId = res.purge_run_id;

  const objects = await db.q(
    `select object_path, bucket, deleted_at from purge_run_objects where purge_run_id = $1 order by object_path`,
    [runId],
  );
  assert.deepEqual(
    objects.map((o) => o.object_path),
    ['storage/bookkeeping-1.jpg', 'storage/bookkeeping-2.jpg'],
  );
  assert.ok(objects.every((o) => o.bucket === 'evidence' && o.deleted_at === null));

  // The browser only managed to delete one of the two objects before it died.
  await db.as('authenticated', USERS.officer);
  const first = await db.q(`select * from finish_purge_run($1::uuid, $2::text[])`, [
    runId,
    ['storage/bookkeeping-1.jpg'],
  ]);
  await db.asOwner();
  assert.equal(first.length, 1);
  assert.equal(first[0].outcome, 'marked_deleted');

  let outstanding = await db.q(
    `select outstanding_count, total_count from v_purge_runs_outstanding where purge_run_id = $1`,
    [runId],
  );
  assert.equal(outstanding.length, 1, 'a half-finished run still shows up as outstanding');
  assert.equal(Number(outstanding[0].outstanding_count), 1);
  assert.equal(Number(outstanding[0].total_count), 2);

  // Finishing the run later: the remaining path, an already-marked repeat of
  // the first, and a path that was never part of this run at all.
  await db.as('authenticated', USERS.officer);
  const second = await db.q(`select * from finish_purge_run($1::uuid, $2::text[])`, [
    runId,
    ['storage/bookkeeping-2.jpg', 'storage/bookkeeping-1.jpg', 'storage/never-part-of-this-run.jpg'],
  ]);
  await db.asOwner();

  const byPath = Object.fromEntries(second.map((row) => [row.object_path, row.outcome]));
  assert.equal(byPath['storage/bookkeeping-2.jpg'], 'marked_deleted');
  assert.equal(byPath['storage/bookkeeping-1.jpg'], 'already_marked');
  assert.equal(byPath['storage/never-part-of-this-run.jpg'], 'unknown_object');

  outstanding = await db.q(
    `select 1 from v_purge_runs_outstanding where purge_run_id = $1`,
    [runId],
  );
  assert.equal(outstanding.length, 0, 'a fully finished run drops out of the outstanding view');

  await db.exec(`
    delete from purge_run_objects where purge_run_id = '${runId}';
    delete from attendance_evidence where object_path like 'storage/bookkeeping-%';
    delete from attendance_records where id in ('${recOne}', '${recTwo}');
    delete from events where id in ('${eventOne}', '${eventTwo}');
    delete from purge_runs where id = '${runId}';
  `);
});

// ---------------------------------------------------------------------------
// Eligibility locking (20.1's `for update of ae`)
// ---------------------------------------------------------------------------
// WHAT THIS DOES AND DOES NOT PROVE. test/helpers/db.mjs runs one PGlite
// connection: every query in this file executes to completion, one at a
// time, on that single connection. There is no way from this harness to
// start a second, genuinely concurrent transaction, hold it open mid-purge,
// and have a first transaction's SELECT ... FOR UPDATE block on it the way
// two officers' browsers racing for the same object_path would. That half of
// the fix, the actual blocking and the EvalPlanQual re-check PostgreSQL
// performs once the first transaction's lock releases, is not something
// this test (or any test in this file) exercises: it is asserted by reading
// the SQL and its comment in supabase/migrations/20260815100000_storage_ops.sql,
// not proven here.
//
// What this test proves instead is the property that locking exists to
// protect, checked the one way a single connection can check it: two
// sequential purge_evidence() calls for the same object never both record
// it in purge_run_objects, and the second call reports the object's event as
// ineligible rather than silently re-purging or silently dropping it. A
// version of purge_evidence() that read _purge_eligible with a plain SELECT
// (no locking at all) would still pass this particular test, because the
// first call's UPDATE has already committed by the time the second runs on
// this single connection; it is FOR UPDATE's EvalPlanQual re-check, not
// pglite, that is expected to be what makes the equivalent true under real
// concurrency.

test('two purges never both record the same object_path, sequentially at least', async () => {
  const eventLock = '55555555-0000-4000-a000-0000000000b1';
  const recLock = '66666666-0000-4000-a000-0000000000b1';

  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token) values
      ('${eventLock}', '${YEAR_2026}', 'Storage Test Locking', current_date - 800, 'tok-storage-h');
    insert into event_categories (event_id, category_id)
    values ('${eventLock}', 'c0000000-0000-4000-a000-000000000005');
    insert into attendance_records (id, event_id, member_id, status, source) values
      ('${recLock}', '${eventLock}', '${MEMBERS.cressida}', 'approved', 'officer_entry');
    insert into attendance_evidence (attendance_record_id, kind, object_path, byte_size) values
      ('${recLock}', 'shirt_photo', 'storage/locking-1.jpg', 999);
  `);

  await db.as('authenticated', USERS.officer);
  const first = await db.val(`select purge_evidence(12, $1::uuid[])`, [[eventLock]]);
  const second = await db.val(`select purge_evidence(12, $1::uuid[])`, [[eventLock]]);
  await db.asOwner();

  assert.equal(first.evidence_count, 1);
  assert.deepEqual(first.event_ids, [eventLock]);
  assert.equal(second.evidence_count, 0, 'the second call saw the already-purged object as still eligible');
  assert.deepEqual(second.ineligible_event_ids, [eventLock]);

  const objects = await db.q(
    `select purge_run_id from purge_run_objects where object_path = 'storage/locking-1.jpg'`,
  );
  assert.equal(objects.length, 1, 'the same object_path was recorded by more than one purge run');

  await db.exec(`
    delete from purge_run_objects where object_path = 'storage/locking-1.jpg';
    delete from attendance_evidence where object_path = 'storage/locking-1.jpg';
    delete from attendance_records where id = '${recLock}';
    delete from events where id = '${eventLock}';
  `);
});

test('finish_purge_run refuses an unknown run rather than silently doing nothing', async () => {
  await db.as('authenticated', USERS.officer);
  const err = await db.expectError(`select * from finish_purge_run($1::uuid, $2::text[])`, [
    '00000000-0000-4000-a000-000000000000',
    ['whatever.jpg'],
  ]);
  await db.asOwner();
  assert.equal(err.code, 'PDS03');
});
