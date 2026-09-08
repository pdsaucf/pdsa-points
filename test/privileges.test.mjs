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
// Role tests below check shared-session compatibility and the per-user
// boundary, including direct RLS writes and every admin RPC refusal.

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

// Separate identities: the historical fixture's USERS.officer is the shared
// passcode account and must not stand in for a restricted officer here.
const ROLE_OFFICER = '99999999-0000-4000-a000-0000000000e1';
const ROLE_ADMIN = '99999999-0000-4000-a000-0000000000e2';
const ROLELESS = '99999999-0000-4000-a000-0000000000e3';
const ROLE_VIEWER = '99999999-0000-4000-a000-0000000000e4';
const ROLE_MEMBER = '99999999-0000-4000-a000-0000000000e5';
const ROLE_EVENT = '22222222-0000-4000-a000-0000000000e1';
const ROLE_YEAR = 'a0000000-0000-4000-a000-000000000001';

async function roleFixture() {
  await db.asOwner();
  await db.exec(`
    insert into auth.users(id,email) values
      ('${ROLE_OFFICER}','director@example.test'),
      ('${ROLE_ADMIN}','secretary@example.test'),
      ('${ROLELESS}','stranger@example.test'),
      ('${ROLE_VIEWER}','unused-viewer@example.test'),
      ('${ROLE_MEMBER}','unused-member@example.test') on conflict do nothing;
    insert into auth.identities(user_id,provider,provider_id,identity_data) values
      ('${ROLE_OFFICER}','google','role-officer-sub','{"email":"director@example.test","email_verified":true}'),
      ('${ROLE_ADMIN}','google','role-admin-sub','{"email":"secretary@example.test","email_verified":true}')
      on conflict(provider_id,provider) do nothing;
    insert into leadership_access(email,role,user_id,google_subject,bound_at) values
      ('director@example.test','officer','${ROLE_OFFICER}','role-officer-sub',now()),
      ('secretary@example.test','admin','${ROLE_ADMIN}','role-admin-sub',now())
      on conflict(email) do update set role=excluded.role, revoked_at=null;
    insert into profiles(user_id,role) values
      ('${ROLE_OFFICER}','officer'), ('${ROLE_ADMIN}','admin'),
      ('${ROLE_VIEWER}','viewer'), ('${ROLE_MEMBER}','member')
      on conflict(user_id) do update set role=excluded.role;
  `);
}

const ADMIN_CALLS = [
  `review_records(array[]::uuid[], 'approve', null)`,
  `add_officer_attendance(null, array[]::uuid[], null)`,
  `add_officer_attendance_batch(null, '[]'::jsonb, null)`,
  `remove_attendance_record(null)`,
  `recover_officer_attendance_batch(null, 'refusal-test')`,
  `resolve_unmatched(null, null, '{}'::jsonb)`,
  `merge_members(null, null)`,
  `validate_requirement_set('${REQ_SET}')`,
  `preview_requirement_set('${REQ_SET}')`,
  `clone_requirement_set('${REQ_SET}')`,
  `publish_requirement_set('${REQ_SET}')`,
  `purge_evidence(12, null)`,
  `purge_orphaned_uploads()`,
  `finish_purge_run(null, array[]::text[])`,
  `upsert_member_and_enroll('Denied', 'Person', null, null, null, null)`,
  `upsert_members_and_enroll('[]'::jsonb, null)`,
  `link_retroactive_matches(null, array[]::uuid[])`,
  `dismiss_duplicate_pair(null, null)`,
  `list_leadership_access()`,
  `authorize_leadership_access('refused@example.test', 'officer')`,
  `set_leadership_role(null, 'officer')`,
  `revoke_leadership_access(null)`,
  `list_leadership_audit()`,
];

