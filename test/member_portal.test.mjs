// The member portal, from the database down.
//
// docs/04-member-ui.md turns on one sentence: "a claim is what stops someone
// signing in as themselves and reading another member's record". Everything in
// this file exists to hold that sentence up, because the portal is the first
// surface in this system where an untrusted stranger arrives holding a valid
// `authenticated` JWT. Anyone can complete a magic-link sign-in. What they get
// afterwards is what migration 18 decides.
//
// So the properties asserted here are, in order of how much they would cost to
// get wrong:
//
//   * AN ACCOUNT IS LINKED TO A MEMBER BY EXACTLY TWO PATHS, and both are
//     narrow. Either the address on the roster row matches the address they
//     signed in with, which is the club's own record of who that person is, or
//     an officer looked at the claim and said yes. Nothing else writes
//     profiles.member_id, and neither path will move a link that already
//     exists or hand out a member somebody else already holds.
//   * A STRANGER READS NOTHING. Before the link, and after a declined claim,
//     the account has a profiles row and no data behind it.
//   * THE ROSTER STAYS SHUT. The claim search is the second name search in
//     this product, and like the first it returns names and ids and nothing
//     else, to a bounded population, at a bounded rate.
//   * NOBODY APPROVES THEMSELVES. A missing-credit request is a pending row in
//     the ordinary review queue carrying the member's own words, and it earns
//     credit only when an officer runs review_records() over it. That is
//     invariant 6, and it is the reason this is an RPC rather than an insert
//     policy.
//
// AND THE TWO REFUSALS EVERY NEW FUNCTION OWES. Migration 16 closed the gap
// where fn_is_officer() returned NULL rather than false for an account with no
// profiles row, and these are the first officer-facing functions written since.
// Every function added by migration 18 is therefore driven twice more: once as
// anon, which holds no EXECUTE grant at all, and once as a signed-in account
// with no profiles row. start_portal_session() is the single exception, and
// only in the second case: serving exactly that caller is its whole job.
//
// TWO GUARDS IN MIGRATION 18 ARE NOT EXERCISED BY ANYTHING BELOW, because
// reaching them needs two sessions interleaving and this harness has one
// connection. They are named, with the exact interleaving each one catches, in
// the block headed "WHAT THIS FILE CANNOT TEST" further down. That block is
// the honest version of coverage those two lines will never have here.
//
// THE ORDER OF THE TESTS IS PART OF THE FILE. A claim has a lifecycle, and
// asserting it means filing one, refusing a rival, approving it, and then
// finding the search and the file path closed afterwards. Tests below run in
// sequence against one database and each leaves the state the next one reads.

import test from 'node:test';
import assert from 'node:assert/strict';

import { attempt, inPinnedMinute } from './helpers/clock.mjs';
import { freshDb } from './helpers/db.mjs';
import { loadFixture, EVENTS, USERS, YEAR_2026 } from './helpers/fixture.mjs';
import { restoreTables, snapshotTables } from './helpers/settings.mjs';

const M = (n) => `77777777-0000-4000-a000-0000000000${n}`;
const U = (n) => `88888888-0000-4000-a000-0000000000${n}`;

// Five Marchettis, so one search for "marchetti" exercises every exclusion the
// claim list makes at once, and the Ashgroves for the link conflicts, kept
// under a different surname so they never show up in that search.
const CAST = {
  quillon: M('01'), // on the roster WITH an address: the auto-link path
  rosalind: M('02'), // no address, like all 355 imported members: the claim path
  sable: M('03'), // archived, and holding an address somebody signs in with
  tycho: M('04'), // merged into Quillon, so a tombstone rather than a person
  ulric: M('05'), // live and unclaimed throughout, the control
  vesper: M('06'), // claimed while somebody else is being linked to them
  winnifred: M('07'), // held by another profile from the start
  xenia: M('08'), // the member an account gets linked to behind a claim
  yolanda: M('09'), // holds the address of an account already linked elsewhere
  zephyr: M('10'), // who that account is actually linked to
  arden: M('11'), // archived while a claim on them sits in the queue
  bramwell: M('12'), // merged away while a claim on them sits in the queue
  cordelia: M('13'), // the survivor of that merge
  dorothea: M('14'), // claimed by a row inserted straight through the policy
  eglantine: M('15'), // claimed by an account that is already linked elsewhere
  fenwick: M('16'), // archived from the start, and claimed through the policy
  harriet: M('17'), // linked by hand while the claim on her was still pending
};

const ACCOUNTS = {
  match: U('01'), // signs in as Quillon.Marchetti@UCF.edu, in the wrong case
  stranger: U('02'), // matches nobody, claims Rosalind, gets approved
  rival: U('03'), // wants Rosalind too, then Vesper
  archived: U('04'), // matches Sable, who is archived
  officerless: U('05'), // an officer in real life, with no profiles row yet
  noProfile: U('06'), // never calls start_portal_session() at all
  mover: U('07'), // linked to Zephyr, signs in with Yolanda's address
  holder: U('08'), // holds Winnifred
  limiter: U('09'), // does nothing but exhaust its own search allowance
  retry: U('10'), // claims Ulric, is declined, and tries again
  waiting: U('11'), // claims Arden, who is archived before anyone answers
  patient: U('12'), // claims Bramwell, who is merged before anyone answers
  direct: U('13'), // inserts a claim through the policy, no session, no profile
  sneak: U('14'), // inserts a claim on somebody archived, through the policy
  settled: U('15'), // an admin links it by hand while its claim is pending
  wordy: U('16'), // tries to write more than the note column will hold
};

// Published events the fixture already carries, plus one that is not.
const UNPUBLISHED = '22222222-0000-4000-a000-0000000000b1';

// Config the rate-limit test lowers. Snapshotted once the fixture is built and
// put back after every test, so a lowered ceiling cannot leak into the next
// one. See helpers/settings.mjs for what that leak actually did once.
const SHARED_CONFIG = ['app_settings'];

let db;
let config;

const session = (userId) => db.withRole('authenticated', userId, () => db.val('select start_portal_session()'));

const searchAs = (userId, q) =>
  db.withRole('authenticated', userId, () => db.q('select * from search_roster_for_claim($1)', [q]));

const fileAs = (userId, memberId, note = null) =>
  db.withRole('authenticated', userId, () =>
    db.val('select file_member_claim($1::uuid, $2)', [memberId, note]),
  );

const reviewAs = (userId, claimId, decision, note = null) =>
  db.withRole('authenticated', userId, () =>
    db.val('select review_member_claim($1::uuid, $2, $3)', [claimId, decision, note]),
  );

