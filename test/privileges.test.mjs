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
// WHICH HALF OF THIS FILE COVERS THE FUTURE, AND WHICH HALF IS A LIST.
//
// The four catalog assertions are written against pg_proc and pg_class rather
// than against any list of migrations, so a function added next year is
// covered by them on the day it is created: it either carries PUBLIC EXECUTE
// or it does not, it either pins search_path or it does not.
//
// The shared-session assertion below verifies that authenticated callers reach
// the admin RPC surface without an application profile or role lookup.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, REQ_SET } from './helpers/fixture.mjs';

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
// PORTAL_ATTENDANCE(UUID) IS A SECOND, LATER WIDENING (migrations 23 and 25), and it is
// worth being honest about what it opens rather than folding it quietly into
// the sentence above. Migration 21 deliberately withheld a member's own
// check-in history: "the individual records are the part an officer needs and
// a stranger does not." The club asked for that reversed, because the
// spreadsheet this product replaces showed a member every event of the year
// and whether they made it, and a point total alone cannot answer that. So this
// function hands back, for one member, every published event of this year once,
// with actual start and end instants, attended, waiting, declined, upcoming or
// nothing, and all category credits grouped on that event. Migration 25 removes
// Location and adds the same public scorecard payload inside the response, so
// exports use one database statement snapshot instead of mixing two requests.
// It still carries none of an officer's context: no decline reason, no flags,
// no reviewer, no reviewed timestamp, no check-in window, no photo, no other
// member. That boundary is asserted in test/public_portal.test.mjs, the same as
// the other four.
//
// PORTAL_ATTENDANCE(UUID) WIDENS ONCE MORE, PRECISELY, in migration 29 (the
// same one that adds portal_events() below). "Every published event of the
// year" above stopped being quite true: a member's own attendance on an
// event that has already happened is now visible even when that event has
// never been published or auto-released, because v_attendance_credit,
// v_member_category_totals and v_member_status never gated on publish state
// in the first place, so an invisible event's points were already counting
// toward that member's total with no row anywhere to explain them. This is
// bounded to PAST events on purpose and is not "every event I have a
// record against": check-in has no gate on occurred_on, this function is
// callable by anonymous id, and portal_leaderboard() hands out every member
// id there is, so an unbounded exception would let a stranger read a
// future, unannounced event off of whoever already checked into it, ahead
// of the Monday drop. A future event a member checked into stays hidden
// from everyone, including that member, until its own date passes. That
// boundary is asserted in test/events_page.test.mjs.
//
// PORTAL_EVENTS() IS A THIRD WIDENING (migration 29, docs/05-events-page.md),
// and it goes further than any function above it: no member id, no name, no
// login at all. It is the public /events page, and it hands anyone who opens
// the site every published-and-visible event of the year that has not
// happened yet, with location, attire, a sign-up link or line, and a
// member-facing description alongside the fields portal_attendance() already
// exposes. What makes that safe is what it still refuses: no member, no
// attendance status, no events.notes (the officer-side field this is
// deliberately not reused for), no checkin_token, and no event that is not
// published or has not been dropped by the Monday auto-publish rule. That
// boundary is asserted in test/events_page.test.mjs.
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
  'portal_events()',
  'portal_find_members(text)',
  'portal_leaderboard()',
  'portal_requirements()',
  'portal_scorecard(uuid)',
  'search_members(text,text,text)',
  'submit_checkin(text,uuid,text,text,numeric,jsonb,text)',
];

const SHARED_ADMIN = '99999999-0000-4000-a000-0000000000f9';
const DELETE_EVENT = '22222222-0000-4000-a000-00000000de1e';
const CATEGORY_GBMS = 'c0000000-0000-4000-a000-000000000001';

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

  // Register the fixed shared identity so audit foreign keys accept it.
  await db.exec(`
    insert into auth.users (id, email)
    values ('${SHARED_ADMIN}', 'officers@pdsaucf.com')
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

test('authenticated event configuration writes exist only behind the RPC', async () => {
  const privileges = await db.q(`
    select c.relname,
           has_table_privilege('authenticated', c.oid, 'SELECT') as can_select,
           has_table_privilege('authenticated', c.oid, 'INSERT') as can_insert,
           has_table_privilege('authenticated', c.oid, 'UPDATE') as can_update,
           has_table_privilege('authenticated', c.oid, 'DELETE') as can_delete
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('events', 'event_categories', 'event_evidence_requirements')
    order by c.relname
  `);

  assert.deepEqual(privileges, [
    {
      relname: 'event_categories',
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    },
    {
      relname: 'event_evidence_requirements',
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    },
    {
      relname: 'events',
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: true,
    },
  ]);

  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token)
    values ('${DELETE_EVENT}', 'a0000000-0000-4000-a000-000000000001',
            'Delete Through Narrow Grant', current_date, 'tok-delete-narrow');
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${DELETE_EVENT}', '${CATEGORY_GBMS}', 'fixed', 1);
    insert into event_evidence_requirements (event_id, kind, is_required)
    values ('${DELETE_EVENT}', 'shirt_photo', true);
  `);

  await db.as('authenticated', SHARED_ADMIN);
  const insertError = await db.expectError(
    `insert into events (academic_year_id, title, occurred_on)
     values ('a0000000-0000-4000-a000-000000000001', 'Direct Refused', current_date)`,
  );
  const updateError = await db.expectError(
    `update events set title = 'Direct Refused' where id = $1`,
    [DELETE_EVENT],
  );
  const childError = await db.expectError(
    `update event_categories set fixed_credit = 9 where event_id = $1`,
    [DELETE_EVENT],
  );
  assert.equal(insertError.code, '42501');
  assert.equal(updateError.code, '42501');
  assert.equal(childError.code, '42501');

  assert.equal(
    (await db.q(`delete from events where id = $1 returning id`, [DELETE_EVENT])).length,
    1,
    'the event detail delete path lost its narrow grant',
  );
  await db.asOwner();
  assert.equal(
    Number(await db.val(`select count(*) from event_categories where event_id = $1`, [DELETE_EVENT])),
    0,
    'the retained event delete did not cascade to category links',
  );
  assert.equal(
    Number(
      await db.val(
        `select count(*) from event_evidence_requirements where event_id = $1`,
        [DELETE_EVENT],
      ),
    ),
    0,
    'the retained event delete did not cascade to evidence requirements',
  );
});

test('every SECURITY DEFINER function pins its search_path', async () => {
  // A definer function runs with the owner's rights. A pinned search path keeps
  // callers from substituting attacker-controlled objects for trusted ones.
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

test('the shared authenticated session reaches the admin RPCs', async () => {
  await db.as('authenticated', SHARED_ADMIN);
  assert.equal(await db.val(`select review_records(array[]::uuid[], 'approve', null)`), 0);
  const problems = await db.q(`select * from validate_requirement_set($1::uuid)`, [REQ_SET]);
  await db.asOwner();

  assert.ok(Array.isArray(problems));

});
