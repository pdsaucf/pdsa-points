// Checks for the categories screen: usage and Delete.
//
// Same rule as verify-admin.mjs and verify-requirements.mjs: assert the things
// that fail SILENTLY. A row that shows a number is easy to see is right or
// wrong; what is not:
//
//   1. THE YEAR-SCOPING TRAP. The subline's event count is scoped to the
//      selected year (event_categories joined to events, filtered by
//      academic_year_id), but delete-eligibility has to ask a different
//      question: has this category EVER been used, in any year. A category
//      with a past-year reference and nothing this year would show "0 events"
//      in its subline and, if delete read that same number, would offer to
//      delete a category a past record still points at. Every reference to a
//      category is `on delete restrict` (invariant 4), so that delete would
//      leave a dangling row the database itself would have refused. This is
//      the single most likely bug in this feature, and it is the first check
//      below.
//   2. That a category a requirement measures, even with zero events, is also
//      refused.
//   3. That the genuinely unused case actually deletes, and that PostgREST's
//      two different refusal shapes (RLS: 200 + empty array; a real
//      foreign-key violation: a thrown error) are told apart rather than one
//      being read as the other.
//   4. That the screen's usage data comes from a small, fixed number of
//      requests, not one per category: see admin-fixtures.mjs, which has
//      more than a handful of categories by the time history events are
//      seeded in.
//   5. That a viewer, who never sees a Retire or Delete button, is refused by
//      the database too if something tried anyway.
//
// Run: node web/mock/verify-categories.mjs   (or npm run verify:categories, from web/)

import assert from 'node:assert/strict';
import { startMock } from './server.mjs';
import { signInAs as signInAsAccount } from './sign-in.mjs';
import { IDS } from './admin-fixtures.mjs';

const PORT = 8801;

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
const { select, patch, remove } = await import('../src/rest.js');
const { RpcError } = await import('../src/errors.js');
const { countByCategory, groupRequirementUses, canDelete } = await import(
  '../src/category-model.js'
);

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
const signInAs = (email) => signInAsAccount(email, PORT);

// The same three usage queries categories.js's load() makes, alongside the
// category select it already made.
const yearUsageOf = (yearId) =>
  select('event_categories', {
    select: 'category_id,events!inner(id,academic_year_id)',
    filters: { 'events.academic_year_id': `eq.${yearId}` },
  });
const allYearUsage = () => select('event_categories', { select: 'category_id' });
const requirementUsage = () =>
  select('requirement_node_categories', {
    select:
      'category_id,requirement_nodes(id,label,requirement_sets(name,version,status,academic_year_id))',
  });

const server = await startMock(PORT);

// ---------------------------------------------------------------------------
process.stdout.write('\nthe year-scoping trap\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('a category used only in a past year shows zero for the current year', async () => {
  const rows = await yearUsageOf(IDS.YEAR_CURRENT);
  const counts = countByCategory(rows);
  assert.equal(counts.get(IDS.CATEGORY_LAST_YEAR_ONLY) ?? 0, 0);
});

await check('the same category is not delete-eligible, because it IS used, elsewhere', async () => {
  const rows = await allYearUsage();
  const allCounts = countByCategory(rows);
  assert.ok(
    (allCounts.get(IDS.CATEGORY_LAST_YEAR_ONLY) ?? 0) > 0,
    'the fixture no longer attaches Last Year Only to a past event',
  );

  const reqRows = await requirementUsage();
  const uses = groupRequirementUses(reqRows, []).get(IDS.CATEGORY_LAST_YEAR_ONLY) ?? [];
  assert.equal(uses.length, 0, 'Last Year Only is meant to carry no requirement link');

  const eligible = canDelete(
    { archived_at: null },
    { allEventCount: allCounts.get(IDS.CATEGORY_LAST_YEAR_ONLY), requirementUses: uses },
  );
  assert.equal(eligible, false, 'a category with a past-year event was reported delete-eligible');
});

