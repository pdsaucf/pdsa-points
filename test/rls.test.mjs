// Acceptance test 7: row level security.
//
// The important assertions here are negative ones. anon must not be able to
// read the roster, the event list or the attendance table, and a member must
// see their own records and nobody else's.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import {
  loadFixture,
  EXPECTED,
  MEMBERS,
  USERS,
  REQ_SET,
  YEAR_2025,
  YEAR_2026,
} from './helpers/fixture.mjs';

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

test('anon cannot select from members, events or attendance_records', async () => {
  for (const table of ['members', 'events', 'attendance_records']) {
    await db.as('anon');
    const err = await db.expectError(`select * from ${table}`);
    await db.asOwner();

    // anon holds no grant on these tables at all, so this fails before any
    // policy is consulted. That is deliberate: a mistake in a policy still
    // cannot expose a row to an anonymous caller.
    assert.equal(err.code, '42501', `${table} should be permission denied`);
    assert.match(err.message, /permission denied/i);
  }
});

test('anon cannot reach the derived views or the roster search shortcut', async () => {
  for (const rel of ['v_member_status', 'v_member_category_totals', 'v_attendance_credit']) {
    await db.as('anon');
    const err = await db.expectError(`select * from ${rel}`);
    await db.asOwner();
    assert.equal(err.code, '42501', `${rel} should be permission denied`);
  }
});

test('anon cannot insert an attendance record directly', async () => {
  await db.as('anon');
  const err = await db.expectError(
    `insert into attendance_records (event_id, member_id, status)
     select id, $1, 'approved' from events limit 1`,
    [MEMBERS.ada],
  );
  await db.asOwner();
  assert.equal(err.code, '42501');
});

test('a member sees only their own attendance rows', async () => {
  await db.as('authenticated', USERS.adaAccount);

  const rows = await db.q(`select distinct member_id from attendance_records`);
  await db.asOwner();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].member_id, MEMBERS.ada);
});

test('a member sees only their own roster row', async () => {
  await db.as('authenticated', USERS.adaAccount);
  const rows = await db.q(`select id, first_name from members`);
  await db.asOwner();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, MEMBERS.ada);
});

test('a member sees only their own status row', async () => {
  await db.as('authenticated', USERS.adaAccount);
  const rows = await db.q(`select member_id, point_total, is_honorary from v_member_status`);
  await db.asOwner();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].member_id, MEMBERS.ada);
  // and the number is still correct when computed under their own RLS
  assert.equal(Number(rows[0].point_total), EXPECTED.ada.pointTotal);
  assert.equal(rows[0].is_honorary, true);
});

test('a member cannot read another members progress through the evaluator', async () => {
  await db.as('authenticated', USERS.adaAccount);
  const err = await db.expectError(
    `select * from fn_member_requirement_status($1, $2)`,
    [MEMBERS.barnaby, REQ_SET],
  );
  await db.asOwner();

  // Refused outright rather than quietly returning zeroes, which would look
  // like a real answer.
  assert.equal(err.code, 'PDS07');
});

test('an account with no approved claim sees nothing', async () => {
  await db.as('authenticated', USERS.unclaimed);
  const members = await db.q(`select * from members`);
  const attendance = await db.q(`select * from attendance_records`);
  const status = await db.q(`select * from v_member_status`);
  await db.asOwner();

  assert.equal(members.length, 0);
  assert.equal(attendance.length, 0);
  assert.equal(status.length, 0);
});

test('an officer sees every member and every attendance row', async () => {
  await db.as('authenticated', USERS.officer);
  const members = Number(await db.val(`select count(*) from members`));
  const attendance = Number(await db.val(`select count(*) from attendance_records`));
  const status = Number(
    await db.val(`select count(*) from v_member_status where academic_year_id = $1`, [
      YEAR_2026,
    ]),
  );
  await db.asOwner();

  assert.equal(members, 10);
  assert.equal(attendance, 51); // 14 + 12 + 12 + 0 + 2 + 3 + 2 + 3 + 1 + 2
  assert.equal(status, 10);
});

test('a viewer reads everything and writes nothing', async () => {
  await db.as('authenticated', USERS.viewer);
  const members = Number(await db.val(`select count(*) from members`));
  const err = await db.expectError(
    `insert into members (first_name, last_name) values ('Nope', 'Viewer')`,
  );
  await db.asOwner();

  assert.equal(members, 10);
  assert.equal(err.code, '42501'); // policy refused the insert
});