const requestAs = (userId, eventId, note, value = null) =>
  db.withRole('authenticated', userId, () =>
    db.val('select request_missing_credit($1::uuid, $2, $3::numeric)', [eventId, note, value]),
  );

/** Drives one statement as one caller and hands back the error it raised. */
async function refusal(userId, sql, params = [], role = 'authenticated') {
  await db.as(role, userId);
  const err = await db.expectError(sql, params);
  await db.asOwner();
  return err;
}

const profileOf = (userId) =>
  db.q('select user_id, member_id, role from profiles where user_id = $1', [userId]);

const claimRow = (claimId) =>
  db.one('select status, note, review_note, reviewed_by, reviewed_at from member_claims where id = $1', [
    claimId,
  ]);

// Every function migration 18 added, with arguments that reach the guard being
// tested rather than tripping over validation on the way there.
function portalRpcs() {
  return [
    ['start_portal_session', 'select start_portal_session()', []],
    ['search_roster_for_claim', `select * from search_roster_for_claim('marchetti')`, []],
    ['file_member_claim', `select file_member_claim($1::uuid, 'me')`, [CAST.ulric]],
    ['review_member_claim', `select review_member_claim($1::uuid, 'approve', null)`, [CAST.ulric]],
    ['list_pending_claims', 'select * from list_pending_claims()', []],
    ['request_missing_credit', `select request_missing_credit($1::uuid, 'missing')`, [EVENTS.gbmSingle]],
  ];
}

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  await db.exec(`
    insert into members (id, first_name, last_name, email, archived_at, merged_into_id) values
      ('${CAST.quillon}',   'Quillon',   'Marchetti', 'quillon.marchetti@ucf.edu',  null,  null),
      ('${CAST.rosalind}',  'Rosalind',  'Marchetti', null,                         null,  null),
      ('${CAST.sable}',     'Sable',     'Marchetti', 'sable.marchetti@ucf.edu',    now(), null),
      ('${CAST.tycho}',     'Tycho',     'Marchetti', null,                         null,  '${CAST.quillon}'),
      ('${CAST.ulric}',     'Ulric',     'Marchetti', null,                         null,  null),
      ('${CAST.vesper}',    'Vesper',    'Ashgrove',  null,                         null,  null),
      ('${CAST.winnifred}', 'Winnifred', 'Ashgrove',  null,                         null,  null),
      ('${CAST.xenia}',     'Xenia',     'Ashgrove',  null,                         null,  null),
      ('${CAST.yolanda}',   'Yolanda',   'Ashgrove',  'yolanda.ashgrove@ucf.edu',   null,  null),
      ('${CAST.zephyr}',    'Zephyr',    'Ashgrove',  null,                         null,  null),
      ('${CAST.arden}',     'Arden',     'Ashgrove',  null,                         null,  null),
      ('${CAST.bramwell}',  'Bramwell',  'Ashgrove',  null,                         null,  null),
      ('${CAST.cordelia}',  'Cordelia',  'Ashgrove',  null,                         null,  null),
      ('${CAST.dorothea}',  'Dorothea',  'Ashgrove',  null,                         null,  null),
      ('${CAST.eglantine}', 'Eglantine', 'Ashgrove',  null,                         null,  null),
      ('${CAST.fenwick}',   'Fenwick',   'Ashgrove',  null,                         now(), null),
      ('${CAST.harriet}',   'Harriet',   'Ashgrove',  null,                         null,  null);

    insert into member_enrollments (member_id, academic_year_id)
    select id, '${YEAR_2026}' from members
    where id in ('${CAST.quillon}', '${CAST.rosalind}', '${CAST.ulric}', '${CAST.vesper}',
                 '${CAST.winnifred}', '${CAST.xenia}', '${CAST.yolanda}', '${CAST.zephyr}',
                 '${CAST.arden}', '${CAST.bramwell}', '${CAST.cordelia}',
                 '${CAST.dorothea}', '${CAST.eglantine}', '${CAST.harriet}');

    -- The address on the account is deliberately not the case the roster
    -- stores. members.email is citext, and docs/04 says the match is
    -- case-insensitive.
    insert into auth.users (id, email) values
      ('${ACCOUNTS.match}',       'Quillon.Marchetti@UCF.edu'),
      ('${ACCOUNTS.stranger}',    'nobody-here@example.test'),
      ('${ACCOUNTS.rival}',       'rival@example.test'),
      ('${ACCOUNTS.archived}',    'sable.marchetti@ucf.edu'),
      ('${ACCOUNTS.officerless}', 'officer-to-be@example.test'),
      ('${ACCOUNTS.noProfile}',   'never-started@example.test'),
      ('${ACCOUNTS.mover}',       'yolanda.ashgrove@ucf.edu'),
      ('${ACCOUNTS.holder}',      'holder@example.test'),
      ('${ACCOUNTS.limiter}',     'limiter@example.test'),
      ('${ACCOUNTS.retry}',       'retry@example.test'),
      ('${ACCOUNTS.waiting}',     'waiting@example.test'),
      ('${ACCOUNTS.patient}',     'patient@example.test'),
      ('${ACCOUNTS.direct}',      'direct@example.test'),
      ('${ACCOUNTS.sneak}',       'sneak@example.test'),
      ('${ACCOUNTS.settled}',     'settled@example.test'),
      ('${ACCOUNTS.wordy}',       'wordy@example.test');

    -- Two accounts that are already linked when the file starts, which is how
    -- an account looks the day after an officer confirmed it.
    insert into profiles (user_id, member_id, role) values
      ('${ACCOUNTS.mover}',   '${CAST.zephyr}',    'member'),
      ('${ACCOUNTS.holder}',  '${CAST.winnifred}', 'member'),
      ('${ACCOUNTS.limiter}', null,                'member');

    -- A published event is a precondition of a missing-credit request, so
    -- there has to be one that is not.
    insert into events (id, academic_year_id, term_id, title, occurred_on, checkin_token, is_published)
    values ('${UNPUBLISHED}', '${YEAR_2026}', null, 'Test Unpublished Draft',
            date '2026-12-05', 'tok-unpublished', false);
  `);

  config = await snapshotTables(db, SHARED_CONFIG);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.afterEach(async () => {
  await db?.asOwner();
  await restoreTables(db, config);
});

