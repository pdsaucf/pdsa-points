// Acceptance test 8: the constraints that make bad states unrepresentable.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, EVENTS, USERS, YEAR_2026 } from './helpers/fixture.mjs';

let db;

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
});

// A failing assertion can leave the connection inside `set role`, which would
// then leak into every later test in the file. Reset before each one.
test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('an unmatched record cannot be approved, but can be rejected', async () => {
  const id = await db.val(
    `insert into attendance_records (event_id, member_id, claimed_name, status, source, flags)
     values ($1, null, 'Someone Notonroster', 'pending', 'self_checkin', '{unmatched_name}')
     returning id`,
    [EVENTS.gbmBlock],
  );

  const err = await db.expectError(
    `update attendance_records set status = 'approved' where id = $1`,
    [id],
  );
  assert.equal(err.code, '23514'); // check constraint
  assert.match(err.message, /attendance_records/);

  // Rejecting one is fine: the point is that credit cannot exist without a
  // person attached, not that the row is untouchable.
  await db.q(`update attendance_records set status = 'rejected' where id = $1`, [id]);
  const row = await db.one(`select status from attendance_records where id = $1`, [id]);
  assert.equal(row.status, 'rejected');

  await db.q(`delete from attendance_records where id = $1`, [id]);
});

test('review_records refuses to approve an unmatched record with a usable message', async () => {
  const id = await db.val(
    `insert into attendance_records (event_id, member_id, claimed_name, status, source, flags)
     values ($1, null, 'Someone Notonroster', 'pending', 'self_checkin', '{unmatched_name}')
     returning id`,
    [EVENTS.clinA],
  );

  await db.as('authenticated', USERS.officer);
  const err = await db.expectError(`select review_records(array[$1]::uuid[], 'approve', null)`, [
    id,
  ]);
  await db.asOwner();

  assert.equal(err.code, 'PDS06');
  assert.match(err.message, /not linked to a member/i);

  await db.q(`delete from attendance_records where id = $1`, [id]);
});

test('a second live record for the same event and member is rejected', async () => {
  // Ada already has a live record for the GBM block.
  const err = await db.expectError(
    `insert into attendance_records (event_id, member_id, status, source)
     values ($1, $2, 'pending', 'self_checkin')`,
    [EVENTS.gbmBlock, MEMBERS.ada],
  );

  assert.equal(err.code, '23505'); // unique violation
  assert.match(err.message, /one_live_record_per_member_event/);
});

test('after a rejection, a fresh submission for the same event succeeds', async () => {
  // Hamish's GBM block record is already rejected, so it is outside the
  // partial unique index and a new attempt must be allowed through.
  const before = await db.one(
    `select status from attendance_records where event_id = $1 and member_id = $2`,
    [EVENTS.gbmBlock, MEMBERS.hamish],
  );
  assert.equal(before.status, 'rejected');

  const id = await db.val(
    `insert into attendance_records (event_id, member_id, status, source)
     values ($1, $2, 'pending', 'self_checkin') returning id`,
    [EVENTS.gbmBlock, MEMBERS.hamish],
  );
  assert.ok(id);

  // And that new one can now be approved normally.
  await db.q(`update attendance_records set status = 'approved' where id = $1`, [id]);

  // Which leaves exactly one live record plus the historical rejection.
  const counts = await db.q(
    `select status, count(*) as n from attendance_records
      where event_id = $1 and member_id = $2 group by status order by status`,
    [EVENTS.gbmBlock, MEMBERS.hamish],
  );
  assert.deepEqual(
    counts.map((c) => [c.status, Number(c.n)]),
    [
      ['approved', 1],
      ['rejected', 1],
    ],
  );

  // A third live one is still refused.
  const err = await db.expectError(
    `insert into attendance_records (event_id, member_id, status, source)
     values ($1, $2, 'pending', 'self_checkin')`,
    [EVENTS.gbmBlock, MEMBERS.hamish],
  );
  assert.equal(err.code, '23505');

  await db.q(`delete from attendance_records where id = $1`, [id]);
});

