// The rule tree, as data, with no DOM in it.
//
// Everything on the requirements screen that can be reasoned about without a
// browser lives here: turning the flat rows PostgREST returns into a tree,
// working out the order and the nesting a move produces, choosing the unit word
// a sentence reads with, and turning a validation code into copy an officer can
// act on.
//
// SHARED WITH THE MEMBER PORTAL, which draws the published set as the member's
// own progress list and therefore needs the same tree and the same unit word:
// buildTree(), flatten() and unitWord() are read by web/src/portal-progress.js.
// The validation copy below is the officer's half and is not.
//
// THE VOCABULARY RULE, WHICH IS THE POINT OF THIS FILE EXISTING AT ALL.
// The database calls these rows nodes, and calls a measured one a threshold.
// docs/03-admin-ui.md says neither word ever reaches a screen, so the officer
// side of the product has exactly one word: a REQUIREMENT is one measured line.
// The translation happens here and nowhere else, which is why the copy below is
// data rather than string literals spread through the renderer.
//
// THE RULE LIST IS FLAT. The tree in the database still holds a root group,
// which is what "must meet all" and "must meet at least 8" are stored in, but
// the editor no longer creates groups inside it and nothing nests. Nesting was
// the only part of this screen nobody could read out loud, and the one rule it
// existed for ("Editorial Points, being Speaking and Writing") is two ordinary
// requirements. Sets written before that can still hold a group, so buildTree()
// and flatten() stay recursive and ungroupInto() takes one apart in place.
//
// The category name is not the requirement's name. "Speaking" measures Journal
// Club and Media Speaking together, which is the compound rule from
// docs/00-spreadsheet-findings.md and the reason a requirement carries a list
// of categories rather than one.

import { pluralUnit } from './format.js';

/**
 * Sort orders are spaced so that a move is one UPDATE per row that actually
 * moved, and so that two officers reordering different parts of the tree do not
 * collide over consecutive integers.
 */
export const ORDER_STEP = 10;

/** What a unit column means when it is read out in a sentence. */
const UNIT_WORD = {
  event_count: 'events',
  hours: 'hours',
  points: 'points',
};

/**
 * 'events', 'hours', or nothing.
 *
 * Nothing is the honest answer for a requirement that measures categories with
 * different units: "at least 3 events" would be a lie about a rule that adds
 * hours to event counts, and the officer needs to see that rather than read a
 * confident wrong word.
 *
 * SAME RULE FOR DISAGREEING LABELS ON THE SAME UNIT. Two categories can share
 * `unit = 'hours'` and still be labelled differently ('hour' on one,
 * 'session' on another): kinds.size is 1 so the mixed-unit guard above does
 * not fire, and without a separate check this fell through to
 * UNIT_WORD['hours'], printing "hours" for a category the club called
 * sessions. That is the identical dishonesty the mixed-unit branch exists to
 * refuse, so it gets the identical answer: nothing, rather than a third word
 * that matches neither label.
 */
export function unitWord(categories) {
  const kinds = new Set();
  const labels = new Set();
  for (const category of categories ?? []) {
    if (!category) continue;
    kinds.add(category.unit ?? 'event_count');
    if (category.unit_label) labels.add(category.unit_label);
  }
  if (kinds.size !== 1) return '';
  if (labels.size > 1) return '';
  if (labels.size === 1) return pluralUnit([...labels][0]);
  return UNIT_WORD[[...kinds][0]] ?? '';
}

/**
 * The flat rows, as a tree.
 *
 * `root_node_id` is what the set says its root is; a set whose root is missing
 * still renders, from whichever row has no parent, because an officer looking
 * at a half-built draft needs to see it rather than an empty screen.
 *
 * @param {Array} rows requirement rows as PostgREST returns them
 * @param {string|null} rootId requirement_sets.root_node_id
 * @returns {{root: object|null, byId: Map<string, object>}}
 */