test.after(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// Getting in
// ---------------------------------------------------------------------------

test('an address on the roster links itself, in whatever case it was typed', async () => {
  // THE COMMON PATH once officers collect emails, and the reason docs/04 says
  // nobody waits for a confirmation in the ordinary case.
  const first = await session(ACCOUNTS.match);

  assert.equal(first.member_id, CAST.quillon);
  assert.equal(first.member_name, 'Quillon Marchetti');
  assert.equal(first.auto_linked, true);
  assert.equal(first.role, 'member');
  assert.equal(first.claim, null);

  assert.deepEqual(await profileOf(ACCOUNTS.match), [
    { user_id: ACCOUNTS.match, member_id: CAST.quillon, role: 'member' },
  ]);

  // The portal calls this on every load, so the second call has to be a read
  // that says the same thing rather than a write that says it again.
  const second = await session(ACCOUNTS.match);
  assert.equal(second.member_id, CAST.quillon);
  assert.equal(second.auto_linked, false, 'a second visit reported linking somebody again');

  assert.equal(
    await db.val(
      `select count(*)::int from audit_log
       where action = 'start_portal_session' and detail ->> 'member_id' = $1`,
      [CAST.quillon],
    ),
    1,
    'an audit row per page load, rather than one per thing that happened',
  );

  // And the link is worth having: the numbers come from the same view the
  // officer board reads.
  const status = await db.withRole('authenticated', ACCOUNTS.match, () =>
    db.q('select member_id, point_total, is_honorary from v_member_status'),
  );
  assert.deepEqual(
    status.map((r) => r.member_id),
    [CAST.quillon],
  );
});

test('an address that matches nobody gets a profile, a member role, and no data', async () => {
  const out = await session(ACCOUNTS.stranger);

  assert.equal(out.member_id, null);
  assert.equal(out.member_name, null);
  assert.equal(out.auto_linked, false);
  assert.equal(out.claim, null);

  // NOT `viewer`. The column default is viewer, and a viewer is read-only
  // STAFF: fn_is_staff() is true for them and the whole club is visible. This
  // is the assertion that catches somebody deleting the explicit role from the
  // insert and letting the default answer for a stranger.
  assert.equal(out.role, 'member');
  assert.equal(
    // Asked as them, because fn_is_staff() reads the role of whoever is
    // calling. Asked as the owner it answers about the owner.
    await db.withRole('authenticated', ACCOUNTS.stranger, () => db.val('select fn_is_staff()')),
    false,
  );

  // A profiles row is not access. Every member-scoped policy keys on
  // member_id, which is still null.
  const sees = await db.withRole('authenticated', ACCOUNTS.stranger, async () => ({
    members: await db.val('select count(*)::int from members'),
    records: await db.val('select count(*)::int from attendance_records'),
    status: await db.val('select count(*)::int from v_member_status'),
    totals: await db.val('select count(*)::int from v_member_category_totals'),
    claims: await db.val('select count(*)::int from member_claims'),
    profiles: await db.val('select count(*)::int from profiles'),
  }));

  assert.deepEqual(sees, {
    members: 0,
    records: 0,
    status: 0,
    totals: 0,
    claims: 0,
    profiles: 1, // their own row, through profiles_read_own
  });
});

test('an archived roster row is not linked to the account holding its address', async () => {
  // merge_members() and the archive path both leave the address on the row, so
  // last year's file still resolves to it. Neither is a person to hand an
  // account to.
  const out = await session(ACCOUNTS.archived);

  assert.equal(out.member_id, null, 'an archived member was linked to an account');
  assert.equal(out.auto_linked, false);
});

test('a role that already exists is never changed, and a link is never moved', async () => {
  for (const [userId, role] of [
    [USERS.officer, 'officer'],
    [USERS.admin, 'admin'],
    [USERS.viewer, 'viewer'],
  ]) {
    const out = await session(userId);
    assert.equal(out.role, role, `${role} came out of the portal as ${out.role}`);
    assert.equal(await db.val('select role from profiles where user_id = $1', [userId]), role);
  }

  // THE DELIBERATE ANSWER, stated in the function comment: an officer whose
  // account never got a profiles row comes out a member. They had no officer
  // rights to lose, because fn_current_role() was NULL, and an admin now
  // updates the role rather than inserting it.
  const bootstrapped = await session(ACCOUNTS.officerless);
  assert.equal(bootstrapped.role, 'member');

  // An account already linked to Zephyr, signing in with Yolanda's address.
  // Following the address would silently move which member this account reads.
  const mover = await session(ACCOUNTS.mover);
  assert.equal(mover.member_id, CAST.zephyr, 'an existing link was moved by an email match');
  assert.equal(mover.auto_linked, false);
  assert.equal(
    await db.val('select count(*)::int from profiles where member_id = $1', [CAST.yolanda]),
    0,
    'the member whose address matched was linked to somebody who was already spoken for',
  );
});

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

test('the claim search returns names only, and only to somebody who needs it', async () => {
  const rows = await searchAs(ACCOUNTS.stranger, 'marchetti');

  // Quillon is linked, Sable is archived, Tycho is a merge tombstone. What is
  // left is what can actually be claimed.
  //
  // Sorted, because WHO is on the list is this file's business and the order
  // they arrive in is search_members()' ranking, which test/rpcs.test.mjs owns.
  // Neither name is a prefix of "marchetti", so the ranking here falls through
  // to trigram similarity and puts the shorter name first.
  assert.deepEqual(rows.map((r) => r.display_name).sort(), [
    'Rosalind Marchetti',
    'Ulric Marchetti',
  ]);

  // NAMES ONLY. No email, no NID, no join date, no totals. The columns are the
  // assertion, because an extra one added later would be invisible in a test
  // that only checked the names.
  assert.deepEqual(Object.keys(rows[0]), ['id', 'display_name']);

  // The same floor search_members() sets. One letter is a way to walk the
  // roster alphabetically.
  const short = await refusal(ACCOUNTS.stranger, `select * from search_roster_for_claim('ma')`);
  assert.equal(short.code, 'PDS03');

  // Already linked, so there is nothing here for them.
  const linked = await refusal(ACCOUNTS.match, `select * from search_roster_for_claim('marchetti')`);
  assert.equal(linked.code, 'PDS07');
});

test('a claim reaches the officer queue carrying the address they signed in with', async () => {
  const filed = await fileAs(ACCOUNTS.stranger, CAST.rosalind, 'I am Rosalind, my UCF address changed.');

  assert.equal(filed.status, 'pending');
  assert.equal(filed.member_id, CAST.rosalind);
  assert.equal(filed.member_name, 'Rosalind Marchetti');

  const row = await claimRow(filed.claim_id);
  assert.equal(row.status, 'pending');
  assert.equal(row.note, 'I am Rosalind, my UCF address changed.');
  assert.equal(row.review_note, null);
  assert.equal(row.reviewed_by, null);

  // THE GAP THIS CLOSES. auth.users.email is not reachable through PostgREST,
  // and it is the one fact that lets an officer decide whether the person
  // asking is who they say they are.
  const queue = await db.withRole('authenticated', USERS.officer, () =>
    db.q('select * from list_pending_claims()'),
  );
  assert.equal(queue.length, 1);
  assert.equal(queue[0].claim_id, filed.claim_id);
  assert.equal(queue[0].account_email, 'nobody-here@example.test');
  assert.equal(queue[0].member_name, 'Rosalind Marchetti');
  assert.equal(queue[0].note, 'I am Rosalind, my UCF address changed.');

  // The queue is an officer's, not a viewer's and not a member's.
  assert.equal((await refusal(USERS.viewer, 'select * from list_pending_claims()')).code, 'PDS07');
  assert.equal(
    (await refusal(ACCOUNTS.stranger, 'select * from list_pending_claims()')).code,
    'PDS07',
  );

  // The member sees their own claim through the session, which is what the
  // "waiting for an officer" screen renders.
  const out = await session(ACCOUNTS.stranger);
  assert.equal(out.member_id, null, 'filing a claim linked the account by itself');
  assert.equal(out.claim.status, 'pending');
  assert.equal(out.claim.member_name, 'Rosalind Marchetti');
});

test('two accounts cannot hold one person, and one account cannot hold two claims', async () => {
  await session(ACCOUNTS.rival);

  // one_live_claim_per_member. docs/04 calls this the index that matters: two
  // people cannot both hold a live claim on Abigail Catto's record.
  const taken = await refusal(ACCOUNTS.rival, `select file_member_claim($1::uuid, null)`, [
    CAST.rosalind,
  ]);
  assert.equal(taken.code, 'PDS14');
  assert.match(taken.message, /already claimed/i);

  // one_live_claim_per_user. A different situation, a different code, because
  // only one of the two is the caller's mistake.
  const twice = await refusal(ACCOUNTS.stranger, `select file_member_claim($1::uuid, null)`, [
    CAST.ulric,
  ]);
  assert.equal(twice.code, 'PDS13');
  assert.match(twice.message, /claim waiting/i);

  // And the refusal is stated earlier, as an absence from the list, rather
  // than only as an error after somebody has chosen.
  assert.deepEqual(
    (await searchAs(ACCOUNTS.rival, 'marchetti')).map((r) => r.display_name).sort(),
    ['Ulric Marchetti'],
  );

  assert.equal(await db.val('select count(*)::int from member_claims'), 1);
});

test('approving links the account, and the member reads their own record', async () => {
  const claimId = await db.val(`select id from member_claims where user_id = $1`, [
    ACCOUNTS.stranger,
  ]);

  const decided = await reviewAs(USERS.officer, claimId, 'approve');
  assert.equal(decided.status, 'approved');
  assert.equal(decided.linked, true);

  // THE WRITE AN OFFICER COULD NOT MAKE. profiles_write_admin means a PATCH on
  // profiles from an officer is refused, which web/src/claims.js documents as
  // the reason Confirm could only record half a decision.
  assert.deepEqual(await profileOf(ACCOUNTS.stranger), [
    { user_id: ACCOUNTS.stranger, member_id: CAST.rosalind, role: 'member' },
  ]);

  const row = await claimRow(claimId);
  assert.equal(row.status, 'approved');
  assert.equal(row.reviewed_by, USERS.officer);
  assert.ok(row.reviewed_at);

  assert.equal(
    await db.val(`select count(*)::int from audit_log where action = 'review_member_claim'`),
    1,
  );

  // The portal is live for them now, and the claim screen is closed.
  const out = await session(ACCOUNTS.stranger);
  assert.equal(out.member_id, CAST.rosalind);
  assert.equal(out.auto_linked, false, 'the officer decision was reported as an email match');
  assert.equal(out.claim.status, 'approved');

  const status = await db.withRole('authenticated', ACCOUNTS.stranger, () =>
    db.q('select member_id from v_member_status'),
  );
  assert.deepEqual(
    status.map((r) => r.member_id),
    [CAST.rosalind],
  );

  const closed = await refusal(ACCOUNTS.stranger, `select * from search_roster_for_claim('marchetti')`);
  assert.equal(closed.code, 'PDS07');

  // A decided claim is decided. A second officer pressing Confirm on a stale
  // screen does not re-run the link.
  const again = await refusal(USERS.officer, `select review_member_claim($1::uuid, 'approve', null)`, [
    claimId,
  ]);
  assert.equal(again.code, 'PDS03');
});

test('approving refuses to hand out a member, or an account, that is already linked', async () => {
  const filed = await fileAs(ACCOUNTS.rival, CAST.vesper, 'This one is me.');

  // An admin linked Vesper by hand while the claim sat in the queue, which is
  // the race these guards exist for: nothing on the officer's card shows it.
  await db.q(`update profiles set member_id = $1 where user_id = $2`, [
    CAST.vesper,
    USERS.unclaimed,
  ]);

  // THIS IS THE CONSTRAINT ANSWERING, NOT A PRE-CHECK. review_member_claim()
  // does not read profiles to find out whether somebody holds Vesper; it
  // inserts, and the UNIQUE constraint on profiles.member_id refuses it. The
  // handler turns that 23505 into PDS14.
  //
  // Arranging the conflicting row before the call is what makes the handler
  // run for real here, and it stands in for the case that actually motivates
  // it: two writers racing, where a read-then-write check would pass and the
  // constraint would fire anyway. That case cannot be driven from this
  // harness. PGlite is a single connection, so there is no second session to
  // interleave with, and a test that simulated one would be asserting against
  // its own stub rather than against Postgres.
  const held = await refusal(USERS.officer, `select review_member_claim($1::uuid, 'approve', null)`, [
    filed.claim_id,
  ]);
  assert.equal(held.code, 'PDS14', 'a raw 23505 reached the caller instead of a translated refusal');
  assert.notEqual(held.code, '23505');

  assert.equal((await claimRow(filed.claim_id)).status, 'pending', 'a refused approval still decided');
  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.rival]),
    null,
  );

  // Now the other way around: the member is free, but the account has picked
  // up a link of its own since it asked.
  await db.q(`update profiles set member_id = null where user_id = $1`, [USERS.unclaimed]);
  await db.q(`update profiles set member_id = $1 where user_id = $2`, [CAST.xenia, ACCOUNTS.rival]);

  const moved = await refusal(USERS.officer, `select review_member_claim($1::uuid, 'approve', null)`, [
    filed.claim_id,
  ]);
  assert.equal(moved.code, 'PDS13');
  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.rival]),
    CAST.xenia,
    'an existing link was overwritten by a claim on somebody else',
  );

  // Put it back the way the officer thought it was, and the same call works.
  await db.q(`update profiles set member_id = null where user_id = $1`, [ACCOUNTS.rival]);
  const ok = await reviewAs(USERS.officer, filed.claim_id, 'approve');
  assert.equal(ok.linked, true);
  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.rival]),
    CAST.vesper,
  );
});

