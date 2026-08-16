// Importing a roster in one call.
//
// The roster screen used to call upsert_member_and_enroll() once per CSV row.
// The real file is 355 rows, so that was 355 sequential round trips, each one
// a fresh chance for the run to stop halfway.
// upsert_members_and_enroll() takes the rows as an array instead.
//
// Making it one request is only worth having if it does not cost the two
// properties the single-row function was written for, so those are what this
// file asserts:
//
//   * A ROW THAT FAILS DOES NOT TAKE THE BATCH WITH IT. Each row runs in its
//     own subtransaction, so one archived member in an officer's file leaves
//     the other rows written and comes back as a line the officer can fix,
//     with the line number they can find it by.
//   * RE-RUNNING THE SAME FILE WRITES NOTHING. The batch is idempotent because
//     each row still goes through upsert_member_and_enroll(), which is also
//     why the match tiers, the tombstone walk and p_matched_member_id behave
//     here exactly as test/member_upsert.test.mjs proves they do there.
//
// And the refusals, because a SECURITY DEFINER function that writes the roster
// is the one thing on this screen that must never be reachable by the wrong
// caller.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, MEMBERS, USERS, YEAR_2026 } from './helpers/fixture.mjs';

let db;

const R = (n) => `55555555-0000-4000-a000-0000000000${n}`;

const CAST = {
  retired: R('01'), // archived, so every batch holding them has one bad row
  known: R('02'), // already a member, with an address a file would find
};

// Nobody signed in has a profiles row, which is the case fn_is_officer()
// answers NULL for rather than false. See migration 16.
const NO_PROFILE = '99999999-0000-4000-a000-0000000000f9';

function batch(rows, { year = YEAR_2026, userId = USERS.officer } = {}) {
  return db.withRole('authenticated', userId, () =>
    db.val(`select upsert_members_and_enroll($1::jsonb, $2::uuid)`, [JSON.stringify(rows), year]),
  );
}

async function refuses(rows, { year = YEAR_2026, userId = USERS.officer } = {}) {
  await db.as('authenticated', userId);
  const err = await db.expectError(`select upsert_members_and_enroll($1::jsonb, $2::uuid)`, [
    JSON.stringify(rows),
    year,
  ]);
  await db.asOwner();
  return err;
}

const memberCount = () => db.val(`select count(*)::int from members`);
const enrolledCount = () =>
  db.val(`select count(*)::int from member_enrollments where academic_year_id = $1`, [YEAR_2026]);

/** Forty rows, which is a batch rather than a handful. */
const roster = (n, tag) =>
  Array.from({ length: n }, (_, i) => ({
    row: i + 2, // line 1 of a CSV is the header
    first_name: `${tag}${i}`,
    last_name: 'Fairweather',
    email: `${tag.toLowerCase()}${i}.fairweather@ucf.edu`,
  }));

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  await db.exec(`
    insert into members (id, first_name, last_name, email, archived_at) values
      ('${CAST.retired}', 'Orsolya', 'Vetranio', 'orsolya.vetranio@ucf.edu', now()),
      ('${CAST.known}',   'Piotr',   'Zawadzki', 'piotr.zawadzki@ucf.edu',   null);
  `);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.afterEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('several dozen rows land in one call, and a second run writes nothing', async () => {
  const rows = roster(40, 'Aster');
  const before = await memberCount();

  const first = await batch(rows);
  assert.equal(first.length, 40);
  assert.equal(first.filter((r) => r.was_created).length, 40);
  assert.equal(first.filter((r) => r.was_enrolled).length, 40);
  assert.equal(await memberCount(), before + 40);

  // THE PROPERTY THAT MAKES A RETRY SAFE. Same file, same call, nothing
  // written, and the same member ids come back.
  const enrolled = await enrolledCount();
  const again = await batch(rows);

  assert.equal(again.length, 40);
  assert.equal(again.filter((r) => r.was_created).length, 0, 'the second run created somebody');
  assert.equal(again.filter((r) => r.was_enrolled).length, 0, 'the second run enrolled somebody');
  assert.deepEqual(
    again.map((r) => r.member_id),
    first.map((r) => r.member_id),
  );
  assert.equal(await memberCount(), before + 40);
  assert.equal(await enrolledCount(), enrolled);
});