test('profile roles fail closed and the shared passcode needs no profile', async () => {
  await roleFixture();
  for (const [user, expected] of [
    [SHARED_ADMIN, [true, true, true]], [ROLE_ADMIN, [true, true, true]],
    [ROLE_OFFICER, [false, true, true]], [ROLELESS, [false, false, false]],
    [ROLE_VIEWER, [false, false, false]], [ROLE_MEMBER, [false, false, false]],
    [null, [false, false, false]],
  ]) {
    await db.as('authenticated', user);
    assert.deepEqual(Object.values(await db.one(
      'select fn_is_admin() a, fn_is_officer() o, fn_is_staff() s',
    )), expected, `role predicates for ${user}`);
  }
  await db.asOwner();
  assert.equal(await db.val('select count(*)::int from profiles where user_id=$1', [SHARED_ADMIN]), 0);
});

test('officer, roleless, unused roles and JWT-less authenticated calls cannot use any admin RPC', async () => {
  await roleFixture();
  for (const user of [ROLE_OFFICER, ROLELESS, ROLE_VIEWER, ROLE_MEMBER, null]) {
    await db.as('authenticated', user);
    for (const call of ADMIN_CALLS) {
      const error = await db.expectError(`select * from ${call}`);
      assert.equal(error.code, 'PDS07', `${user}: ${call}: ${error.message}`);
    }
  }
});

test('officers cannot grant themselves admin, assign anyone else, or delete profiles', async () => {
  await roleFixture();
  await db.as('authenticated', ROLE_OFFICER);
  assert.equal((await db.q('select * from profiles')).length, 1);
  assert.equal((await db.expectError("update profiles set role='admin' where user_id=$1", [ROLE_OFFICER])).code, '42501');
  assert.equal((await db.expectError('delete from profiles')).code, '42501');
  assert.equal((await db.expectError("insert into profiles(user_id,role) values($1,'admin')", [ROLELESS])).code, '42501');
  await db.as('authenticated', ROLELESS);
  assert.equal((await db.expectError("insert into profiles(user_id,role) values($1,'admin')", [ROLELESS])).code, '42501');
  await db.as('authenticated', ROLE_ADMIN);
  assert.equal((await db.expectError("update profiles set role='officer' where user_id=$1", [ROLE_OFFICER])).code, '42501');
  const accessId = (await db.q('select * from list_leadership_access()')).find(row => row.user_id === ROLE_OFFICER).id;
  await db.q("select set_leadership_role($1,'officer')", [accessId]);
  assert.equal(await db.val("select review_records(array[]::uuid[], 'approve', null)"), 0);
  assert.ok(Array.isArray(await db.q('select * from validate_requirement_set($1)', [REQ_SET])));
  await db.asOwner();
  await db.q('delete from profiles where user_id=$1', [ROLE_OFFICER]);
  await db.as('authenticated', ROLE_OFFICER);
  assert.equal(await db.val('select fn_is_staff()'), false, 'revocation takes effect without a new JWT');
  assert.equal((await db.expectError('select set_event_published($1,true)', [ROLE_EVENT])).code, 'PDS07');
});

