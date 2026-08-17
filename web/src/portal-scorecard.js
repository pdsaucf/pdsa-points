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
// The unit word comes from the categories a requirement measures, through
// unitWord(), which answers with nothing at all rather than a confident wrong
// word when a requirement adds hours to event counts. Same rule as the officer
// side, same function.

import { rpc } from './api.js';
import { buildTree, flatten, unitWord } from './requirement-model.js';
import { $, h, announce, setHidden, plural } from './ui.js';

const number = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
};

/**
 * The unit word, agreeing with the number in front of it.
 *
 * unitWord() answers in the plural, because that is what a column heading and a
 * target need, and "1 events" is the one place that reads as a bug rather than
 * as a figure. The singular is the plural without its s, which holds for the
 * three words this can produce and for any unit_label a club types in.
 */
const unitFor = (value, categories) => {
  const word = unitWord(categories);
  if (!word) return '';
  return Number(value) === 1 ? word.replace(/s$/i, '') : word;
};

export function createScorecard(ctx) {
  const el = {
    card: $('scorecard'),
    name: $('score-name'),
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

    const unit = unitFor(item.min_value, item.categories);
    const sources = item.categories.map((category) => category.name).join(', ');

    return h(
      'li',
      { class: 'honorary-row', dataset: { depth: String(depth) } },
      h('span', { class: 'honorary-label' }, item.label),
      h(
        'span',
        { class: 'honorary-need' },
        [number(item.min_value), unit].filter(Boolean).join(' '),
      ),
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

  function render(card) {
    el.name.textContent = card?.member?.display_name ?? '';

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

    // Which categories each requirement measures, kept beside the tree rather
    // than on it: buildTree() fills in a categoryIds of its own from the shape
    // PostgREST returns for an embedded table, and would overwrite one set here.
    const byCategory = new Map((card?.categories ?? []).map((row) => [row.id, row]));
    const measuring = new Map(
      (card?.requirements ?? []).map((row) => [
        row.node_id,
        (row.category_ids ?? []).map((id) => byCategory.get(id)).filter(Boolean),
      ]),
    );

    const { root } = buildTree(requirements, card?.root_node_id ?? null);
    const rows = root ? flatten(root).slice(1) : [];

    el.figures.textContent = root ? `${number(root.value)} of ${number(root.target)} met` : '';

    const honorary = Boolean(card?.is_honorary);
    el.state.textContent = honorary ? 'Honorary Member' : '';
    setHidden(el.state, !honorary);

    el.list.replaceChildren(...rows.map(({ item, depth }) => memberRow(item, depth, measuring)));

    el.points.textContent = plural(Number(card?.point_total ?? 0), 'point');
    setHidden(el.card, false);
    announce(
      `${card?.member?.display_name ?? 'You'}: ${plural(Number(card?.point_total ?? 0), 'point')}${
        honorary ? ', Honorary Member' : ''
      }`,
    );
  }

  function memberRow(item, depth, measuring) {
    const measured = item.type !== 'group';
    const unit = measured ? unitFor(item.target, measuring.get(item.id) ?? []) : '';

    // A group whose rule is "some of these" is the one place a tick with no
    // figures would look wrong: two of its three requirements are visibly not
    // met and the group passed anyway. Where a group needs all of them, the
    // ticks below it already say the same thing, so it stays quiet.
    const showFigures = measured || item.target < (item.children?.length ?? 0);

    return h(
      'li',
      { class: 'check-row', dataset: { met: String(item.passed), depth: String(depth) } },
      h('span', { class: 'check-mark', 'aria-hidden': 'true' }, item.passed ? '✓' : '○'),
      h('span', { class: 'check-label' }, item.label),
      showFigures
        ? h(
            'span',
            { class: 'check-figures' },
            [`${number(item.value)} of ${number(item.target)}`, measured ? unit : 'met']
              .filter(Boolean)
              .join(' '),
          )
        : null,
      // Never the colour alone, and never the glyph alone either.
      h('span', { class: 'visually-hidden' }, item.passed ? 'Met' : 'Not met'),
    );
  }

  function clear() {
    setHidden(el.card, true);
    el.list.replaceChildren();
    el.figures.textContent = '';
    el.points.textContent = '';
    setHidden(el.state, true);
  }

  return { loadRequirements, render, clear };
}
