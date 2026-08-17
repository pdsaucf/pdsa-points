// The member portal, now that it is not an account.
//
// Migration 21 replaced a magic-link session and a claim queue with four
// functions any stranger may call. That is a deliberate widening, and the whole
// value of this file is that the width is exactly what was intended and no
// more. So the properties asserted here are:
//
//   * ANON CAN READ THE CLUB-FACING FIGURES. A member types their name and gets
//     their own categories, their point total and the honorary verdict. If this
//     breaks, the portal is a dead page.
//   * AND NOTHING ELSE. No email address, no student id, no notes, no
//     individual check-ins, and no pending or rejected records leaking in as
//     credit. The functions return shaped answers, so the test reads the keys
//     of those answers rather than trusting the SELECT list.
//   * THE VERDICT IS POSTGRES'S. portal_scorecard() agrees with v_member_status
//     member by member, because invariant 2 says honorary status is computed in
//     Postgres and nowhere else, and a portal that scored people itself would be
//     the first place that stopped being true.
//   * A YEAR IS A BOUNDARY. Last year's credit is not this year's total, and
//     somebody who is not on this year's roster is refused rather than shown a
//     screen of zeroes that reads as "you have attended nothing".
//   * THE TABLES ARE STILL SHUT. anon holds EXECUTE on the four portal
//     functions and on nothing else: not the evaluator they call, not
//     fn_portal_year(), and not a single table or view.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, EXPECTED, MEMBERS, USERS, YEAR_2026, YEAR_2025 } from './helpers/fixture.mjs';

let db;

const anon = (sql, params = []) => db.withRole('anon', null, () => db.val(sql, params));
const anonRows = (sql, params = []) => db.withRole('anon', null, () => db.q(sql, params));

const findMembers = (first, last) =>
  anonRows(`select * from portal_find_members($1, $2)`, [first, last]);

const scorecard = (memberId) => anon(`select portal_scorecard($1)`, [memberId]);
const leaderboard = () => anon(`select portal_leaderboard()`);
const requirements = () => anon(`select portal_requirements()`);

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
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

// ---------------------------------------------------------------------------
// Finding yourself
// ---------------------------------------------------------------------------

test('a name finds the member on this years roster', async () => {
  const rows = await findMembers('Ada', 'Testwood');
  assert.equal(rows.length, 1, 'a member typing their own name found nobody');
  assert.equal(rows[0].member_id, MEMBERS.ada);
  assert.ok(rows[0].joined_on, 'the join date is what tells two of one name apart');
});

test('case, spacing and punctuation do not make somebody a stranger', async () => {
  const rows = await findMembers('  ADA ', 'testwood');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member_id, MEMBERS.ada);
});

test('the name search returns names and ids, never anything else', async () => {
  const rows = await findMembers('Ada', 'Testwood');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['display_name', 'joined_on', 'member_id']);
});

test('half a name finds nobody rather than everybody', async () => {
  assert.deepEqual(await findMembers('Ada', ''), []);
  assert.deepEqual(await findMembers('', ''), []);
  assert.deepEqual(await findMembers(null, null), []);
});

test('two members with one name both come back, to be told apart', async () => {
  // With no address on file, this is the case the portal has to ask about
  // rather than guess at. Ada gets a namesake on this year's roster.
  const twin = '55555555-0000-4000-a000-000000000001';
  await db.exec(`
    insert into members (id, first_name, last_name)
    values ('${twin}', 'Ada', 'Testwood');
    insert into member_enrollments (member_id, academic_year_id, joined_on)
    values ('${twin}', '${YEAR_2026}', date '2026-11-02');
  `);

  const rows = await findMembers('Ada', 'Testwood');
  assert.equal(rows.length, 2, 'the portal picked one of two people with the same name');
  assert.notEqual(rows[0].joined_on?.toISOString?.() ?? rows[0].joined_on,
                  rows[1].joined_on?.toISOString?.() ?? rows[1].joined_on,
                  'nothing on screen would tell these two apart');

  await db.exec(`delete from member_enrollments where member_id = '${twin}';
                 delete from members where id = '${twin}';`);
});

const LAST_YEAR_ONLY = '55555555-0000-4000-a000-0000000000ff';

test('somebody not on this years roster is not found by name', async () => {
  // Last year's member, typing their own name this year. Answering them with a
  // scorecard of zeroes would read as "you have attended nothing".
  await db.exec(`
    insert into members (id, first_name, last_name)
    values ('${LAST_YEAR_ONLY}', 'Wilhelmina', 'Formeryear')
    on conflict (id) do nothing;
    insert into member_enrollments (member_id, academic_year_id, joined_on)
    values ('${LAST_YEAR_ONLY}', '${YEAR_2025}', date '2025-08-19')
    on conflict do nothing;
  `);

  assert.deepEqual(await findMembers('Wilhelmina', 'Formeryear'), []);
});

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------