test('a row that fails is reported and its neighbours are still written', async () => {
  // THE FINDING. One archived member in a 355 row file used to be a choice
  // between losing the whole run and not knowing which row was bad. Each row
  // is its own subtransaction, so the answer is neither.
  const before = await memberCount();

  const results = await batch([
    { row: 7, first_name: 'Bertil', last_name: 'Nordqvist', email: 'bertil.n@ucf.edu' },
    { row: 8, first_name: 'Orsolya', last_name: 'Vetranio', email: 'orsolya.vetranio@ucf.edu' },
    { row: 9, first_name: 'Csilla', last_name: 'Radulescu', email: 'csilla.r@ucf.edu' },
  ]);

  assert.equal(results.length, 3);
  assert.equal(results[0].was_created, true);
  assert.equal(results[2].was_created, true);

  const refused = results[1];
  assert.equal(refused.row, 8, 'the refusal does not point at the officers line');
  assert.equal(refused.error, 'PDS03');
  assert.match(refused.message, /archived/i);
  assert.equal(refused.member_id, null);
  assert.equal(refused.was_created, false);
  assert.equal(refused.was_enrolled, false);

  // Two written, one refused, and the archived member is still archived and
  // still off this year's roster.
  assert.equal(await memberCount(), before + 2);
  assert.equal(
    await db.val(`select count(*)::int from member_enrollments where member_id = $1`, [
      CAST.retired,
    ]),
    0,
    'an archived member was put on the roster anyway',
  );
});

test('results come back in input order', async () => {
  // The caller maps a result onto the row it sent by position as well as by
  // line number, and the UI lists refusals in the order the officer sees them
  // in their file.
  const rows = [
    { row: 30, first_name: 'Ingrid', last_name: 'Solheim', email: 'ingrid.solheim@ucf.edu' },
    { row: 12, first_name: 'Orsolya', last_name: 'Vetranio', email: 'orsolya.vetranio@ucf.edu' },
    { row: 21, first_name: 'Jonas', last_name: 'Halvorsen', email: 'jonas.halvorsen@ucf.edu' },
    { row: 4, first_name: 'Katarina', last_name: 'Bakke', email: 'katarina.bakke@ucf.edu' },
  ];

  const results = await batch(rows);

  assert.deepEqual(results.map((r) => r.row), [30, 12, 21, 4]);
  assert.deepEqual(results.map((r) => Boolean(r.error)), [false, true, false, false]);
});

test('a row with no line number is numbered by its position', async () => {
  const results = await batch([
    { first_name: 'Lauri', last_name: 'Virtanen' },
    { first_name: 'Orsolya', last_name: 'Vetranio', email: 'orsolya.vetranio@ucf.edu' },
  ]);

  assert.deepEqual(results.map((r) => r.row), [1, 2]);
  assert.equal(results[1].error, 'PDS03');
});

test('a line number the caller cannot mean does not take the batch with it', async () => {
  // THE ROW VALUE IS CALLER CONTROLLED, AND jsonb NUMBERS ARE numeric. 1e100
  // is a valid JSON number and an invalid int, so reading it outside the
  // per-row block would raise 22P02 where nothing catches it and roll back
  // every row already written. That is precisely the guarantee this function
  // exists to give, so it is asserted rather than assumed.
  //
  // A row number that cannot be used is not itself a refusal either: the
  // ordinal stands, and the row's one result still reports what was actually
  // wrong with the row.
  const before = await memberCount();

  const results = await batch([
    { row: 2, first_name: 'Ilkka', last_name: 'Rautavaara', email: 'ilkka.r@ucf.edu' },
    { row: 1e100, first_name: 'Sorcha', last_name: 'Ballantyne', email: 'sorcha.b@ucf.edu' },
    { row: 4.5, first_name: 'Orsolya', last_name: 'Vetranio', email: 'orsolya.vetranio@ucf.edu' },
    { row: 5, first_name: 'Ulla', last_name: 'Kekkonen', email: 'ulla.k@ucf.edu' },
  ]);

  assert.equal(results.length, 4, 'the call aborted instead of reporting the row');

  // The valid rows around it are committed, which is the half that used to be
  // rolled back.
  assert.equal(results[0].row, 2);
  assert.equal(results[0].was_created, true);
  assert.equal(results[3].row, 5);
  assert.equal(results[3].was_created, true);
  assert.equal(await memberCount(), before + 3);

  // Both unusable line numbers fall back to the 1-based position, and neither
  // one is what refused its row: row 2 was written, and row 3 was refused for
  // being archived.
  assert.equal(results[1].row, 2, 'an out-of-range line number was not replaced');
  assert.equal(results[1].error, undefined, 'a bad line number refused a good row');
  assert.equal(results[1].was_created, true);

  assert.equal(results[2].row, 3, 'a fractional line number was not replaced');
  assert.equal(results[2].error, 'PDS03');
  assert.match(results[2].message, /archived/i, 'the bad line number ate the real reason');
});

test('the officers answer from the preview outranks the lookup', async () => {
  // Same assertion the single-row test makes, because this is the same code
  // path: the address below belongs to somebody else entirely and must lose to
  // the id the officer pressed Link member on.
  const before = await memberCount();

  const [result] = await batch([
    {
      row: 2,
      first_name: 'Dorian',
      last_name: 'Nullstone',
      email: 'piotr.zawadzki@ucf.edu',
      matched_member_id: MEMBERS.dorian,
    },
  ]);

  assert.equal(result.member_id, MEMBERS.dorian);
  assert.equal(result.was_created, false);
  assert.equal(await memberCount(), before);
});

