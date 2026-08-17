// The progress board: the screen that replaces the Total and Honorary tabs.
//
// This is the one officers actually looked at, so it is the one that decides
// whether the system is worth using instead of the sheet. It is a wall of
// numbers by design. Sticky first column, because scanning across thirteen
// categories without losing the name is the entire interaction, and one button
// that hands the whole thing over as a spreadsheet, because some officers will
// always want one.
//
// NOTHING ON THIS SCREEN IS COMPUTED HERE (invariant 2).
//
//   point_total   read from v_member_status. It sums only the categories
//                 flagged as counting toward it, which is what excludes
//                 Volunteering hours, and that flag is a row rather than a rule
//                 anybody wrote in JavaScript.
//   is_honorary   read from v_member_status. It is the root requirement's
//                 verdict, evaluated by fn_member_requirement_status() in
//                 Postgres.
//   each cell     read from v_member_category_totals.
//
// The one comparison this file makes is `total >= target` for the tick in a
// cell, and BOTH of those numbers came from the database: the total from the
// view, the target from requirement_nodes.min_value. It is a rendering of two
// server values, not a second evaluator. It is also deliberately only drawn for
// a category measured by a requirement all on its own, because a category that
// is only measured together with another one (Journal Club and Media Speaking
// share a rule) has no threshold of its own to be met, and inventing one would
// tell an officer something the rules do not say. Those columns show the number
// and no target. The member detail screen asks
// fn_member_requirement_status() for the authoritative per-requirement verdict.

import { select } from './rest.js';
import { csvFilename, downloadCsv } from './csv.js';
import { $, h, announce, setHidden, plural } from './ui.js';

const HONORARY_FILTERS = {
  all: 'Everyone',
  honorary: 'Honorary only',
  not_honorary: 'Not honorary yet',
};