test('the scorecard is the same verdict v_member_status reaches', async () => {
  for (const [name, id] of Object.entries(MEMBERS)) {
    const expected = EXPECTED[name];
    if (!expected) continue;
    const held = await db.q(
      `select point_total, is_honorary from v_member_status
       where member_id = $1 and academic_year_id = $2`,
      [id, YEAR_2026],
    );
    if (!held.length) continue;

    const card = await scorecard(id);
    assert.equal(
      Number(card.point_total),
      Number(held[0].point_total),
      `${name}: the portal and the view disagree about the point total`,
    );
    assert.equal(
      card.is_honorary,
      held[0].is_honorary,
      `${name}: the portal and the view disagree about the honorary verdict`,
    );
    assert.equal(Number(card.point_total), expected.pointTotal, `${name}: point total drifted`);
    assert.equal(card.is_honorary, expected.isHonorary, `${name}: honorary verdict drifted`);
  }
});

test('every live category is on the scorecard, with this years total in it', async () => {
  const card = await scorecard(MEMBERS.ada);
  const live = await db.val(`select count(*)::int from categories where archived_at is null`);
  assert.equal(card.categories.length, live, 'the scorecard is missing a category');

  for (const category of card.categories) {
    const total = await db.val(
      `select coalesce(sum(total), 0) from v_member_category_totals
       where member_id = $1 and academic_year_id = $2 and category_id = $3`,
      [MEMBERS.ada, YEAR_2026, category.id],
    );
    assert.equal(Number(category.total), Number(total), `${category.name} disagrees with the view`);
  }
});

test('a member with no records reads as zero, not as an error', async () => {
  const card = await scorecard(MEMBERS.dorian);
  assert.equal(Number(card.point_total), 0);
  assert.equal(card.is_honorary, false);
  assert.ok(card.categories.length > 0, 'the categories vanished for somebody with no credit');
  assert.ok(
    card.categories.every((row) => Number(row.total) === 0),
    'somebody with no records was credited with something',
  );
});

test('pending and rejected records are not credit', async () => {
  // Hamish has nothing else. If either status ever counted, this is where a
  // member would see points the officer never approved.
  const card = await scorecard(MEMBERS.hamish);
  assert.equal(Number(card.point_total), 0, 'an unapproved record reached a members total');
});

test('last years credit is not this years total', async () => {
  const card = await scorecard(MEMBERS.ada);
  const thisYear = await db.val(
    `select coalesce(sum(t.total), 0) from v_member_category_totals t
     join categories c on c.id = t.category_id
     where t.member_id = $1 and t.academic_year_id = $2 and c.counts_toward_point_total`,
    [MEMBERS.ada, YEAR_2026],
  );
  assert.equal(Number(card.point_total), Number(thisYear));
});

test('the requirements come back evaluated, with the root among them', async () => {
  const card = await scorecard(MEMBERS.barnaby);
  assert.ok(card.requirements.length > 0, 'the published rules were not evaluated at all');
  assert.ok(card.root_node_id, 'the scorecard does not say which requirement is the whole rule');

  const root = card.requirements.find((row) => row.node_id === card.root_node_id);
  assert.ok(root, 'the root requirement is missing from the list');
  assert.equal(root.passed, card.is_honorary, 'the root verdict and the star disagree');

  // Barnaby fails exactly one requirement, and it is a measured one.
  const failed = card.requirements.filter((row) => row.type === 'threshold' && !row.passed);
  assert.equal(failed.length, 1, 'the fixture no longer fails exactly one requirement');
  assert.ok(failed[0].category_ids.length > 0, 'a measured requirement measures no category');
});

test('the scorecard carries no address, student id or note', async () => {
  const card = await scorecard(MEMBERS.ada);
  assert.deepEqual(Object.keys(card.member).sort(), ['display_name', 'id', 'joined_on']);
  const text = JSON.stringify(card).toLowerCase();
  for (const secret of ['email', 'ucf_nid', 'notes', 'claimed', 'review_note']) {
    assert.ok(!text.includes(secret), `the scorecard carries ${secret}`);
  }
});

test('a member not on this years roster is refused, not zeroed', async () => {
  await db.as('anon', null);
  const err = await db.expectError(`select portal_scorecard($1)`, [LAST_YEAR_ONLY]);
  await db.asOwner();
  assert.equal(err.code, 'PDS03');
  assert.match(err.message, /roster/i);
});

test('an id nobody has is refused the same way', async () => {
  await db.as('anon', null);
  const err = await db.expectError(`select portal_scorecard($1)`, [
    '00000000-0000-4000-a000-0000000000ff',
  ]);
  await db.asOwner();
  assert.equal(err.code, 'PDS03');
});

// ---------------------------------------------------------------------------
// The leaderboard
// ---------------------------------------------------------------------------

