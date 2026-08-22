// add_officer_attendance(): filing the paper sign-in sheet.
//
// The events screen used to do this in two HTTP calls, an INSERT followed by
// review_records(). These tests are about the two things that made that wrong,
// and they are both things a client cannot fix on its own:
//
//   1. THE GAP BETWEEN THE TWO CALLS. The insert commits; the approval fails.
//      The officer is told the action failed and N pending records they were
//      never told about are sitting in the queue. Here the whole thing is one
//      transaction, so a refused approval takes the inserts with it.
//
//   2. THE CLIENT DECIDING WHAT AN EVENT WANTS. Whether a member types a
//      number is `event_categories.credit_mode`, and the screen reads it when
//      it opens. Change it underneath and the client goes on filing
//      submitted_value = NULL against a from_submission link, which is worth
//      zero, and says the members were added. The function reads the event
//      itself, at the moment of the write, and refuses.
//
// The zero-credit case is the one worth being loud about: nothing raises, no
// constraint is violated, and the officer is told it worked. It is only
// visible weeks later, as a member who says their hours are missing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, USERS, YEAR_2026 } from './helpers/fixture.mjs';

// Seeded category ids, as the other suites name them.
const CATEGORY_GBMS = 'c0000000-0000-4000-a000-000000000001';
const CATEGORY_VOLUNTEERING = 'c0000000-0000-4000-a000-000000000002';

let db;

const FIXED_EVENT = '22222222-0000-4000-a000-0000000000e1';
const TYPED_EVENT = '22222222-0000-4000-a000-0000000000e2';

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  // Two events with no attendance of their own: one with plain fixed credit,
  // one that asks the member for a number.
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token)
    values ('${FIXED_EVENT}', '${YEAR_2026}', 'Officer Entry Fixed', current_date, 'tok-oe-fixed'),
           ('${TYPED_EVENT}', '${YEAR_2026}', 'Officer Entry Typed', current_date, 'tok-oe-typed');

    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${FIXED_EVENT}', '${CATEGORY_GBMS}', 'fixed', 1),
           ('${TYPED_EVENT}', '${CATEGORY_VOLUNTEERING}', 'from_submission', 1);
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

const asOfficer = (sql, params = []) =>
  db.withRole('authenticated', USERS.officer, () => db.val(sql, params));

const add = (eventId, memberIds, value = null) =>
  asOfficer(`select add_officer_attendance($1::uuid, $2::uuid[], $3::numeric)`, [
    eventId,
    memberIds,
    value,
  ]);

test('a batch is filed and approved in one call, stamped with the officer', async () => {
  const ids = await add(FIXED_EVENT, [MEMBERS.dorian, MEMBERS.greta]);
  assert.equal(ids.length, 2);

  const rows = await db.q(
    `select status, source, submitted_value, reviewed_by, reviewed_at
       from attendance_records where id = any($1::uuid[])`,
    [ids],
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'approved');
    assert.equal(row.source, 'officer_entry');
    assert.equal(row.submitted_value, null);
    // The reviewer stamp comes from review_records(), which this function
    // calls rather than reimplementing. If it ever set `status` itself, this
    // is the assertion that would notice.
    assert.equal(row.reviewed_by, USERS.officer);
    assert.ok(row.reviewed_at);
  }

  await db.q(`delete from attendance_records where id = any($1::uuid[])`, [ids]);
});

test('an event that asks for a number refuses a call that does not carry one', async () => {
  const err = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], null)`, [
      TYPED_EVENT,
      [MEMBERS.dorian],
    ]),
  );
  assert.equal(err.code, 'PDS03');
  assert.match(err.message, /number/i);

  // And nothing was written. This is the zero-credit case: without the
  // refusal the record lands approved and worth nothing at all.
  const left = await db.val(
    `select count(*) from attendance_records where event_id = $1`,
    [TYPED_EVENT],
  );
  assert.equal(Number(left), 0);
});

test('an event that collects no number refuses a call that carries one', async () => {
  const err = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], 3.5)`, [
      FIXED_EVENT,
      [MEMBERS.dorian],
    ]),
  );
  assert.equal(err.code, 'PDS03');
});

