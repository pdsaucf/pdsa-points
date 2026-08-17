// The requirements editor. This screen is the reason the rest of the product
// exists: the rules for Honorary Member are rows, and an officer changes them
// here without anybody deploying anything (invariant 1).
//
// IT HAS TO READ AS SENTENCES. The tree in the database is a graph of nodes,
// and nobody using this screen is ever told that. A measured line is a
// REQUIREMENT, and the words "node", "threshold" and "schema" are absent from
// every string below. The vocabulary itself lives in requirement-model.js so it
// can be checked in one place.
//
// THE LIST IS FLAT, AND THIS SCREEN NEVER MAKES A GROUP. The root still carries
// "must meet all" or "must meet at least 8 of", because that is the rule for
// the set as a whole. Below it, every row is one requirement measuring one or
// more categories, and nothing nests. A requirement already spans categories
// ("Speaking" is Journal Club plus Media Speaking), so the compound rule that
// nesting existed for is one ordinary row, and the second level bought nothing
// but a tree an officer had to hold in their head. Sets written before this can
// still hold a group: those rows render, and carry Ungroup, which lifts what is
// inside them up to the top and then deletes the empty group.
//
// EDITS SAVE AS THEY ARE MADE, AND THERE IS NO "SAVE DRAFT" BUTTON.
// The wireframe in docs/03-admin-ui.md draws one, next to a live preview of who
// would qualify. Those two cannot both be true: preview_requirement_set() reads
// the rows in the database, so a change that is still sitting unsaved in the
// browser is a change the preview cannot see, and a preview that ignores half
// of what is on screen is worse than no preview. A draft changes nothing on its
// own, which is what Publish is for, so saving as you go costs nothing and
// keeps the number on screen honest. See the report for this phase.
//
// THE PREVIEW NEVER BLOCKS TYPING. It is debounced, it runs against its own
// AbortController, and a slow or failed one leaves the last number on screen
// with a note rather than an empty editor.
//
// A PUBLISHED SET IS NOT EDITED. Every control is read-only against one, and
// "Edit as draft" clones it into a new version. RLS would in fact let an admin
// write a published set directly (req_sets_write in migration 11 admits
// fn_is_admin() unconditionally), so this is a line the client holds, and it is
// the line that keeps last year's members judged by last year's numbers.

import { select, insert, patch, remove, callRpc } from './rest.js';
import { READ_ONLY } from './officer-errors.js';
import {
  buildTree,
  flatten,
  nextOrder,
  reorderWithin,
  ungroupInto,
  problemsByNode,
  preferredSet,
  setMeta,
  setOptionLabel,
  statusTitle,
  isEditable,
  unitWord,
} from './requirement-model.js';
import { UNIT_LABEL, uniqueSlug } from './category-model.js';
import { $, h, announce, moveButton, setHidden, plural } from './ui.js';

const NODE_SELECT = [
  'id',
  'requirement_set_id',
  'parent_id',
  'type',
  'label',
  'sort_order',
  'min_children_passing',
  'min_value',
  'term_id',
  'requirement_node_categories(category_id)',
].join(',');

const SET_SELECT =
  'id,academic_year_id,name,version,status,root_node_id,published_at,created_at';

// Long enough that typing a two digit number is one write, short enough that
// the preview catches up before an officer has finished looking at the row.
const SETTLE_MS = 450;

// A write that came back having changed nothing. On this screen that means the
// set stopped being a draft underneath the officer, which is a page that is out
// of date rather than a mistake they made.
const NOT_CHANGED = 'Nothing was changed. Reload the page.';

const ONLY_ADMIN_PUBLISHES = 'Only an admin can publish.';

// The last option in every category picker, which is not a category.
const NEW_CATEGORY = 'new';