test('declining keeps the reason, keeps the members words, and frees both sides', async () => {
  await session(ACCOUNTS.retry);
  const filed = await fileAs(ACCOUNTS.retry, CAST.ulric, 'Pretty sure this is me.');

  const decided = await reviewAs(
    USERS.officer,
    filed.claim_id,
    'reject',
    'Ulric already collected his card.',
  );
  assert.equal(decided.status, 'rejected');
  assert.equal(decided.linked, false);

  const row = await claimRow(filed.claim_id);
  assert.equal(row.status, 'rejected');

  // ONE COLUMN PER AUTHOR. The officer's reason did not overwrite what the
  // member said, which is the same split as member_note against review_note on
  // an attendance record.
  assert.equal(row.note, 'Pretty sure this is me.');
  assert.equal(row.review_note, 'Ulric already collected his card.');

  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.retry]),
    null,
    'a declined claim linked the account anyway',
  );

  // Both partial indexes exclude rejected rows, so a decline is not a dead
  // end for either side. web/src/claims.js already promises the officer this.
  assert.deepEqual(
    (await searchAs(ACCOUNTS.retry, 'marchetti')).map((r) => r.display_name).sort(),
    ['Ulric Marchetti'],
  );
  const refiled = await fileAs(ACCOUNTS.retry, CAST.ulric, 'Asking again.');
  assert.equal(refiled.status, 'pending');

  // Tidy up after the lifecycle so the later refusal tests do not inherit a
  // live claim on Ulric.
  await db.q(`update member_claims set status = 'rejected' where id = $1`, [refiled.claim_id]);
});