test('a record must identify somebody, one way or the other', async () => {
  const err = await db.expectError(
    `insert into attendance_records (event_id, member_id, claimed_name, status, source)
     values ($1, null, null, 'pending', 'self_checkin')`,
    [EVENTS.soap],
  );
  assert.equal(err.code, '23514');
});

test('an unknown triage flag is refused', async () => {
  const err = await db.expectError(
    `insert into attendance_records (event_id, member_id, status, source, flags)
     values ($1, $2, 'pending', 'self_checkin', '{definitely_not_a_flag}')`,
    [EVENTS.soap, MEMBERS.dorian],
  );
  assert.equal(err.code, '23514');
});

test('a category in use cannot be deleted, only archived', async () => {
  const err = await db.expectError(
    `delete from categories where slug = 'gbms'`,
  );
  // 23001 is restrict_violation, which is specifically what `on delete
  // restrict` raises. A plain foreign key would give 23503 instead.
  assert.equal(err.code, '23001');

  // Archiving is the supported move, and the config lint notices.
  await db.q(`update categories set archived_at = now() where slug = 'gbms'`);
  const warnings = await db.q(
    `select code, subject_label from v_config_warnings where code = 'rule_on_archived_category'`,
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].subject_label, 'GBMs');

  await db.q(`update categories set archived_at = null where slug = 'gbms'`);
});

test('an event can only have one link that reads the submitted value', async () => {
  const err = await db.expectError(
    `insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
     values ($1, (select id from categories where slug = 'tabling'), 'from_submission', 0)`,
    [EVENTS.volDay],
  );
  assert.equal(err.code, '23505');
  assert.match(err.message, /one_submitted_value_per_event/);
});

test('there can only be one current academic year', async () => {
  const err = await db.expectError(
    `insert into academic_years (label, starts_on, ends_on, is_current)
     values ('2027-2028', date '2027-08-16', date '2028-05-05', true)`,
  );
  assert.equal(err.code, '23505');
  assert.match(err.message, /one_current_year/);
});

test('a threshold node must carry a value and a group must not', async () => {
  const badThreshold = await db.expectError(
    `insert into requirement_nodes (requirement_set_id, type, label)
     values ('d0000000-0000-4000-a000-000000000001', 'threshold', 'No Value')`,
  );
  assert.equal(badThreshold.code, '23514');

  const badGroup = await db.expectError(
    `insert into requirement_nodes (requirement_set_id, type, label, min_value)
     values ('d0000000-0000-4000-a000-000000000001', 'group', 'Group With A Value', 3)`,
  );
  assert.equal(badGroup.code, '23514');
});

test('the seeded configuration is intact and warning-free', async () => {
  const cats = Number(await db.val(`select count(*) from categories where archived_at is null`));
  assert.equal(cats, 13);

  // A category is a name, a slug and an order. It carried a unit and a
  // counts_toward_point_total flag until migration 22, and the pair of them is
  // what this check used to read: Volunteering was 'hours' and did not count,
  // everything else was 'event_count' and did. Both columns are gone, so what is
  // asserted instead is that they are gone: a migration that put either back
  // would put a choice in front of an officer that changes nothing.
  const columns = await db.q(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'categories'
      order by column_name`,
  );
  assert.deepEqual(
    columns.map((row) => row.column_name),
    ['archived_at', 'created_at', 'id', 'name', 'slug', 'sort_order'],
  );
  assert.equal(
    Number(await db.val(`select count(*) from pg_type where typname = 'unit_type'`)),
    0,
    'the unit enum is still in the schema',
  );

  const set = await db.one(
    `select status, root_node_id from requirement_sets where academic_year_id = $1`,
    [YEAR_2026],
  );
  assert.equal(set.status, 'published');
  assert.ok(set.root_node_id);

  const nodes = Number(
    await db.val(`select count(*) from requirement_nodes where requirement_set_id = $1`, [
      'd0000000-0000-4000-a000-000000000001',
    ]),
  );
  // root + 9 top-level thresholds + the Editorial group + its 2 thresholds
  assert.equal(nodes, 13);

  const warnings = await db.q(`select code, subject_label from v_config_warnings`);
  assert.deepEqual(warnings, [], 'the shipped configuration should lint clean');
});
