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
import { loadFixture, EXPECTED, MEMBERS, EVENTS, USERS, YEAR_2026, YEAR_2025 } from './helpers/fixture.mjs';

let db;

const anon = (sql, params = []) => db.withRole('anon', null, () => db.val(sql, params));
const anonRows = (sql, params = []) => db.withRole('anon', null, () => db.q(sql, params));

const findMembers = (first, last) =>
  anonRows(`select * from portal_find_members($1, $2)`, [first, last]);

const scorecard = (memberId) => anon(`select portal_scorecard($1)`, [memberId]);
const attendance = (memberId) => anon(`select portal_attendance($1)`, [memberId]);
const leaderboard = () => anon(`select portal_leaderboard()`);
const requirements = () => anon(`select portal_requirements()`);

const categoryIn = (card, name) => card.categories.find((c) => c.name === name);
const eventIn = (category, title) => category?.events.find((e) => e.title === title);

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
    assert.deepEqual(
      Object.keys(category).sort(),
      ['id', 'name', 'total'],
      'a category on the scorecard carries something beyond its name and its total',
    );
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
     where t.member_id = $1 and t.academic_year_id = $2`,
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
// portal_attendance(): a member's own event history (migration 23)
// ---------------------------------------------------------------------------
// Migration 21 deliberately kept individual check-ins off the portal. The club
// asked for that reversed: every published event of the year, by category,
// with what this member did about each one. What is tested here is the part a
// UI test cannot reach: the SQL rules for which row wins, which categories and
// events are in scope, and that nothing an officer alone should see rides
// along in the answer.

test('every event this member could have attended is there, by category, with nothing else mixed in', async () => {
  const card = await attendance(MEMBERS.ada);
  const gbms = categoryIn(card, 'GBMs');
  assert.ok(gbms, 'GBMs is missing from a member enrolled all year');
  assert.equal(gbms.total, 10, 'the section total disagrees with the scorecard total');

  const attended = eventIn(gbms, 'Test GBM Block');
  assert.ok(attended, 'an event Ada attended is missing');
  assert.equal(attended.status, 'attended');
  assert.equal(Number(attended.credit), 9);

  // Ada has no record for this one, and it is scheduled ahead of today, so an
  // absence has not been decided yet: it reads as upcoming rather than as one
  // she missed.
  const speaking = categoryIn(card, 'Media Speaking');
  const notYetHappened = eventIn(speaking, 'Test Media Speaking Spot');
  assert.ok(notYetHappened, 'a future event this member has no record for is missing from the section');
  assert.equal(notYetHappened.status, 'upcoming');
});

test('a past event nobody checked in for reads as none, not as upcoming', async () => {
  // The whole fixture year runs ahead of the real clock, so a genuinely past
  // event has to be created here rather than borrowed from the fixture.
  const eventId = '22222222-0000-4000-a000-00000000ff03';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token)
    values ('${eventId}', '${YEAR_2026}', 'Test Already Happened', current_date - 1, 'tok-past');
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', 'c0000000-0000-4000-a000-000000000001', 'fixed', 1);
  `);

  const card = await attendance(MEMBERS.dorian);
  const row = eventIn(categoryIn(card, 'GBMs'), 'Test Already Happened');
  assert.ok(row, 'the past event is missing entirely');
  assert.equal(row.status, 'none');
  assert.equal(row.credit, null);

  await db.exec(`delete from event_categories where event_id = '${eventId}';
                 delete from events where id = '${eventId}';`);
});

test('an event counting for two categories is listed under both', async () => {
  // Soap Carving is Clinical Workshops and Socials, both fixed, and Ada
  // attended it. A history that drew only the first category link would look
  // identical everywhere else in this fixture.
  const card = await attendance(MEMBERS.ada);
  const clinical = eventIn(categoryIn(card, 'Clinical Workshops'), 'Test Soap Carving Twofer');
  const socials = eventIn(categoryIn(card, 'Socials'), 'Test Soap Carving Twofer');
  assert.ok(clinical, 'Soap Carving is missing from Clinical Workshops');
  assert.ok(socials, 'Soap Carving is missing from Socials');
  assert.equal(clinical.status, 'attended');
  assert.equal(socials.status, 'attended');
});

test('pending and rejected records read as waiting and declined, not as credit', async () => {
  const card = await attendance(MEMBERS.hamish);
  const rejected = eventIn(categoryIn(card, 'GBMs'), 'Test GBM Block');
  const pending = eventIn(categoryIn(card, 'GBMs'), 'Test GBM Single');
  assert.equal(rejected.status, 'declined');
  assert.equal(rejected.credit, null);
  assert.equal(pending.status, 'waiting');
  assert.equal(pending.credit, null);
});