// ---------------------------------------------------------------------------
// What happens to the member while the claim waits
// ---------------------------------------------------------------------------
// A claim is pending for as long as it takes an officer to look at it, which
// is the entire point of the flow: docs/04 budgets one officer click per
// member, spread over whenever each person first signs in. The roster is not
// frozen for that whole time. It is being cleaned up, and cleaning it up is
// archiving and merging.
//
// file_member_claim() checks the member is live when the claim is FILED. These
// two tests are about the other end.
// ---------------------------------------------------------------------------

test('a member archived while the claim waited cannot be linked afterwards', async () => {
  await db.withRole('authenticated', ACCOUNTS.waiting, () =>
    db.val('select start_portal_session()'),
  );
  const filed = await fileAs(ACCOUNTS.waiting, CAST.arden, 'This is me.');

  // An officer retires the roster row, through the ordinary policy, exactly as
  // the roster screen does it.
  await db.withRole('authenticated', USERS.officer, () =>
    db.q('update members set archived_at = now() where id = $1', [CAST.arden]),
  );

  const err = await refusal(USERS.officer, `select review_member_claim($1::uuid, 'approve', null)`, [
    filed.claim_id,
  ]);
  assert.equal(err.code, 'PDS03');
  assert.match(err.message, /archived/i);

  // Archived means an officer has said this is not somebody we are tracking.
  // search_roster_for_claim() already refuses to offer them; approval has to
  // agree, or the two halves of the same rule disagree.
  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.waiting]),
    null,
    'an account was linked to an archived member',
  );
  assert.equal((await claimRow(filed.claim_id)).status, 'pending', 'a refused approval still decided');
});

test('a member merged while the claim waited is followed to the survivor', async () => {
  await db.withRole('authenticated', ACCOUNTS.patient, () =>
    db.val('select start_portal_session()'),
  );
  const filed = await fileAs(ACCOUNTS.patient, CAST.bramwell, 'Bramwell is me.');

  // Roster cleanup, which is when this happens in real life: a fresh import
  // has just run, duplicates are being merged, and claims are arriving from
  // the people that import just added.
  await db.withRole('authenticated', USERS.officer, () =>
    db.val('select merge_members($1::uuid, $2::uuid)', [CAST.bramwell, CAST.cordelia]),
  );

  const decided = await reviewAs(USERS.officer, filed.claim_id, 'approve');

  // A merge does not mean the person stopped existing. It means the row that
  // represents them moved, and merge_members() moved every record with it. The
  // account is linked to where the records went.
  assert.equal(decided.member_id, CAST.cordelia);
  assert.equal(decided.claimed_member_id, CAST.bramwell);
  assert.equal(decided.followed_merge, true);

  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.patient]),
    CAST.cordelia,
    'the account was linked to the tombstone rather than to the survivor',
  );

  // The claim still says what the member actually picked. Rewriting it would
  // destroy the record of what they asserted in order to tidy an index.
  const row = await db.one('select member_id, status from member_claims where id = $1', [
    filed.claim_id,
  ]);
  assert.equal(row.member_id, CAST.bramwell);
  assert.equal(row.status, 'approved');

  // Following is recorded rather than silent: an officer reading the audit log
  // can see that Confirm on one row linked another.
  const audited = await db.one(
    `select detail from audit_log
      where action = 'review_member_claim' and entity_id = $1`,
    [filed.claim_id],
  );
  assert.equal(audited.detail.claimed_member_id, CAST.bramwell);
  assert.equal(audited.detail.member_id, CAST.cordelia);

  // And the link is worth having, which is the whole argument for following:
  // the survivor is where the history went.
  const status = await db.withRole('authenticated', ACCOUNTS.patient, () =>
    db.q('select member_id from v_member_status'),
  );
  assert.deepEqual(
    status.map((r) => r.member_id),
    [CAST.cordelia],
  );
});

// ---------------------------------------------------------------------------
// The path that does not go through file_member_claim()
// ---------------------------------------------------------------------------