test('the credit mode is read at the write, not taken from the caller', async () => {
  // THE RACE THIS EXISTS FOR. A screen opened while the event was fixed keeps
  // calling without a number. Another officer switches the event to
  // from_submission. The old two-call client would file NULL against a
  // from_submission link and approve it, which is an approved record worth
  // zero and nothing anywhere says so.
  await db.exec(`
    update event_categories set credit_mode = 'from_submission'
     where event_id = '${FIXED_EVENT}';
  `);

  const err = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], null)`, [
      FIXED_EVENT,
      [MEMBERS.dorian],
    ]),
  );
  assert.equal(err.code, 'PDS03');
  assert.equal(
    Number(await db.val(`select count(*) from attendance_records where event_id = $1`, [FIXED_EVENT])),
    0,
    'a record was filed against a credit mode the caller did not know about',
  );

  await db.exec(`
    update event_categories set credit_mode = 'fixed'
     where event_id = '${FIXED_EVENT}';
  `);
});

test('a member already holding a live record takes the whole batch down with them', async () => {
  const first = await add(FIXED_EVENT, [MEMBERS.dorian]);
  assert.equal(first.length, 1);

  // Dorian is now on the event. Adding a batch that includes them must not
  // half-land: one_live_record_per_member_event refuses Dorian, and Greta
  // must not be filed either.
  const err = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], null)`, [
      FIXED_EVENT,
      [MEMBERS.greta, MEMBERS.dorian],
    ]),
  );
  assert.equal(err.code, 'PDS05');

  const onEvent = await db.q(
    `select member_id from attendance_records where event_id = $1`,
    [FIXED_EVENT],
  );
  assert.equal(onEvent.length, 1, 'the refused batch left a record behind');
  assert.equal(onEvent[0].member_id, MEMBERS.dorian);

  await db.q(`delete from attendance_records where event_id = $1`, [FIXED_EVENT]);
});

test('a declined record does not block the same member being added again', async () => {
  // one_live_record_per_member_event deliberately excludes rejected rows, so
  // an officer who declined somebody by mistake can put them back.
  const ids = await add(FIXED_EVENT, [MEMBERS.dorian]);
  await db.withRole('authenticated', USERS.officer, () =>
    db.val(`select review_records($1::uuid[], 'reject', 'By mistake')`, [ids]),
  );

  const again = await add(FIXED_EVENT, [MEMBERS.dorian]);
  assert.equal(again.length, 1);
  assert.notEqual(again[0], ids[0]);

  await db.q(`delete from attendance_records where event_id = $1`, [FIXED_EVENT]);
});

test('an archived member cannot be given credit', async () => {
  await db.exec(`
    insert into members (id, first_name, last_name, archived_at)
    values ('11111111-0000-4000-a000-0000000000f1', 'Gone', 'Away', now());
  `);

  const err = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], null)`, [
      FIXED_EVENT,
      [MEMBERS.dorian, '11111111-0000-4000-a000-0000000000f1'],
    ]),
  );
  assert.equal(err.code, 'PDS03');
  assert.equal(
    Number(await db.val(`select count(*) from attendance_records where event_id = $1`, [FIXED_EVENT])),
    0,
    'the live member in the batch was filed anyway',
  );

  await db.exec(`delete from members where id = '11111111-0000-4000-a000-0000000000f1'`);
});

test('an empty batch and an unknown event are both refused', async () => {
  const empty = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, array[]::uuid[], null)`, [FIXED_EVENT]),
  );
  assert.equal(empty.code, 'PDS03');

  const unknown = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], null)`, [
      '22222222-0000-4000-a000-0000000000ff',
      [MEMBERS.dorian],
    ]),
  );
  assert.equal(unknown.code, 'PDS03');
});

test('a viewer cannot file attendance, and anon holds no grant at all', async () => {
  const asViewer = await db.withRole('authenticated', USERS.viewer, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], null)`, [
      FIXED_EVENT,
      [MEMBERS.dorian],
    ]),
  );
  assert.equal(asViewer.code, 'PDS07');

  const asAnon = await db.withRole('anon', null, () =>
    db.expectError(`select add_officer_attendance($1::uuid, $2::uuid[], null)`, [
      FIXED_EVENT,
      [MEMBERS.dorian],
    ]),
  );
  assert.equal(asAnon.code, '42501');
});

