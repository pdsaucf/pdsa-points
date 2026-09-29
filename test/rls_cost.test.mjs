// Role checks in RLS policies must run once per statement.
//
// A bare fn_is_staff() in a policy is evaluated for every row, and each call
// is a chain of SECURITY DEFINER lookups. On a full roster that took the
// Members screen past the statement timeout. Wrapped as (select fn_is_staff())
// it is an InitPlan, evaluated once. See
// supabase/migrations/20260926100000_rls_role_check_once_per_query.sql.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';

let db;

test.before(async () => {
  db = await freshDb();
});

test.after(async () => db?.close());

test('no policy calls a role check once per row', async () => {
  const policies = await db.q(
    `select schemaname || '.' || tablename || ' ' || policyname as name, qual, with_check
     from pg_policies`,
  );
  const bare = /(?<!SELECT )fn_is_(admin|officer|staff)\(\)/;
  const offenders = policies
    .filter((p) => bare.test(p.qual ?? '') || bare.test(p.with_check ?? ''))
    .map((p) => p.name);
  assert.deepEqual(offenders, []);
  assert.ok(policies.some((p) => /SELECT fn_is_staff\(\)/.test(p.qual ?? '')), 'the pattern still matches deparsed policies');
});

// The honorary evaluator runs a dozen or so statements per member. Under the
// caller's RLS each one repeated the role lookup for every table it read, and
// a 235 member roster passed the statement timeout. It authorizes once and
// reads as the owner. See 20260928120000_evaluator_role_check_once.sql.
test('v_member_status looks up the caller role a few times per member, not per statement', async () => {
  const { loadFixture, USERS, YEAR_2026 } = await import('./helpers/fixture.mjs');
  await loadFixture(db);
  await db.asOwner();
  await db.exec(`set track_functions = 'all'`);
  const calls = async () => {
    // Counts flush at transaction end, at most once a second unless forced.
    await db.exec('select pg_stat_force_next_flush()');
    await db.exec('select pg_stat_clear_snapshot()');
    return Number(await db.val(`select coalesce(sum(calls), 0) from pg_stat_user_functions where funcname = 'fn_staff_role'`));
  };

  const before = await calls();
  const rows = await db.withRole('authenticated', USERS.officer, () =>
    db.q(`select member_id, is_honorary from v_member_status where academic_year_id = $1`, [YEAR_2026]),
  );
  const perMember = ((await calls()) - before) / rows.length;

  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.is_honorary), 'the evaluator still ran');
  assert.ok(perMember <= 3, `${perMember} role lookups per member`);
});

test('an authenticated request with no user cannot evaluate a member', async () => {
  const { loadFixture, MEMBERS, REQ_SET } = await import('./helpers/fixture.mjs');
  if (!(await db.val(`select count(*)::int from members`))) await loadFixture(db);
  await db.as('authenticated', null);
  const err = await db.expectError(`select * from fn_member_requirement_status($1, $2)`, [MEMBERS.ada, REQ_SET]);
  await db.asOwner();
  assert.equal(err.code, 'PDS07');
});
