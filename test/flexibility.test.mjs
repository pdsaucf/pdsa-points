// Acceptance test 6: the engine bends without code changing.
//
// "All ten categories" becoming "any eight of ten" must be a single integer
// update to one row. If this test ever needs a migration, a deploy or a code
// change to pass, the invariant it guards has been broken.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import {
  loadFixture,
  EXPECTED_HONORARY_COUNT,
  EXPECTED_HONORARY_COUNT_AT_8,
  MEMBERS,
  REQ_SET,
  ROOT_NODE,
  YEAR_2026,
} from './helpers/fixture.mjs';

let db;

const honoraryCount = async () =>
  Number(
    await db.val(
      `select count(*) from v_member_status where academic_year_id = $1 and is_honorary`,
      [YEAR_2026],
    ),
  );

const honoraryNames = async () =>
  (
    await db.q(
      `select m.first_name
         from v_member_status s
         join members m on m.id = s.member_id
        where s.academic_year_id = $1 and s.is_honorary
        order by m.first_name`,
      [YEAR_2026],
    )
  ).map((r) => r.first_name);

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

test('changing min_children_passing to 8 changes who qualifies, and reverting restores it', async () => {
  assert.equal(await honoraryCount(), EXPECTED_HONORARY_COUNT);
  assert.deepEqual(await honoraryNames(), ['Ada', 'Cressida']);

  // The entire change. One integer, one row, no deploy.
  await db.q(`update requirement_nodes set min_children_passing = 8 where id = $1`, [
    ROOT_NODE,
  ]);

  assert.equal(await honoraryCount(), EXPECTED_HONORARY_COUNT_AT_8);
  assert.deepEqual(await honoraryNames(), ['Ada', 'Barnaby', 'Cressida']);

  // Barnaby passes nine of ten. Under "all ten" he failed; under "any eight"
  // he qualifies, and the root now reports the rule it was actually judged by.
  const root = await db.one(
    `select value, target, passed
       from fn_member_requirement_status($1, $2) where node_id = $3`,
    [MEMBERS.barnaby, REQ_SET, ROOT_NODE],
  );
  assert.equal(Number(root.value), 9);
  assert.equal(Number(root.target), 8);
  assert.equal(root.passed, true);

  await db.q(`update requirement_nodes set min_children_passing = null where id = $1`, [
    ROOT_NODE,
  ]);

  assert.equal(await honoraryCount(), EXPECTED_HONORARY_COUNT);
  assert.deepEqual(await honoraryNames(), ['Ada', 'Cressida']);
});

test('a threshold moves the same way, from data alone', async () => {
  // Barnaby is the only member sitting one short of Clinical Workshops.
  // Lowering that one threshold should let him and nobody else through.
  await db.q(
    `update requirement_nodes set min_value = 4 where label = 'Clinical Workshops'`,
  );
  assert.deepEqual(await honoraryNames(), ['Ada', 'Barnaby', 'Cressida']);

  await db.q(
    `update requirement_nodes set min_value = 5 where label = 'Clinical Workshops'`,
  );
  assert.deepEqual(await honoraryNames(), ['Ada', 'Cressida']);
});

test('a new category and rule appear in the tree with no code change', async () => {
  await db.exec(`
    insert into categories (id, slug, name, sort_order)
    values ('c0000000-0000-4000-a000-0000000000ff', 'test-outreach', 'Test Outreach', 140);

    insert into requirement_nodes
      (id, requirement_set_id, parent_id, type, label, sort_order, min_value)
    values ('e0000000-0000-4000-a000-0000000000fe',
            'd0000000-0000-4000-a000-000000000001',
            'e0000000-0000-4000-a000-000000000000',
            'threshold', 'Test Outreach', 130, 1);

    insert into requirement_node_categories (node_id, category_id)
    values ('e0000000-0000-4000-a000-0000000000fe', 'c0000000-0000-4000-a000-0000000000ff');
  `);

  // Eleven children now, and nobody has any Test Outreach credit, so the
  // requirement everyone previously met is no longer met by anyone.
  const root = await db.one(
    `select value, target from fn_member_requirement_status($1, $2) where node_id = $3`,
    [MEMBERS.ada, REQ_SET, ROOT_NODE],
  );
  assert.equal(Number(root.target), 11);
  assert.equal(Number(root.value), 10);
  assert.equal(await honoraryCount(), 0);

  await db.exec(`
    delete from requirement_node_categories
      where node_id = 'e0000000-0000-4000-a000-0000000000fe';
    delete from requirement_nodes where id = 'e0000000-0000-4000-a000-0000000000fe';
    delete from categories where id = 'c0000000-0000-4000-a000-0000000000ff';
  `);
  assert.equal(await honoraryCount(), EXPECTED_HONORARY_COUNT);
});
