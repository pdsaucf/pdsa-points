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
