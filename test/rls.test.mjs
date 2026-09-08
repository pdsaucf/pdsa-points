// Row-level security for the actual access model: anonymous visitors use only
// shaped RPCs. The shared admin session remains supported alongside profiles.
// Officer role boundaries and refusals are exercised in privileges.test.mjs.

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

test('a valid shared session can create an event through the configuration RPC', async () => {
  const eventId = '22222222-0000-4000-a000-0000000000e1';
  await db.as('authenticated', USERS.officer);
  const saved = await db.val(
    `select save_event_config($1, $2, $3::jsonb, '[]'::jsonb, null, null, true)`,
    [
      eventId,
      YEAR_2026,
      JSON.stringify({ title: 'Shared session regression', occurred_on: '2026-08-19' }),
    ],
  );
  await db.asOwner();

  assert.equal(saved.id, eventId);
  assert.ok(saved.checkin_token);
  await db.q(`delete from events where id = $1`, [eventId]);
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

test('staff profiles are restored without reviving member claims', async () => {
  assert.equal(await db.val("select to_regclass('public.profiles')"), 'profiles');
  assert.equal(await db.val("select to_regclass('public.member_claims')"), null);
  assert.deepEqual((await db.q(`select enumlabel from pg_enum
    where enumtypid='app_role'::regtype order by enumsortorder`)).map(row => row.enumlabel),
  ['admin', 'officer', 'viewer', 'member']);
});

test('retiring an old Auth user preserves historical rows', async () => {
  const oldUser = '99999999-0000-4000-a000-0000000000f8';
  const eventId = '22222222-0000-4000-a000-0000000000f8';

  await db.exec(`
    insert into auth.users (id, email)
    values ('${oldUser}', 'former-president@example.test');
    insert into profiles(user_id,role) values ('${oldUser}','officer');
    insert into events (id, academic_year_id, title, occurred_on, created_by)
    values ('${eventId}', '${YEAR_2026}', 'Historical event', date '2026-08-18', '${oldUser}');
    insert into audit_log (actor_user_id, action, entity_type, entity_id)
    values ('${oldUser}', 'historical_action', 'event', '${eventId}');
    delete from auth.users where id = '${oldUser}';
  `);

  assert.equal(await db.val('select count(*)::int from profiles where user_id=$1', [oldUser]), 0);
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
        and not (conrelid = 'profiles'::regclass and confdeltype = 'c')
    `),
  );
  assert.equal(remainingRestrictive, 0);

  await db.exec(`delete from events where id = '${eventId}'`);
});