test('officers create, edit, duplicate and publish events through the existing RPC boundary', async () => {
  await roleFixture();
  await db.as('authenticated', ROLE_OFFICER);
  const event = {title: 'Officer Event', occurred_on: '2026-09-15'};
  const categories = [{category_id: CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 1}];
  const evidence = {kind: 'shirt_photo', prompt: 'Photo'};
  const save = (id, config, version, create) => db.val(
    'select save_event_config($1,$2,$3,$4,$5,$6,$7)',
    [id, ROLE_YEAR, config, categories, evidence, version, create],
  );
  const created = await save(ROLE_EVENT, event, null, true);
  assert.equal(created.created, true);
  assert.ok(created.checkin_token);
  const edited = await save(ROLE_EVENT, {...event, title: 'Officer Edited'}, created.config_version, false);
  assert.ok(edited.config_version > created.config_version);
  const duplicate = '22222222-0000-4000-a000-0000000000e2';
  assert.equal((await save(duplicate, {...event, title: 'Officer Copy'}, null, true)).created, true);
  await db.q('select set_event_published($1,true)', [ROLE_EVENT]);
  assert.equal(await db.val('select is_published from events where id=$1', [ROLE_EVENT]), true);
  await db.q('select set_event_published($1,false)', [ROLE_EVENT]);
  assert.equal(await db.val('select is_published from events where id=$1', [ROLE_EVENT]), false);
  assert.equal((await db.expectError("update events set title='Bypass' where id=$1", [ROLE_EVENT])).code, '42501');
  assert.equal((await db.expectError('update event_categories set fixed_credit=999 where event_id=$1', [ROLE_EVENT])).code, '42501');
  assert.equal((await db.expectError('delete from event_evidence_requirements where event_id=$1', [ROLE_EVENT])).code, '42501');
  assert.equal((await db.q('delete from events where id=$1 returning id', [duplicate])).length, 1);
  const attended = '22222222-0000-4000-a000-000000000001';
  const before = await db.val('select count(*)::int from attendance_records where event_id=$1', [attended]);
  assert.ok(before > 0);
  assert.equal((await db.expectError('delete from events where id=$1', [attended])).code, '23001');
  assert.equal(await db.val('select count(*)::int from attendance_records where event_id=$1', [attended]), before);
});

test('officer settings reads preserve computed visibility when auto-publish is disabled', async () => {
  await roleFixture();
  await db.q("update app_settings set value='false'::jsonb where key='events_auto_publish'");
  // Simulate a drop that has already happened without changing server time.
  await db.exec('alter table events disable trigger events_release_at_before_update');
  try {
    await db.q("update events set release_at=now()-interval '1 day', is_published=false where id=$1", [ROLE_EVENT]);
  } finally {
    await db.exec('alter table events enable trigger events_release_at_before_update');
  }
  try {
    await db.as('authenticated', ROLE_OFFICER);
    assert.equal(await db.val("select fn_setting_bool('events_auto_publish',true)"), false);
    assert.equal(await db.val('select is_visible(e) from events e where id=$1', [ROLE_EVENT]), false);
    assert.deepEqual(await db.q("update app_settings set value='true'::jsonb where key='events_auto_publish' returning key"), []);
    assert.deepEqual(await db.q("delete from app_settings where key='events_auto_publish' returning key"), []);
    assert.equal((await db.expectError("insert into app_settings(key,value) values('officer-bypass','true')")).code, '42501');
    await db.as('authenticated', ROLE_ADMIN);
    await db.q("update app_settings set value='true'::jsonb where key='events_auto_publish'");
    await db.as('authenticated', ROLE_OFFICER);
    assert.equal(await db.val('select is_visible(e) from events e where id=$1', [ROLE_EVENT]), true);
  } finally {
    await db.asOwner();
    await db.q("update app_settings set value='true'::jsonb where key='events_auto_publish'");
  }
});