test('the audit log records who filed what', async () => {
  const ids = await add(FIXED_EVENT, [MEMBERS.dorian]);

  const audit = await db.one(
    `select actor_user_id, detail from audit_log
      where action = 'add_officer_attendance' order by created_at desc limit 1`,
  );
  assert.equal(audit.actor_user_id, USERS.officer);
  assert.equal(audit.detail.event_id, FIXED_EVENT);
  assert.equal(audit.detail.count, 1);

  await db.q(`delete from attendance_records where id = any($1::uuid[])`, [ids]);
});

// ---------------------------------------------------------------------------
// remove_attendance_record(): deleting a record that carries a photo
// ---------------------------------------------------------------------------
//
// The bytes live in Storage and the row lives in Postgres, and there is no
// transaction across the two. The first attempt at this deleted the object
// first, which destroys a photo irreversibly when the row delete then fails.
// The second deleted the row first and argued the bytes were recoverable by
// purge_orphaned_uploads(). They were not: that function only looks at grants
// with consumed_at IS NULL, and submit_checkin() stamps consumed_at the moment
// a check-in is filed, so a real submitted photo is invisible to it, and
// purge_evidence() cannot see it either once the cascade has removed the
// attendance_evidence row.
//
// So the intent is written down before the delete. These tests are about that
// row existing, because it is the only thing standing between a browser that
// dies mid-flow and bytes nobody can ever name again.

test('removing a record with a photo leaves a purge run naming the object', async () => {
  const [record] = await db.q(
    `insert into attendance_records (event_id, member_id, source, status)
     values ($1, $2, 'self_checkin', 'approved') returning id`,
    [FIXED_EVENT, MEMBERS.dorian],
  );
  await db.q(
    `insert into attendance_evidence (attendance_record_id, kind, object_path, byte_size)
     values ($1, 'shirt_photo', 'year/shirt_photo/removal-test.jpg', 4096)`,
    [record.id],
  );

  const out = await asOfficer(`select remove_attendance_record($1::uuid)`, [record.id]);
  assert.deepEqual(out.object_paths, ['year/shirt_photo/removal-test.jpg']);
  assert.ok(out.purge_run_id, 'no purge run was written, so nothing names the bytes');

  assert.equal(
    Number(await db.val(`select count(*) from attendance_records where id = $1`, [record.id])),
    0,
    'the record survived',
  );
  assert.equal(
    Number(await db.val(`select count(*) from attendance_evidence where attendance_record_id = $1`, [record.id])),
    0,
    'the evidence row did not cascade',
  );

  const run = await db.one(
    `select kind, evidence_count, bytes_freed, retention_months, event_ids
       from purge_runs where id = $1`,
    [out.purge_run_id],
  );
  assert.equal(run.kind, 'record_removed');
  assert.equal(run.evidence_count, 1);
  assert.equal(Number(run.bytes_freed), 4096);
  assert.equal(run.retention_months, null);
  assert.deepEqual(run.event_ids, [FIXED_EVENT]);

  // And it is outstanding until somebody confirms the bucket delete, which is
  // what the storage screen lists and what makes this recoverable at all.
  const outstanding = await db.one(
    `select outstanding_count, total_count from v_purge_runs_outstanding
      where purge_run_id = $1`,
    [out.purge_run_id],
  );
  assert.equal(Number(outstanding.outstanding_count), 1);

  // Finishing it is the ordinary path, shared with every other purge.
  await db.withRole('authenticated', USERS.officer, () =>
    db.q(`select * from finish_purge_run($1::uuid, $2::text[])`, [
      out.purge_run_id,
      ['year/shirt_photo/removal-test.jpg'],
    ]),
  );
  const settled = await db.q(
    `select 1 from v_purge_runs_outstanding where purge_run_id = $1`,
    [out.purge_run_id],
  );
  assert.equal(settled.length, 0, 'the run is still outstanding after being finished');
});