test('an event with no record from this member carries no credit either way', async () => {
  const card = await attendance(MEMBERS.dorian);
  const gbmBlock = eventIn(categoryIn(card, 'GBMs'), 'Test GBM Block');
  assert.ok(gbmBlock, 'a fully enrolled, fully absent member is missing the event entirely');
  assert.notEqual(gbmBlock.status, 'attended');
  assert.equal(gbmBlock.credit, null);
});

test('last years events do not appear in this years history', async () => {
  const card = await attendance(MEMBERS.ada);
  for (const category of card.categories) {
    assert.equal(
      eventIn(category, 'Test Prior Year GBM Block'),
      undefined,
      `${category.name} carries an event from a different academic year`,
    );
  }
});

test('an unpublished event is not on a members own history either', async () => {
  const draftId = '22222222-0000-4000-a000-00000000ff01';
  await db.exec(`
    insert into events (id, academic_year_id, title, occurred_on, checkin_token, is_published)
    values ('${draftId}', '${YEAR_2026}', 'Test Draft Event', date '2026-09-11', 'tok-draft', false);
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${draftId}', 'c0000000-0000-4000-a000-000000000001', 'fixed', 1);
  `);

  const card = await attendance(MEMBERS.ada);
  assert.equal(eventIn(categoryIn(card, 'GBMs'), 'Test Draft Event'), undefined);

  await db.exec(`delete from event_categories where event_id = '${draftId}';
                 delete from events where id = '${draftId}';`);
});

test('a category retired mid year still shows if this member holds credit in it', async () => {
  const memberId = '33333333-0000-4000-a000-000000000001';
  const eventId = '22222222-0000-4000-a000-00000000ff02';
  const categoryId = '44444444-0000-4000-a000-000000000001';
  await db.exec(`
    insert into members (id, first_name, last_name)
    values ('${memberId}', 'Test', 'RetiredCategory');
    insert into member_enrollments (member_id, academic_year_id)
    values ('${memberId}', '${YEAR_2026}');
    insert into categories (id, slug, name, sort_order)
    values ('${categoryId}', 'test-retired-mid-year', 'Test Retired Category', 200);
    insert into events (id, academic_year_id, title, occurred_on, checkin_token)
    values ('${eventId}', '${YEAR_2026}', 'Test Retired Category Event', date '2026-09-12', 'tok-retired');
    insert into event_categories (event_id, category_id, credit_mode, fixed_credit)
    values ('${eventId}', '${categoryId}', 'fixed', 1);
    insert into attendance_records (event_id, member_id, status, source)
    values ('${eventId}', '${memberId}', 'approved', 'officer_entry');
    update categories set archived_at = now() where id = '${categoryId}';
  `);

  const card = await attendance(memberId);
  const retired = categoryIn(card, 'Test Retired Category');
  assert.ok(retired, 'a category the member has credit in vanished when it was archived');
  assert.equal(retired.total, 1);
  assert.equal(eventIn(retired, 'Test Retired Category Event').status, 'attended');

  const other = await attendance(MEMBERS.dorian);
  assert.equal(
    categoryIn(other, 'Test Retired Category'),
    undefined,
    'an archived category with no credit for this member should not appear',
  );

  await db.exec(`
    delete from attendance_records where event_id = '${eventId}';
    delete from event_categories where event_id = '${eventId}';
    delete from events where id = '${eventId}';
    delete from categories where id = '${categoryId}';
    delete from member_enrollments where member_id = '${memberId}';
    delete from members where id = '${memberId}';
  `);
});

test('a rejection followed by a fresh check-in shows where the member stands now, not the rejection', async () => {
  // Dorian has no records at all, so this is entirely self-contained: a
  // rejected row and a later live one for the same event, which
  // one_live_record_per_member_event permits because rejected sits outside it.
  await db.exec(`
    insert into attendance_records (event_id, member_id, status, source, created_at)
    values ('${EVENTS.tabling}', '${MEMBERS.dorian}', 'rejected', 'self_checkin', now() - interval '1 hour');
    insert into attendance_records (event_id, member_id, status, source, created_at)
    values ('${EVENTS.tabling}', '${MEMBERS.dorian}', 'approved', 'officer_entry', now());
  `);

  const card = await attendance(MEMBERS.dorian);
  const row = eventIn(categoryIn(card, 'Tabling'), 'Test Tabling Block');
  assert.ok(row, 'the event is missing entirely');
  assert.equal(row.status, 'attended', 'the superseded rejection is what the history shows');
  assert.equal(Number(row.credit), 2);

  await db.exec(`delete from attendance_records where event_id = '${EVENTS.tabling}' and member_id = '${MEMBERS.dorian}'`);
});