test('a member may change their preferred name and email, and nothing else', async () => {
  await db.as('authenticated', USERS.adaAccount);

  await db.q(`update members set preferred_name = 'Addie', email = 'addie@example.test'
              where id = $1`, [MEMBERS.ada]);

  const err = await db.expectError(`update members set last_name = 'Renamed' where id = $1`, [
    MEMBERS.ada,
  ]);
  await db.asOwner();

  assert.equal(err.code, 'PDS07');

  const row = await db.one(`select preferred_name, display_name, last_name from members where id = $1`, [
    MEMBERS.ada,
  ]);
  assert.equal(row.preferred_name, 'Addie');
  assert.equal(row.last_name, 'Testwood');
  assert.equal(row.display_name, 'Addie Testwood');

  await db.q(`update members set preferred_name = null, email = null where id = $1`, [
    MEMBERS.ada,
  ]);
});

test('a member cannot change anyone elses row', async () => {
  await db.as('authenticated', USERS.adaAccount);
  const rows = await db.q(
    `update members set preferred_name = 'Hacked' where id = $1 returning id`,
    [MEMBERS.barnaby],
  );
  await db.asOwner();

  // The policy makes the row invisible, so the update matches nothing rather
  // than raising.
  assert.equal(rows.length, 0);
  const check = await db.one(`select preferred_name from members where id = $1`, [
    MEMBERS.barnaby,
  ]);
  assert.equal(check.preferred_name, null);
});

test('a member cannot approve their own pending record', async () => {
  await db.as('authenticated', USERS.adaAccount);
  const rows = await db.q(
    `update attendance_records set status = 'approved'
      where member_id = $1 returning id`,
    [MEMBERS.ada],
  );
  await db.asOwner();
  assert.equal(rows.length, 0);
});

test('an officer cannot publish a requirement set, an admin can', async () => {
  // In 2025-2026, not the current year: 2026-2027 already holds a published
  // set, and one_published_set_per_year would reject the admin's update below
  // for a reason that has nothing to do with the policy under test.
  await db.exec(`
    insert into requirement_sets (id, academic_year_id, name, version, status)
    values ('d0000000-0000-4000-a000-0000000000aa',
            '${YEAR_2025}', 'Draft Under Test', 1, 'draft');
  `);

  await db.as('authenticated', USERS.officer);

  // The USING clause lets an officer see and edit a draft, so the row is
  // reachable. The WITH CHECK clause then rejects the version of the row that
  // says 'published', which surfaces as an error rather than a silent no-op.
  const publishErr = await db.expectError(
    `update requirement_sets set status = 'published'
      where id = 'd0000000-0000-4000-a000-0000000000aa'`,
  );
  assert.equal(publishErr.code, '42501', 'officer must not be able to publish');
  assert.match(publishErr.message, /row-level security policy/i);

  // An officer also cannot edit a set that is already published.
  const publishedRows = await db.q(
    `update requirement_nodes set min_value = 1 where requirement_set_id = $1 returning id`,
    [REQ_SET],
  );
  assert.equal(publishedRows.length, 0, 'published sets are immutable to officers');

  await db.as('authenticated', USERS.admin);
  const adminRows = await db.q(
    `update requirement_sets set status = 'published'
      where id = 'd0000000-0000-4000-a000-0000000000aa' returning id`,
  );
  assert.equal(adminRows.length, 1);

  await db.asOwner();
  await db.exec(
    `delete from requirement_sets where id = 'd0000000-0000-4000-a000-0000000000aa'`,
  );
});

test('the role helper is not fooled by a caller shadowing profiles', async () => {
  // fn_current_role pins its search_path, so a temp table called `profiles`
  // cannot be used to claim a role the caller does not have.
  await db.as('authenticated', USERS.adaAccount);
  await db.exec(`
    create temporary table profiles (user_id uuid, member_id uuid, role text);
    insert into profiles values
      ('${USERS.adaAccount}', null, 'admin');
  `);

  const role = await db.val(`select fn_current_role()`);
  const members = Number(await db.val(`select count(*) from members`));

  await db.exec(`drop table pg_temp.profiles`);
  await db.asOwner();

  assert.equal(role, 'member');
  assert.equal(members, 1);
});
