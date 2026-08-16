// Checks for the requirements editor.
//
// The rule from verify.mjs and verify-admin.mjs holds: assert the things that
// fail SILENTLY. A tree that draws is easy to see. What is not:
//
//   1. That a PUBLISHED set is genuinely read-only. RLS answers an officer's
//      refused UPDATE with 200 and an empty array, so a client that does not
//      count the rows would report an edit that never happened, and last year's
//      members would appear to have been rejudged.
//   2. That publishing is an admin's decision and an officer is told so before
//      pressing anything.
//   3. That a requirement measuring TWO categories survives a round trip. The
//      compound editorial rule is the one shape a simpler editor would quietly
//      flatten to one category, and nothing on screen would look wrong.
//   4. That the preview actually moves when a threshold or a group's "at least
//      N" moves. A preview wired to nothing looks identical to a working one.
//   5. That a validation problem lands against the requirement it belongs to
//      rather than in a heap at the top.
//   6. That the database's own vocabulary never reaches the screen. "node" and
//      "threshold" are what these rows are called in SQL and are exactly what
//      docs/03-admin-ui.md forbids an officer being shown.
//
// Run: node web/mock/verify-requirements.mjs   (npm run verify:requirements)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';
import { IDS } from './admin-fixtures.mjs';

const PORT = 8797;
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