test('the leaderboard is this years roster, in point order, with ties level', async () => {
  const board = await leaderboard();
  const enrolled = await db.val(
    `select count(*)::int from member_enrollments me
     join members m on m.id = me.member_id
     where me.academic_year_id = $1 and m.archived_at is null and m.merged_into_id is null`,
    [YEAR_2026],
  );
  assert.equal(board.members.length, enrolled, 'the leaderboard lost or invented a member');

  const totals = board.members.map((row) => Number(row.point_total));
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), 'the leaderboard is not in order');

  // Ties share a rank rather than being numbered arbitrarily.
  for (let i = 1; i < board.members.length; i += 1) {
    if (totals[i] === totals[i - 1]) {
      assert.equal(
        board.members[i].rank,
        board.members[i - 1].rank,
        'two equal totals were given different ranks',
      );
    }
  }
  assert.equal(board.members[0].rank, 1);
});

test('the breakdown ships with the list and agrees with the totals view', async () => {
  const board = await leaderboard();
  const ada = board.members.find((row) => row.member_id === MEMBERS.ada);
  assert.ok(ada, 'Ada is not on the leaderboard');

  for (const category of board.categories) {
    const total = await db.val(
      `select coalesce(sum(total), 0) from v_member_category_totals
       where member_id = $1 and academic_year_id = $2 and category_id = $3`,
      [MEMBERS.ada, YEAR_2026, category.id],
    );
    assert.equal(
      Number(ada.totals[category.id] ?? 0),
      Number(total),
      `${category.name} on the leaderboard disagrees with the view`,
    );
  }

  const counted = board.categories.filter((row) => row.counts_toward_point_total);
  const sum = counted.reduce((acc, row) => acc + Number(ada.totals[row.id] ?? 0), 0);
  assert.equal(sum, Number(ada.point_total), 'the breakdown does not add up to the total shown');
});

test('the leaderboard carries no address, student id or note', async () => {
  const board = await leaderboard();
  const text = JSON.stringify(board).toLowerCase();
  for (const secret of ['email', 'ucf_nid', 'notes', 'claimed']) {
    assert.ok(!text.includes(secret), `the leaderboard carries ${secret}`);
  }
  assert.deepEqual(
    Object.keys(board.members[0]).sort(),
    ['display_name', 'is_honorary', 'member_id', 'point_total', 'rank', 'totals'],
  );
});

// ---------------------------------------------------------------------------
// What an Honorary Member is
// ---------------------------------------------------------------------------

test('the published rules are readable with nobody looked up', async () => {
  const answer = await requirements();
  assert.ok(answer.set, 'no published set reached the portal');
  assert.ok(answer.set.root_node_id, 'the tree has no root to draw from');
  assert.ok(answer.nodes.length > 1, 'the published tree arrived empty');

  const measured = answer.nodes.filter((node) => node.type === 'threshold');
  assert.ok(measured.length > 0);
  assert.ok(
    measured.every((node) => node.min_value !== null),
    'a measured requirement arrived with no number',
  );
  const compound = measured.find((node) => node.categories.length > 1);
  assert.ok(compound, 'the multi-category shape is not represented, so this proves little');
  assert.ok(compound.categories.every((c) => c.name), 'a category arrived with no name');
});

test('the rules and the scorecard describe the same tree', async () => {
  const answer = await requirements();
  const card = await scorecard(MEMBERS.ada);
  assert.equal(answer.set.root_node_id, card.root_node_id);
  assert.deepEqual(
    answer.nodes.map((node) => node.node_id).sort(),
    card.requirements.map((row) => row.node_id).sort(),
    'the rules on the portal are not the rules it scores people against',
  );
});

// ---------------------------------------------------------------------------
// What anon still cannot do
// ---------------------------------------------------------------------------

test('anon holds EXECUTE on the four portal functions and nothing near them', async () => {
  const may = async (name) =>
    db.val(`select has_function_privilege('anon', $1, 'EXECUTE')`, [name]);

  for (const name of [
    'portal_find_members(text, text)',
    'portal_scorecard(uuid)',
    'portal_leaderboard()',
    'portal_requirements()',
  ]) {
    assert.equal(await may(name), true, `anon cannot call ${name}, so the portal is dead`);
  }

  for (const name of [
    'fn_portal_year()',
    'fn_member_requirement_status(uuid, uuid)',
    'start_portal_session()',
    'request_missing_credit(uuid, text, numeric)',
    'upsert_member_and_enroll(text, text, citext, citext, uuid, uuid)',
    'review_records(uuid[], text, text)',
  ]) {
    assert.equal(await may(name), false, `anon can call ${name}`);
  }
});

test('anon still reads no table and no view', async () => {
  for (const relation of [
    'members',
    'member_enrollments',
    'attendance_records',
    'categories',
    'requirement_nodes',
    'v_member_status',
    'v_member_category_totals',
    'profiles',
  ]) {
    await db.as('anon', null);
    const err = await db.expectError(`select * from ${relation} limit 1`);
    await db.asOwner();
    assert.ok(err, `anon read ${relation} directly`);
    assert.match(
      `${err.code} ${err.message}`,
      /42501|permission denied/i,
      `anon was refused ${relation} for the wrong reason: ${err.message}`,
    );
  }
});
