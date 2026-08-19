// What a category is, with no DOM in it: the slug rule.
//
// TWO SCREENS CREATE CATEGORIES. The categories screen is where they are
// managed, and the requirements editor makes one inline, because an officer
// writing a rule for something the club has not tracked before should not have
// to abandon a half written rule to go and create it. Both have to agree on what
// a slug looks like, so both read it here.
//
// A CATEGORY IS A NAME AND AN ORDER. It used to carry a unit (events, hours or
// points) and a flag for whether its credit counted toward the point total.
// Migration 22 dropped both: the unit never changed any arithmetic, the club
// does not track hours, and the flag existed only to keep Volunteering hours out
// of a total they could not honestly be added to. There is one unit and it is
// points.

/**
 * The stable key. Never shown, never reused, and unique across retired ones
 * too: a slug that came back for a second category would attach this year's
 * credit to a name last year's rules already measure.
 *
 * @param {string} name what the officer typed
 * @param {Iterable<string>} taken every slug that already exists
 */
export function uniqueSlug(name, taken) {
  const base =
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'category';

  const used = new Set(taken ?? []);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Usage: where the category is actually referenced
// ---------------------------------------------------------------------------
// The categories screen used to answer "is this used anywhere" one request at
// a time (usesOf(), one category_id at a time, only when Retire was pressed).
// It now shows a usage count on every row on load, which means the counting
// has to happen once, in bulk, over rows the screen already fetched, rather
// than as a filtered request per row. These functions are the counting: no
// DOM, no fetch, so the mock's verify-categories.mjs can call them directly.

/**
 * How many rows in a list reference each category, keyed by category_id.
 *
 * Used twice, on two different row sets: event_categories rows scoped to the
 * selected year (what the subline displays) and event_categories rows across
 * every year (what delete-eligibility checks). Passing the wrong one to the
 * wrong caller is the single most likely bug here, which is why both callers
 * name which they mean rather than sharing a variable.
 *
 * @param {Array<{category_id: string}>} rows
 * @returns {Map<string, number>}
 */
export function countByCategory(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const id = row?.category_id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Which requirements measure each category, keyed by category_id. Same shape
 * retire()'s dialog already built for one category with usesOf(); this is the
 * same question asked once for every category, so a row's subline and the
 * retire dialog both read from one map instead of two requests.
 *
 * @param {Array} rows requirement_node_categories rows, embedding
 *   requirement_nodes(id,label,requirement_sets(name,version,status,academic_year_id))
 * @param {Array} years the calendar, for turning academic_year_id into a label
 * @returns {Map<string, Array<{label: string, where: string}>>}
 */
export function groupRequirementUses(rows, years) {
  const map = new Map();
  for (const row of rows ?? []) {
    const node = row?.requirement_nodes;
    if (!node || !row.category_id) continue;
    const set = node.requirement_sets ?? {};
    const year = (years ?? []).find((entry) => entry.id === set.academic_year_id);
    const use = { label: node.label, where: [year?.label, set.status].filter(Boolean).join(' · ') };
    if (!map.has(row.category_id)) map.set(row.category_id, []);
    map.get(row.category_id).push(use);
  }
  return map;
}

/**
 * Whether a category may be deleted outright rather than only retired.
 *
 * Every reference to a category is `on delete restrict` (invariant 4), so
 * this is not a decision this screen is trusted to get right on its own: it
 * exists only to decide whether to show the button at all, and the database
 * still refuses the DELETE itself if this is stale (see the foreign-key catch
 * in categories.js's del()). `allEventCount` MUST be the all-year count, never
 * the year-scoped display count: a category unused this year can still be
 * attached to a past event, and deleting it would dangle that record.
 *
 * @param {{archived_at: string|null}} category
 * @param {{allEventCount: number, requirementUses: Array}} usage
 */
export function canDelete(category, usage = {}) {
  if (!category || category.archived_at) return false;
  const events = usage.allEventCount ?? 0;
  const requirements = usage.requirementUses?.length ?? 0;
  return events === 0 && requirements === 0;
}