test('a member, an anon caller and an account with no role are all refused', async () => {
  const before = await memberCount();
  const rows = [{ row: 2, first_name: 'Snuck', last_name: 'In' }];

  const member = await refuses(rows, { userId: USERS.adaAccount });
  assert.equal(member.code, 'PDS07');

  // The NULL-role gap migration 16 closes. fn_is_officer() is NULL rather than
  // false for a caller with no profiles row, so officer status is asserted
  // positively here as well, before the loop writes anything.
  const unknown = await refuses(rows, { userId: NO_PROFILE });
  assert.equal(unknown.code, 'PDS07');

  await db.as('anon');
  const anon = await db.expectError(`select upsert_members_and_enroll($1::jsonb, $2::uuid)`, [
    JSON.stringify(rows),
    YEAR_2026,
  ]);
  await db.asOwner();
  assert.equal(anon.code, '42501');

  assert.equal(await memberCount(), before, 'a refused call still wrote somebody');
});

test('a refused caller writes nothing, including the rows before the bad one', async () => {
  // The role check is up front, so it is not a question of how far down the
  // file the refusal happens. Nothing in the batch is written.
  const before = await memberCount();
  const err = await refuses(
    [
      { row: 2, first_name: 'Malachy', last_name: 'Devereux', email: 'malachy.d@ucf.edu' },
      { row: 3, first_name: 'Noor', last_name: 'Al-Amin', email: 'noor.alamin@ucf.edu' },
    ],
    { userId: USERS.adaAccount },
  );

  assert.equal(err.code, 'PDS07');
  assert.equal(await memberCount(), before);
  assert.equal(
    await db.val(`select count(*)::int from members where email = 'malachy.d@ucf.edu'`),
    0,
  );
});

test('over the cap is refused outright', async () => {
  const before = await memberCount();
  const err = await refuses(roster(501, 'Overflow'));

  assert.equal(err.code, 'PDS03');
  assert.match(err.message, /500/);
  assert.equal(await memberCount(), before, 'an over-cap batch wrote rows before it was refused');

  // And 500 exactly is fine, so the cap is a cap and not an off-by-one.
  const ok = await batch(roster(500, 'Edgecase'));
  assert.equal(ok.length, 500);
  assert.equal(ok.filter((r) => r.error).length, 0);
});

test('a bad argument is refused before any row runs', async () => {
  const before = await memberCount();

  await db.as('authenticated', USERS.officer);
  const notArray = await db.expectError(
    `select upsert_members_and_enroll('{"first_name": "Not"}'::jsonb, $1::uuid)`,
    [YEAR_2026],
  );
  const noYear = await db.expectError(`select upsert_members_and_enroll($1::jsonb, $2::uuid)`, [
    JSON.stringify([{ first_name: 'Yara', last_name: 'Bright' }]),
    '00000000-0000-4000-a000-000000000000',
  ]);
  await db.asOwner();

  assert.equal(notArray.code, 'PDS03');
  assert.equal(noYear.code, 'PDS03');
  assert.equal(await memberCount(), before);
});

test('an empty batch is an empty array and not an error', async () => {
  assert.deepEqual(await batch([]), []);
});

test('it writes one audit row for the batch on top of the per-row ones', async () => {
  const rows = [
    { row: 2, first_name: 'Perpetua', last_name: 'Okonjo', email: 'perpetua.okonjo@ucf.edu' },
    { row: 3, first_name: 'Orsolya', last_name: 'Vetranio', email: 'orsolya.vetranio@ucf.edu' },
  ];
  const perRowBefore = await db.val(
    `select count(*)::int from audit_log where action = 'upsert_member_and_enroll'`,
  );

  await batch(rows);

  const summary = await db.one(
    `select * from audit_log where action = 'upsert_members_and_enroll' order by id desc limit 1`,
  );
  assert.equal(summary.actor_user_id, USERS.officer);
  assert.equal(summary.detail.rows, 2);
  assert.equal(summary.detail.created, 1);
  assert.equal(summary.detail.refused, 1);
  assert.equal(summary.detail.academic_year_id, YEAR_2026);

  // The refused row rolled back its own subtransaction, so it left no per-row
  // audit row behind either.
  assert.equal(
    await db.val(`select count(*)::int from audit_log where action = 'upsert_member_and_enroll'`),
    perRowBefore + 1,
  );
});

test('the function grants EXECUTE to nobody it should not', async () => {
  // Postgres creates a function with EXECUTE granted to PUBLIC. The blanket
  // revoke in migration 11 ran long before this one existed, so the revoke in
  // migration 17 is the only thing keeping anon out of a function that writes
  // the roster. test/privileges.test.mjs holds the same line for every
  // function at once; this is the one that names this file's.
  const leaky = await db.q(`
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'upsert_members_and_enroll'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  `);
  assert.deepEqual(leaky, [], 'upsert_members_and_enroll is callable by anon');
});