globalThis.__PDSA_CONFIG__ = {
  SUPABASE_URL: `http://localhost:${PORT}`,
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

const auth = await import('../src/auth.js');
const { select, insert, patch, remove, callRpc } = await import('../src/rest.js');
const { describeOfficer } = await import('../src/officer-errors.js');
const { RpcError } = await import('../src/errors.js');
const model = await import('../src/requirement-model.js');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

const api = (path) => fetch(`http://localhost:${PORT}${path}`).then((r) => r.json());
const reset = async () => {
  await api('/__mock/reset');
  auth.forgetSession();
};

async function signInAs(email) {
  auth.forgetSession();
  await auth.sendMagicLink(email, `http://localhost:${PORT}/admin/`);
  const { url } = await api(`/__mock/magic-link?email=${encodeURIComponent(email)}`);
  const parsed = auth.parseAuthRedirect(url);
  assert.ok(parsed?.session, `no session in the sign-in link for ${email}`);
  auth.adoptSession(parsed.session);
  return parsed.session;
}

// The same two queries the screen makes.
const NODE_SELECT =
  'id,requirement_set_id,parent_id,type,label,sort_order,min_children_passing,min_value,term_id,requirement_node_categories(category_id)';

const loadSet = async (setId) => {
  const rows = await select('requirement_nodes', {
    select: NODE_SELECT,
    filters: { requirement_set_id: `eq.${setId}` },
    order: 'sort_order.asc',
  });
  const set = (
    await select('requirement_sets', {
      select: 'id,academic_year_id,name,version,status,root_node_id,published_at',
      filters: { id: `eq.${setId}` },
    })
  )[0];
  return { set, ...model.buildTree(rows, set?.root_node_id) };
};

const previewOf = async (setId) => {
  const rows = await callRpc('preview_requirement_set', { p_set_id: setId });
  return new Map(rows.map((row) => [row.node_id, { passing: row.passing, total: row.total }]));
};

const server = await startMock(PORT);

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const sources = {
  'src/requirements.js': await readFile(`${WEB_ROOT}src/requirements.js`, 'utf8'),
  'src/categories.js': await readFile(`${WEB_ROOT}src/categories.js`, 'utf8'),
  'src/requirement-model.js': await readFile(`${WEB_ROOT}src/requirement-model.js`, 'utf8'),
};
const adminHtml = await readFile(`${WEB_ROOT}admin/index.html`, 'utf8');
const adminCss = await readFile(`${WEB_ROOT}assets/css/admin.css`, 'utf8');
const selfSource = await readFile(new URL(import.meta.url), 'utf8');

await check('no em dash in anything this screen is made of', () => {
  const emDash = String.fromCharCode(0x2014);
  for (const [label, source] of [
    ...Object.entries(sources),
    ['admin/index.html', adminHtml],
    ['assets/css/admin.css', adminCss],
    ['mock/verify-requirements.mjs', selfSource],
  ]) {
    assert.ok(!source.includes(emDash), `${label} contains an em dash`);
  }
});

/**
 * Every string literal in a module, minus the ones that are plainly not copy.
 *
 * A table name, a column, a class or a PostgREST filter is all lower case with
 * no spaces; anything an officer reads has a capital letter or a space in it.
 * That is the whole rule, and it is what lets this check see the difference
 * between select('requirement_nodes') and a sentence about requirement nodes.
 */
function uiStrings(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const found = [];
  const patterns = [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g, /`((?:[^`\\]|\\.)*)`/g];
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      const text = match[1];
      if (!text) continue;
      if (!/\s/.test(text) && !/[A-Z]/.test(text)) continue; // an identifier, not copy
      found.push(text);
    }
  }
  return found;
}

await check('the database vocabulary never reaches the screen', () => {
  // docs/03-admin-ui.md: no "schema", no "node". An officer sees requirements
  // and groups, and nothing else.
  const banned = [
    'node',
    'nodes',
    'threshold',
    'thresholds',
    'schema',
    'RLS',
    'RPC',
    'PostgREST',
    'constraint',
    'foreign key',
    'uuid',
    'jsonb',
    'boolean',
  ];

  const copy = [
    ...Object.entries(sources).flatMap(([label, source]) =>
      uiStrings(source).map((text) => [label, text]),
    ),
    // The markup, comments stripped, is read by an officer as it stands.
    ['admin/index.html', adminHtml.replace(/<!--[\s\S]*?-->/g, ' ')],
  ];

  for (const [label, text] of copy) {
    for (const word of banned) {
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i'),
        `${label} shows the word "${word}": ${JSON.stringify(text.slice(0, 90))}`,
      );
    }
  }
});

await check('a sentence the database wrote is cleaned before it is shown', () => {
  const said = model.plainly(
    'Requirement node measures category "Journal Club", which is archived. Threshold nodes need a schema.',
  );
  assert.doesNotMatch(said, /\bnodes?\b/i);
  assert.doesNotMatch(said, /\bthresholds?\b/i);
  assert.doesNotMatch(said, /\bschemas?\b/i);
  assert.match(said, /Journal Club/);
});

await check('an unknown problem still says something an officer can act on', () => {
  const described = model.describeProblem({
    code: 'something_added_next_year',
    node_id: 'n1',
    message: 'Group node has no children.',
  });
  assert.equal(described.nodeId, 'n1');
  assert.doesNotMatch(`${described.title} ${described.body}`, /\bnodes?\b/i);
  assert.match(described.body, /children/);
});

await check('a known problem uses the copy written for it, not the database sentence', () => {
  const described = model.describeProblem({
    code: 'rule_on_archived_category',
    node_id: 'n1',
    message: 'Requirement node measures category "X", which is archived.',
  });
  assert.equal(described.title, 'Measures a retired category');
  assert.doesNotMatch(described.body, /\bnodes?\b/i);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe tree, as data\n');
// ---------------------------------------------------------------------------

await check('the unit word comes from the categories, and is honest about a mix', () => {
  const events = [{ unit: 'event_count', unit_label: null }];
  const hours = [{ unit: 'hours', unit_label: 'hour' }];
  assert.equal(model.unitWord(events), 'events');
  assert.equal(model.unitWord(hours), 'hours');
  assert.equal(model.unitWord([...events, ...hours]), '');
  assert.equal(model.unitWord([]), '');

  // Two categories can share `unit` and still disagree on unit_label: 'hours'
  // labelled 'hour' on one row and 'session' on another. kinds.size is 1 there,
  // so the mixed-unit branch above does not catch it on its own, and without a
  // separate check on labels.size this used to fall through to UNIT_WORD.hours
  // and print "hours" for a category nobody called that. Same dishonesty as
  // the mixed-unit case, same answer: nothing.
  const sessions = [{ unit: 'hours', unit_label: 'session' }];
  assert.equal(
    model.unitWord([...hours, ...sessions]),
    '',
    'a disagreeing pair of labels on the same unit printed a word instead of nothing',
  );
});

await check('moving a row reports only the rows that actually moved', () => {
  const siblings = [
    { id: 'a', sort_order: 10, label: 'a' },
    { id: 'b', sort_order: 20, label: 'b' },
    { id: 'c', sort_order: 30, label: 'c' },
  ];
  const changed = model.reorderWithin(siblings, 'c', -1);
  assert.deepEqual(changed, [
    { id: 'c', sort_order: 20 },
    { id: 'b', sort_order: 30 },
  ]);
  assert.deepEqual(model.reorderWithin(siblings, 'a', -1), [], 'the first row moved up');
  assert.deepEqual(model.reorderWithin(siblings, 'c', 1), [], 'the last row moved down');
});

await check('a group is never offered a move into itself', () => {
  const rows = [
    { id: 'root', parent_id: null, type: 'group', label: 'Honorary Member', sort_order: 0 },
    { id: 'g1', parent_id: 'root', type: 'group', label: 'Editorial Points', sort_order: 10 },
    { id: 'g2', parent_id: 'g1', type: 'group', label: 'Inside', sort_order: 10 },
    { id: 't1', parent_id: 'g2', type: 'threshold', label: 'Speaking', sort_order: 10 },
  ];
  const { root, byId } = model.buildTree(rows, 'root');
  const targets = model.movableInto(root, byId.get('g1')).map((entry) => entry.item.id);
  assert.deepEqual(targets, ['root'], 'a group could be moved inside itself or its own child');
});

await check('the newest draft is what the screen opens on', () => {
  const sets = [
    { id: 'p', version: 1, status: 'published' },
    { id: 'd2', version: 3, status: 'draft' },
    { id: 'd1', version: 2, status: 'draft' },
  ];
  assert.equal(model.preferredSet(sets).id, 'd2');
  assert.equal(model.preferredSet([{ id: 'p', version: 1, status: 'published' }]).id, 'p');
  assert.equal(model.preferredSet([]), null);
  assert.equal(model.setOptionLabel({ version: 2, status: 'draft' }), 'Draft version 2');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe rules an officer opens\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('the published set reads as the sentence in the wireframe', async () => {
  const { set, root, byId } = await loadSet(IDS.SET_CURRENT);
  assert.equal(set.status, 'published');
  assert.equal(root.id, IDS.NODES.root);
  assert.equal(root.min_children_passing, null, 'the root should be "all of the following"');

  const rows = model.flatten(root).slice(1);
  assert.deepEqual(
    rows.map((row) => `${'  '.repeat(row.depth - 1)}${row.item.label}`),
    ['GBMs', 'Volunteering', 'Socials', 'Tabling', 'Editorial Points', '  Speaking', '  Writing'],
  );

  const gbms = byId.get(IDS.NODES.gbms);
  assert.equal(Number(gbms.min_value), 9);
  assert.deepEqual(gbms.categoryIds, [IDS.CATEGORY_GBMS]);
});

await check('a requirement can measure two categories at once', async () => {
  const { byId } = await loadSet(IDS.SET_CURRENT);
  const speaking = byId.get(IDS.NODES.speaking);
  assert.equal(Number(speaking.min_value), 1);
  assert.deepEqual(
    [...speaking.categoryIds].sort(),
    [IDS.CATEGORY_JOURNAL_CLUB, IDS.CATEGORY_MEDIA_SPEAKING].sort(),
    'the compound editorial rule lost a category on the way to the screen',
  );
});

await check('the preview counts real members against the real rules', async () => {
  const counts = await previewOf(IDS.SET_CURRENT);
  const root = counts.get(IDS.NODES.root);
  // 60 base fixture members enrolled for YEAR_CURRENT, plus the 4
  // retroactive-matching fixture members (admin-fixtures.mjs's RETRO block),
  // all enrolled for the same year.
  assert.equal(root.total, 64, `expected the 64 enrolled members, got ${root.total}`);
  assert.ok(root.passing > 0 && root.passing < root.total, `${root.passing} of ${root.total}`);

  // Every requirement carries its own count, which is the "63 ✓" column.
  for (const id of Object.values(IDS.NODES).filter((value) => value.startsWith('f0'))) {
    assert.ok(counts.has(id), `no count came back for one of the requirements`);
  }

  // A member cannot pass the root without passing every requirement under it.
  for (const id of [IDS.NODES.gbms, IDS.NODES.volunteering, IDS.NODES.socials]) {
    assert.ok(
      counts.get(id).passing >= root.passing,
      'a requirement passed by fewer members than the whole rule',
    );
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\na published set is read only\n');
// ---------------------------------------------------------------------------

await check('an officer cannot edit a published requirement, and is not told it worked', async () => {
  const before = await loadSet(IDS.SET_CURRENT);
  const rows = await patch(
    'requirement_nodes',
    { id: `eq.${IDS.NODES.gbms}` },
    { min_value: 1 },
  );
  assert.deepEqual(rows, [], 'an officer edited a published set');

  const after = await loadSet(IDS.SET_CURRENT);
  assert.equal(
    Number(after.byId.get(IDS.NODES.gbms).min_value),
    Number(before.byId.get(IDS.NODES.gbms).min_value),
  );
});

await check('nor remove one, nor add one to it', async () => {
  const removed = await remove('requirement_nodes', { id: `eq.${IDS.NODES.tabling}` });
  assert.deepEqual(removed, [], 'an officer removed a requirement from a published set');

  await assert.rejects(
    () =>
      insert(
        'requirement_nodes',
        [
          {
            requirement_set_id: IDS.SET_CURRENT,
            parent_id: IDS.NODES.root,
            type: 'threshold',
            label: 'Snuck in',
            min_value: 1,
          },
        ],
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.status === 403,
  );

  const { byId } = await loadSet(IDS.SET_CURRENT);
  assert.ok(byId.get(IDS.NODES.tabling), 'the requirement is gone');
});

let draftId = null;

await check('"Edit as draft" clones it into a new version that can be edited', async () => {
  draftId = await callRpc('clone_requirement_set', { p_set_id: IDS.SET_CURRENT });
  assert.ok(draftId, 'no set came back');

  const draft = await loadSet(draftId);
  assert.equal(draft.set.status, 'draft');
  assert.equal(draft.set.version, 2);
  assert.equal(draft.set.academic_year_id, IDS.YEAR_CURRENT);
  assert.notEqual(draft.root.id, IDS.NODES.root, 'the clone shares rows with the published set');

  // Same rule, including the compound one.
  assert.deepEqual(
    model.flatten(draft.root).slice(1).map((row) => row.item.label),
    ['GBMs', 'Volunteering', 'Socials', 'Tabling', 'Editorial Points', 'Speaking', 'Writing'],
  );
  const speaking = [...draft.byId.values()].find((item) => item.label === 'Speaking');
  assert.equal(speaking.categoryIds.length, 2, 'the clone flattened the compound requirement');

  // And the published one is untouched by anything done to the copy.
  const edited = await patch('requirement_nodes', { id: `eq.${speaking.id}` }, { min_value: 2 });
  assert.equal(edited.length, 1, 'the clone is not editable');
  const published = await loadSet(IDS.SET_CURRENT);
  assert.equal(Number(published.byId.get(IDS.NODES.speaking).min_value), 1);

  // Put the probe back. Nothing above needs it to stay, and everything below
  // reads this draft's preview: at 2, Speaking asks for more editorial credit
  // than the roster holds, Editorial Points fails for every member, and the
  // root counts 0 whatever else is changed. That is a preview reporting the
  // rules correctly, and it is also a preview that cannot move, which would
  // leave the checks underneath green against numbers that never budge.
  await patch('requirement_nodes', { id: `eq.${speaking.id}` }, { min_value: 1 });
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe preview moves when the rules move\n');
// ---------------------------------------------------------------------------

await check('lowering a threshold lets more members through', async () => {
  const draft = await loadSet(draftId);
  const gbms = [...draft.byId.values()].find((item) => item.label === 'GBMs');
  const start = (await previewOf(draftId)).get(draft.root.id);
  const before = start.passing;

  // The baseline has to be able to go up, or `after > before` proves nothing.
  // A root already at 0 stays at 0 when some OTHER requirement is what is
  // holding everybody back, and a root already at the whole roster has nowhere
  // left to go. Either way the assertion below passes or fails for a reason
  // that has nothing to do with the threshold, so it is checked first.
  assert.ok(
    before > 0 && before < start.total,
    `the baseline cannot move, so this proves nothing: ${before} of ${start.total}`,
  );

  await patch('requirement_nodes', { id: `eq.${gbms.id}` }, { min_value: 3 });
  const after = (await previewOf(draftId)).get(draft.root.id).passing;

  assert.ok(after > before, `the preview did not move: ${before} then ${after}`);

  // Back to the published number, so the next check starts from the rule this
  // draft was cloned from rather than from this one's leftovers.
  await patch('requirement_nodes', { id: `eq.${gbms.id}` }, { min_value: 9 });
  assert.equal((await previewOf(draftId)).get(draft.root.id).passing, before);
});

await check('a group\'s "at least N" is a data change, not a deploy', async () => {
  const draft = await loadSet(draftId);
  const strict = (await previewOf(draftId)).get(draft.root.id).passing;

  // "any 4 of the 5", which is the "any 8 of 10" ask from the data model doc.
  const rows = await patch(
    'requirement_nodes',
    { id: `eq.${draft.root.id}` },
    { min_children_passing: 4 },
  );
  assert.equal(rows.length, 1);
  const loose = (await previewOf(draftId)).get(draft.root.id).passing;
  assert.ok(loose > strict, `"at least 4" changed nothing: ${strict} then ${loose}`);

  await patch('requirement_nodes', { id: `eq.${draft.root.id}` }, { min_children_passing: null });
  const back = (await previewOf(draftId)).get(draft.root.id).passing;
  assert.equal(back, strict, 'putting it back to "all" did not put the count back');
});

let addedId = null;

await check('adding a requirement updates the preview and the new row has its own count', async () => {
  const draft = await loadSet(draftId);
  const before = (await previewOf(draftId)).get(draft.root.id).passing;

  const created = await insert('requirement_nodes', [
    {
      requirement_set_id: draftId,
      parent_id: draft.root.id,
      type: 'threshold',
      label: 'Journal Club',
      sort_order: model.nextOrder(draft.root.children),
      min_value: 1,
    },
  ]);
  addedId = created[0].id;
  await insert('requirement_node_categories', [
    { node_id: addedId, category_id: IDS.CATEGORY_JOURNAL_CLUB },
  ]);

  const counts = await previewOf(draftId);
  assert.ok(counts.has(addedId), 'the new requirement has no count of its own');
  assert.ok(counts.get(addedId).passing > 0, 'nobody at all passes the new requirement');
  assert.ok(
    counts.get(draft.root.id).passing <= before,
    'one more requirement let MORE members through',
  );
});

await check('a category is added and removed as a chip, and the rest survive', async () => {
  const draft = await loadSet(draftId);
  const speaking = [...draft.byId.values()].find((item) => item.label === 'Speaking');
  assert.equal(speaking.categoryIds.length, 2);

  await insert('requirement_node_categories', [
    { node_id: speaking.id, category_id: IDS.CATEGORY_SOCIALS },
  ]);
  let reread = await loadSet(draftId);
  let now = [...reread.byId.values()].find((item) => item.id === speaking.id);
  assert.equal(now.categoryIds.length, 3, 'a third category did not stick');

  const dropped = await remove('requirement_node_categories', {
    node_id: `eq.${speaking.id}`,
    category_id: `eq.${IDS.CATEGORY_SOCIALS}`,
  });
  assert.equal(dropped.length, 1);

  reread = await loadSet(draftId);
  now = [...reread.byId.values()].find((item) => item.id === speaking.id);
  assert.deepEqual(
    [...now.categoryIds].sort(),
    [IDS.CATEGORY_JOURNAL_CLUB, IDS.CATEGORY_MEDIA_SPEAKING].sort(),
    'removing one chip took another with it',
  );
});

await check('removing a group takes what is inside it, and nothing else', async () => {
  const draft = await loadSet(draftId);
  const editorial = [...draft.byId.values()].find((item) => item.label === 'Editorial Points');
  const inside = editorial.children.map((child) => child.id);
  assert.equal(inside.length, 2);

  const removed = await remove('requirement_nodes', { id: `eq.${editorial.id}` });
  assert.equal(removed.length, 1);

  const after = await loadSet(draftId);
  for (const id of inside) assert.equal(after.byId.has(id), false, 'a child outlived its group');
  assert.ok(after.byId.get(addedId), 'removing one group removed something else');

  // Put it back the way it was, so the checks below read a whole rule.
  const group = await insert('requirement_nodes', [
    {
      requirement_set_id: draftId,
      parent_id: after.root.id,
      type: 'group',
      label: 'Editorial Points',
      sort_order: 50,
    },
  ]);
  const speaking = await insert('requirement_nodes', [
    {
      requirement_set_id: draftId,
      parent_id: group[0].id,
      type: 'threshold',
      label: 'Speaking',
      sort_order: 10,
      min_value: 1,
    },
  ]);
  await insert('requirement_node_categories', [
    { node_id: speaking[0].id, category_id: IDS.CATEGORY_JOURNAL_CLUB },
    { node_id: speaking[0].id, category_id: IDS.CATEGORY_MEDIA_SPEAKING },
  ]);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nproblems land on the requirement they belong to\n');
// ---------------------------------------------------------------------------

await check('an empty group is reported against that group', async () => {
  const draft = await loadSet(draftId);
  const created = await insert('requirement_nodes', [
    {
      requirement_set_id: draftId,
      parent_id: draft.root.id,
      type: 'group',
      label: 'Nothing in here',
      sort_order: 900,
    },
  ]);
  const emptyId = created[0].id;

  const problems = await callRpc('validate_requirement_set', { p_set_id: draftId });
  const byNode = model.problemsByNode(problems);
  const held = byNode.get(emptyId) ?? [];
  assert.equal(held.length, 1, 'the empty group was not flagged, or was flagged twice');
  assert.equal(held[0].title, 'Empty group');
  assert.doesNotMatch(`${held[0].title} ${held[0].body}`, /\bnodes?\b/i);

  // And nothing else on the screen was blamed for it.
  for (const [id, list] of byNode) {
    if (id !== emptyId) {
      assert.equal(
        list.some((problem) => problem.title === 'Empty group'),
        false,
        'another requirement was blamed for the empty group',
      );
    }
  }

  await remove('requirement_nodes', { id: `eq.${emptyId}` });
});

await check('a requirement measuring a retired category says so, on that row', async () => {
  const draft = await loadSet(draftId);
  const created = await insert('requirement_nodes', [
    {
      requirement_set_id: draftId,
      parent_id: draft.root.id,
      type: 'threshold',
      label: 'President Workshops',
      sort_order: 910,
      min_value: 1,
    },
  ]);
  const nodeId = created[0].id;
  await insert('requirement_node_categories', [
    { node_id: nodeId, category_id: IDS.CATEGORY_RETIRED },
  ]);

  const byNode = model.problemsByNode(
    await callRpc('validate_requirement_set', { p_set_id: draftId }),
  );
  const held = byNode.get(nodeId) ?? [];
  assert.equal(held.length, 1);
  assert.equal(held[0].title, 'Measures a retired category');

  await remove('requirement_nodes', { id: `eq.${nodeId}` });
});

await check('a requirement measuring nothing at all is flagged before it is published', async () => {
  const draft = await loadSet(draftId);
  const created = await insert('requirement_nodes', [
    {
      requirement_set_id: draftId,
      parent_id: draft.root.id,
      type: 'threshold',
      label: 'Measures nothing',
      sort_order: 920,
      min_value: 1,
    },
  ]);
  const byNode = model.problemsByNode(
    await callRpc('validate_requirement_set', { p_set_id: draftId }),
  );
  assert.equal((byNode.get(created[0].id) ?? [])[0]?.title, 'Measures nothing');
  await remove('requirement_nodes', { id: `eq.${created[0].id}` });
});

// ---------------------------------------------------------------------------
process.stdout.write('\npublishing is an admins decision\n');
// ---------------------------------------------------------------------------

await check('an officer is refused, with copy that names the account that can', async () => {
  await assert.rejects(
    () => callRpc('publish_requirement_set', { p_set_id: draftId }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );

  const copy = describeOfficer(
    new RpcError('PDS07', 'Publishing a requirement set requires an admin account.', 400),
  );
  assert.match(`${copy.title} ${copy.body}`, /admin/i);
  assert.doesNotMatch(`${copy.title} ${copy.body}`, /policy|permission denied/i);
});

await check('the screen says so before the officer presses anything', () => {
  // The button is offered disabled with the reason beside it, rather than
  // enabled and answered with a refusal.
  assert.match(sources['src/requirements.js'], /Only an admin can publish\./);
  assert.match(sources['src/requirements.js'], /el\.publish\.disabled = !ctx\.canPublish/);
});

await check('an admin publishes, and the version that was live is kept', async () => {
  await signInAs('ben@pdsaucf.com');
  const result = await callRpc('publish_requirement_set', { p_set_id: draftId });
  assert.equal(result.version, 2);
  assert.ok(result.published_at, 'nothing recorded when it went live');
  assert.equal(result.archived_set_id, IDS.SET_CURRENT, 'the previous version was not kept');

  const sets = await select('requirement_sets', {
    select: 'id,version,status',
    filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
    order: 'version.asc',
  });
  assert.deepEqual(
    sets.map((row) => `${row.version} ${row.status}`),
    ['1 archived', '2 published'],
  );
});

await check('and the version just published is read only from that moment', async () => {
  await signInAs('sara@pdsaucf.com');
  const { root } = await loadSet(draftId);
  const rows = await patch('requirement_nodes', { id: `eq.${root.id}` }, { label: 'Changed' });
  assert.deepEqual(rows, [], 'a published set stayed editable after publishing');
});

await check('an officer cannot promote a draft by writing the column directly', async () => {
  const clone = await callRpc('clone_requirement_set', { p_set_id: draftId });
  await assert.rejects(
    () => patch('requirement_sets', { id: `eq.${clone}` }, { status: 'published' }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.status === 403,
  );
  const after = await select('requirement_sets', {
    select: 'id,status',
    filters: { id: `eq.${clone}` },
  });
  assert.equal(after[0].status, 'draft');
});

// ---------------------------------------------------------------------------
process.stdout.write('\ncopying last year\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('a copy of another year lands on the year on screen', async () => {
  // What the screen does: clone, read the copy back, and move it onto the year
  // in the top bar if the clone did not put it there.
  const newId = await callRpc('clone_requirement_set', { p_set_id: IDS.SET_PAST });
  let created = (
    await select('requirement_sets', {
      select: 'id,academic_year_id,name,version,status',
      filters: { id: `eq.${newId}` },
    })
  )[0];

  if (created.academic_year_id !== IDS.YEAR_CURRENT) {
    const moved = await patch(
      'requirement_sets',
      { id: `eq.${created.id}` },
      { academic_year_id: IDS.YEAR_CURRENT },
    );
    assert.equal(moved.length, 1, 'the copy could not be moved onto this year');
    created = moved[0];
  }

  assert.equal(created.academic_year_id, IDS.YEAR_CURRENT);
  assert.equal(created.status, 'draft');

  const copied = await loadSet(created.id);
  assert.deepEqual(
    model.flatten(copied.root).slice(1).map((row) => row.item.label),
    ['GBMs', 'Socials'],
    'last year\'s rule did not come across',
  );
  assert.equal(Number([...copied.byId.values()].find((i) => i.label === 'GBMs').min_value), 8);
});

// ---------------------------------------------------------------------------
process.stdout.write('\ncategories\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('a new category is created with a key nobody has to see', async () => {
  const rows = await insert('categories', [
    {
      slug: 'dental-school-visits',
      name: 'Dental School Visits',
      unit: 'event_count',
      unit_label: null,
      counts_toward_point_total: true,
      sort_order: 100,
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Dental School Visits');
  assert.equal(rows[0].archived_at, null);

  // The slug is an identifier and never appears in any copy.
  for (const text of uiStrings(sources['src/categories.js'])) {
    assert.doesNotMatch(text, /\bslug\b/i, `"slug" is on screen: ${text}`);
  }
});

await check('renaming a category leaves every rule pointing at the same thing', async () => {
  const before = await select('requirement_node_categories', {
    select: 'node_id,category_id',
    filters: { category_id: `eq.${IDS.CATEGORY_SOCIALS}` },
  });
  const renamed = await patch(
    'categories',
    { id: `eq.${IDS.CATEGORY_SOCIALS}` },
    { name: 'Social Events' },
  );
  assert.equal(renamed[0].name, 'Social Events');
  assert.equal(renamed[0].slug, 'socials', 'a rename changed the key underneath');

  const after = await select('requirement_node_categories', {
    select: 'node_id,category_id',
    filters: { category_id: `eq.${IDS.CATEGORY_SOCIALS}` },
  });
  assert.deepEqual(after, before);
});

await check('retiring a category that a rule measures explains itself first', async () => {
  // The query the dialog is built from.
  const uses = await select('requirement_node_categories', {
    select:
      'category_id,requirement_nodes(id,label,requirement_sets(name,version,status,academic_year_id))',
    filters: { category_id: `eq.${IDS.CATEGORY_JOURNAL_CLUB}` },
  });
  assert.ok(uses.length >= 1, 'the fixture no longer has a rule measuring Journal Club');
  assert.equal(uses[0].requirement_nodes.label, 'Speaking');
  assert.equal(uses[0].requirement_nodes.requirement_sets.status, 'published');
});

await check('retiring is archiving: the row stays, and the rule now says it is retired', async () => {
  const rows = await patch(
    'categories',
    { id: `eq.${IDS.CATEGORY_JOURNAL_CLUB}` },
    { archived_at: new Date().toISOString() },
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0].archived_at);

  const still = await select('categories', {
    select: 'id,name,archived_at',
    filters: { id: `eq.${IDS.CATEGORY_JOURNAL_CLUB}` },
  });
  assert.equal(still.length, 1, 'retiring deleted the category');

  const problems = await callRpc('validate_requirement_set', { p_set_id: IDS.SET_CURRENT });
  const held = model.problemsByNode(problems).get(IDS.NODES.speaking) ?? [];
  assert.equal(held[0]?.title, 'Measures a retired category');
});

await check('nothing on this screen ever deletes a category', () => {
  assert.doesNotMatch(sources['src/categories.js'], /remove\(\s*['"]categories['"]/);
  assert.doesNotMatch(sources['src/requirements.js'], /remove\(\s*['"]categories['"]/);
});

await check('a viewer reads the rules and changes none of them', async () => {
  await signInAs('advisor@ucf.edu');
  const { root } = await loadSet(IDS.SET_CURRENT);
  assert.ok(root, 'a viewer could not read the rules they are shown');

  const rows = await patch('categories', { id: `eq.${IDS.CATEGORY_GBMS}` }, { name: 'Nope' });
  assert.deepEqual(rows, [], 'a viewer renamed a category');
  await assert.rejects(
    () => callRpc('publish_requirement_set', { p_set_id: IDS.SET_CURRENT }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );
});

// ---------------------------------------------------------------------------

server.close();
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exit(failures ? 1 : 0);