export function createRequirements(ctx) {
  const el = {
    loading: $('loading-requirements'),
    header: $('requirements-header'),
    status: $('set-status'),
    meta: $('set-meta'),
    setSelect: $('set-select'),
    copyFrom: $('copy-from'),
    copyRun: $('copy-from-run'),
    editAsDraft: $('edit-as-draft'),
    publish: $('publish'),
    publishNote: $('publish-note'),
    problems: $('set-problems'),
    problemsTitle: $('set-problems-title'),
    problemsList: $('set-problems-list'),
    body: $('requirements-body'),
    sentence: $('root-sentence'),
    tree: $('rule-tree'),
    footer: $('rule-footer'),
    addRequirement: $('add-requirement'),
    newCategory: $('new-category'),
    discardDraft: $('discard-draft'),
    publishBottom: $('publish-bottom'),
    previewLine: $('preview-line'),
    saveState: $('save-state'),
    empty: $('empty-requirements'),
    startDraft: $('start-draft'),
    publishDialog: $('publish-dialog'),
    publishForm: $('publish-form'),
    publishTitle: $('publish-title'),
    publishMeta: $('publish-meta'),
    publishPreview: $('publish-preview'),
    publishProblems: $('publish-problems'),
    discardDialog: $('discard-dialog'),
    discardForm: $('discard-form'),
    discardMeta: $('discard-meta'),
    discardEffect: $('discard-effect'),
    categoryDialog: $('new-category-dialog'),
    categoryForm: $('new-category-form'),
    categoryName: $('new-category-name'),
    categoryUnit: $('new-category-unit'),
    categoryError: $('new-category-error'),
  };

  const state = {
    sets: [],
    set: null,
    chosenSetId: null,
    root: null,
    byId: new Map(),
    categories: [],
    categoryById: new Map(),
    otherSets: new Map(), // academic year id -> the set a copy would come from
    counts: new Map(), // node id -> { passing, total }
    total: 0,
    baseline: null, // what the published set of this year says today
    problems: new Map(), // node id, or '' for the whole set
    rows: new Map(), // node id -> the two spans that get repainted
    pending: new Map(), // node id -> debounce timer for a typed value
    previewTimer: null,
    previewRun: 0,
    previewAbort: null,
    inFlight: 0,
    loaded: false,
  };

  const canEdit = () => ctx.canReview && isEditable(state.set);

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function load() {
    setHidden(el.loading, false);
    setHidden(el.header, true);
    setHidden(el.body, true);
    setHidden(el.empty, true);

    try {
      const [sets, categories] = await Promise.all([
        select('requirement_sets', {
          select: SET_SELECT,
          filters: { academic_year_id: `eq.${ctx.year.id}` },
          order: 'version.desc',
        }),
        select('categories', {
          select: 'id,slug,name,unit,unit_label,counts_toward_point_total,sort_order,archived_at',
          order: 'sort_order.asc',
        }),
      ]);

      state.sets = sets;
      state.categories = categories;
      state.categoryById = new Map(categories.map((row) => [row.id, row]));

      state.set =
        sets.find((row) => row.id === state.chosenSetId) ?? preferredSet(sets) ?? null;
      state.chosenSetId = state.set?.id ?? null;
      state.loaded = true;

      if (!state.set) {
        setHidden(el.loading, true);
        renderHeader();
        setHidden(el.empty, false);
        el.startDraft.disabled = !ctx.canReview;
        return;
      }

      await loadTree();
      setHidden(el.loading, true);
      renderHeader();
      renderTree();
      setHidden(el.body, false);

      refreshPreview({ now: true });
      loadBaseline();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  async function loadTree() {
    const rows = await select('requirement_nodes', {
      select: NODE_SELECT,
      filters: { requirement_set_id: `eq.${state.set.id}` },
      order: 'sort_order.asc',
    });
    const { root, byId } = buildTree(rows, state.set.root_node_id);
    state.root = root;
    state.byId = byId;
  }

  /**
   * "was 45" in the wireframe. The number worth comparing against is what the
   * rules that are live right now produce, so it comes from the published set
   * of the same year rather than from whatever this draft said a minute ago.
   * A year with nothing published has nothing to compare to, and says nothing.
   */
  async function loadBaseline() {
    state.baseline = null;
    const published = state.sets.find((row) => row.status === 'published');
    if (!published || published.id === state.set?.id) return;
    try {
      const rows = await callRpc(
        'preview_requirement_set',
        { p_set_id: published.id },
        { attempts: 2 },
      );
      const root = rootRow(rows, published.root_node_id);
      state.baseline = root ? Number(root.passing) : null;
      paintPreviewLine();
    } catch {
      // A baseline that cannot be read is a missing parenthetical, not an
      // error worth a strip across the screen.
    }
  }

  const rootRow = (rows, rootId) =>
    (rows ?? []).find((row) => row.node_id === rootId) ?? (rows ?? [])[0] ?? null;

  // -------------------------------------------------------------------------
  // The header
  // -------------------------------------------------------------------------

  function renderHeader() {
    setHidden(el.header, false);
    el.status.textContent = statusTitle(state.set);
    el.meta.textContent = state.set ? `${ctx.year.label} · ${setMeta(state.set)}` : ctx.year.label;

    // The picker only appears when a year holds more than one, which is the
    // state a year is in between starting a draft and publishing it.
    setHidden(el.setSelect, state.sets.length < 2);
    if (state.sets.length > 1) {
      el.setSelect.replaceChildren(
        ...state.sets.map((row) => h('option', { value: row.id }, setOptionLabel(row))),
      );
      el.setSelect.value = state.set.id;
    }

    const others = otherYearSets();
    setHidden(el.copyFrom, others.length === 0 || !ctx.canReview);
    setHidden(el.copyRun, others.length === 0 || !ctx.canReview);
    if (others.length) {
      el.copyFrom.replaceChildren(
        ...others.map((entry) => h('option', { value: entry.set.id }, entry.year.label)),
      );
    }

    const published = state.set?.status === 'published';
    setHidden(el.editAsDraft, !published || !ctx.canReview);

    const draft = isEditable(state.set);
    setHidden(el.publish, !draft || !ctx.canReview);

    // An officer is told why, rather than left pressing a button that answers
    // with a refusal from the database.
    const note = !ctx.canReview
      ? READ_ONLY
      : draft && !ctx.canPublish
        ? ONLY_ADMIN_PUBLISHES
        : '';
    el.publishNote.textContent = note;
    setHidden(el.publishNote, !note);

    setHidden(el.footer, !canEdit());

    // The same button as the one in the header, so that a long list does not
    // send an officer back to the top to publish what they just finished.
    setHidden(el.publishBottom, !draft || !ctx.canReview);
    paintBusy();
  }

  /** One entry per other year that has a set worth copying. */
  function otherYearSets() {
    return (ctx.years ?? [])
      .filter((year) => year.id !== ctx.year.id)
      .map((year) => ({ year, set: null }))
      .filter((entry) => {
        entry.set = state.otherSets?.get(entry.year.id) ?? null;
        return Boolean(entry.set);
      });
  }

  /**
   * Which set each other year would be copied from. Read once, because the
   * copy control is only useful when a previous year actually has rules and
   * asking every time the header repaints would be a request per keystroke.
   */
  async function loadOtherYears() {
    const years = (ctx.years ?? []).filter((year) => year.id !== ctx.year.id);
    if (!years.length) return;
    try {
      const rows = await select('requirement_sets', {
        select: SET_SELECT,
        filters: { academic_year_id: `in.(${years.map((year) => year.id).join(',')})` },
        order: 'version.desc',
      });
      const byYear = new Map();
      for (const year of years) {
        const set = preferredSet(rows.filter((row) => row.academic_year_id === year.id));
        if (set) byYear.set(year.id, set);
      }
      state.otherSets = byYear;
      if (state.loaded) renderHeader();
    } catch {
      // The copy control simply does not appear.
    }
  }

  // -------------------------------------------------------------------------
  // The tree
  // -------------------------------------------------------------------------

  function renderTree() {
    state.rows.clear();

    el.sentence.replaceChildren(
      'A member must meet ',
      ...(state.root ? groupControl(state.root) : ['every requirement']),
      ' of the following:',
    );

    if (!state.root) {
      el.tree.replaceChildren(h('p', { class: 'muted' }, 'Nothing to check yet.'));
      return;
    }

    const rows = flatten(state.root).slice(1); // the root is the sentence above
    if (!rows.length) {
      el.tree.replaceChildren(
        h(
          'div',
          { class: 'rule-empty' },
          h('p', { class: 'muted' }, 'No requirements yet.'),
          canEdit()
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'button',
                  disabled: state.inFlight > 0,
                  onClick: addRequirement,
                },
                'Add requirement',
              )
            : null,
        ),
      );
      return;
    }

    el.tree.replaceChildren(...rows.map(({ item, depth }) => renderRow(item, depth)));
    paintCounts();
    paintProblems();
  }

  function renderRow(item, depth) {
    const row = h('div', {
      class: item.type === 'group' ? 'rule-row rule-row-group' : 'rule-row',
      dataset: { id: item.id, depth: String(depth) },
      style: `--depth: ${depth}`,
    });

    const line = h('div', { class: 'rule-line' });
    line.append(labelField(item));
    if (item.type === 'group') line.append('must meet ', ...groupControl(item), ' of:');
    else line.append(...thresholdControl(item));

    const count = h('span', { class: 'rule-count' });
    const problems = h('ul', { class: 'problem-list problem-list-inline', hidden: true });
    state.rows.set(item.id, { count, problems });

    row.append(line, count, rowActions(item));
    row.append(problems);
    return row;
  }

  function labelField(item) {
    return h('input', {
      class: 'rule-label',
      type: 'text',
      value: item.label ?? '',
      maxlength: '60',
      autocomplete: 'off',
      spellcheck: 'false',
      disabled: !canEdit(),
      'aria-label': item.type === 'group' ? 'Group name' : 'Requirement name',
      onInput: (event) => queueEdit(item, { label: event.target.value }),
      onChange: (event) => queueEdit(item, { label: event.target.value }, { now: true }),
    });
  }

  /**
   * "( all / at least [N] )". This is the control that turns "every category"
   * into "any 8 of 10" without anybody touching SQL.
   *
   * The words around it belong to the caller, because the sentence differs:
   * the root reads "A member must meet all of the following", and a leftover
   * group reads "Editorial Points must meet all of".
   */
  function groupControl(item) {
    const all = item.min_children_passing === null || item.min_children_passing === undefined;
    const name = `mode-${item.id}`;

    const number = h('input', {
      class: 'rule-number rule-number-small',
      type: 'number',
      min: '1',
      step: '1',
      value: all ? '' : String(item.min_children_passing),
      disabled: !canEdit() || all,
      'aria-label': 'How many must pass',
      onInput: (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value) || value < 1) return;
        queueEdit(item, { min_children_passing: Math.round(value) });
      },
    });

    const radio = (checked, label, onPick) =>
      h(
        'label',
        { class: 'rule-choice' },
        h('input', {
          type: 'radio',
          name,
          checked,
          disabled: !canEdit(),
          onChange: onPick,
        }),
        label,
      );

    return [
      h(
        'span',
        { class: 'rule-mode' },
        // The two handlers reach straight into the number box rather than
        // redrawing the row, because redrawing takes the focus out of whatever
        // the officer is in the middle of.
        radio(all, 'all', () => {
          number.disabled = true;
          number.value = '';
          queueEdit(item, { min_children_passing: null }, { now: true });
        }),
        radio(!all, 'at least', () => {
          const wanted = item.min_children_passing ?? Math.max(1, item.children.length);
          number.disabled = false;
          number.value = String(wanted);
          number.focus();
          queueEdit(item, { min_children_passing: wanted }, { now: true });
        }),
        number,
      ),
    ];
  }

  /** "at least [ 9 ] events from ⟨GBMs⟩", with the categories as real chips. */
  function thresholdControl(item) {
    const categories = item.categoryIds
      .map((id) => state.categoryById.get(id))
      .filter(Boolean);
    const unit = unitWord(categories);

    const number = h('input', {
      class: 'rule-number',
      type: 'number',
      min: '0',
      step: unit === 'hours' ? '0.5' : '1',
      value: item.min_value === null || item.min_value === undefined ? '' : String(Number(item.min_value)),
      disabled: !canEdit(),
      'aria-label': 'How many are needed',
      onInput: (event) => {
        const value = Number(event.target.value);
        // A cleared box is somebody midway through typing, not a rule with no
        // number in it. The old value stays until they type a new one.
        if (event.target.value === '' || !Number.isFinite(value) || value < 0) return;
        queueEdit(item, { min_value: value });
      },
      onChange: (event) => {
        if (event.target.value === '') event.target.value = String(Number(item.min_value ?? 0));
      },
    });

    const chips = h('span', { class: 'chip-row' });
    for (const category of categories) chips.append(categoryChip(item, category));
    if (canEdit()) chips.append(addCategoryControl(item));
    if (!categories.length && !canEdit()) {
      chips.append(h('span', { class: 'muted small' }, 'No categories'));
    }

    return ['at least ', number, unit ? ` ${unit}` : '', ' from ', chips];
  }

  function categoryChip(item, category) {
    const chip = h(
      'span',
      {
        class: 'category-chip',
        dataset: { archived: String(Boolean(category.archived_at)) },
      },
      h('span', {}, category.name),
    );
    if (canEdit()) {
      chip.append(
        h(
          'button',
          {
            type: 'button',
            class: 'chip-remove',
            'aria-label': `Remove ${category.name}`,
            title: `Remove ${category.name}`,
            onClick: () => dropCategory(item, category),
          },
          '×',
        ),
      );
    }
    return chip;
  }

  /**
   * The picker that attaches a category to a requirement, with the way to
   * create one at the bottom of it.
   *
   * A rule for something the club has never tracked is the ordinary reason an
   * officer opens this screen, and sending them to the categories tab to make
   * it loses the half written rule they were looking at. The new category is
   * attached to this requirement the moment it exists.
   */
  function addCategoryControl(item) {
    const available = state.categories.filter(
      (category) => !category.archived_at && !item.categoryIds.includes(category.id),
    );

    return h(
      'select',
      {
        class: 'select select-quiet chip-add',
        'aria-label': 'Add an event category',
        onChange: (event) => {
          const value = event.target.value;
          event.target.value = '';
          if (value === NEW_CATEGORY) {
            newCategory(item);
            return;
          }
          const category = state.categoryById.get(value);
          if (category) addCategory(item, category);
        },
      },
      h('option', { value: '' }, 'Add event category'),
      ...available.map((category) => h('option', { value: category.id }, category.name)),
      h('option', { value: NEW_CATEGORY }, 'New event category…'),
    );
  }

  function rowActions(item) {
    const actions = h('div', { class: 'rule-actions' });
    if (!canEdit()) return actions;

    const parent = item.parent_id ? state.byId.get(item.parent_id) : null;
    const siblings = parent ? parent.children : [];

    const button = (label, title, onClick, disabled = false) =>
      h(
        'button',
        {
          type: 'button',
          class: 'button button-small',
          title,
          'aria-label': title,
          disabled: disabled || state.inFlight > 0,
          onClick,
        },
        label,
      );

    actions.append(
      moveButton({
        direction: 'up',
        title: `Move ${item.label} up`,
        disabled: siblings[0]?.id === item.id || state.inFlight > 0,
        onClick: () => moveWithin(item, -1),
      }),
      moveButton({
        direction: 'down',
        title: `Move ${item.label} down`,
        disabled: siblings[siblings.length - 1]?.id === item.id || state.inFlight > 0,
        onClick: () => moveWithin(item, 1),
      }),
    );

    // Only a set written before the list went flat still holds one of these,
    // and Ungroup is how it stops holding it: what is inside comes up to the
    // top level, in order, and the group itself goes.
    if (item.type === 'group') {
      actions.append(
        button('Ungroup', `Move what is inside ${item.label} to the top`, () => ungroup(item)),
      );
    }

    actions.append(
      h(
        'button',
        {
          type: 'button',
          class: 'button button-small button-danger',
          disabled: state.inFlight > 0,
          'aria-label': `Remove ${item.label}`,
          onClick: () => removeItem(item),
        },
        'Remove',
      ),
    );

    return actions;
  }

  // -------------------------------------------------------------------------
  // Painting the numbers, without rebuilding the rows underneath them
  // -------------------------------------------------------------------------
  // Rebuilding the tree on every preview would take the focus out of whatever
  // box the officer is typing in, which is the one thing this screen cannot do.

  function paintCounts() {
    for (const [id, refs] of state.rows) {
      const count = state.counts.get(id);
      if (!count) {
        refs.count.textContent = '';
        continue;
      }
      refs.count.textContent = `${count.passing} ✓`;
      refs.count.title = `${plural(count.passing, 'member')} of ${count.total} meet this`;
    }
    paintPreviewLine();
  }

  function paintPreviewLine() {
    const root = state.root ? state.counts.get(state.root.id) : null;
    if (!root) {
      el.previewLine.textContent = state.previewFailed ? 'Preview unavailable.' : '';
      return;
    }
    const was =
      state.baseline !== null && state.baseline !== root.passing ? ` (was ${state.baseline})` : '';
    el.previewLine.textContent = `${root.passing} of ${root.total} members would qualify${was}`;
  }

  function paintProblems() {
    const setLevel = state.problems.get('') ?? [];
    setHidden(el.problems, setLevel.length === 0);
    if (setLevel.length) {
      el.problemsTitle.textContent = plural(setLevel.length, 'problem');
      el.problemsList.replaceChildren(...setLevel.map(problemItem));
    }

    for (const [id, refs] of state.rows) {
      const held = state.problems.get(id) ?? [];
      refs.problems.replaceChildren(...held.map(problemItem));
      setHidden(refs.problems, held.length === 0);
      const row = el.tree.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (row) row.dataset.problem = String(held.length > 0);
    }
  }

  const problemItem = (problem) =>
    h(
      'li',
      { class: 'problem' },
      h('span', { class: 'problem-title' }, problem.title),
      problem.body ? ` ${problem.body}` : '',
    );

  // -------------------------------------------------------------------------
  // Preview and validation
  // -------------------------------------------------------------------------

  function refreshPreview({ now = false } = {}) {
    clearTimeout(state.previewTimer);
    if (now) runPreview();
    else state.previewTimer = setTimeout(runPreview, SETTLE_MS);
  }

  async function runPreview() {
    if (!state.set) return;
    const setId = state.set.id;

    state.previewAbort?.abort();
    const controller = new AbortController();
    state.previewAbort = controller;
    const run = ++state.previewRun;

    try {
      const [counts, problems] = await Promise.all([
        callRpc(
          'preview_requirement_set',
          { p_set_id: setId },
          { signal: controller.signal, attempts: 2 },
        ),
        callRpc(
          'validate_requirement_set',
          { p_set_id: setId },
          { signal: controller.signal, attempts: 2 },
        ),
      ]);

      // A slower earlier run must never overwrite a faster later one.
      if (run !== state.previewRun) return;

      state.previewFailed = false;
      state.counts = new Map(
        (counts ?? []).map((row) => [
          row.node_id,
          { passing: Number(row.passing) || 0, total: Number(row.total) || 0 },
        ]),
      );
      state.problems = problemsByNode(problems);
      paintCounts();
      paintProblems();
    } catch (err) {
      if (err?.name === 'AbortError' || run !== state.previewRun) return;
      state.previewFailed = true;
      state.counts = new Map();
      paintCounts();
    }
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  function setSaving(on, said) {
    state.inFlight += on ? 1 : -1;
    if (state.inFlight < 0) state.inFlight = 0;
    el.saveState.textContent = state.inFlight > 0 ? 'Saving…' : said ?? '';
    paintBusy();
  }

  /**
   * The buttons that are the same for the whole screen, held against whatever
   * is in flight. The row buttons are not here: Up on the first row is disabled
   * for a reason that has nothing to do with saving, and re-enabling everything
   * would lose it. Rows are redrawn once a write lands instead.
   */
  function paintBusy() {
    const busy = state.inFlight > 0;
    const editable = canEdit();
    el.addRequirement.disabled = !editable || busy;
    el.newCategory.disabled = !editable || busy;
    el.discardDraft.disabled = !editable || busy;
    el.editAsDraft.disabled = busy;
    el.publish.disabled = !ctx.canPublish || busy;
    el.publishBottom.disabled = el.publish.disabled;
  }

  /**
   * One edit to one row.
   *
   * Typing "25" into a box is two input events and has to be one write, so the
   * value is held for a moment first. Picking a radio or a category is not
   * something anybody types, so those go straight out.
   */
  function queueEdit(item, changes, { now = false } = {}) {
    Object.assign(item, changes);
    const pending = state.pending.get(item.id) ?? {};
    Object.assign(pending, changes);
    state.pending.set(item.id, pending);

    clearTimeout(pending.timer);
    if (now) {
      flushEdit(item.id);
      return;
    }
    pending.timer = setTimeout(() => flushEdit(item.id), SETTLE_MS);
  }

  async function flushEdit(id) {
    const pending = state.pending.get(id);
    if (!pending) return;
    state.pending.delete(id);
    const { timer, ...changes } = pending;
    clearTimeout(timer);
    if (!Object.keys(changes).length) return;

    setSaving(true);
    try {
      const rows = await patch('requirement_nodes', { id: `eq.${id}` }, changes);
      if (!rows.length) {
        setSaving(false);
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      setSaving(false, 'Saved');
      refreshPreview();
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  /** One more line at the end of the list. There is no other shape to add. */
  async function addRequirement() {
    if (!state.root) return;
    setSaving(true);
    try {
      const rows = await insert('requirement_nodes', [
        {
          requirement_set_id: state.set.id,
          parent_id: state.root.id,
          type: 'threshold',
          label: 'New requirement',
          sort_order: nextOrder(state.root.children),
          // A requirement has to carry a number from the moment it exists: the
          // check constraint on the table refuses one without.
          min_value: 1,
        },
      ]);
      if (!rows?.length) throw new Error('nothing came back');
      await reloadTree('Added a requirement.');
      focusRow(rows[0].id);
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  async function removeItem(item) {
    setSaving(true);
    try {
      const rows = await remove('requirement_nodes', { id: `eq.${item.id}` });
      if (!rows.length) {
        setSaving(false);
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      await reloadTree(`Removed ${item.label}.`);
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  async function moveWithin(item, delta) {
    const parent = state.byId.get(item.parent_id);
    if (!parent) return;
    const changes = reorderWithin(parent.children, item.id, delta);
    if (!changes.length) return;

    setSaving(true);
    try {
      for (const change of changes) {
        await patch('requirement_nodes', { id: `eq.${change.id}` }, { sort_order: change.sort_order });
      }
      await reloadTree('Moved.');
      focusRow(item.id);
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  /**
   * Taking a leftover group apart.
   *
   * The children move to the top level FIRST and the group is deleted after,
   * because parent_id cascades: deleting it while they are still inside would
   * take the requirements with it, which is the one outcome an officer pressing
   * a button called Ungroup cannot be shown.
   */
  async function ungroup(item) {
    setSaving(true);
    try {
      for (const move of ungroupInto(state.root, item)) {
        await patch(
          'requirement_nodes',
          { id: `eq.${move.id}` },
          { parent_id: move.parent_id, sort_order: move.sort_order },
        );
      }
      const rows = await remove('requirement_nodes', { id: `eq.${item.id}` });
      if (!rows.length) {
        setSaving(false);
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      await reloadTree(`Ungrouped ${item.label}.`);
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  /**
   * A category that does not exist yet, made without leaving the rule.
   *
   * `item` is the requirement whose picker asked for it, if one did: the new
   * category is attached to it straight away, because an officer who typed
   * "Journal Club" into a rule meant that rule to measure it.
   */
  async function newCategory(item = null) {
    const made = await askForCategory();
    if (!made) return;

    let category = null;
    setSaving(true);
    try {
      const rows = await insert('categories', [
        {
          slug: uniqueSlug(
            made.name,
            state.categories.map((row) => row.slug),
          ),
          name: made.name,
          unit: made.unit,
          unit_label: UNIT_LABEL[made.unit] ?? null,
          counts_toward_point_total: true,
          sort_order: nextOrder(state.categories),
        },
      ]);
      category = rows?.[0];
      if (!category) throw new Error('nothing came back');
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
      return;
    }

    state.categories.push(category);
    state.categoryById.set(category.id, category);
    // The categories screen is showing the same rows, so it re-reads them.
    ctx.onCategoriesChanged?.();
    setSaving(false, `${category.name} added.`);

    if (item) {
      await addCategory(item, category);
      return;
    }
    renderTree();
    announce(`${category.name} added.`);
  }

  function askForCategory() {
    el.categoryName.value = '';
    el.categoryUnit.value = 'event_count';
    setHidden(el.categoryError, true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        el.categoryForm.removeEventListener('submit', onSubmit);
        el.categoryDialog.removeEventListener('close', onClose);
        resolve(value);
      };
      // A nameless category would be a chip with nothing written on it, so the
      // submit is refused rather than the dialog closing on a blank field.
      const onSubmit = (event) => {
        const name = el.categoryName.value.trim();
        if (!name) {
          event.preventDefault();
          setHidden(el.categoryError, false);
          el.categoryName.focus();
          return;
        }
        el.categoryDialog.close();
        finish({ name, unit: el.categoryUnit.value });
      };
      const onClose = () => finish(null);

      el.categoryForm.addEventListener('submit', onSubmit);
      el.categoryDialog.addEventListener('close', onClose, { once: true });
      el.categoryDialog.showModal();
      el.categoryName.focus();
    });
  }

  async function addCategory(item, category) {
    setSaving(true);
    try {
      await insert('requirement_node_categories', [
        { node_id: item.id, category_id: category.id },
      ]);
      await reloadTree(`Added ${category.name}.`);
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  async function dropCategory(item, category) {
    setSaving(true);
    try {
      const rows = await remove('requirement_node_categories', {
        node_id: `eq.${item.id}`,
        category_id: `eq.${category.id}`,
      });
      if (!rows.length) {
        setSaving(false);
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      await reloadTree(`Removed ${category.name}.`);
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  /**
   * Re-read what the database now holds, redraw, and ask for a fresh preview.
   *
   * The save is marked finished BEFORE the redraw, because a row draws its Up,
   * Down and Remove buttons disabled while a write is in flight, and a redraw
   * that happened first would leave every one of them disabled with nothing
   * left to re-enable them.
   */
  async function reloadTree(said) {
    try {
      await loadTree();
      setSaving(false, said);
      renderTree();
      if (said) announce(said);
      refreshPreview();
    } catch (err) {
      setSaving(false);
      ctx.fail(err, load);
    }
  }

  function focusRow(id) {
    const row = el.tree.querySelector(`[data-id="${CSS.escape(id)}"] .rule-label`);
    if (row) setTimeout(() => row.focus({ preventScroll: true }), 0);
  }

  // -------------------------------------------------------------------------
  // The lifecycle: draft, publish, copy
  // -------------------------------------------------------------------------

  async function startDraft() {
    setSaving(true);
    try {
      const sets = await insert('requirement_sets', [
        {
          academic_year_id: ctx.year.id,
          name: 'Honorary Member',
          version: highestVersion() + 1,
          status: 'draft',
        },
      ]);
      const set = sets?.[0];
      if (!set) throw new Error('nothing came back');

      const roots = await insert('requirement_nodes', [
        {
          requirement_set_id: set.id,
          parent_id: null,
          type: 'group',
          label: 'Honorary Member',
          sort_order: 0,
        },
      ]);
      if (roots?.[0]) {
        await patch('requirement_sets', { id: `eq.${set.id}` }, { root_node_id: roots[0].id });
      }

      state.chosenSetId = set.id;
      setSaving(false, 'Draft started');
      await load();
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  const highestVersion = () =>
    state.sets.reduce((max, row) => Math.max(max, Number(row.version) || 0), 0);

  /**
   * Cloning, which is both "Edit as draft" and "Copy from last year".
   *
   * clone_requirement_set() takes only the set to copy, so it decides for
   * itself which year the copy lands in. For "Edit as draft" that is this year
   * either way. For a copy from another year it may not be, so the new set is
   * read back and moved onto the year on screen if it is not there already,
   * which is an ordinary draft write an officer is allowed to make. If that
   * move is refused, the screen says where the copy actually went rather than
   * showing an empty year and claiming success.
   */
  async function cloneFrom(sourceId, { said }) {
    setSaving(true);
    try {
      const newId = await callRpc('clone_requirement_set', { p_set_id: sourceId });
      if (!newId) throw new Error('nothing came back');

      const rows = await select('requirement_sets', {
        select: SET_SELECT,
        filters: { id: `eq.${newId}` },
        limit: 1,
      });
      let created = rows[0] ?? null;

      if (created && created.academic_year_id !== ctx.year.id) {
        const moved = await patch(
          'requirement_sets',
          { id: `eq.${created.id}` },
          { academic_year_id: ctx.year.id },
        );
        created = moved[0] ?? created;
      }

      setSaving(false);

      if (created && created.academic_year_id !== ctx.year.id) {
        const where = (ctx.years ?? []).find((year) => year.id === created.academic_year_id);
        ctx.note(`The copy was made in ${where?.label ?? 'another year'}.`, 'warn');
        return;
      }

      state.chosenSetId = created?.id ?? null;
      ctx.note(said);
      announce(said);
      await load();
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  async function publish() {
    const confirmed = await confirmPublish();
    if (!confirmed) return;

    setSaving(true);
    try {
      const result = await callRpc('publish_requirement_set', { p_set_id: state.set.id });
      setSaving(false);
      const version = result?.version ?? state.set.version;
      const said = `Published version ${version}.`;
      ctx.note(said);
      announce(said);
      state.chosenSetId = state.set.id;
      await load();
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  function confirmPublish() {
    const root = state.root ? state.counts.get(state.root.id) : null;
    const problems = [...state.problems.values()].flat();

    el.publishTitle.textContent = `Publish version ${state.set.version}`;
    el.publishMeta.textContent = `${ctx.year.label} · ${state.set.name}`;
    el.publishPreview.textContent = root
      ? `${root.passing} of ${root.total} members would qualify.`
      : '';
    el.publishProblems.replaceChildren(...problems.map(problemItem));
    setHidden(el.publishProblems, problems.length === 0);

    return decide(el.publishDialog, el.publishForm);
  }

  /**
   * Throwing the draft away, which is what "cancel my changes" means on a
   * screen that has already saved every one of them.
   *
   * Only the draft goes. The published set is a separate row and is what
   * members go on being judged by, which is the line the dialog states before
   * anybody presses anything.
   */
  async function discardDraft() {
    if (!isEditable(state.set)) return;

    const published = state.sets.find(
      (row) => row.status === 'published' && row.id !== state.set.id,
    );
    el.discardMeta.textContent = `${ctx.year.label} · ${setMeta(state.set)}`;
    el.discardEffect.textContent = published
      ? `Members stay judged by version ${published.version}.`
      : 'Nothing is published for this year, so nobody qualifies until one is.';

    if (!(await decide(el.discardDialog, el.discardForm))) return;

    const version = state.set.version;
    setSaving(true);
    try {
      // The nodes go with it: requirement_nodes cascades from the set.
      const rows = await remove('requirement_sets', { id: `eq.${state.set.id}` });
      if (!rows.length) {
        setSaving(false);
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      setSaving(false);
      const said = `Discarded version ${version}.`;
      ctx.note(said);
      announce(said);
      state.chosenSetId = null;
      await load();
    } catch (err) {
      setSaving(false);
      ctx.fail(err, null);
    }
  }

  /**
   * A dialog that answers true when it is submitted and false when it is
   * dismissed.
   *
   * Same guard as the review queue's dialogs: close() fires its event as a
   * queued task, so the cancel path can still run after submit decided.
   */
  function decide(dialog, form) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        form.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('close', onClose);
        resolve(value);
      };
      const onSubmit = () => {
        dialog.close();
        finish(true);
      };
      const onClose = () => finish(false);

      form.addEventListener('submit', onSubmit);
      dialog.addEventListener('close', onClose, { once: true });
      dialog.showModal();
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wire() {
    el.setSelect.addEventListener('change', () => {
      state.chosenSetId = el.setSelect.value;
      load();
    });

    el.startDraft.addEventListener('click', startDraft);

    el.editAsDraft.addEventListener('click', () =>
      cloneFrom(state.set.id, { said: 'Draft started from the published version.' }),
    );

    el.copyRun.addEventListener('click', () => {
      const sourceId = el.copyFrom.value;
      if (!sourceId) return;
      cloneFrom(sourceId, { said: 'Copied.' });
    });

    el.publish.addEventListener('click', publish);
    el.publishBottom.addEventListener('click', publish);

    el.addRequirement.addEventListener('click', addRequirement);
    el.newCategory.addEventListener('click', () => newCategory(null));
    el.discardDraft.addEventListener('click', discardDraft);

    for (const dialog of [el.publishDialog, el.discardDialog, el.categoryDialog]) {
      dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    }
  }

  return {
    mount() {
      wire();
      loadOtherYears();
      return load();
    },
    reload() {
      state.chosenSetId = null;
      loadOtherYears();
      return load();
    },
    hasLoaded: () => state.loaded,
  };
}