test('a claim inserted straight through the policy is reviewed like any other', async () => {
  // claims_insert_own is `with check (user_id = auth.uid() and status =
  // 'pending')` and member_claims carries an INSERT grant to authenticated, so
  // a claim can be POSTed to PostgREST without file_member_claim() ever being
  // called. This account has no profiles row at all, which is what makes the
  // insert branch of review_member_claim() reachable rather than theoretical.
  assert.equal(
    await db.val('select count(*)::int from profiles where user_id = $1', [ACCOUNTS.direct]),
    0,
  );

  await db.withRole('authenticated', ACCOUNTS.direct, () =>
    db.q('insert into member_claims (user_id, member_id, note) values ($1, $2, $3)', [
      ACCOUNTS.direct,
      CAST.dorothea,
      'Filed by hand.',
    ]),
  );

  const claimId = await db.val('select id from member_claims where user_id = $1', [
    ACCOUNTS.direct,
  ]);

  const queue = await db.withRole('authenticated', USERS.officer, () =>
    db.q('select claim_id, account_email, member_name from list_pending_claims()'),
  );
  assert.ok(
    queue.some((r) => r.claim_id === claimId),
    'a claim filed through the policy never reached the officers queue',
  );

  const decided = await reviewAs(USERS.officer, claimId, 'approve');
  assert.equal(decided.linked, true);

  // The profiles row is created on approval, with role member for the same
  // reason start_portal_session() writes it out rather than taking the viewer
  // column default.
  assert.deepEqual(await profileOf(ACCOUNTS.direct), [
    { user_id: ACCOUNTS.direct, member_id: CAST.dorothea, role: 'member' },
  ]);
});

test('the direct path is not a way around what file_member_claim checks', async () => {
  // TWO CHECKS file_member_claim() makes about the CALLER and the MEMBER that
  // an INSERT through the policy does not make. Both have to be caught again
  // at approval, because approval is the step that actually grants the read.

  // 1. Already linked. file_member_claim() refuses this outright.
  //
  // THE ACCOUNT HERE IS THE AUTO-LINKED ONE, and it has to be. An account that
  // was linked by having a claim approved still HAS that claim, and
  // one_live_claim_per_user refuses it a second row before any of this comes
  // up. An account linked by an email match never filed one, so the index has
  // nothing to catch and the approval-time check is the only thing standing
  // there. Same for an account an admin linked by hand.
  assert.equal(
    (await refusal(ACCOUNTS.match, `select file_member_claim($1::uuid, null)`, [CAST.eglantine]))
      .code,
    'PDS07',
  );
  await db.withRole('authenticated', ACCOUNTS.match, () =>
    db.q('insert into member_claims (user_id, member_id, note) values ($1, $2, $3)', [
      ACCOUNTS.match,
      CAST.eglantine,
      'And this one too.',
    ]),
  );
  const greedy = await db.val(
    `select id from member_claims where user_id = $1 and member_id = $2`,
    [ACCOUNTS.match, CAST.eglantine],
  );

  const moved = await refusal(USERS.officer, `select review_member_claim($1::uuid, 'approve', null)`, [
    greedy,
  ]);
  assert.equal(moved.code, 'PDS13', 'an account collected a second member through the policy');
  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.match]),
    CAST.quillon,
  );

  // 2. The member must be live. file_member_claim() refuses an archived row as
  // an unknown member; the insert has no such check, so approval is where it
  // has to be caught.
  await db.withRole('authenticated', ACCOUNTS.sneak, () => db.val('select start_portal_session()'));
  assert.equal(
    (await refusal(ACCOUNTS.sneak, `select file_member_claim($1::uuid, null)`, [CAST.fenwick]))
      .code,
    'PDS03',
  );
  await db.withRole('authenticated', ACCOUNTS.sneak, () =>
    db.q('insert into member_claims (user_id, member_id, note) values ($1, $2, $3)', [
      ACCOUNTS.sneak,
      CAST.fenwick,
      'Nobody will notice.',
    ]),
  );
  const onArchived = await db.val(`select id from member_claims where user_id = $1`, [
    ACCOUNTS.sneak,
  ]);

  const refused = await refusal(
    USERS.officer,
    `select review_member_claim($1::uuid, 'approve', null)`,
    [onArchived],
  );
  assert.equal(refused.code, 'PDS03');
  assert.match(refused.message, /archived/i);
  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.sneak]),
    null,
    'an account was linked to an archived member through the policy',
  );
});

test('the note cap is on the column, not only on the function that checks it', async () => {
  // file_member_claim() refuses a long note with a sentence, and that is the
  // message a member should get. But it is not the only way a row arrives, so
  // the length is also a constraint, which is what makes it a cap rather than
  // a convention. Both paths, one limit.
  await db.withRole('authenticated', ACCOUNTS.wordy, () => db.val('select start_portal_session()'));

  const viaFunction = await refusal(ACCOUNTS.wordy, `select file_member_claim($1::uuid, $2)`, [
    CAST.yolanda,
    'x'.repeat(501),
  ]);
  assert.equal(viaFunction.code, 'PDS03');
  assert.match(viaFunction.message, /too long/i);

  const viaPolicy = await refusal(
    ACCOUNTS.wordy,
    'insert into member_claims (user_id, member_id, note) values ($1, $2, $3)',
    [ACCOUNTS.wordy, CAST.yolanda, 'x'.repeat(501)],
  );
  assert.equal(viaPolicy.code, '23514', 'the policy path wrote a note the function would refuse');
  assert.equal(viaPolicy.constraint, 'member_claims_note_length');

  // Exactly 500 is fine on both paths, so the boundary is where it says it is.
  const ok = await fileAs(ACCOUNTS.wordy, CAST.yolanda, 'x'.repeat(500));
  assert.equal(ok.status, 'pending');
});

test('approving a link an admin already made by hand is not a false refusal', async () => {
  // The postcondition added for the lost-update race has to accept the case
  // where the link it is checking for is already correct, or clearing the
  // queue after an admin has linked somebody by hand would refuse for a
  // reason that is not true.
  //
  // This drives the postcondition's read branch for real: the upsert's guard
  // suppresses the update, RETURNING gives nothing, and the row is read to
  // find out whether that silence meant "already right" or "holds somebody
  // else". This is the "already right" half.
  await db.withRole('authenticated', ACCOUNTS.settled, () =>
    db.val('select start_portal_session()'),
  );
  const filed = await fileAs(ACCOUNTS.settled, CAST.harriet, 'Please confirm.');

  await db.q('update profiles set member_id = $1 where user_id = $2', [
    CAST.harriet,
    ACCOUNTS.settled,
  ]);

  const decided = await reviewAs(USERS.officer, filed.claim_id, 'approve');
  assert.equal(decided.linked, true);
  assert.equal(decided.member_id, CAST.harriet);
  assert.equal((await claimRow(filed.claim_id)).status, 'approved');
  assert.equal(
    await db.val('select member_id from profiles where user_id = $1', [ACCOUNTS.settled]),
    CAST.harriet,
  );
});