test('an officer-entered record reads identically to a self check-in', async () => {
  // Ada's approved records are all source = officer_entry; Hamish's rejected
  // and pending rows are self_checkin. Neither function branches on source,
  // and this is the one place that would show it if either did.
  const officerEntered = await attendance(MEMBERS.ada);
  const attended = eventIn(categoryIn(officerEntered, 'GBMs'), 'Test GBM Block');
  assert.equal(attended.status, 'attended');
  assert.ok(!('source' in attended), 'source leaked into the payload');
});

test('an event carries the same credit portal_attendance and v_member_category_totals agree on', async () => {
  const card = await attendance(MEMBERS.edda);
  const volunteering = categoryIn(card, 'Volunteering');
  const total = volunteering.events
    .filter((e) => e.status === 'attended')
    .reduce((sum, e) => sum + Number(e.credit), 0);
  assert.equal(total, volunteering.total, 'summing the rows disagrees with the sections own total');
  assert.equal(volunteering.total, 25); // 12.5 + 12.5. The 1 social point from
  // the same event is a different category and is not in this section.
});

test('renaming an event or moving its date is reflected with no data to migrate', async () => {
  const renamed = 'Test GBM Block, Renamed By An Officer';
  await db.exec(
    `update events set title = '${renamed}', occurred_on = date '2026-09-30' where id = '${EVENTS.gbmBlock}'`,
  );

  const card = await attendance(MEMBERS.ada);
  const gbms = categoryIn(card, 'GBMs');
  assert.equal(eventIn(gbms, 'Test GBM Block'), undefined, 'the old title is still there');
  const row = eventIn(gbms, renamed);
  assert.ok(row, 'the renamed event is missing');
  assert.equal(String(row.occurred_on).slice(0, 10), '2026-09-30');
  assert.equal(row.status, 'attended');

  await db.exec(
    `update events set title = 'Test GBM Block', occurred_on = date '2026-09-10' where id = '${EVENTS.gbmBlock}'`,
  );
});

test('merging a duplicate member moves their history to the survivor', async () => {
  const loserId = '33333333-0000-4000-a000-0000000000d2';
  await db.exec(`
    insert into members (id, first_name, last_name)
    values ('${loserId}', 'Dorian', 'Duplicate');
    insert into member_enrollments (member_id, academic_year_id)
    values ('${loserId}', '${YEAR_2026}');
    insert into attendance_records (event_id, member_id, status, source)
    values ('${EVENTS.visits}', '${loserId}', 'approved', 'officer_entry');
  `);

  await db.as('authenticated', USERS.officer);
  await db.val(`select merge_members($1, $2)`, [loserId, MEMBERS.dorian]);
  await db.asOwner();

  const card = await attendance(MEMBERS.dorian);
  const row = eventIn(categoryIn(card, 'Dental School Visits'), 'Test Visits Block');
  assert.ok(row, 'the merged records did not follow to the survivor');
  assert.equal(row.status, 'attended');

  await db.exec(`delete from attendance_records where event_id = '${EVENTS.visits}' and member_id = '${MEMBERS.dorian}'`);
});

test('portal_attendance carries none of an officers context', async () => {
  const card = await attendance(MEMBERS.hamish);
  const text = JSON.stringify(card);
  for (const secret of [
    'review_note',
    'reviewed_by',
    'reviewed_at',
    'submitted_at',
    'flags',
    'claimed_name',
    'claimed_email',
    'source',
    'object_path',
  ]) {
    assert.ok(!text.includes(secret), `portal_attendance carries ${secret}`);
  }
  assert.deepEqual(Object.keys(card.member).sort(), ['display_name', 'id']);
});

test('a member not on this years roster is refused, not zeroed, by portal_attendance too', async () => {
  await db.as('anon', null);
  const err = await db.expectError(`select portal_attendance($1)`, [LAST_YEAR_ONLY]);
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

  // Every category, not a subset: one unit, and all of it is points.
  const sum = board.categories.reduce((acc, row) => acc + Number(ada.totals[row.id] ?? 0), 0);
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

test('anon holds EXECUTE on the five portal functions and nothing near them', async () => {
  const may = async (name) =>
    db.val(`select has_function_privilege('anon', $1, 'EXECUTE')`, [name]);

  for (const name of [
    'portal_find_members(text, text)',
    'portal_scorecard(uuid)',
    'portal_attendance(uuid)',
    'portal_leaderboard()',
    'portal_requirements()',
  ]) {
    assert.equal(await may(name), true, `anon cannot call ${name}, so the portal is dead`);
  }

  for (const name of [
    'fn_portal_year()',
    'fn_member_requirement_status(uuid, uuid)',
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
