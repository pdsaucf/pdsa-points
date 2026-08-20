// Row-level security for the actual access model: anonymous visitors use only
// shaped RPCs, while the one shared authenticated admin session owns the full
// admin surface. There are no per-account application roles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, USERS, YEAR_2026 } from './helpers/fixture.mjs';

let db;

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
});

test.beforeEach(async () => db?.asOwner());
test.after(async () => db?.close());

test('anon cannot read admin tables', async () => {
  for (const table of ['members', 'events', 'attendance_records', 'app_settings']) {
    await db.as('anon');
    const read = await db.expectError(`select * from ${table}`);
    await db.asOwner();
    assert.equal(read.code, '42501', `${table} should be permission denied`);
  }
});

test('a valid shared session reads the complete admin surface', async () => {
  await db.as('authenticated', USERS.officer);
  const members = Number(await db.val(`select count(*) from members`));
  const attendance = Number(await db.val(`select count(*) from attendance_records`));
  const status = Number(
    await db.val(`select count(*) from v_member_status where academic_year_id = $1`, [YEAR_2026]),
  );
  await db.asOwner();

  assert.equal(members, 10);
  assert.equal(attendance, 51);
  assert.equal(status, 10);
});

test('a valid shared session can create an event without a profile row', async () => {
  await db.as('authenticated', USERS.officer);
  const rows = await db.q(
    `insert into events (academic_year_id, title, occurred_on)
     values ($1, 'Shared session regression', date '2026-08-19')
     returning id, checkin_token`,
    [YEAR_2026],
  );
  await db.asOwner();

  assert.equal(rows.length, 1);
  assert.ok(rows[0].checkin_token);
  await db.q(`delete from events where id = $1`, [rows[0].id]);
});

test('another authenticated Auth user is not an administrator', async () => {
  await db.as('authenticated', USERS.viewer);
  const insert = await db.expectError(
    `insert into events (academic_year_id, title, occurred_on)
     values ($1, 'Unauthorized event', date '2026-08-19')
     returning id`,
    [YEAR_2026],
  );
  const visibleMembers = Number(await db.val(`select count(*) from members`));
  await db.asOwner();

  assert.equal(insert.code, '42501');
  assert.equal(visibleMembers, 0);
});

test('the application account layer is absent', async () => {
  for (const relation of ['profiles', 'member_claims']) {
    const row = await db.val(`select to_regclass($1)`, [`public.${relation}`]);
    assert.equal(row, null, relation);
  }

  assert.equal(
    await db.val(`select exists (select 1 from pg_type where typname = 'app_role')`),
    false,
  );
});

test('retiring an old Auth user preserves historical rows', async () => {
  const oldUser = '99999999-0000-4000-a000-0000000000f8';
  const eventId = '22222222-0000-4000-a000-0000000000f8';

  await db.exec(`
    insert into auth.users (id, email)
    values ('${oldUser}', 'former-president@example.test');
    insert into events (id, academic_year_id, title, occurred_on, created_by)
    values ('${eventId}', '${YEAR_2026}', 'Historical event', date '2026-08-18', '${oldUser}');
    insert into audit_log (actor_user_id, action, entity_type, entity_id)
    values ('${oldUser}', 'historical_action', 'event', '${eventId}');
    delete from auth.users where id = '${oldUser}';
  `);

  assert.equal(await db.val(`select created_by from events where id = $1`, [eventId]), null);
  assert.equal(
    await db.val(`select actor_user_id from audit_log where entity_id = $1`, [eventId]),
    null,
  );

  const remainingRestrictive = Number(
    await db.val(`
      select count(*)
      from pg_constraint
      where contype = 'f'
        and confrelid = 'auth.users'::regclass
        and connamespace <> 'auth'::regnamespace
        and confdeltype <> 'n'
    `),
  );
  assert.equal(remainingRestrictive, 0);

  await db.exec(`delete from events where id = '${eventId}'`);
});