export function buildTree(rows, rootId = null) {
  const byId = new Map();
  for (const row of rows ?? []) {
    byId.set(row.id, {
      ...row,
      categoryIds: (row.requirement_node_categories ?? []).map((link) => link.category_id),
      children: [],
    });
  }

  const orphans = [];
  for (const item of byId.values()) {
    const parent = item.parent_id ? byId.get(item.parent_id) : null;
    if (parent) parent.children.push(item);
    else if (!item.parent_id) orphans.push(item);
  }

  for (const item of byId.values()) item.children.sort(byOrder);
  orphans.sort(byOrder);

  const root = (rootId && byId.get(rootId)) || orphans[0] || null;
  return { root, byId };
}

const byOrder = (a, b) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.label).localeCompare(String(b.label));

/** Depth-first, in display order, with the depth each row is drawn at. */
export function flatten(root, depth = 0, out = []) {
  if (!root) return out;
  out.push({ item: root, depth });
  for (const child of root.children) flatten(child, depth + 1, out);
  return out;
}

/**
 * Taking a group apart: where each of its children lands once the group itself
 * is gone.
 *
 * The editor no longer makes groups (see the note at the top of this file), so
 * the only ones left are in sets written before that, and the whole point of an
 * ungroup is that nothing measured is lost on the way. Removing the group
 * outright would take its children with it, because parent_id cascades, so the
 * children are moved to the root first and the group is deleted after.
 *
 * Order is preserved: the children arrive at the end of the root in the order
 * they had inside the group.
 *
 * @returns {Array<{id: string, parent_id: string, sort_order: number}>}
 */
export function ungroupInto(root, group) {
  if (!root || !group || group.id === root.id) return [];
  let order = nextOrder(root.children);
  return [...(group.children ?? [])].sort(byOrder).map((child) => {
    const row = { id: child.id, parent_id: root.id, sort_order: order };
    order += ORDER_STEP;
    return row;
  });
}

/**
 * Moving one row up or down among its siblings.
 *
 * Returns only the rows whose sort_order actually changed, because each one is
 * a write. Swapping two neighbours is two writes, not eleven.
 *
 * @returns {Array<{id: string, sort_order: number}>}
 */
export function reorderWithin(siblings, id, delta) {
  const ordered = [...siblings].sort(byOrder);
  const at = ordered.findIndex((child) => child.id === id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= ordered.length) return [];

  const moved = [...ordered];
  const [taken] = moved.splice(at, 1);
  moved.splice(to, 0, taken);

  return moved
    .map((child, index) => ({ id: child.id, sort_order: (index + 1) * ORDER_STEP }))
    .filter((row, index) => row.sort_order !== moved[index].sort_order);
}

/** The sort_order a new row gets: after everything already in that group. */
export function nextOrder(siblings) {
  const highest = (siblings ?? []).reduce(
    (max, child) => Math.max(max, child.sort_order ?? 0),
    0,
  );
  return highest + ORDER_STEP;
}

// ---------------------------------------------------------------------------
// Validation problems
// ---------------------------------------------------------------------------
// validate_requirement_set() answers with (code, node_id, message). The code is
// what this screen branches on, exactly as officer-errors.js branches on a PDS
// code and never on a sentence.
//
// Two codes can mean the same thing to an officer (a group with no children is
// an empty group whether the database calls it empty_group or empty_group_node),
// so the aliases are folded together here rather than at the call site.

