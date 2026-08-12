// The requirements evaluator, against the hand-built fixture.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import {
  loadFixture,
  MEMBERS,
  EXPECTED,
  EXPECTED_HONORARY_COUNT,
  EXPECTED_ADA_CATEGORY_TOTALS,
  EXPECTED_CRESSIDA_THRESHOLDS,
  EXPECTED_CHILDREN_PASSING,
  REQ_SET,
  ROOT_NODE,
  YEAR_2026,
  YEAR_2025,
  TERM_FALL,
  TERM_SPRING,
} from './helpers/fixture.mjs';

const num = (v) => (v === null || v === undefined ? v : Number(v));

let db;

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);
});

// A failing assertion can leave the connection inside `set role`, which would
// then leak into every later test in the file. Reset before each one.
test.beforeEach(async () => {
  await db?.asOwner();
});

test.after(async () => {
  await db?.close();
});

test('every fixture member has the point total derived by hand', async () => {
  const rows = await db.q(
    `select m.first_name, s.point_total
       from v_member_status s
       join members m on m.id = s.member_id
      where s.academic_year_id = $1
      order by m.first_name`,
    [YEAR_2026],
  );

  const got = Object.fromEntries(
    rows.map((r) => [r.first_name.toLowerCase(), num(r.point_total)]),
  );
  const want = Object.fromEntries(
    Object.entries(EXPECTED).map(([k, v]) => [k, v.pointTotal]),
  );

  assert.deepEqual(got, want);
});

test('every fixture member has the honorary verdict derived by hand', async () => {
  const rows = await db.q(
    `select m.first_name, s.is_honorary
       from v_member_status s
       join members m on m.id = s.member_id
      where s.academic_year_id = $1`,
    [YEAR_2026],
  );

  const got = Object.fromEntries(
    rows.map((r) => [r.first_name.toLowerCase(), r.is_honorary]),
  );
  const want = Object.fromEntries(
    Object.entries(EXPECTED).map(([k, v]) => [k, v.isHonorary]),
  );

  assert.deepEqual(got, want);
});

test('the honorary count matches', async () => {
  const n = await db.val(
    `select count(*) from v_member_status where academic_year_id = $1 and is_honorary`,
    [YEAR_2026],
  );
  assert.equal(num(n), EXPECTED_HONORARY_COUNT);
});

test('category totals feeding the thresholds are right, not just consistent', async () => {
  const rows = await db.q(
    `select c.slug, t.total
       from v_member_category_totals t
       join categories c on c.id = t.category_id
      where t.member_id = $1 and t.academic_year_id = $2`,
    [MEMBERS.ada, YEAR_2026],
  );

  const got = Object.fromEntries(rows.map((r) => [r.slug, num(r.total)]));
  assert.deepEqual(got, EXPECTED_ADA_CATEGORY_TOTALS);
});

test('a member who fails exactly one requirement fails exactly one node', async () => {
  const failed = await db.q(
    `select label, value, target
       from fn_member_requirement_status($1, $2)
      where type = 'threshold' and not passed`,
    [MEMBERS.barnaby, REQ_SET],
  );

  assert.equal(failed.length, 1);
  assert.equal(failed[0].label, 'Clinical Workshops');
  assert.equal(num(failed[0].value), 4);
  assert.equal(num(failed[0].target), 5);
});

test('a member exactly on every boundary passes every threshold', async () => {
  const rows = await db.q(
    `select label, value, target, passed
       from fn_member_requirement_status($1, $2)
      where type = 'threshold'`,
    [MEMBERS.cressida, REQ_SET],
  );

  assert.equal(rows.length, 11);
  for (const r of rows) {
    const want = EXPECTED_CRESSIDA_THRESHOLDS[r.label];
    assert.equal(num(r.value), want, `${r.label} value`);
    assert.equal(num(r.target), want, `${r.label} target`);
    assert.equal(r.passed, true, `${r.label} passes on equality, so >= not >`);
  }
});

test('the nested Editorial group passes on its own even when the root does not', async () => {
  const rows = await db.q(
    `select label, type, value, target, passed
       from fn_member_requirement_status($1, $2)
      where label in ('Honorary Member', 'Editorial Points', 'Speaking', 'Writing')`,
    [MEMBERS.jasper, REQ_SET],
  );
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));

  // Reached through Media Speaking and Media Writing, the second category of
  // each multi-category threshold.
  assert.equal(by.Speaking.passed, true);
  assert.equal(by.Writing.passed, true);

  assert.equal(by['Editorial Points'].type, 'group');
  assert.equal(by['Editorial Points'].passed, true);
  assert.equal(num(by['Editorial Points'].value), 2);
  assert.equal(num(by['Editorial Points'].target), 2);

  assert.equal(by['Honorary Member'].passed, false);
  assert.equal(num(by['Honorary Member'].value), 1);
  assert.equal(num(by['Honorary Member'].target), 10);
});