test('officers read the club but direct writes to roster, attendance, categories, rules and calendar are refused', async () => {
  await roleFixture();
  // A real draft is essential: published-tree immutability alone would mask
  // an officer write policy accidentally left open.
  await db.as('authenticated', ROLE_ADMIN);
  const draft = await db.val('select clone_requirement_set($1)', [REQ_SET]);
  await db.asOwner();
  const tables = [
    'members', 'member_enrollments', 'attendance_records', 'categories',
    'requirement_sets', 'requirement_nodes', 'requirement_node_categories',
    'academic_years', 'terms',
  ];
  for (const table of tables) {
    await db.asOwner();
    const columns = (await db.q(`select attname from pg_attribute
      where attrelid=$1::regclass and attnum>0 and not attisdropped and attgenerated=''
      order by attnum`, [table])).map(r => r.attname);
    const count = await db.val(`select count(*)::int from ${table}`);
    assert.ok(count > 0, `${table} test requires existing rows`);
    await db.as('authenticated', ROLE_OFFICER);
    assert.equal(await db.val(`select count(*)::int from ${table}`), count, `${table} staff read`);
    assert.equal((await db.expectError(
      `insert into ${table} (${columns.join(',')}) select ${columns.join(',')} from ${table} limit 1`,
    )).code, '42501', `${table} insert must be RLS, not a duplicate-key failure`);
    assert.deepEqual(await db.q(`update ${table} set ${columns[0]}=${columns[0]} returning 1`), [], `${table} update`);
    assert.deepEqual(await db.q(`delete from ${table} returning 1`), [], `${table} delete`);
    await db.asOwner();
    assert.equal(await db.val(`select count(*)::int from ${table}`), count, `${table} unchanged`);
  }
  await db.as('authenticated', ROLE_OFFICER);
  assert.ok((await db.q("select id from attendance_records where status='pending'")).length > 0);
  assert.ok((await db.q('select * from v_member_status')).length > 0);
  assert.ok(Array.isArray(await db.q('select * from fn_duplicate_member_pairs()')));
  await db.asOwner();
  assert.equal(await db.val('select status from requirement_sets where id=$1', [draft]), 'draft');
});

test('officers cannot read evidence metadata or storage bytes, or replace/delete known photo paths', async () => {
  await roleFixture();
  const record = await db.val('select id from attendance_records limit 1');
  const path = 'roles-test/evidence.jpg';
  await db.q(`insert into attendance_evidence(attendance_record_id,kind,object_path,drive_file_id)
    values($1,'shirt_photo',$2,'private-archive-id')`, [record, path]);
  await db.q("insert into storage.objects(bucket_id,name) values('evidence',$1)", [path]);
  assert.equal(await db.val("select public from storage.buckets where id='evidence'"), false);
  await db.as('authenticated', ROLE_OFFICER);
  assert.deepEqual(await db.q('select * from attendance_evidence'), []);
  assert.deepEqual(await db.q("select * from storage.objects where bucket_id='evidence' and name=$1", [path]), []);
  assert.deepEqual(await db.q('delete from attendance_evidence returning id'), []);
  assert.deepEqual(await db.q('update attendance_evidence set object_path=null returning id'), []);
  assert.equal((await db.expectError(`insert into attendance_evidence(attendance_record_id,kind,object_path)
    values($1,'shirt_photo',$2)`, [record,path])).code, '42501');
  assert.deepEqual(await db.q("delete from storage.objects where name=$1 returning id", [path]), []);
  assert.deepEqual(await db.q("update storage.objects set name='replacement' where name=$1 returning id", [path]), []);
  assert.equal((await db.expectError("insert into storage.objects(bucket_id,name) values('evidence',$1)", [path])).code, '42501');
  // Storage statistics expose aggregates only, never signed URLs or paths.
  assert.deepEqual(Object.keys(await db.one('select * from fn_storage_usage()')).sort(),
    ['bytes_held','orphaned_count','percent_used','photo_count','quota_bytes','warn_percent']);
  for (const user of [ROLE_ADMIN, SHARED_ADMIN]) {
    await db.as('authenticated', user);
    assert.equal((await db.q('select object_path from attendance_evidence where object_path=$1', [path])).length, 1);
    assert.equal((await db.q("select name from storage.objects where name=$1", [path])).length, 1);
  }
  await db.as('authenticated', ROLE_ADMIN);
  assert.equal((await db.q("delete from storage.objects where name=$1 returning id", [path])).length, 1);
});

