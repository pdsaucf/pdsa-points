// What the database hands out, and to whom.
//
// Two failures this file exists to catch, both of which were live in the
// schema before migration 16 and neither of which any other test could see.
//
// THE MISSING REVOKE. Postgres grants EXECUTE on a new function to PUBLIC.
// Migration 11 clears that with one blanket revoke, but that ran once, over
// the functions that existed then. Every migration since has had to remember
// its own `revoke ... from public, anon, authenticated`, and the only thing
// making anybody remember was a comment. A SECURITY DEFINER function left on
// the default ACL is callable by anon, which for anything that writes the
// roster or reviews a record is the whole security model gone. Migration 01's
// `alter default privileges ... revoke execute on functions from public` does
// not cover it: it writes no pg_default_acl row and a function created
// afterwards still comes out with `=X/postgres`. So the guard is here instead,
// and it is a guard rather than a snapshot: assertion 2 pins the anon surface
// from both sides, so a leak fails and so does an accidental removal.
//
// THE NULL ROLE. fn_current_role() returns NULL for a signed-in account with
// no profiles row, which is what every account is until an officer gives it
// one. fn_is_officer() was therefore NULL rather than false, and
// fn_assert_officer() asked `if not fn_is_officer()`, which does not raise on
// NULL. Nine SECURITY DEFINER RPCs routed their only role check through those
// two helpers. The second half of this file drives all nine as exactly that
// caller.
//
// WHICH HALF OF THIS FILE COVERS THE FUTURE, AND WHICH HALF IS A LIST.
//
// The four catalog assertions are written against pg_proc and pg_class rather
// than against any list of migrations, so a function added next year is
// covered by them on the day it is created: it either carries PUBLIC EXECUTE
// or it does not, it either pins search_path or it does not.
//
// The nine-RPC assertion below is not that. It is a hand-maintained list of
// the call sites that route their role check through fn_assert_officer() and
// fn_assert_admin(), and it can only ever cover the RPCs written into it. An
// RPC added later with its own inline check has to be added here by hand, and
// nothing in this file will notice if it is not. That is a deliberate limit
// rather than an oversight: deriving the list from catalog metadata, or
// keeping an allowlist of every SECURITY DEFINER function with a required
// unauthorized-caller test, is more machinery than a two-officer club system
// should carry. What the list does buy is that the nine that exist today
// cannot regress.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, REQ_SET, USERS } from './helpers/fixture.mjs';

let db;

// Everything an anonymous caller is allowed to reach, and nothing else. The
// check-in RPCs are the ones docs/01-data-model.md section 8 lists;
// fn_upload_grant_is_live is consulted by the storage insert policy, which
// anon has to be able to satisfy while uploading a photo it was granted a
// path for.
//
// THE FOUR portal_* FUNCTIONS ARE A DELIBERATE WIDENING, from migration 21. The
// member portal stopped being an account: the club has no email addresses for
// its members, so a member types their name and reads their own points, and the
// leaderboard lists the whole roster with their totals the way the spreadsheet
// this product replaces did. Each one answers a shaped question with the
// club-facing figures and nothing else, which is asserted in
// test/public_portal.test.mjs and is the reason they are functions rather than
// a grant on v_member_status. If one of them ever starts carrying an address, a
// student id or an unapproved record, that test fails rather than this one.
//
// PORTAL_ATTENDANCE(UUID) IS A SECOND, LATER WIDENING (migration 23), and it is
// worth being honest about what it opens rather than folding it quietly into
// the sentence above. Migration 21 deliberately withheld a member's own
// check-in history: "the individual records are the part an officer needs and
// a stranger does not." The club asked for that reversed, because the
// spreadsheet this product replaces showed a member every event of the year
// and whether they made it, and a point total alone cannot answer that. So this
// function hands back, for one member, every published event of this year by
// category with attended, waiting, declined, upcoming or nothing next to each
// one. It still carries none of an officer's context: no decline reason, no
// flags, no reviewer, no reviewed timestamp, no photo, no other member. That
// boundary is asserted in test/public_portal.test.mjs, the same as the other
// four.
//
// Full signatures rather than bare names. Postgres identifies a function by
// name AND argument types, so an overload is a different function with its own
// ACL: adding `search_members(text, text)` alongside the existing one and
// granting it to anon would leave a name-only list looking untouched. Compared
// this way, a new overload fails as an unexpected entry that names itself.
const ANON_MAY_EXECUTE = [
  'create_evidence_upload(text,uuid,evidence_kind_t,text)',
  // Not part of the check-in surface: .github/workflows/keepalive.yml calls
  // this, unauthenticated, so a free-tier pause on Postgres inactivity
  // specifically (not just API traffic) is something the workflow can
  // actually detect. See supabase/migrations/20260815100000_storage_ops.sql
  // section 20.8.
  'fn_keepalive()',
  'fn_upload_grant_is_live(text,text)',
  'get_checkin_context(text)',
  'portal_attendance(uuid)',
  'portal_find_members(text,text)',
  'portal_leaderboard()',
  'portal_requirements()',
  'portal_scorecard(uuid)',
  'search_members(text,text,text)',
  'submit_checkin(text,uuid,text,text,numeric,jsonb,text)',
];

