// P3, the database half: draft, validate, preview, clone, publish.
//
// The engine itself is covered by engine.test.mjs and flexibility.test.mjs.
// What is proved here is everything AROUND an edit: that a clone is a genuinely
// separate tree, that publishing is one atomic swap, that a ruleset nobody can
// satisfy is refused rather than published, and that the tree cannot be turned
// into something the evaluator answers wrongly.
//
// Every test builds its own ruleset and every test leaves the three requirement
// tables exactly as it found them, restored from a snapshot in afterEach rather
// than by remembering to undo things. See helpers/settings.mjs for why that is
// a hook and not a line at the end of each test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { snapshotTables } from './helpers/settings.mjs';
import {
  loadFixture,
  MEMBERS,
  USERS,
  REQ_SET,
  ROOT_NODE,
  TERM_FALL,
  YEAR_2025,
  YEAR_2026,
} from './helpers/fixture.mjs';

const num = (v) => (v === null || v === undefined ? v : Number(v));

let db;
let snapshot;
let CATS;

// settings.mjs restores one table at a time, and these three cannot be put back
// that way: requirement_sets.root_node_id points at a requirement_node and
// requirement_nodes.requirement_set_id points back, so whichever table goes in
// first breaks a foreign key. The rows go back without their root pointers, and
// the pointers go on afterwards.
async function restoreRequirements() {
  await db.q(`delete from requirement_sets`); // cascades nodes and node categories

  for (const { table, rows } of snapshot) {
    const payload =
      table === 'requirement_sets' ? rows.map((r) => ({ ...r, root_node_id: null })) : rows;
    await db.q(
      `insert into ${table}
       select * from jsonb_populate_recordset(null::${table}, $1::jsonb)`,
      [JSON.stringify(payload)],
    );
  }

  for (const row of snapshot.find((s) => s.table === 'requirement_sets').rows) {
    if (row.root_node_id) {
      await db.q(`update requirement_sets set root_node_id = $1 where id = $2`, [
        row.root_node_id,
        row.id,
      ]);
    }
  }
}