const PROBLEM_COPY = {
  measures_nothing: {
    title: 'Measures nothing',
    body: 'Add at least one category.',
    codes: [
      'threshold_without_category',
      'threshold_without_categories',
      'node_without_category',
      'requirement_without_category',
    ],
  },
  empty_group: {
    title: 'Empty group',
    body: 'A group with nothing in it passes for everybody.',
    codes: ['empty_group', 'empty_group_node', 'group_without_children'],
  },
  archived_category: {
    title: 'Measures a retired category',
    body: 'Swap it for an active one, or bring the category back.',
    codes: ['rule_on_archived_category', 'archived_category', 'category_archived'],
  },
  too_many_required: {
    title: 'Asks for more than it holds',
    body: 'Lower the number, or add more to this group.',
    codes: [
      'min_children_exceeds_children',
      'group_min_too_high',
      'min_children_passing_too_high',
    ],
  },
  no_requirements: {
    title: 'No requirements yet',
    body: 'Nobody can qualify until this has something in it.',
    codes: ['set_without_root', 'no_root', 'empty_set', 'set_is_empty'],
  },
  needs_a_number: {
    title: 'Needs a number above zero',
    body: '',
    codes: ['min_value_not_positive', 'min_value_missing', 'invalid_min_value'],
  },
  needs_a_name: {
    title: 'Needs a name',
    body: '',
    codes: ['label_missing', 'missing_label', 'blank_label'],
  },
  mixed_units: {
    title: 'Mixes hours and events',
    body: 'One requirement can only add up one kind of thing.',
    codes: ['mixed_units', 'mixed_unit_types', 'incompatible_units'],
  },
  duplicated: {
    title: 'Measured twice',
    body: 'Two requirements measure the same category.',
    codes: ['duplicate_category', 'category_measured_twice'],
  },
};

const BY_CODE = new Map();
for (const entry of Object.values(PROBLEM_COPY)) {
  for (const code of entry.codes) BY_CODE.set(code, entry);
}

/**
 * The database's own vocabulary, kept off the screen.
 *
 * Only reached by a code this client has never seen, where the alternative is
 * either printing "Requirement node measures category X, which is archived" at
 * an officer or dropping a problem the database thinks is worth raising.
 * Dropping it is worse, so the sentence is shown with the two words that must
 * never appear rewritten into the two that are allowed.
 */
export function plainly(message) {
  return String(message ?? '')
    .replace(/\brequirement nodes?\b/gi, 'requirement')
    .replace(/\bgroup nodes?\b/gi, 'group')
    .replace(/\bnodes?\b/gi, 'requirement')
    .replace(/\bthresholds?\b/gi, 'requirement')
    .replace(/\bschemas?\b/gi, 'setup')
    .trim();
}

/**
 * One row from validate_requirement_set(), as a heading and a sentence.
 *
 * @param {{code: string, node_id: string|null, message: string}} problem
 * @returns {{title: string, body: string, nodeId: string|null, code: string}}
 */
export function describeProblem(problem) {
  const known = BY_CODE.get(problem?.code);
  if (known) {
    return {
      code: problem.code,
      nodeId: problem.node_id ?? null,
      title: known.title,
      body: known.body,
    };
  }
  return {
    code: problem?.code ?? 'unknown',
    nodeId: problem?.node_id ?? null,
    title: 'Needs attention',
    body: plainly(problem?.message) || 'Check this requirement before publishing.',
  };
}

/** Problems grouped by the requirement they belong to. Null is the whole set. */
export function problemsByNode(problems) {
  const map = new Map();
  for (const problem of problems ?? []) {
    const described = describeProblem(problem);
    const key = described.nodeId ?? '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(described);
  }
  return map;
}

// ---------------------------------------------------------------------------
// The set itself
// ---------------------------------------------------------------------------

/** 'Draft' / 'Published' / 'Archived'. The heading names the state. */
export function statusTitle(set) {
  if (!set) return 'No requirements';
  if (set.status === 'draft') return 'Draft';
  if (set.status === 'published') return 'Published';
  return 'Archived';
}

/** 'Honorary Member · version 2', for the line under the heading. */
export function setMeta(set) {
  if (!set) return '';
  return [set.name, `version ${set.version}`].filter(Boolean).join(' · ');
}

export const isEditable = (set) => Boolean(set) && set.status === 'draft';

/** The set the screen opens on: the newest draft, else the published one. */
export function preferredSet(sets) {
  const rows = [...(sets ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  return (
    rows.find((set) => set.status === 'draft') ??
    rows.find((set) => set.status === 'published') ??
    rows[0] ??
    null
  );
}

/** 'Draft version 3', for the picker when a year holds more than one. */
export function setOptionLabel(set) {
  return `${statusTitle(set)} version ${set.version}`;
}