test('roleless and unused-role accounts cannot read internal tables or invoke event operations', async () => {
  await roleFixture();
  const tables = (await db.q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relrowsecurity
      and has_table_privilege('authenticated',c.oid,'SELECT') order by 1`)).map(r => r.relname);
  for (const user of [ROLELESS, ROLE_VIEWER, ROLE_MEMBER]) {
    await db.as('authenticated', user);
    for (const table of tables.filter(t => t !== 'profiles')) {
      assert.deepEqual(await db.q(`select * from ${table}`), [], `${user}: ${table}`);
    }
    assert.equal((await db.expectError('select set_event_published($1,true)', [ROLE_EVENT])).code, 'PDS07');
    assert.equal((await db.expectError('select save_event_config(null,null,null)')).code, 'PDS07');
  }
});

async function googleUser(suffix, email, provider = 'google', verified = true) {
  await db.asOwner();
  const user = `99999999-0000-4000-a000-00000000${suffix}`;
  await db.q('insert into auth.users(id,email) values($1,$2)', [user, email]);
  await db.q(`insert into auth.identities(user_id,provider_id,provider,identity_data)
    values($1,$2,$3,$4)`, [user, `google-${suffix}`, provider, {email, email_verified: verified}]);
  return user;
}

async function approve(email, role = 'officer') {
  await db.as('authenticated', SHARED_ADMIN);
  return db.val('select authorize_leadership_access($1,$2)', [email, role]);
}

test('leadership approval binds only its verified Google identity and never member records', async () => {
  await roleFixture();
  const user = await googleUser('d001', 'new.director@example.test');
  const membersBefore = await db.val('select count(*)::int from members');
  await db.as('authenticated', user);
  assert.deepEqual(await db.val('select leadership_session()'), {
    role: null, is_shared_admin: false, email: 'new.director@example.test',
  });
  const approved = await approve('  NEW.DIRECTOR@example.test  ');
  assert.equal(approved.email, 'new.director@example.test');
  assert.equal(approved.user_id, null);
  await db.as('authenticated', user);
  assert.equal((await db.val('select leadership_session()')).role, 'officer');
  assert.equal(await db.val('select fn_is_officer()'), true);
  assert.equal((await db.expectError("select review_records('{}','approve',null)")).code, 'PDS07');
  await db.asOwner();
  assert.equal(await db.val('select user_id from leadership_access where id=$1', [approved.id]), user);
  assert.equal(await db.val('select count(*)::int from members'), membersBefore);
});

test('editable user metadata, non-Google or unverified identities and legacy profiles cannot grant access', async () => {
  await roleFixture();
  for (const [suffix, provider, verified] of [
    ['d002','email',true], ['d003','github',true], ['d004','google',false], ['d005','google','true'],
  ]) {
    const email = `${suffix}@example.test`;
    const user = await googleUser(suffix,email,provider,verified);
    await approve(email,'admin');
    await db.asOwner();
    await db.q(`update auth.users set raw_user_meta_data=$2 where id=$1`,
      [user,{email,email_verified:true,provider:'google',role:'admin'}]);
    await db.q("insert into profiles(user_id,role) values($1,'admin')", [user]);
    await db.as('authenticated',user);
    assert.equal((await db.val('select leadership_session()')).role,null);
    assert.equal(await db.val('select fn_is_admin()'),false);
    assert.equal((await db.expectError('select * from list_leadership_access()')).code,'PDS07');
    assert.equal((await db.expectError("update auth.identities set identity_data='{}'::jsonb")).code,'42501');
  }
});

test('approval is bound to one user and subject, and revocation takes effect on the existing session', async () => {
  await roleFixture();
  const email = 'stable.binding@example.test';
  const original = await googleUser('d006',email);
  const approved = await approve(email);
  await db.as('authenticated',original);
  assert.equal((await db.val('select leadership_session()')).role,'officer');
  const impostor = await googleUser('d007',email);
  await db.as('authenticated',impostor);
  assert.equal((await db.val('select leadership_session()')).role,null);
  await db.as('authenticated',SHARED_ADMIN);
  await db.q('select revoke_leadership_access($1)',[approved.id]);
  await db.as('authenticated',original);
  assert.equal(await db.val('select fn_is_staff()'),false, 'same JWT immediately loses access');
  assert.equal((await db.val('select leadership_session()')).role,null, 'no automatic reapproval');
  assert.equal((await db.expectError('select set_event_published($1,true)',[ROLE_EVENT])).code,'PDS07');
  await approve(email);
  await db.as('authenticated',impostor);
  assert.equal((await db.val('select leadership_session()')).role,null, 'restore retains original binding');
  await db.as('authenticated',original);
  assert.equal((await db.val('select leadership_session()')).role,'officer');
  await db.asOwner();
  await db.q("update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','false') where user_id=$1",[original]);
  await db.as('authenticated',original);
  assert.equal(await db.val('select fn_is_staff()'),false, 'provider verification is checked on each protected call');
});

test('leadership last-admin guard excludes shared fallback and pending approvals', async () => {
  await roleFixture();
  const soleAdmin = await db.val('select id from leadership_access where user_id=$1',[ROLE_ADMIN]);
  await approve('pending.secretary@example.test','admin');
  await db.as('authenticated',SHARED_ADMIN);
  for (const call of [
    ['select revoke_leadership_access($1)',[soleAdmin]],
    ["select set_leadership_role($1,'officer')",[soleAdmin]],
    ["select authorize_leadership_access('secretary@example.test','officer')",[]],
  ]) assert.equal((await db.expectError(...call)).code,'PDS16');
  const second = await googleUser('d008','second.secretary@example.test');
  const access = await approve('second.secretary@example.test','admin');
  await db.as('authenticated',second);
  assert.equal((await db.val('select leadership_session()')).role,'admin');
  await db.q('select revoke_leadership_access($1)',[soleAdmin]);
  await db.as('authenticated',ROLE_ADMIN);
  assert.equal((await db.expectError('select revoke_leadership_access($1)',[access.id])).code,'PDS07');
  await db.as('authenticated',SHARED_ADMIN);
  assert.equal((await db.expectError('select revoke_leadership_access($1)',[access.id])).code,'PDS16');
  // Global lock must cover every route that can compete for the last admin.
  await db.asOwner();
  for (const name of ['leadership_session','authorize_leadership_access','set_leadership_role','revoke_leadership_access']) {
    const body = await db.val('select prosrc from pg_proc where proname=$1',[name]);
    assert.ok(body.includes('pg_advisory_xact_lock(721934, 1)'),name);
    if (name !== 'leadership_session') assert.ok(body.indexOf('pg_advisory_xact_lock') < body.indexOf('fn_assert_admin'),name);
  }
});

test('leadership tables and audit are admin RPC-only and ordinary staff audit carries no leadership email', async () => {
  await roleFixture();
  for (const user of [ROLE_OFFICER,ROLELESS,SHARED_ADMIN,ROLE_ADMIN]) {
    await db.as('authenticated',user);
    for (const table of ['leadership_access','leadership_audit']) {
      assert.equal((await db.expectError(`select * from ${table}`)).code,'42501');
      assert.equal((await db.expectError(`delete from ${table}`)).code,'42501');
    }
    assert.equal((await db.expectError("update profiles set role='admin'")).code,'42501');
  }
  await db.as('authenticated',ROLE_OFFICER);
  assert.equal((await db.expectError('select * from list_leadership_audit()')).code,'PDS07');
  const generalAudit = JSON.stringify(await db.q('select * from audit_log'));
  assert.equal(generalAudit.includes('stable.binding@example.test'),false);
  await db.as('authenticated',ROLE_ADMIN);
  const history = await db.q('select * from list_leadership_audit()');
  assert.ok(history.some(row => row.target_email==='stable.binding@example.test' && row.action==='revoke'));
  assert.ok(history.some(row => row.action==='bind'));
  assert.ok(history.every(row => row.actor_email));
  for (const [email,role] of [['bad-email','admin'],['officers@pdsaucf.com','admin'],['valid@example.test','viewer']]) {
    assert.equal((await db.expectError('select authorize_leadership_access($1,$2)',[email,role])).code,'PDS03');
  }
});

test('a stale bound admin cannot stand in for the last effective individual admin', async () => {
  await roleFixture();
  const adminId = await db.val('select id from leadership_access where user_id=$1',[ROLE_ADMIN]);
  // Remove provider verification from every other bound administrator. Their
  // approval rows still exist, but none could actually use an admin RPC.
  await db.q(`update auth.identities set identity_data=jsonb_set(identity_data,'{email_verified}','false')
    where user_id in (select user_id from leadership_access where role='admin' and user_id<>$1)`,[ROLE_ADMIN]);
  await db.as('authenticated',ROLE_ADMIN);
  assert.equal((await db.expectError('select revoke_leadership_access($1)',[adminId])).code,'PDS16');
  assert.equal((await db.expectError("select set_leadership_role($1,'officer')",[adminId])).code,'PDS16');
  await db.as('authenticated',SHARED_ADMIN);
  assert.equal((await db.val('select leadership_session()')).is_shared_admin,true);
});

test('officer-role migration resolves citext signatures when Supabase installs the extension outside public', async () => {
  const {PGlite} = await import('@electric-sql/pglite');
  const {citext} = await import('@electric-sql/pglite/contrib/citext');
  const {pg_trgm} = await import('@electric-sql/pglite/contrib/pg_trgm');
  const {pgcrypto} = await import('@electric-sql/pglite/contrib/pgcrypto');
  const {readFile} = await import('node:fs/promises');
  const {migrationFiles} = await import('./helpers/db.mjs');
  const isolated = new PGlite({extensions:{citext,pg_trgm,pgcrypto}});
  try {
    await isolated.exec(await readFile(new URL('./helpers/supabase_stub.sql',import.meta.url),'utf8'));
    for (const name of await migrationFiles()) {
      if (name==='20260905100000_officer_roles.sql') {
        await isolated.exec('create schema extensions; alter extension citext set schema extensions; set search_path=public');
      }
      await isolated.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'));
    }
    const result = await isolated.query(`select prosrc from pg_proc where proname='upsert_member_and_enroll'`);
    assert.match(result.rows[0].prosrc,/fn_is_admin\(\)/);
  } finally {
    await isolated.close();
  }
});

test('role promotion and demotion change RPC permissions for the same signed-in individual', async () => {
  await roleFixture();
  const accessId = await db.val('select id from leadership_access where user_id=$1',[ROLE_OFFICER]);
  await db.as('authenticated',ROLE_OFFICER);
  assert.equal(await db.val('select fn_is_admin()'),false);
  assert.equal((await db.expectError("select review_records('{}','approve',null)")).code,'PDS07');

  await db.as('authenticated',ROLE_ADMIN);
  await db.q("select set_leadership_role($1,'admin')",[accessId]);
  // Reuse the same JWT subject without leadership_session() or rebinding.
  await db.as('authenticated',ROLE_OFFICER);
  assert.equal(await db.val('select fn_is_admin()'),true);
  assert.equal(await db.val("select review_records('{}','approve',null)"),0);

  await db.as('authenticated',ROLE_ADMIN);
  await db.q("select set_leadership_role($1,'officer')",[accessId]);
  await db.as('authenticated',ROLE_OFFICER);
  assert.equal(await db.val('select fn_is_admin()'),false);
  assert.equal(await db.val('select fn_is_officer()'),true);
  assert.equal((await db.expectError("select review_records('{}','approve',null)")).code,'PDS07');
  await db.asOwner();
  assert.equal(await db.val('select role from profiles where user_id=$1',[ROLE_OFFICER]),'officer');
  assert.equal(await db.val('select role from leadership_access where id=$1',[accessId]),'officer');
});