// The smallest ruleset that validates clean:
//
//   group     "Root"            every child must pass
//   |- threshold "Alpha"        [GBMs] >= 1
//   \- group     "Beta"         every child must pass
//      \- threshold "Gamma"     [Socials] >= 1
//
// Each validation case below breaks exactly one thing about it.
async function buildDraft(name, year = YEAR_2026) {
  const setId = await db.val(
    `insert into requirement_sets (academic_year_id, name, version, status)
     values ($1, $2, 1, 'draft') returning id`,
    [year, name],
  );

  const node = (parent, type, label, sort, opts = {}) =>
    db.val(
      `insert into requirement_nodes
         (requirement_set_id, parent_id, type, label, sort_order,
          min_children_passing, min_value)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        setId,
        parent,
        type,
        label,
        sort,
        opts.minChildren ?? null,
        opts.minValue ?? null,
      ],
    );

  const root = await node(null, 'group', 'Root', 0);
  const alpha = await node(root, 'threshold', 'Alpha', 10, { minValue: 1 });
  const beta = await node(root, 'group', 'Beta', 20);
  const gamma = await node(beta, 'threshold', 'Gamma', 30, { minValue: 1 });

  await db.q(
    `insert into requirement_node_categories (node_id, category_id)
     values ($1, $2), ($3, $4)`,
    [alpha, CATS.gbms, gamma, CATS.socials],
  );
  await db.q(`update requirement_sets set root_node_id = $1 where id = $2`, [root, setId]);

  return { setId, root, alpha, beta, gamma };
}

const asOfficer = (fn) => db.withRole('authenticated', USERS.officer, fn);
const asAdmin = (fn) => db.withRole('authenticated', USERS.officer, fn);

const validate = (setId) =>
  asOfficer(() =>
    db.q(`select code, node_id, message from validate_requirement_set($1) order by code`, [
      setId,
    ]),
  );

const validationCodes = async (setId) => (await validate(setId)).map((r) => r.code);

const preview = (setId) =>
  asOfficer(() => db.q(`select * from preview_requirement_set($1)`, [setId]));

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

// The shape of a whole tree, in a form that is comparable across two sets and
// carries no ids. Used to prove a clone matches its original, and later that
// the original did not move while the clone was edited.
const treeShape = (setId) =>
  db.q(
    `select n.label, n.type, n.sort_order, n.min_children_passing, n.min_value, n.term_id,
            (select p.label from requirement_nodes p where p.id = n.parent_id) as parent_label,
            (select coalesce(string_agg(c.slug, ',' order by c.slug), '')
               from requirement_node_categories rnc
               join categories c on c.id = rnc.category_id
              where rnc.node_id = n.id) as cats
       from requirement_nodes n
      where n.requirement_set_id = $1
      order by n.label`,
    [setId],
  );

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  CATS = Object.fromEntries(
    (await db.q(`select slug, id from categories`)).map((r) => [
      r.slug.replace(/-/g, '_'),
      r.id,
    ]),
  );

  // The restore assumes nothing ships archived, and one test archives a
  // category to trip a validation rule.
  assert.equal(
    num(await db.val(`select count(*) from categories where archived_at is not null`)),
    0,
  );

  snapshot = await snapshotTables(db, [
    'requirement_sets',
    'requirement_nodes',
    'requirement_node_categories',
  ]);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.afterEach(async () => {
  await db?.asOwner();
  // Unconditional, because a test that disables a guard to simulate corrupt
  // data must not be able to leave it disabled for the next one.
  await db.exec(`
    alter table requirement_nodes enable trigger requirement_nodes_tree_guard_insert;
    alter table requirement_nodes enable trigger requirement_nodes_tree_guard_update;
  `);
  await restoreRequirements();
  await db.q(`update categories set archived_at = null where archived_at is not null`);
});

test.after(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

test('a clone is the same tree at the next version, and a draft', async () => {
  const cloneId = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));

  const set = await db.one(
    `select academic_year_id, name, version, status, published_at, root_node_id
       from requirement_sets where id = $1`,
    [cloneId],
  );
  assert.equal(set.academic_year_id, YEAR_2026);
  assert.equal(set.name, 'Honorary Member');
  assert.equal(set.version, 2);
  assert.equal(set.status, 'draft');
  assert.equal(set.published_at, null);

  assert.deepEqual(await treeShape(cloneId), await treeShape(REQ_SET));

  const rootRow = await db.one(`select requirement_set_id, parent_id from requirement_nodes where id = $1`, [
    set.root_node_id,
  ]);
  assert.equal(rootRow.requirement_set_id, cloneId, 'the clone points at its own root');
  assert.equal(rootRow.parent_id, null);

  assert.deepEqual(await validate(cloneId), [], 'a clone of a sound set is sound');
});

test('no node in a clone points at a node of the original', async () => {
  const cloneId = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));

  const borrowed = num(
    await db.val(
      `select count(*) from requirement_nodes c
        where c.requirement_set_id = $1
          and (c.id        in (select id from requirement_nodes where requirement_set_id = $2)
            or c.parent_id in (select id from requirement_nodes where requirement_set_id = $2))`,
      [cloneId, REQ_SET],
    ),
  );
  assert.equal(borrowed, 0);

  // And every parent link that exists resolves inside the clone, so the tree
  // was rebuilt rather than flattened.
  const dangling = num(
    await db.val(
      `select count(*) from requirement_nodes c
        where c.requirement_set_id = $1 and c.parent_id is not null
          and not exists (select 1 from requirement_nodes p
                           where p.id = c.parent_id and p.requirement_set_id = $1)`,
      [cloneId],
    ),
  );
  assert.equal(dangling, 0);

  const parented = num(
    await db.val(
      `select count(*) from requirement_nodes
        where requirement_set_id = $1 and parent_id is not null`,
      [cloneId],
    ),
  );
  assert.equal(parented, 12, 'twelve of the thirteen nodes sit under something');
});

test('editing a clone leaves the original evaluating exactly as before', async () => {
  const before = await treeShape(REQ_SET);
  const beforeNames = await honoraryNames();
  const beforePreview = await preview(REQ_SET);

  const cloneId = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));

  // Wreck the clone thoroughly: move a whole subtree, retune thresholds,
  // delete a rule, and change how many children the root needs.
  await db.q(
    `update requirement_nodes set min_value = 999 where requirement_set_id = $1 and type = 'threshold'`,
    [cloneId],
  );
  await db.q(
    `update requirement_nodes set min_children_passing = 1
      where requirement_set_id = $1 and parent_id is null`,
    [cloneId],
  );
  await db.q(
    `update requirement_nodes c
        set parent_id = (select id from requirement_nodes
                          where requirement_set_id = $1 and label = 'Editorial Points')
      where c.requirement_set_id = $1 and c.label = 'Tabling'`,
    [cloneId],
  );
  await db.q(`delete from requirement_nodes where requirement_set_id = $1 and label = 'GBMs'`, [
    cloneId,
  ]);

  assert.deepEqual(await treeShape(REQ_SET), before, 'the original tree is untouched');
  assert.deepEqual(await honoraryNames(), beforeNames);
  assert.deepEqual(await preview(REQ_SET), beforePreview);

  const root = await db.one(
    `select value, target, passed from fn_member_requirement_status($1, $2) where node_id = $3`,
    [MEMBERS.ada, REQ_SET, ROOT_NODE],
  );
  assert.equal(num(root.target), 10, 'the original root still counts ten children');
  assert.equal(root.passed, true);
});

test('cloning twice does not collide on the version already taken', async () => {
  const first = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));
  const second = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));

  assert.equal(num(await db.val(`select version from requirement_sets where id = $1`, [first])), 2);
  assert.equal(num(await db.val(`select version from requirement_sets where id = $1`, [second])), 3);
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

test('publishing archives the set it replaces, in one step', async () => {
  const cloneId = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));

  const result = await asAdmin(() => db.val(`select publish_requirement_set($1)`, [cloneId]));

  assert.equal(result.requirement_set_id, cloneId);
  assert.equal(num(result.version), 2);
  assert.equal(result.archived_set_id, REQ_SET);
  assert.ok(result.published_at, 'the publish time comes back');

  const rows = await db.q(
    `select id, status from requirement_sets where academic_year_id = $1 order by version`,
    [YEAR_2026],
  );
  assert.deepEqual(rows, [
    { id: REQ_SET, status: 'archived' },
    { id: cloneId, status: 'published' },
  ]);

  assert.equal(
    await db.val(`select fn_published_requirement_set($1)`, [YEAR_2026]),
    cloneId,
    'the published set for the year is the new one',
  );
});

test('a year can never hold two published sets', async () => {
  // Through the RPC: publishing a second draft archives the first rather than
  // joining it.
  const first = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));
  await asAdmin(() => db.val(`select publish_requirement_set($1)`, [first]));

  const second = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [first]));
  const result = await asAdmin(() => db.val(`select publish_requirement_set($1)`, [second]));
  assert.equal(result.archived_set_id, first);

  assert.equal(
    num(
      await db.val(
        `select count(*) from requirement_sets where academic_year_id = $1 and status = 'published'`,
        [YEAR_2026],
      ),
    ),
    1,
  );

  // And around it: even the owner, with RLS out of the way entirely, cannot
  // put a second published set into the year.
  const err = await db.expectError(
    `insert into requirement_sets (academic_year_id, name, version, status)
     values ($1, 'Second Published', 9, 'published')`,
    [YEAR_2026],
  );
  assert.equal(err.code, '23505');
  assert.match(err.message, /one_published_set_per_year/);
});

test('publishing an invalid set is refused, and says why', async () => {
  const cloneId = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));
  await db.q(
    `delete from requirement_node_categories
      where node_id in (select id from requirement_nodes
                         where requirement_set_id = $1 and label = 'Tabling')`,
    [cloneId],
  );

  const err = await asAdmin(() => db.expectError(`select publish_requirement_set($1)`, [cloneId]));
  assert.equal(err.code, 'PDS12');
  assert.match(err.message, /threshold_without_category/);

  assert.equal(await db.val(`select status from requirement_sets where id = $1`, [cloneId]), 'draft');
  assert.equal(
    await db.val(`select status from requirement_sets where id = $1`, [REQ_SET]),
    'published',
    'the ruleset in force was not disturbed by a failed publish',
  );
});

test('only a draft can be published', async () => {
  const err = await asAdmin(() => db.expectError(`select publish_requirement_set($1)`, [REQ_SET]));
  assert.equal(err.code, 'PDS03');
  assert.match(err.message, /draft/);
});

test('publishing an unknown set says so', async () => {
  const err = await asAdmin(() =>
    db.expectError(`select publish_requirement_set('d0000000-0000-4000-a000-0000000000de')`),
  );
  assert.equal(err.code, 'PDS08');
});

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

test('the shared admin session can clone and publish', async () => {
  const officerClone = await asOfficer(() =>
    db.val(`select clone_requirement_set($1)`, [REQ_SET]),
  );
  assert.ok(officerClone);

  const result = await asOfficer(() => db.val(`select publish_requirement_set($1)`, [officerClone]));
  assert.equal(result.requirement_set_id, officerClone);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('the ruleset that ships validates clean', async () => {
  assert.deepEqual(await validate(REQ_SET), []);
});

const CASES = [
  {
    code: 'no_root',
    what: 'a set with nothing in it',
    async break(ctx) {
      await db.q(`update requirement_sets set root_node_id = null where id = $1`, [ctx.setId]);
      await db.q(`delete from requirement_nodes where requirement_set_id = $1`, [ctx.setId]);
    },
  },
  {
    code: 'multiple_roots',
    what: 'a second requirement sitting at the top',
    async break(ctx) {
      const stray = await db.val(
        `insert into requirement_nodes (requirement_set_id, type, label, min_value)
         values ($1, 'threshold', 'Stray', 1) returning id`,
        [ctx.setId],
      );
      await db.q(
        `insert into requirement_node_categories (node_id, category_id) values ($1, $2)`,
        [stray, CATS.tabling],
      );
    },
  },
  {
    code: 'root_not_group',
    what: 'a single threshold at the top',
    async break(ctx) {
      await db.q(`delete from requirement_nodes where requirement_set_id = $1 and parent_id is not null`, [
        ctx.setId,
      ]);
      await db.q(
        `update requirement_nodes
            set type = 'threshold', min_value = 1, min_children_passing = null
          where id = $1`,
        [ctx.root],
      );
      await db.q(
        `insert into requirement_node_categories (node_id, category_id) values ($1, $2)`,
        [ctx.root, CATS.tabling],
      );
    },
  },
  {
    code: 'root_node_mismatch',
    what: 'a set that lost its root pointer',
    async break(ctx) {
      await db.q(`update requirement_sets set root_node_id = null where id = $1`, [ctx.setId]);
    },
  },
  {
    code: 'orphan_node',
    what: 'a subtree hanging outside the root',
    async break(ctx) {
      const stray = await db.val(
        `insert into requirement_nodes (requirement_set_id, type, label)
         values ($1, 'group', 'Stray Group') returning id`,
        [ctx.setId],
      );
      const kid = await db.val(
        `insert into requirement_nodes (requirement_set_id, parent_id, type, label, min_value)
         values ($1, $2, 'threshold', 'Stray Rule', 1) returning id`,
        [ctx.setId, stray],
      );
      await db.q(
        `insert into requirement_node_categories (node_id, category_id) values ($1, $2)`,
        [kid, CATS.tabling],
      );
    },
  },
  {
    code: 'cycle',
    what: 'a requirement inside itself',
    async break(ctx) {
      await db.exec(
        `alter table requirement_nodes disable trigger requirement_nodes_tree_guard_update`,
      );
      await db.q(`update requirement_nodes set parent_id = $1 where id = $2`, [
        ctx.gamma,
        ctx.beta,
      ]);
    },
  },
  {
    code: 'foreign_parent',
    what: 'a requirement sitting under another ruleset',
    async break(ctx) {
      await db.exec(
        `alter table requirement_nodes disable trigger requirement_nodes_tree_guard_update`,
      );
      await db.q(`update requirement_nodes set parent_id = $1 where id = $2`, [
        ROOT_NODE,
        ctx.beta,
      ]);
    },
  },
  {
    code: 'foreign_child',
    what: 'another ruleset hanging under this one',
    async break(ctx) {
      const other = await buildDraft('Foreign Child Source');
      await db.exec(
        `alter table requirement_nodes disable trigger requirement_nodes_tree_guard_update`,
      );
      await db.q(`update requirement_nodes set parent_id = $1 where id = $2`, [
        ctx.beta,
        other.alpha,
      ]);
    },
  },
  {
    code: 'threshold_without_category',
    what: 'a requirement that measures nothing',
    async break(ctx) {
      await db.q(`delete from requirement_node_categories where node_id = $1`, [ctx.alpha]);
    },
  },
  {
    code: 'archived_category',
    what: 'a requirement on a retired category',
    async break() {
      await db.q(`update categories set archived_at = now() where slug = 'gbms'`);
    },
  },
  {
    code: 'threshold_with_children',
    what: 'requirements nested under a threshold',
    async break(ctx) {
      await db.q(`update requirement_nodes set parent_id = $1 where id = $2`, [
        ctx.alpha,
        ctx.beta,
      ]);
    },
  },
  {
    code: 'term_year_mismatch',
    what: 'a requirement scoped to another years term',
    year: YEAR_2025,
    async break(ctx) {
      await db.q(`update requirement_nodes set term_id = $1 where id = $2`, [
        TERM_FALL,
        ctx.alpha,
      ]);
    },
  },
  {
    code: 'empty_group',
    what: 'a group with nothing in it',
    async break(ctx) {
      await db.q(`delete from requirement_nodes where id = $1`, [ctx.gamma]);
    },
  },
  {
    code: 'group_min_exceeds_children',
    what: 'a group needing more children than it has',
    async break(ctx) {
      await db.q(`update requirement_nodes set min_children_passing = 5 where id = $1`, [ctx.beta]);
    },
  },
];

for (const c of CASES) {
  test(`validation catches ${c.code}: ${c.what}`, async () => {
    const ctx = await buildDraft(`Case ${c.code}`, c.year ?? YEAR_2026);
    assert.deepEqual(await validate(ctx.setId), [], 'the draft starts sound');

    await c.break(ctx);

    const rows = await validate(ctx.setId);
    const codes = rows.map((r) => r.code);
    assert.ok(codes.includes(c.code), `expected ${c.code}, got ${codes.join(', ') || 'nothing'}`);

    for (const row of rows) {
      assert.ok(row.message.length > 0, `${row.code} has no message`);
      if (row.code !== 'no_root' && row.code !== 'root_node_mismatch') {
        assert.ok(row.node_id, `${row.code} should name a node`);
      }
    }

    // Validation that publishing ignores would not be a guard.
    const err = await asAdmin(() =>
      db.expectError(`select publish_requirement_set($1)`, [ctx.setId]),
    );
    assert.equal(err.code, 'PDS12');
    assert.match(err.message, new RegExp(c.code));
  });
}

// ---------------------------------------------------------------------------
// The tree stays a tree
// ---------------------------------------------------------------------------

test('an officer cannot bend a draft into a cycle', async () => {
  const ctx = await buildDraft('Cycle Attempts');

  await db.as('authenticated', USERS.officer);

  // Root under its own grandchild.
  const loop = await db.expectError(`update requirement_nodes set parent_id = $1 where id = $2`, [
    ctx.gamma,
    ctx.root,
  ]);
  assert.equal(loop.code, 'PDS11');

  const self = await db.expectError(`update requirement_nodes set parent_id = $1 where id = $1`, [
    ctx.beta,
  ]);
  assert.equal(self.code, 'PDS11');

  // And the link that would let a draft reach into the published set.
  const foreign = await db.expectError(
    `update requirement_nodes set parent_id = $1 where id = $2`,
    [ROOT_NODE, ctx.beta],
  );
  assert.equal(foreign.code, 'PDS11');

  const inserted = await db.expectError(
    `insert into requirement_nodes (requirement_set_id, parent_id, type, label, min_value)
     values ($1, $2, 'threshold', 'Reaching Out', 1)`,
    [ctx.setId, ROOT_NODE],
  );
  assert.equal(inserted.code, 'PDS11');

  await db.asOwner();

  // Nothing landed, so the draft is still exactly what it was.
  assert.deepEqual(await validate(ctx.setId), []);
});

test('a cycle cannot hang the evaluator', async () => {
  const ctx = await buildDraft('Cycle Survival');

  // The trigger makes this state unreachable, so it has to be forced to prove
  // what the evaluator does if it ever meets one anyway.
  await db.exec(
    `alter table requirement_nodes disable trigger requirement_nodes_tree_guard_update`,
  );
  await db.q(`update requirement_nodes set parent_id = $1 where id = $2`, [ctx.gamma, ctx.root]);

  const bounded = (promise) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the evaluator did not come back')), 10_000).unref(),
      ),
    ]);

  // Every node is now inside the loop, so the set has no top-level requirement
  // at all. That is refused rather than answered with a silent no.
  const err = await bounded(
    db.expectError(`select * from fn_member_requirement_status($1, $2)`, [
      MEMBERS.ada,
      ctx.setId,
    ]),
  );
  assert.equal(err.code, 'PDS11');

  // A loop further down leaves a usable top, and the evaluator answers for the
  // part of the tree that is still a tree.
  await db.q(`update requirement_nodes set parent_id = null where id = $1`, [ctx.root]);
  await db.q(`update requirement_nodes set parent_id = $1 where id = $2`, [ctx.gamma, ctx.beta]);

  const rows = await bounded(
    db.q(`select label, passed from fn_member_requirement_status($1, $2)`, [
      MEMBERS.ada,
      ctx.setId,
    ]),
  );
  assert.equal(rows.length, 4);

  const codes = await validationCodes(ctx.setId);
  assert.ok(codes.includes('cycle'));

  await db.exec(
    `alter table requirement_nodes enable trigger requirement_nodes_tree_guard_update`,
  );
});

test('a node in another set cannot change what a published group counts', async () => {
  const before = await db.one(
    `select value, target, passed from fn_member_requirement_status($1, $2) where node_id = $3`,
    [MEMBERS.ada, REQ_SET, ROOT_NODE],
  );

  // Forced past the trigger, because the arithmetic has to be right even if the
  // row somehow exists.
  const ctx = await buildDraft('Foreign Reach');
  await db.exec(
    `alter table requirement_nodes disable trigger requirement_nodes_tree_guard_update`,
  );
  await db.q(`update requirement_nodes set parent_id = $1 where id = $2`, [ROOT_NODE, ctx.alpha]);

  const after = await db.one(
    `select value, target, passed from fn_member_requirement_status($1, $2) where node_id = $3`,
    [MEMBERS.ada, REQ_SET, ROOT_NODE],
  );
  assert.deepEqual(after, before);
  assert.equal(num(after.target), 10);

  const codes = await validationCodes(REQ_SET);
  assert.ok(codes.includes('foreign_child'), 'and it is reported rather than ignored');
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('preview on a draft matches what happens once it is published', async () => {
  const cloneId = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));

  // The change an officer would actually make: one threshold, one integer.
  // Barnaby is one clinical workshop short under the published rules.
  await db.q(
    `update requirement_nodes set min_value = 4
      where requirement_set_id = $1 and label = 'Clinical Workshops'`,
    [cloneId],
  );

  const predicted = await preview(cloneId);
  const root = predicted.find((r) => r.label === 'Honorary Member');
  assert.equal(num(root.passing), 3);
  assert.equal(num(root.total), 10, 'the denominator is this years roster');
  assert.equal(predicted.length, 13, 'one row per node, root included');

  await asAdmin(() => db.val(`select publish_requirement_set($1)`, [cloneId]));

  // What actually happened, computed from the published set rather than from
  // preview, node by node.
  const actual = await db.q(
    `select f.node_id, f.label, count(*) filter (where f.passed)::int as passing
       from member_enrollments me
       cross join lateral fn_member_requirement_status(me.member_id, $1) f
      where me.academic_year_id = $2 and me.status = 'active'
      group by f.node_id, f.label`,
    [cloneId, YEAR_2026],
  );

  const predictedBy = Object.fromEntries(predicted.map((r) => [r.node_id, num(r.passing)]));
  const actualBy = Object.fromEntries(actual.map((r) => [r.node_id, num(r.passing)]));
  assert.deepEqual(actualBy, predictedBy);

  assert.deepEqual(await honoraryNames(), ['Ada', 'Barnaby', 'Cressida']);
  assert.equal(
    num(
      await db.val(
        `select count(*) from v_member_status where academic_year_id = $1 and is_honorary`,
        [YEAR_2026],
      ),
    ),
    num(root.passing),
  );
});

test('preview counts the set own year, not the current one', async () => {
  const ctx = await buildDraft('Preview Year Scoping', YEAR_2025);
  const rows = await preview(ctx.setId);

  // Only Imogen is enrolled in 2025-2026 in the fixture.
  assert.equal(num(rows[0].total), 1);
  assert.equal(rows.length, 4);
});

// ---------------------------------------------------------------------------
// Published sets are read-only
// ---------------------------------------------------------------------------

test('the shared admin cannot edit the tree of a published set', async () => {
  await db.as('authenticated', USERS.officer);

  const updated = await db.q(
    `update requirement_nodes set min_value = 1 where requirement_set_id = $1 returning id`,
    [REQ_SET],
  );
  assert.equal(updated.length, 0, 'the shared admin must not edit a published tree');

  const deleted = await db.q(
    `delete from requirement_node_categories
      where node_id in (select id from requirement_nodes where requirement_set_id = $1)
      returning node_id`,
    [REQ_SET],
  );
  assert.equal(deleted.length, 0, 'the shared admin must not detach a published categorys rule');

  const err = await db.expectError(
    `insert into requirement_nodes (requirement_set_id, parent_id, type, label, min_value)
     values ($1, $2, 'threshold', 'Snuck In', 1)`,
    [REQ_SET, ROOT_NODE],
  );
  assert.equal(err.code, '42501', 'the shared admin must not add to a published tree');

  await db.asOwner();
});

test('an archived set is as closed as a published one', async () => {
  const cloneId = await asOfficer(() => db.val(`select clone_requirement_set($1)`, [REQ_SET]));
  await asAdmin(() => db.val(`select publish_requirement_set($1)`, [cloneId]));

  await db.as('authenticated', USERS.officer);
  const updated = await db.q(
    `update requirement_nodes set min_value = 1 where requirement_set_id = $1 returning id`,
    [REQ_SET],
  );
  await db.asOwner();
  assert.equal(updated.length, 0, 'last years record stays as it was');
});

test('an officer can still build and edit a draft', async () => {
  const ctx = await buildDraft('Officer Editing');

  await db.as('authenticated', USERS.officer);
  const updated = await db.q(
    `update requirement_nodes set min_value = 3 where id = $1 returning id`,
    [ctx.alpha],
  );
  const added = await db.q(
    `insert into requirement_nodes (requirement_set_id, parent_id, type, label, min_value)
     values ($1, $2, 'threshold', 'Delta', 2) returning id`,
    [ctx.setId, ctx.root],
  );
  await db.asOwner();

  assert.equal(updated.length, 1);
  assert.equal(added.length, 1);
});