// ---------------------------------------------------------------------------
// WHAT THIS FILE CANNOT TEST, AND WHY IT SAYS SO INSTEAD OF PRETENDING
// ---------------------------------------------------------------------------
// PGlite is one connection. There is no second session to interleave with, so
// no test here can drive a race, and a test whose name said "concurrent" over
// a sequential body would be asserting against its own fiction. Two guards in
// migration 18 exist for interleavings that cannot be reached from here, and
// both are named so a reader knows they are guards rather than dead code.
//
// 1. THE MERGE WINDOW, closed by the FOR UPDATE pair that migration 18 section
//    18.11 adds to the top of merge_members(). merge_members() moves records
//    and enrollments first and tombstones the loser last, so before the lock
//    was added there was a window in which the loser looked live and unmerged
//    while its records had already gone to the survivor. The interleaving is:
//
//      merge:    moves every record and enrollment, has not yet tombstoned
//      approval: locks the loser, sees merged_into_id and archived_at null,
//                links the account, commits
//      merge:    tombstones the loser, commits
//
//    The account ends up on a tombstone with no records, and the officer was
//    told it worked. What CAN be asserted here is the completed-merge case,
//    which is the test above: after a merge finishes, approval follows it to
//    the survivor.
//
// 2. THE LOST UPDATE, caught by the postcondition in review_member_claim().
//    The profile row is locked before the PDS13 check, so an existing row
//    cannot move underneath the decision. A row that does not exist yet cannot
//    be locked, and that is the gap:
//
//      approval: finds no profiles row, so locks nothing
//      other:    inserts a profiles row for that account holding member N
//      approval: inserts, hits `on conflict (user_id) do update ... where
//                member_id is null`, the guard suppresses it, nothing is
//                written and nothing is raised
//
//    Without the postcondition the claim would be marked approved and the
//    officer told linked = true, with the account on somebody else entirely.
//    The half of that branch which IS reachable sequentially is the test
//    above: the same silent no-op, arrived at because the link was already
//    correct, must not be reported as a failure.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "Something is missing"
// ---------------------------------------------------------------------------

test('a missing-credit request arrives pending, flagged, and approved by nobody', async () => {
  const filed = await requestAs(ACCOUNTS.stranger, EVENTS.gbmSingle, 'I signed the sheet at GBM 4.');

  assert.equal(filed.status, 'pending');
  assert.deepEqual(filed.flags, ['member_requested']);

  const row = await db.one(
    `select member_id, status, source, flags, member_note, review_note, submitted_value,
            reviewed_by, reviewed_at
     from attendance_records where id = $1`,
    [filed.record_id],
  );

  assert.equal(row.member_id, CAST.rosalind);
  assert.equal(row.status, 'pending');
  assert.equal(row.source, 'member_request');
  assert.deepEqual(row.flags, ['member_requested']);

  // THE MEMBER'S WORDS ARE IN THE MEMBER'S COLUMN. review_note is where an
  // officer's decline reason goes, and docs/04 shows the portal reading it
  // back to the member, so a note sitting there would be read as an officer's.
  assert.equal(row.member_note, 'I signed the sheet at GBM 4.');
  assert.equal(row.review_note, null);

  assert.equal(row.reviewed_by, null);
  assert.equal(row.reviewed_at, null);
  assert.equal(row.submitted_value, null);

  // INVARIANT 6. It is worth nothing until a person approves it, and it earns
  // credit through the same function the review queue already calls.
  const credited = await db.val(
    `select count(*)::int from v_attendance_credit where attendance_id = $1`,
    [filed.record_id],
  );
  assert.equal(credited, 0, 'a member request earned credit without anybody approving it');

  const queued = await db.withRole('authenticated', USERS.officer, () =>
    db.q(`select id, flags, member_note from attendance_records where id = $1`, [filed.record_id]),
  );
  assert.equal(queued.length, 1, 'the request never reached the officers queue');

  await db.withRole('authenticated', USERS.officer, () =>
    db.val(`select review_records(array[$1]::uuid[], 'approve', null)`, [filed.record_id]),
  );
  assert.equal(
    await db.val('select status from attendance_records where id = $1', [filed.record_id]),
    'approved',
  );

  // And the member can read the whole lifecycle of their own record, which is
  // the "I checked in, did it work?" question docs/04 is written around.
  const mine = await db.withRole('authenticated', ACCOUNTS.stranger, () =>
    db.q('select id, status, member_note from attendance_records'),
  );
  assert.deepEqual(
    mine.map((r) => r.id),
    [filed.record_id],
  );
});

test('a request is refused for an event the member cannot ask about', async () => {
  // one_live_record_per_member_event. The row from the previous test is
  // approved, which is still live, so the index refuses a second.
  const twice = await refusal(
    ACCOUNTS.stranger,
    `select request_missing_credit($1::uuid, 'again')`,
    [EVENTS.gbmSingle],
  );
  assert.equal(twice.code, 'PDS05');

  // Rosalind is enrolled in 2026-2027 only, and priorGbm belongs to the year
  // before. submit_checkin() flags that case and files anyway, because
  // somebody standing at an event is evidence; nobody is standing anywhere
  // here, so this is a mistake at the point of asking.
  const wrongYear = await refusal(
    ACCOUNTS.stranger,
    `select request_missing_credit($1::uuid, 'last year')`,
    [EVENTS.priorGbm],
  );
  assert.equal(wrongYear.code, 'PDS03');

  for (const [name, eventId, note] of [
    ['an unpublished draft', UNPUBLISHED, 'draft'],
    ['an event that does not exist', '22222222-0000-4000-a000-0000000000ff', 'nothing'],
  ]) {
    const err = await refusal(ACCOUNTS.stranger, `select request_missing_credit($1::uuid, $2)`, [
      eventId,
      note,
    ]);
    assert.equal(err.code, 'PDS03', `${name} was accepted`);
  }

  // The officer reading this queue needs something to act on.
  for (const note of ['', '   ', null]) {
    const err = await refusal(ACCOUNTS.stranger, `select request_missing_credit($1::uuid, $2)`, [
      EVENTS.tabling,
      note,
    ]);
    assert.equal(err.code, 'PDS03', 'a request with no words was accepted');
  }

  const long = await refusal(ACCOUNTS.stranger, `select request_missing_credit($1::uuid, $2)`, [
    EVENTS.tabling,
    'x'.repeat(501),
  ]);
  assert.equal(long.code, 'PDS03');

  assert.equal(
    await db.val(
      `select count(*)::int from attendance_records where member_id = $1 and event_id = $2`,
      [CAST.rosalind, EVENTS.tabling],
    ),
    0,
    'a refused request wrote a row anyway',
  );
});