// A signed-in account nobody has given a role to. Same id the member_upsert
// test uses for this case.
const NO_PROFILE = '99999999-0000-4000-a000-0000000000f9';

// Extension-owned objects are not ours to grant or revoke. citext, pg_trgm and
// pgcrypto all install functions into public with their own ACLs.
const NOT_FROM_AN_EXTENSION = `
  not exists (
    select 1 from pg_depend d
    where d.objid = p.oid
      and d.classid = 'pg_proc'::regclass
      and d.deptype = 'e'
  )
`;

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  // In auth.users but not in profiles, which is precisely the state a
  // magic-link sign-in leaves an account in. Registering them matters: without
  // the auth.users row the FK on audit_log.actor_user_id would refuse the
  // audit write, and an RPC that got past its role check would look refused
  // for a reason that has nothing to do with the role check.
  await db.exec(`
    insert into auth.users (id, email)
    values ('${NO_PROFILE}', 'signed-in-nobody@example.test')
    on conflict (id) do nothing;
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// What the catalogs say
// ---------------------------------------------------------------------------

test('no function in public carries EXECUTE for PUBLIC', async () => {
  // Two ways to hold it: proacl null, which IS the default and grants PUBLIC
  // EXECUTE, or an explicit entry for grantee 0.
  const leaky = await db.q(`
    select p.oid::regprocedure::text as signature,
           coalesce(p.proacl::text, 'default (PUBLIC EXECUTE)') as acl
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and ${NOT_FROM_AN_EXTENSION}
      and (
        p.proacl is null
        or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
      )
    order by 1
  `);

  assert.deepEqual(
    leaky,
    [],
    `these functions are callable by anon: ${leaky.map((r) => `${r.signature} ${r.acl}`).join(', ')}`,
  );
});

test('anon may execute the check-in and portal surfaces and nothing else', async () => {
  // has_function_privilege rather than a scan of proacl, because it accounts
  // for a grant to PUBLIC as well as one to anon. Assertion 1 above is what
  // keeps the PUBLIC half empty; this one would still be correct without it.
  const rows = await db.q(`
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and ${NOT_FROM_AN_EXTENSION}
      and has_function_privilege('anon', p.oid, 'EXECUTE')
    order by 1
  `);

  // Both directions. A function that leaks fails, and so does one that was
  // revoked without anybody noticing the check-in page needs it.
  assert.deepEqual(rows.map((r) => r.signature), ANON_MAY_EXECUTE);
});

test('anon holds no privilege on any table, view or sequence', async () => {
  // Not "a policy denies it": no grant at all, which is the sentence the
  // README's security paragraph makes.
  const relations = await db.q(`
    select c.relname, c.relkind, a.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and a.grantee in (0, 'anon'::regrole::oid)
      and not exists (
        select 1 from pg_depend d
        where d.objid = c.oid
          and d.classid = 'pg_class'::regclass
          and d.deptype = 'e'
      )
    order by c.relname, a.privilege_type
  `);

  assert.deepEqual(
    relations,
    [],
    `anon was granted: ${relations.map((r) => `${r.relname}.${r.privilege_type}`).join(', ')}`,
  );
});

test('every SECURITY DEFINER function pins its search_path', async () => {
  // A definer function runs with the owner's rights. Without a pinned
  // search_path a caller can put a table of their own in front of `profiles`
  // and have the function read it, which is how fn_current_role() would be
  // talked into returning 'admin'.
  const unpinned = await db.q(`
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and ${NOT_FROM_AN_EXTENSION}
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
        where c like 'search_path=%'
      )
    order by 1
  `);

  assert.deepEqual(
    unpinned,
    [],
    `SECURITY DEFINER with an unpinned search_path: ${unpinned.map((r) => r.signature).join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// The NULL role
// ---------------------------------------------------------------------------

/**
 * Every officer or admin RPC, called in a way that reaches its role check.
 *
 * The arguments are deliberately ones that would otherwise be accepted, so a
 * caller who gets past the assertion does real work rather than tripping over
 * a validation error a moment later and looking refused. review_records and
 * merge_members carry real ids for the same reason: see the writes asserted
 * below.
 */
function officerRpcs() {
  return [
    ['review_records', `select review_records($1::uuid[], 'approve', null)`, [[]]],
    ['resolve_unmatched', `select resolve_unmatched($1::uuid, null, null)`, [null]],
    ['merge_members', `select merge_members($1::uuid, $2::uuid)`, [MEMBERS.dorian, MEMBERS.ada]],
    ['purge_evidence', `select purge_evidence(null, null)`, []],
    ['purge_orphaned_uploads', `select purge_orphaned_uploads()`, []],
    ['fn_purge_preview', `select * from fn_purge_preview(null)`, []],
    ['fn_storage_usage', `select * from fn_storage_usage()`, []],
    [
      'finish_purge_run',
      `select * from finish_purge_run($1::uuid, $2::text[])`,
      ['00000000-0000-4000-a000-000000000000', []],
    ],
    ['clone_requirement_set', `select clone_requirement_set($1::uuid)`, [REQ_SET]],
    ['publish_requirement_set', `select publish_requirement_set($1::uuid)`, [REQ_SET]],
    ['validate_requirement_set', `select * from validate_requirement_set($1::uuid)`, [REQ_SET]],
    ['preview_requirement_set', `select * from preview_requirement_set($1::uuid)`, [REQ_SET]],
  ];
}

test('an account with no profiles row is refused by every officer RPC', async () => {
  // THE FINDING. fn_current_role() selects no row for this user, so
  // fn_is_officer() is NULL, and `if not NULL` does not raise. Before
  // migration 16 this caller walked into nine SECURITY DEFINER functions
  // running with the owner's rights.
  //
  // Anyone who completes a magic-link sign-in with the anon key holds an
  // authenticated JWT, and nothing creates a profiles row for them, so this is
  // the state a brand new account is in rather than a contrived one.
  assert.equal(
    await db.val(`select count(*)::int from profiles where user_id = $1`, [NO_PROFILE]),
    0,
    'the account this test is about now has a role, so it proves nothing',
  );

  for (const [name, sql, params] of officerRpcs()) {
    await db.as('authenticated', NO_PROFILE);
    const err = await db.expectError(sql, params);
    await db.asOwner();
    assert.equal(err.code, 'PDS07', `${name} did not refuse an account with no role: ${err.message}`);
  }
});

test('nothing an account with no profiles row asked for was written', async () => {
  // The two calls above that would have changed something. review_records
  // approves, which is the one that matters most: approving is the decision
  // the design says a person makes, and this caller is not one.
  const pending = (
    await db.q(
      `select id from attendance_records where member_id = $1 and status = 'pending' order by id`,
      [MEMBERS.hamish],
    )
  ).map((row) => row.id);
  assert.ok(pending.length > 0, 'the fixture no longer has a pending record to try to approve');

  await db.as('authenticated', NO_PROFILE);
  const approve = await db.expectError(`select review_records($1::uuid[], 'approve', 'mine now')`, [
    pending,
  ]);
  const merge = await db.expectError(`select merge_members($1::uuid, $2::uuid)`, [
    MEMBERS.dorian,
    MEMBERS.ada,
  ]);
  await db.asOwner();

  assert.equal(approve.code, 'PDS07');
  assert.equal(merge.code, 'PDS07');

  const statuses = await db.q(
    `select distinct status from attendance_records where id = any($1::uuid[])`,
    [pending],
  );
  assert.deepEqual(statuses, [{ status: 'pending' }], 'a record was approved by nobody');
  assert.equal(
    await db.val(`select merged_into_id from members where id = $1`, [MEMBERS.dorian]),
    null,
    'a member was merged away by an account with no role',
  );
});

test('an officer still gets through the same assertions', async () => {
  // The other half of the change. Refusing an indeterminate role is only
  // correct if a determinate one still passes, and fn_assert_officer() and
  // fn_assert_admin() keep their grants across `create or replace`.
  await db.as('authenticated', USERS.officer);
  assert.equal(await db.val(`select review_records(array[]::uuid[], 'approve', null)`), 0);
  const problems = await db.q(`select * from validate_requirement_set($1::uuid)`, [REQ_SET]);
  await db.asOwner();

  assert.ok(Array.isArray(problems));

  // A member account is still refused, which is the case that always worked.
  await db.as('authenticated', USERS.adaAccount);
  const asMember = await db.expectError(`select review_records(array[]::uuid[], 'approve', null)`);
  await db.asOwner();
  assert.equal(asMember.code, 'PDS07');
});