export function createProgress(ctx) {
  const el = {
    loading: $('loading-progress'),
    empty: $('empty-progress'),
    emptyTitle: $('empty-progress-title'),
    emptyBody: $('empty-progress-body'),
    search: $('progress-search'),
    filter: $('progress-filter'),
    count: $('progress-count'),
    exportButton: $('progress-export'),
    scroll: $('progress-scroll'),
    table: $('progress-table'),
  };

  const state = {
    categories: [],
    targets: new Map(), // category_id -> min_value, single-category rules only
    members: [],
    status: new Map(), // member_id -> { point_total, is_honorary }
    totals: new Map(), // `${member_id}:${category_id}` -> total
    query: '',
    filter: 'all',
    loaded: false,
  };

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function load() {
    setHidden(el.loading, false);
    setHidden(el.empty, true);
    setHidden(el.scroll, true);

    const yearId = ctx.year.id;

    try {
      // Five reads, in parallel, none of which depends on another. The board is
      // 355 rows by 13 columns and every one of those numbers is already
      // aggregated by the database, so this is five requests rather than one
      // per member.
      const [categories, enrollments, status, totals, targets] = await Promise.all([
        select('categories', {
          select: 'id,name,sort_order,archived_at',
          order: 'sort_order.asc',
        }),
        select('member_enrollments', {
          select: 'member_id,status,joined_on,members!inner(id,display_name,archived_at,merged_into_id)',
          filters: {
            academic_year_id: `eq.${yearId}`,
            'members.archived_at': 'is.null',
            'members.merged_into_id': 'is.null',
          },
        }),
        select('v_member_status', {
          select: 'member_id,point_total,is_honorary',
          filters: { academic_year_id: `eq.${yearId}` },
        }),
        select('v_member_category_totals', {
          select: 'member_id,category_id,total',
          filters: { academic_year_id: `eq.${yearId}` },
        }),
        loadTargets(yearId),
      ]);

      // A retired category still holds last year's credit, so it earns a column
      // only when somebody on this year's board actually has a number in it.
      const used = new Set(totals.map((row) => row.category_id));
      state.categories = categories.filter((row) => !row.archived_at || used.has(row.id));

      state.members = enrollments
        .map((row) => row.members)
        .filter(Boolean)
        .sort((a, b) => a.display_name.localeCompare(b.display_name));

      state.status = new Map(
        status.map((row) => [
          row.member_id,
          { point_total: Number(row.point_total ?? 0), is_honorary: Boolean(row.is_honorary) },
        ]),
      );

      state.totals = new Map(
        totals.map((row) => [`${row.member_id}:${row.category_id}`, Number(row.total ?? 0)]),
      );

      state.targets = targets;
      state.loaded = true;
      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  /**
   * The number under each column heading.
   *
   * It is the published rule's own min_value, read from the same rows the
   * requirements editor writes, so changing a threshold there changes this
   * board with no deploy (invariant 1). A requirement that measures two
   * categories at once contributes no target to either of them: see the note at
   * the top of this file.
   */
  async function loadTargets(yearId) {
    const sets = await select('requirement_sets', {
      select: 'id,status',
      filters: { academic_year_id: `eq.${yearId}`, status: 'eq.published' },
      limit: 1,
    });
    const set = sets[0];
    if (!set) return new Map();

    const rows = await select('requirement_nodes', {
      select: 'id,type,min_value,requirement_node_categories(category_id)',
      filters: { requirement_set_id: `eq.${set.id}`, type: 'eq.threshold' },
    });

    const targets = new Map();
    for (const row of rows) {
      const links = row.requirement_node_categories ?? [];
      if (links.length !== 1) continue;
      targets.set(links[0].category_id, Number(row.min_value));
    }
    return targets;
  }

  // -------------------------------------------------------------------------
  // What is on screen right now
  // -------------------------------------------------------------------------

  function visibleMembers() {
    const query = state.query.trim().toLowerCase();
    return state.members.filter((member) => {
      if (query && !member.display_name.toLowerCase().includes(query)) return false;
      const honorary = state.status.get(member.id)?.is_honorary ?? false;
      if (state.filter === 'honorary' && !honorary) return false;
      if (state.filter === 'not_honorary' && honorary) return false;
      return true;
    });
  }

  const totalFor = (memberId, categoryId) => state.totals.get(`${memberId}:${categoryId}`) ?? 0;

  /** 29.5 stays 29.5, 5.00 becomes 5. Columns of numbers read badly otherwise. */
  const number = (value) => {
    const n = Number(value ?? 0);
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  };

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function render() {
    setHidden(el.loading, true);

    const rows = visibleMembers();
    const honorary = rows.filter((member) => state.status.get(member.id)?.is_honorary).length;

    el.count.textContent = state.members.length
      ? `${plural(rows.length, 'member')} · ${honorary} honorary`
      : '';

    setHidden(el.empty, rows.length > 0);
    setHidden(el.scroll, rows.length === 0);
    el.exportButton.disabled = rows.length === 0;

    if (!rows.length) {
      const anybody = state.members.length > 0;
      el.emptyTitle.textContent = anybody ? 'No members match' : 'Nobody on the roster';
      el.emptyBody.textContent = anybody ? '' : 'Add them on the Members tab.';
      return;
    }

    el.table.replaceChildren(head(), body(rows));
  }

  function head() {
    const names = h(
      'tr',
      {},
      h('th', { class: 'board-name-cell', scope: 'col' }, 'Member'),
      h('th', { class: 'board-number', scope: 'col' }, 'Points'),
      ...state.categories.map((category) =>
        h('th', { class: 'board-number', scope: 'col' }, category.name),
      ),
      h('th', { class: 'board-number', scope: 'col' }, 'Honorary'),
    );

    // The threshold strip. Empty under Points, because the point total is not
    // something a member passes: it is the old Total column, and the Honorary
    // rule never mentions it.
    const targets = h(
      'tr',
      { class: 'board-targets' },
      h('td', { class: 'board-name-cell' }, ''),
      h('td', { class: 'board-number' }, ''),
      ...state.categories.map((category) => {
        const target = state.targets.get(category.id);
        return h(
          'td',
          { class: 'board-number' },
          target === undefined ? '' : `of ${number(target)}`,
        );
      }),
      h('td', { class: 'board-number' }, ''),
    );

    return h('thead', {}, names, targets);
  }

  function body(rows) {
    return h(
      'tbody',
      {},
      ...rows.map((member) => {
        const status = state.status.get(member.id) ?? { point_total: 0, is_honorary: false };

        const name = h(
          'th',
          { class: 'board-name-cell', scope: 'row' },
          h(
            'button',
            {
              type: 'button',
              class: 'board-name',
              onClick: () => ctx.openMember(member.id),
            },
            member.display_name,
          ),
        );

        return h(
          'tr',
          { dataset: { member: member.id } },
          name,
          h('td', { class: 'board-number board-points' }, number(status.point_total)),
          ...state.categories.map((category) => cell(member, category)),
          h(
            'td',
            { class: 'board-number' },
            status.is_honorary
              ? h('span', { class: 'board-star', title: 'Honorary' }, '★')
              : h('span', { class: 'board-blank', 'aria-label': 'Not honorary' }, '·'),
          ),
        );
      }),
    );
  }

  function cell(member, category) {
    const total = totalFor(member.id, category.id);
    const target = state.targets.get(category.id);
    const met = target !== undefined && total >= target;

    return h(
      'td',
      { class: 'board-number', dataset: { met: String(met) } },
      h('span', { class: 'board-value' }, number(total)),
      met ? h('span', { class: 'board-tick', 'aria-label': 'Met' }, '✓') : null,
    );
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * Exactly what is on screen, in the order it is on screen. An export that
   * quietly ignored the filter would be a different answer to the question the
   * officer just asked.
   */
  function exportRows() {
    const header = [
      'Member',
      'Points',
      ...state.categories.map((category) => category.name),
      'Honorary',
    ];

    const rows = visibleMembers().map((member) => {
      const status = state.status.get(member.id) ?? { point_total: 0, is_honorary: false };
      return [
        member.display_name,
        number(status.point_total),
        ...state.categories.map((category) => number(totalFor(member.id, category.id))),
        status.is_honorary ? 'yes' : 'no',
      ];
    });

    return [header, ...rows];
  }

  function exportCsv() {
    const rows = exportRows();
    downloadCsv(csvFilename('progress', ctx.year.label), rows);
    announce(`${plural(rows.length - 1, 'member')} exported.`);
  }

  // -------------------------------------------------------------------------

  function wire() {
    el.filter.replaceChildren(
      ...Object.entries(HONORARY_FILTERS).map(([value, label]) =>
        h('option', { value }, label),
      ),
    );

    el.search.addEventListener('input', () => {
      state.query = el.search.value;
      render();
    });
    el.filter.addEventListener('change', () => {
      state.filter = el.filter.value;
      render();
    });
    el.exportButton.addEventListener('click', exportCsv);
  }

  return {
    mount() {
      wire();
      return load();
    },
    reload: load,
    hasLoaded: () => state.loaded,
    // Read by the checks, so what the CSV carries can be compared against what
    // the table drew without a browser in between.
    exportRows,
  };
}