test('a value is required where the event reads one, and discarded where it does not', async () => {
  // Exactly what submit_checkin() does with p_value, because both paths write
  // the same column and v_attendance_credit reads it the same way from both.
  const missing = await refusal(
    ACCOUNTS.stranger,
    `select request_missing_credit($1::uuid, 'I volunteered')`,
    [EVENTS.volDay],
  );
  assert.equal(missing.code, 'PDS03');

  const negative = await refusal(
    ACCOUNTS.stranger,
    `select request_missing_credit($1::uuid, 'I volunteered', -4)`,
    [EVENTS.volDay],
  );
  assert.equal(negative.code, 'PDS03');

  const hours = await requestAs(ACCOUNTS.stranger, EVENTS.volDay, 'I volunteered', 4);
  assert.equal(
    await db.val('select submitted_value from attendance_records where id = $1', [hours.record_id]),
    '4.00',
  );

  // A number nobody asked for is ignored rather than stored, so it can never
  // turn into credit on an event whose categories are all fixed.
  const ignored = await requestAs(ACCOUNTS.stranger, EVENTS.socialBlock, 'Missed the sheet', 999);
  assert.equal(
    await db.val('select submitted_value from attendance_records where id = $1', [
      ignored.record_id,
    ]),
    null,
    'a value nobody asked for was stored',
  );
});

// ---------------------------------------------------------------------------
// What none of this opened up
// ---------------------------------------------------------------------------

test('a linked member still reads nobody elses anything', async () => {
  const seen = await db.withRole('authenticated', ACCOUNTS.stranger, async () => ({
    members: await db.q('select id from members'),
    status: await db.q('select member_id from v_member_status'),
    totals: (await db.q('select distinct member_id from v_member_category_totals')).map(
      (r) => r.member_id,
    ),
    records: (await db.q('select distinct member_id from attendance_records')).map(
      (r) => r.member_id,
    ),
    claims: (await db.q('select distinct user_id from member_claims')).map((r) => r.user_id),
    profiles: (await db.q('select user_id from profiles')).map((r) => r.user_id),
  }));

  assert.deepEqual(
    seen.members.map((r) => r.id),
    [CAST.rosalind],
    'a member read somebody elses roster row',
  );
  assert.deepEqual(
    seen.status.map((r) => r.member_id),
    [CAST.rosalind],
  );
  assert.deepEqual(seen.totals, [CAST.rosalind]);
  assert.deepEqual(seen.records, [CAST.rosalind]);
  assert.deepEqual(seen.claims, [ACCOUNTS.stranger]);
  assert.deepEqual(seen.profiles, [ACCOUNTS.stranger]);

  // The evaluator refuses to answer about anybody else, which is the check
  // fn_member_requirement_status() has carried since migration 09.
  const other = await refusal(
    ACCOUNTS.stranger,
    `select * from fn_member_requirement_status($1::uuid, $2::uuid)`,
    [CAST.quillon, 'd0000000-0000-4000-a000-000000000001'],
  );
  assert.equal(other.code, 'PDS07');

  // Nothing added by this migration lets a member act as an officer.
  assert.equal(
    (await refusal(ACCOUNTS.stranger, 'select * from list_pending_claims()')).code,
    'PDS07',
  );
  // Retry filed twice, so name the first one rather than assuming there is one.
  const claimId = await db.val(
    `select id from member_claims where user_id = $1 order by requested_at, id limit 1`,
    [ACCOUNTS.retry],
  );
  assert.equal(
    (
      await refusal(ACCOUNTS.stranger, `select review_member_claim($1::uuid, 'approve', null)`, [
        claimId,
      ])
    ).code,
    'PDS07',
  );
});

test('anon holds no EXECUTE on any of it', async () => {
  // Not "a check inside refuses them": no grant at all, which is the sentence
  // the README's security paragraph makes and the property
  // test/privileges.test.mjs pins from both sides.
  for (const [name, sql, params] of portalRpcs()) {
    const err = await refusal(null, sql, params, 'anon');
    assert.equal(err.code, '42501', `anon reached ${name}: ${err.message}`);
  }
});

test('an account with no profiles row is refused by everything but the front door', async () => {
  // The caller migration 16 is about. fn_current_role() selects no row for
  // them, so fn_is_officer() is NULL rather than false, and these are the
  // first officer-facing functions written since that was fixed.
  assert.equal(
    await db.val('select count(*)::int from profiles where user_id = $1', [ACCOUNTS.noProfile]),
    0,
    'the account this test is about now has a profile, so it proves nothing',
  );

  for (const [name, sql, params] of portalRpcs()) {
    if (name === 'start_portal_session') continue; // serving this caller is its job
    const err = await refusal(ACCOUNTS.noProfile, sql, params);
    assert.equal(err.code, 'PDS07', `${name} did not refuse an account with no profile`);
  }

  // Nothing they asked for was written.
  assert.deepEqual(await db.q('select id from member_claims where user_id = $1', [ACCOUNTS.noProfile]), []);
  assert.equal(
    await db.val(`select count(*)::int from attendance_records where source = 'member_request'
                  and member_note = 'missing'`),
    0,
  );

  // And the front door still opens, which is the other half of the change: a
  // refusal everywhere is only correct if the one function meant to serve this
  // caller still does.
  const out = await session(ACCOUNTS.noProfile);
  assert.equal(out.role, 'member');
  assert.equal(out.member_id, null);
});

test('the claim search is bounded, and the bucket is the account', async () => {
  await db.q(`update app_settings set value = '3'::jsonb where key = 'claim_search_max_per_min'`);

  // now() is fixed for a transaction, so every call below lands in one limiter
  // window rather than straddling a minute boundary. See helpers/clock.mjs.
  const run = await inPinnedMinute(db, async () => {
    await db.as('authenticated', ACCOUNTS.limiter);

    let admitted = 0;
    let refused = null;
    for (let i = 0; i < 6; i += 1) {
      const turn = await attempt(db, 'claim_search', () =>
        db.q(`select * from search_roster_for_claim('marchetti')`),
      );
      if (!turn.ok) {
        refused = turn.error;
        break;
      }
      admitted += 1;
    }

    // A different account in the same minute. The key is the caller, so this
    // one has its own allowance and is not paying for the first one's.
    await db.as('authenticated', ACCOUNTS.retry);
    const other = await attempt(db, 'other_account', () =>
      db.q(`select * from search_roster_for_claim('marchetti')`),
    );

    return { admitted, refused, other };
  });

  await db.asOwner();

  assert.equal(run.admitted, 3, 'the ceiling admitted a different number than it says');
  assert.equal(run.refused?.code, 'PDS09');
  assert.equal(run.other.ok, true, 'one account exhausted another accounts allowance');
});