test('removing a record with no photo writes no purge run', async () => {
  const ids = await add(FIXED_EVENT, [MEMBERS.dorian]);
  const before = Number(await db.val(`select count(*) from purge_runs`));

  const out = await asOfficer(`select remove_attendance_record($1::uuid)`, [ids[0]]);
  assert.equal(out.purge_run_id, null);
  assert.deepEqual(out.object_paths, []);
  assert.equal(Number(await db.val(`select count(*) from purge_runs`)), before);
});

test('removing deletes only the named attendance record', async () => {
  const [targetId] = await add(FIXED_EVENT, [MEMBERS.dorian]);
  const [sameEventId] = await add(FIXED_EVENT, [MEMBERS.greta]);
  const [otherEventId] = await add(TYPED_EVENT, [MEMBERS.fergus], 2.5);

  const memberBefore = await db.val(
    `select to_jsonb(m) from members m where id = $1`,
    [MEMBERS.dorian],
  );
  const eventBefore = await db.val(
    `select to_jsonb(e) from events e where id = $1`,
    [FIXED_EVENT],
  );
  const unrelatedBefore = await db.q(
    `select to_jsonb(a) as row from attendance_records a
      where id = any($1::uuid[]) order by id`,
    [[sameEventId, otherEventId]],
  );

  await asOfficer(`select remove_attendance_record($1::uuid)`, [targetId]);

  assert.equal(
    Number(await db.val(`select count(*) from attendance_records where id = $1`, [targetId])),
    0,
  );
  assert.deepEqual(
    await db.val(`select to_jsonb(m) from members m where id = $1`, [MEMBERS.dorian]),
    memberBefore,
    'the member changed with the attendance record',
  );
  assert.deepEqual(
    await db.val(`select to_jsonb(e) from events e where id = $1`, [FIXED_EVENT]),
    eventBefore,
    'the event changed with the attendance record',
  );
  assert.deepEqual(
    await db.q(
      `select to_jsonb(a) as row from attendance_records a
        where id = any($1::uuid[]) order by id`,
      [[sameEventId, otherEventId]],
    ),
    unrelatedBefore,
    'an unrelated attendance record changed',
  );

  const audit = await db.one(
    `select entity_id, detail from audit_log
      where action = 'remove_attendance_record' order by created_at desc limit 1`,
  );
  assert.equal(audit.entity_id, targetId);
  assert.equal(audit.detail.event_id, FIXED_EVENT);
  assert.equal(audit.detail.member_id, MEMBERS.dorian);

  await db.q(`delete from attendance_records where id = any($1::uuid[])`, [
    [sameEventId, otherEventId],
  ]);
});

test('removing refuses an unknown record, and a viewer cannot remove at all', async () => {
  const unknown = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select remove_attendance_record($1::uuid)`, [
      '33333333-0000-4000-a000-0000000000ff',
    ]),
  );
  assert.equal(unknown.code, 'PDS03');

  const ids = await add(FIXED_EVENT, [MEMBERS.dorian]);
  const asViewer = await db.withRole('authenticated', USERS.viewer, () =>
    db.expectError(`select remove_attendance_record($1::uuid)`, [ids[0]]),
  );
  assert.equal(asViewer.code, 'PDS07');
  assert.equal(
    Number(await db.val(`select count(*) from attendance_records where id = $1`, [ids[0]])),
    1,
    'a viewer deleted a record',
  );
  await db.q(`delete from attendance_records where id = any($1::uuid[])`, [ids]);
});