await check('the database itself refuses to delete it, matching canDelete()', async () => {
  await assert.rejects(
    () => remove('categories', { id: `eq.${IDS.CATEGORY_LAST_YEAR_ONLY}` }),
    (err) => err instanceof RpcError && err.code === '23503',
    'deleting a category a past event still references did not throw a foreign-key error',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\nmeasured by a requirement\n');
// ---------------------------------------------------------------------------

await check('a category with zero events but a requirement link is not delete-eligible', () => {
  // No fixture category happens to have zero events and a requirement link at
  // once (every measured category here also has history events), so this is
  // canDelete() exercised directly against that shape.
  const eligible = canDelete(
    { archived_at: null },
    { allEventCount: 0, requirementUses: [{ label: 'Speaking', where: '2026-2027 · Published' }] },
  );
  assert.equal(eligible, false);
});

await check('a category both requirements and events use is not delete-eligible either', async () => {
  const allCounts = countByCategory(await allYearUsage());
  const uses = groupRequirementUses(await requirementUsage(), []).get(IDS.CATEGORY_GBMS) ?? [];
  assert.ok((allCounts.get(IDS.CATEGORY_GBMS) ?? 0) > 0, 'GBMs has no event usage in the fixture');
  assert.ok(uses.length > 0, 'GBMs has no requirement using it in the fixture');
  assert.equal(
    canDelete({ archived_at: null }, { allEventCount: allCounts.get(IDS.CATEGORY_GBMS), requirementUses: uses }),
    false,
  );

  await assert.rejects(
    () => remove('categories', { id: `eq.${IDS.CATEGORY_GBMS}` }),
    (err) => err instanceof RpcError && err.code === '23503',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\ngenuinely unused\n');
// ---------------------------------------------------------------------------

await check('a category referenced nowhere is delete-eligible, and the delete actually removes it', async () => {
  const allCounts = countByCategory(await allYearUsage());
  const uses = groupRequirementUses(await requirementUsage(), []).get(IDS.CATEGORY_UNUSED) ?? [];
  assert.equal(allCounts.get(IDS.CATEGORY_UNUSED) ?? 0, 0);
  assert.equal(uses.length, 0);
  assert.equal(
    canDelete({ archived_at: null }, { allEventCount: allCounts.get(IDS.CATEGORY_UNUSED) ?? 0, requirementUses: uses }),
    true,
  );

  const rows = await remove('categories', { id: `eq.${IDS.CATEGORY_UNUSED}` });
  assert.equal(rows.length, 1, 'the delete did not report removing the row');
  assert.equal(rows[0].id, IDS.CATEGORY_UNUSED);

  const still = await select('categories', {
    select: 'id',
    filters: { id: `eq.${IDS.CATEGORY_UNUSED}` },
  });
  assert.equal(still.length, 0, 'the category is still readable after being deleted');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe two refusal shapes\n');
// ---------------------------------------------------------------------------

await reset();

await check('a role WRITE_POLICY refuses comes back an empty array, not a rejection', async () => {
  await signInAs('advisor@ucf.edu'); // viewer: not in OFFICER_ROLES
  const rows = await remove('categories', { id: `eq.${IDS.CATEGORY_UNUSED}` });
  assert.deepEqual(rows, [], 'a viewer deleted a category');

  const still = await select('categories', {
    select: 'id',
    filters: { id: `eq.${IDS.CATEGORY_UNUSED}` },
  });
  assert.equal(still.length, 1, 'the category was removed by a role the policy should have refused');
});

await check('a genuine foreign-key refusal rejects instead, and is not read as success', async () => {
  await signInAs('sara@pdsaucf.com'); // officer: passes WRITE_POLICY
  await assert.rejects(
    () => remove('categories', { id: `eq.${IDS.CATEGORY_GBMS}` }),
    (err) => err instanceof RpcError && err.code === '23503' && err.status === 409,
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\nbulk loading\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('usage counts come from a bounded number of requests, not one per category', async () => {
  const categoryCount = (
    await select('categories', { select: 'id' })
  ).length;
  assert.ok(categoryCount > 4, 'the fixture needs more categories than the query count to prove this');

  const before = await api('/__mock/audit').then((body) => body.admin.calls);
  const countBefore = (fn) => before.filter((call) => call.fn === fn).length;

  // The exact sequence categories.js's load() runs: categories, this year's
  // event usage, every year's event usage, every requirement's category
  // links.
  await select('categories', { select: 'id,slug,name,sort_order,archived_at' });
  await yearUsageOf(IDS.YEAR_CURRENT);
  await allYearUsage();
  await requirementUsage();

  const after = await api('/__mock/audit').then((body) => body.admin.calls);
  const countAfter = (fn) => after.filter((call) => call.fn === fn).length;

  assert.equal(
    countAfter('rest.event_categories') - countBefore('rest.event_categories'),
    2,
    'event_categories was read a different number of times than the two bulk queries load() makes',
  );
  assert.equal(
    countAfter('rest.requirement_node_categories') - countBefore('rest.requirement_node_categories'),
    1,
    'requirement_node_categories was read a different number of times than the one bulk query load() makes',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\na viewer\n');
// ---------------------------------------------------------------------------

await check('a viewer reads categories and changes none of them, retire or delete', async () => {
  await signInAs('advisor@ucf.edu');

  const rows = await select('categories', { select: 'id' });
  assert.ok(rows.length > 0, 'a viewer could not read the categories they are shown');

  const retired = await patch(
    'categories',
    { id: `eq.${IDS.CATEGORY_GBMS}` },
    { archived_at: new Date().toISOString() },
  );
  assert.deepEqual(retired, [], 'a viewer retired a category');

  const deleted = await remove('categories', { id: `eq.${IDS.CATEGORY_GBMS}` });
  assert.deepEqual(deleted, [], 'a viewer deleted a category');
});

// ---------------------------------------------------------------------------

server.close();
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exit(failures ? 1 : 0);