test('group nodes count children passed, deepest first', async () => {
  for (const [who, expected] of Object.entries(EXPECTED_CHILDREN_PASSING)) {
    const row = await db.one(
      `select value, target, passed
         from fn_member_requirement_status($1, $2)
        where node_id = $3`,
      [MEMBERS[who], REQ_SET, ROOT_NODE],
    );
    assert.equal(num(row.value), expected, `${who} children passing`);
    assert.equal(num(row.target), 10, `${who} target`);
    assert.equal(row.passed, EXPECTED[who].isHonorary, `${who} root verdict`);
  }
});

test('pending and rejected records earn nothing', async () => {
  const gbms = await db.one(
    `select value from fn_member_requirement_status($1, $2) where label = 'GBMs'`,
    [MEMBERS.hamish, REQ_SET],
  );
  assert.equal(num(gbms.value), 0);
});

test('credit from another academic year does not leak into this one', async () => {
  const thisYear = await db.one(
    `select point_total from v_member_status where member_id = $1 and academic_year_id = $2`,
    [MEMBERS.imogen, YEAR_2026],
  );
  assert.equal(num(thisYear.point_total), 0);

  // The credit is real, it is simply somewhere else.
  const lastYear = await db.one(
    `select point_total, is_honorary from v_member_status
      where member_id = $1 and academic_year_id = $2`,
    [MEMBERS.imogen, YEAR_2025],
  );
  assert.equal(num(lastYear.point_total), 9);

  // 2025-2026 has no published requirement set in this fixture, so the
  // evaluator is never called and honorary falls back to false rather than
  // erroring on a null set id.
  assert.equal(lastYear.is_honorary, false);
});

test('an event linked to two categories with different credit modes credits both', async () => {
  // Greta attended vol_social once. It should yield 3 volunteering hours from
  // her submitted value, and 1 social from the fixed link on the same event.
  const rows = await db.q(
    `select c.slug, v.credit
       from v_attendance_credit v
       join categories c on c.id = v.category_id
      where v.member_id = $1 and v.event_id =
            (select id from events where checkin_token = 'tok-vol-social')`,
    [MEMBERS.greta],
  );

  const got = Object.fromEntries(rows.map((r) => [r.slug, num(r.credit)]));
  assert.deepEqual(got, { volunteering: 3, socials: 1 });
});

test('a term-scoped threshold counts only events inside that term', async () => {
  // Ada has 9 GBM credits in Fall 2026 and 1 in Spring 2027. A node scoped to
  // a term must see only its own term's events.
  await db.asOwner();
  await db.exec(`
    insert into requirement_sets (id, academic_year_id, name, version, status)
    values ('d0000000-0000-4000-a000-0000000000ff', '${YEAR_2026}', 'Per Semester Test', 1, 'draft');

    insert into requirement_nodes
      (id, requirement_set_id, parent_id, type, label, sort_order, min_value, term_id)
    values
      ('e0000000-0000-4000-a000-0000000000f1', 'd0000000-0000-4000-a000-0000000000ff', null,
       'threshold', 'Fall GBMs', 10, 9, '${TERM_FALL}'),
      ('e0000000-0000-4000-a000-0000000000f2', 'd0000000-0000-4000-a000-0000000000ff', null,
       'threshold', 'Spring GBMs', 20, 9, '${TERM_SPRING}');

    insert into requirement_node_categories (node_id, category_id) values
      ('e0000000-0000-4000-a000-0000000000f1', 'c0000000-0000-4000-a000-000000000001'),
      ('e0000000-0000-4000-a000-0000000000f2', 'c0000000-0000-4000-a000-000000000001');
  `);

  const rows = await db.q(
    `select label, value, passed
       from fn_member_requirement_status($1, 'd0000000-0000-4000-a000-0000000000ff')
      order by label`,
    [MEMBERS.ada],
  );
  const by = Object.fromEntries(rows.map((r) => [r.label, r]));

  assert.equal(num(by['Fall GBMs'].value), 9);
  assert.equal(by['Fall GBMs'].passed, true);
  assert.equal(num(by['Spring GBMs'].value), 1);
  assert.equal(by['Spring GBMs'].passed, false);

  await db.exec(
    `delete from requirement_sets where id = 'd0000000-0000-4000-a000-0000000000ff'`,
  );
});
