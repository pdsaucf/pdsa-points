// One member's points, and the rules those points are measured against.
//
// NOTHING ON THIS SCREEN IS DECIDED HERE (invariants 1 and 2). portal_scorecard()
// returns one row per requirement in the PUBLISHED set with the value, the
// target and the verdict already decided by fn_member_requirement_status(), and
// the point total and the honorary star come from v_member_status through the
// same call. A category added in September appears here in September, and
// nothing in this file names a category, a threshold or a unit.
//
// THE REQUIREMENTS BOX IS THE SAME TREE, WITHOUT A MEMBER. It is what the page
// says before anybody types a name, and it is drawn from portal_requirements(),
// which reads the published set. Writing the club's rules into this file as copy
// would mean the answer to "what do I have to do" could drift from the answer to
// "have I done it", and the whole product exists so those two cannot drift.
//
// THERE IS NO UNIT WORD. A requirement reads "GBMs 3 of 9", and the category is
// what names the number, so a noun after it would be saying GBMs twice. Events,
// hours and points were three labels on one behaviour and migration 22 dropped
// the column. The one figure that keeps its noun is the total, which is in
// points, because that is what the whole product counts.

import { rpc } from './api.js';
import { buildTree, flatten } from './requirement-model.js';
import { $, h, announce, setHidden, plural } from './ui.js';

const number = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
};

/**
 * Count measured requirements using only verdicts Postgres already supplied.
 * Group nodes describe the pass rule and are not themselves measured rows.
 */
export function measuredRequirementSummary(requirements) {
  const measured = (requirements ?? []).filter((row) => row.type !== 'group');
  return {
    met: measured.filter((row) => Boolean(row.passed)).length,
    total: measured.length,
  };
}

export function createScorecard(ctx) {
  const el = {
    card: $('scorecard'),
    name: $('score-name'),
    nameText: $('score-name-text'),
    nameStar: $('score-name-star'),
    year: $('score-year'),
    figures: $('score-figures'),
    state: $('score-state'),
    list: $('score-list'),
    points: $('score-points'),
    change: $('score-change'),
    honoraryList: $('honorary-list'),
    honoraryNote: $('honorary-note'),
  };

  /**
   * The published rules, as a list of what has to be met.
   *
   * A group is drawn as a line of its own only when it says "some of these",
   * because that is a fact the rows underneath it cannot convey. A group that
   * wants all of them is the same list with an extra heading nobody needs.
   */
  async function loadRequirements() {
    try {
      const answer = await rpc('portal_requirements', {});
      const nodes = (answer?.nodes ?? []).map((node) => ({
        id: node.node_id,
        parent_id: node.parent_id,
        type: node.type,
        label: node.label,
        sort_order: node.sort_order,
        min_value: node.min_value,
        min_children_passing: node.min_children_passing,
        categories: node.categories ?? [],
      }));

      if (!answer?.set || !nodes.length) {
        el.honoraryList.replaceChildren();
        el.honoraryNote.textContent = 'The requirements for this year are not published yet.';
        setHidden(el.honoraryNote, false);
        return;
      }

      const { root } = buildTree(nodes, answer.set.root_node_id);
      const rows = flatten(root).slice(1);

      el.honoraryList.replaceChildren(
        ...rows.map(({ item, depth }) => requirementRow(item, depth)).filter(Boolean),
      );
      setHidden(el.honoraryNote, root?.min_children_passing === null);
      if (root?.min_children_passing !== null && root?.min_children_passing !== undefined) {
        el.honoraryNote.textContent = `Any ${root.min_children_passing} of these.`;
      }
    } catch {
      // The box is an explanation, not the page. A member who came here for
      // their own points still gets them, so this failure is left silent
      // rather than shown as a refusal at the top of the screen.
      el.honoraryList.replaceChildren();
      setHidden(el.honoraryNote, true);
    }
  }

  function requirementRow(item, depth) {
    if (item.type === 'group') {
      // A leftover group from a set written before the list went flat. It is a
      // heading, and it only has anything to say when its rule is "some of
      // these": where it wants all of them, the rows underneath already say so.
      const wanted = item.min_children_passing;
      return h(
        'li',
        { class: 'honorary-row', dataset: { depth: String(depth) } },
        h('span', { class: 'honorary-label' }, item.label),
        wanted === null || wanted === undefined
          ? null
          : h('span', { class: 'honorary-need' }, `any ${wanted}`),
      );
    }

    const sources = item.categories.map((category) => category.name).join(', ');

    return h(
      'li',
      { class: 'honorary-row', dataset: { depth: String(depth) } },
      h('span', { class: 'honorary-label' }, item.label),
      h('span', { class: 'honorary-need' }, number(item.min_value)),
      // The sources only when they are not simply the requirement's own name,
      // which is the ordinary case: "GBMs, 9 events" says it once already.
      sources && sources !== item.label
        ? h('span', { class: 'honorary-from' }, sources)
        : null,
    );
  }

  // -------------------------------------------------------------------------
  // One member
  // -------------------------------------------------------------------------

  function render(card, { focus = true, announceStatus = true } = {}) {
    const honorary = Boolean(card?.is_honorary);
    el.nameText.textContent = card?.member?.display_name ?? '';
    setHidden(el.nameStar, !honorary);
    el.year.textContent = card?.year?.label ?? '';

    const requirements = (card?.requirements ?? []).map((row) => ({
      id: row.node_id,
      parent_id: row.parent_id,
      type: row.type,
      label: row.label,
      sort_order: row.sort_order,
      value: Number(row.value ?? 0),
      target: Number(row.target ?? 0),
      passed: Boolean(row.passed),
    }));

    const { root } = buildTree(requirements, card?.root_node_id ?? null);
    const rows = root
      ? flatten(root)
          .slice(1)
          .filter(({ item }) => item.type !== 'group')
      : [];

    const progress = measuredRequirementSummary(card?.requirements);
    el.figures.textContent = `${progress.met} of ${progress.total}`;

    el.state.textContent = honorary ? 'Earned' : 'Not yet';
    setHidden(el.state, false);

    el.list.replaceChildren(...rows.map(({ item, depth }) => memberRow(item, depth)));

    el.points.textContent = number(card?.point_total ?? 0);
    setHidden(el.card, false);
    if (focus) el.name.focus();
    if (announceStatus) {
      announce(
        `${card?.member?.display_name ?? 'You'}: ${plural(Number(card?.point_total ?? 0), 'point')}${
          honorary ? ', Honorary Member' : ''
        }`,
      );
    }
  }

  function memberRow(item, depth) {
    return h(
      'li',
      { class: 'check-row', dataset: { met: String(item.passed), depth: String(depth) } },
      h('span', { class: 'check-mark', 'aria-hidden': 'true' }, item.passed ? '✓' : '○'),
      h('span', { class: 'check-label' }, item.label),
      h(
        'span',
        { class: 'check-figures' },
        `${number(item.value)} of ${number(item.target)}`,
      ),
      // Never the colour alone, and never the glyph alone either.
      h('span', { class: 'visually-hidden' }, item.passed ? 'Met' : 'Not met'),
    );
  }

  function clear() {
    setHidden(el.card, true);
    el.nameText.textContent = '';
    setHidden(el.nameStar, true);
    el.list.replaceChildren();
    el.year.textContent = '';
    el.figures.textContent = '';
    el.points.textContent = '';
    setHidden(el.state, true);
  }

  return { loadRequirements, render, clear };
}
