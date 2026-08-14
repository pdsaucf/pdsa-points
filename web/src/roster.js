// The roster: who is on it, who is being added to it, and who is on it twice.
//
// Roster hygiene is the one thing the old setup gets right. All fourteen tabs
// carry the same 355 names with no duplicates, because they are all
// IMPORTRANGEd from one master list (docs/00-spreadsheet-findings.md). The new
// system has more ways in than that one list did, so this screen carries the
// two defences that keep it clean:
//
//   IMPORT PREVIEWS EVERY ROW, and shows the fuzzy matches against the members
//   already on the roster BEFORE anything is written. A row that looks like
//   somebody already here is not a decision this file makes. It is offered to
//   the officer, and the import cannot be run while one is still unanswered.
//   That is what stops an import quietly creating a second Abigail Catto, and
//   it is the reason the button is disabled rather than the row defaulted.
//
//   DUPLICATES ARE SURFACED AND MERGED, from v_possible_duplicate_members.
//   Merging is merge_members(), which moves the records onto the survivor,
//   drops the collisions, tombstones the loser and writes member_merges. Not a
//   duplicate is dismiss_duplicate_pair(), and it is remembered, so the same
//   pair never asks twice.
//
// The matching rule here is the same one scripts/import_roster.py uses, because
// the two paths load the same rosters into the same table: by email when the
// incoming row has one, by normalised name when it does not. What this adds on
// top is the fuzzy tier the script has no way to offer, since the script has
// nobody to ask.

import { select, insert, remove, callRpc } from './rest.js';
import { READ_ONLY } from './officer-errors.js';
import { normaliseName, rankMembers, similarity } from './match.js';
import { csvFilename, downloadCsv, readRoster } from './csv.js';
import { $, h, announce, setHidden, plural, monthYear } from './ui.js';

// Above this, an incoming name is close enough to somebody on the roster that
// an officer has to look.
//
// It is set from the case this feature exists for: "Abby Cato" scores 0.333
// against "Abigail Catto", which is the pair docs/03-admin-ui.md names. A floor
// above that would let exactly the import this screen was built to stop run
// straight through. Below it the suggestion is noise, and a preview full of
// noise gets clicked through, which is the other way to lose.
const FUZZY_FLOOR = 0.3;

/**
 * What the duplicate view found, in an officer's words.
 *
 * Branching is on the code and never on the sentence, which is the same rule
 * officer-errors.js follows. A code this screen has not been taught still
 * renders as a pair to decide about rather than as a blank card, because a
 * duplicate nobody is shown is a duplicate nobody merges.
 */
const DUPLICATE_REASON = {
  exact_email: 'Same email address',
  exact_nid: 'Same student id',
  exact_name: 'Same name',
  close_name: 'Similar name',
};

/**
 * Every incoming row, matched against the roster, with what would happen to it.
 *
 * Pure, so the checks can drive it without a browser: this is the decision the
 * preview renders, and getting it wrong is the failure the preview exists to
 * prevent.
 *
 * verdict is one of:
 *   'exact'  already on the roster. Enrolled, never created
 *   'fuzzy'  looks like somebody already here. Needs an answer before import
 *   'new'    nobody close. Created and enrolled
 *
 * @param {Array<{first_name: string, last_name: string, email: string|null, row: number}>} people
 * @param {Array<{id: string, display_name: string, email?: string|null}>} members
 */
export function matchRoster(people, members) {
  const byEmail = new Map();
  const byName = new Map();
  for (const member of members ?? []) {
    if (member.email) byEmail.set(String(member.email).toLowerCase(), member);
    const key = normaliseName(member.display_name);
    if (!byName.has(key)) byName.set(key, member);
  }

  return (people ?? []).map((person) => {
    const fullName = `${person.first_name} ${person.last_name}`;
    const email = person.email ? person.email.toLowerCase() : null;

    // An email is an identity, not a resemblance. Same rule as the script, and
    // the same rule rankMembers() applies on the review queue.
    const byAddress = email ? byEmail.get(email) : null;
    if (byAddress) {
      return { ...person, verdict: 'exact', match: byAddress, why: 'Same email address' };
    }

    const sameName = byName.get(normaliseName(fullName));
    if (sameName && (!email || !sameName.email)) {
      return { ...person, verdict: 'exact', match: sameName, why: 'Same name' };
    }

    const ranked = rankMembers({ name: fullName, email: person.email }, members ?? [], {
      limit: 3,
      floor: FUZZY_FLOOR,
    });
    if (ranked.length) {
      return {
        ...person,
        verdict: 'fuzzy',
        match: ranked[0].member,
        why: `${Math.round(similarity(fullName, ranked[0].member.display_name) * 100)}% name match`,
      };
    }

    return { ...person, verdict: 'new', match: null, why: '' };
  });
}

export function createRoster(ctx) {
  const el = {
    loading: $('loading-roster'),
    empty: $('empty-roster'),
    emptyTitle: $('empty-roster-title'),
    emptyBody: $('empty-roster-body'),
    search: $('roster-search'),
    count: $('roster-count'),
    add: $('roster-add'),
    importButton: $('roster-import'),
    exportButton: $('roster-export'),
    table: $('roster-table'),
    rows: $('roster-rows'),

    duplicatesZone: $('duplicates-zone'),
    duplicatesTitle: $('duplicates-title'),
    duplicatesList: $('duplicates-list'),

    addDialog: $('roster-add-dialog'),
    addForm: $('roster-add-form'),
    addFirst: $('roster-add-first'),
    addLast: $('roster-add-last'),
    addEmail: $('roster-add-email'),
    addError: $('roster-add-error'),

    removeDialog: $('roster-remove-dialog'),
    removeForm: $('roster-remove-form'),
    removeMeta: $('roster-remove-meta'),

    importDialog: $('import-dialog'),
    importForm: $('import-form'),
    importFile: $('import-file'),
    importProblem: $('import-problem'),
    importProblemTitle: $('import-problem-title'),
    importProblemBody: $('import-problem-body'),
    importSummary: $('import-summary'),
    importRows: $('import-rows'),
    importTable: $('import-table'),
    importSkipped: $('import-skipped'),
    importRun: $('import-run'),
  };

  const state = {
    members: [], // this year's roster, with their status
    status: new Map(),
    joined: new Map(),
    recordCounts: new Map(),
    duplicates: [],
    query: '',
    incoming: [], // the import preview, once a file has been read
    skipped: [],
    removing: null,
    busy: false,
    loaded: false,
  };

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function load() {
    setHidden(el.loading, false);
    setHidden(el.empty, true);
    setHidden(el.table, true);

    const yearId = ctx.year.id;

    try {
      const [enrollments, statuses, duplicates] = await Promise.all([
        select('member_enrollments', {
          select:
            'member_id,status,joined_on,members!inner(id,first_name,last_name,preferred_name,display_name,email,archived_at,merged_into_id)',
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
        loadDuplicates(),
      ]);

      state.members = enrollments
        .map((row) => row.members)
        .filter(Boolean)
        .sort((a, b) => a.display_name.localeCompare(b.display_name));

      state.joined = new Map(enrollments.map((row) => [row.member_id, row.joined_on]));
      state.status = new Map(
        statuses.map((row) => [
          row.member_id,
          { point_total: Number(row.point_total ?? 0), is_honorary: Boolean(row.is_honorary) },
        ]),
      );
      state.duplicates = duplicates;
      state.loaded = true;
      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  /**
   * The pairs the database thinks are one person.
   *
   * Each pair comes back once, never in both orders, so nothing here has to
   * dedupe it. A viewer can read the view and cannot act on it, which is why
   * the buttons are drawn from ctx.canReview rather than from whether the read
   * succeeded.
   */
  async function loadDuplicates() {
    try {
      return await select('v_possible_duplicate_members', {
        select:
          'member_a,member_b,display_a,display_b,email_a,email_b,reason,score,records_a,records_b,joined_a,joined_b',
        order: 'score.desc',
      });
    } catch (err) {
      // A roster screen that will not load because the duplicate view is
      // missing is worse than a roster screen with no banner on it.
      ctx.fail(err, null);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  const number = (value) => {
    const n = Number(value ?? 0);
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  };

  function visibleMembers() {
    const query = state.query.trim().toLowerCase();
    if (!query) return state.members;
    return state.members.filter(
      (member) =>
        member.display_name.toLowerCase().includes(query) ||
        String(member.email ?? '').toLowerCase().includes(query),
    );
  }

  function render() {
    setHidden(el.loading, true);
    setHidden(el.add, !ctx.canReview);
    setHidden(el.importButton, !ctx.canReview);

    const rows = visibleMembers();
    el.count.textContent = plural(rows.length, 'member');
    el.exportButton.disabled = rows.length === 0;

    setHidden(el.empty, rows.length > 0);
    setHidden(el.table, rows.length === 0);

    renderDuplicates();

    if (!rows.length) {
      const anybody = state.members.length > 0;
      el.emptyTitle.textContent = anybody ? 'No members match' : 'Nobody on the roster';
      el.emptyBody.textContent = anybody ? '' : 'Add one, or import a CSV.';
      return;
    }

    el.rows.replaceChildren(
      ...rows.map((member) => {
        const status = state.status.get(member.id) ?? { point_total: 0, is_honorary: false };
        return h(
          'tr',
          { dataset: { member: member.id } },
          h(
            'td',
            {},
            h(
              'button',
              { type: 'button', class: 'board-name', onClick: () => ctx.openMember(member.id) },
              member.display_name,
            ),
          ),
          h('td', { class: 'roster-email' }, member.email ?? ''),
          h('td', { class: 'board-number' }, number(status.point_total)),
          h(
            'td',
            { class: 'board-number' },
            status.is_honorary ? h('span', { class: 'board-star' }, '★') : '',
          ),
          h('td', {}, monthYear(state.joined.get(member.id))),
          h(
            'td',
            { class: 'roster-actions' },
            ctx.canReview
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'button button-small',
                    disabled: state.busy,
                    'aria-label': `Remove ${member.display_name} from this year`,
                    onClick: () => askRemove(member),
                  },
                  'Remove',
                )
              : null,
          ),
        );
      }),
    );
  }

  function renderDuplicates() {
    const pairs = state.duplicates;
    setHidden(el.duplicatesZone, pairs.length === 0);

    // Emptied rather than only hidden. A banner that still holds the pair an
    // officer just merged is a card that comes back the moment anything
    // unhides the zone again, and the buttons on it would act on a member who
    // no longer exists.
    el.duplicatesTitle.textContent = pairs.length ? plural(pairs.length, 'possible duplicate') : '';
    el.duplicatesList.replaceChildren(...pairs.map(renderPair));
  }

  function renderPair(pair) {
    const key = `${pair.member_a}:${pair.member_b}`;

    // Whichever row carries more history is offered as the survivor, with the
    // earlier join date breaking a tie. It is a default, not a decision: the
    // counts and the dates are on screen because they are what tells an officer
    // which row should live.
    const preferB =
      Number(pair.records_b ?? 0) > Number(pair.records_a ?? 0) ||
      (Number(pair.records_b ?? 0) === Number(pair.records_a ?? 0) &&
        String(pair.joined_b ?? '') < String(pair.joined_a ?? ''));

    const side = (which) => {
      const id = which === 'a' ? pair.member_a : pair.member_b;
      const name = which === 'a' ? pair.display_a : pair.display_b;
      const email = which === 'a' ? pair.email_a : pair.email_b;
      const records = which === 'a' ? pair.records_a : pair.records_b;
      const joined = which === 'a' ? pair.joined_a : pair.joined_b;
      const checked = which === (preferB ? 'b' : 'a');

      return h(
        'label',
        { class: 'dupe-side' },
        h('input', {
          type: 'radio',
          name: `keep-${key}`,
          value: id,
          checked,
          disabled: !ctx.canReview,
          // Without this the control announces its value, which is an id. The
          // choice being made is which person survives the merge, so it says
          // so.
          'aria-label': `Keep ${name}`,
        }),
        h(
          'span',
          { class: 'dupe-body' },
          h('span', { class: 'dupe-name' }, name),
          h(
            'span',
            { class: 'dupe-meta' },
            [
              plural(Number(records ?? 0), 'record'),
              joined ? `joined ${monthYear(joined)}` : null,
              email || null,
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        ),
      );
    };

    const card = h(
      'div',
      { class: 'dupe-card', dataset: { pair: key } },
      h(
        'p',
        { class: 'dupe-reason' },
        DUPLICATE_REASON[pair.reason] ?? 'Possible duplicate',
      ),
      h('div', { class: 'dupe-sides' }, side('a'), side('b')),
    );

    if (ctx.canReview) {
      card.append(
        h(
          'div',
          { class: 'dupe-actions' },
          h('p', { class: 'muted small' }, 'Records move to the row you keep.'),
          h(
            'button',
            {
              type: 'button',
              class: 'button button-small',
              disabled: state.busy,
              onClick: () => dismissPair(pair),
            },
            'Dismiss',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'button button-small button-primary',
              disabled: state.busy,
              onClick: () => mergePair(pair, card),
            },
            'Merge',
          ),
        ),
      );
    } else {
      card.append(h('p', { class: 'muted small' }, READ_ONLY));
    }

    return card;
  }

  // -------------------------------------------------------------------------
  // Merging
  // -------------------------------------------------------------------------

  async function mergePair(pair, card) {
    const chosen = card.querySelector('input[type="radio"]:checked')?.value;
    if (!chosen) return;
    const into = chosen;
    const from = chosen === pair.member_a ? pair.member_b : pair.member_a;
    const keptName = chosen === pair.member_a ? pair.display_a : pair.display_b;

    setBusy(true);
    ctx.clearMessage();
    try {
      const result = await callRpc('merge_members', { p_from_id: from, p_into_id: into });
      const moved = Number(result?.moved ?? 0);
      const dropped = Number(result?.dropped ?? 0);
      const said = dropped
        ? `${plural(moved, 'record')} moved to ${keptName}. ${plural(dropped, 'duplicate')} dropped.`
        : `${plural(moved, 'record')} moved to ${keptName}.`;
      ctx.note(said);
      announce(said);
      await load();
      ctx.onRosterChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  async function dismissPair(pair) {
    setBusy(true);
    try {
      await callRpc('dismiss_duplicate_pair', {
        p_member_a: pair.member_a,
        p_member_b: pair.member_b,
      });
      state.duplicates = state.duplicates.filter(
        (row) => !(row.member_a === pair.member_a && row.member_b === pair.member_b),
      );
      render();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Adding one by hand
  // -------------------------------------------------------------------------

  function openAdd() {
    setHidden(el.addError, true);
    el.addForm.reset();
    el.addDialog.showModal();
  }

  async function addMember(event) {
    event.preventDefault();
    const first = el.addFirst.value.trim();
    const last = el.addLast.value.trim();
    if (!first || !last) {
      el.addError.textContent = 'First and last name are both required.';
      setHidden(el.addError, false);
      return;
    }

    // The same check the import runs, on one row, and refusing on the same
    // tier it refuses on: the same address, or the same name with no address
    // to tell them apart. A merely similar name is NOT refused, because two
    // sisters exist and an officer who cannot add the second one has no way
    // through. That case is caught a moment later instead, by the duplicate
    // banner, where it can be merged or dismissed rather than blocked.
    const email = el.addEmail.value.trim() || null;
    const [matched] = matchRoster([{ first_name: first, last_name: last, email, row: 1 }], state.members);
    if (matched.verdict === 'exact') {
      el.addError.textContent = `${matched.match.display_name} is already on the roster.`;
      setHidden(el.addError, false);
      return;
    }

    setHidden(el.addError, true);
    el.addDialog.close();
    setBusy(true);
    try {
      const created = await insert('members', [
        { first_name: first, last_name: last, email },
      ]);
      const member = created?.[0];
      if (!member) throw new Error('nothing came back');

      await insert('member_enrollments', [
        { member_id: member.id, academic_year_id: ctx.year.id },
      ]);

      const said = `${member.display_name ?? `${first} ${last}`} added.`;
      ctx.note(said);
      announce(said);
      await load();
      ctx.onRosterChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Taking one off this year
  // -------------------------------------------------------------------------

  function askRemove(member) {
    state.removing = member;
    el.removeMeta.textContent = `${member.display_name} · ${ctx.year.label}`;
    el.removeDialog.showModal();
  }

  async function confirmRemove(event) {
    event.preventDefault();
    const member = state.removing;
    el.removeDialog.close();
    if (!member) return;

    setBusy(true);
    try {
      const gone = await remove('member_enrollments', {
        member_id: `eq.${member.id}`,
        academic_year_id: `eq.${ctx.year.id}`,
      });
      if (!gone.length) {
        ctx.note('Nothing was changed. Reload the page.', 'warn');
        return;
      }
      ctx.note(`${member.display_name} removed from ${ctx.year.label}.`);
      await load();
      ctx.onRosterChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.removing = null;
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  function openImport() {
    state.incoming = [];
    state.skipped = [];
    el.importForm.reset();
    setHidden(el.importProblem, true);
    setHidden(el.importTable, true);
    el.importSummary.textContent = 'Choose a CSV with first_name, last_name and email columns.';
    el.importRun.disabled = true;
    el.importDialog.showModal();
  }

  async function onFileChosen() {
    const file = el.importFile.files?.[0];
    if (!file) return;

    let text;
    try {
      text = await file.text();
    } catch {
      showImportProblem('That file could not be read', 'Choose it again.');
      return;
    }

    const { people, skipped, problem } = readRoster(text);
    if (problem) {
      showImportProblem(problem.title, problem.body);
      return;
    }

    setHidden(el.importProblem, true);
    state.incoming = matchRoster(people, state.members).map((row) => ({
      ...row,
      // A fuzzy row starts undecided on purpose. See the note at the top.
      decision: row.verdict === 'fuzzy' ? null : row.verdict,
    }));
    state.skipped = skipped;
    renderImport();
  }

  /**
   * A file that cannot be loaded at all. Nothing is previewed and nothing can
   * be run, because a roster that is half loaded is worse than one that is not
   * loaded, which is the same line scripts/import_roster.py holds.
   */
  function showImportProblem(title, body) {
    state.incoming = [];
    state.skipped = [];
    el.importProblemTitle.textContent = title;
    el.importProblemBody.textContent = body;
    setHidden(el.importProblem, false);
    setHidden(el.importTable, true);
    el.importRows.replaceChildren();
    el.importSummary.textContent = '';
    el.importRun.disabled = true;
  }

  const undecided = () => state.incoming.filter((row) => row.decision === null);

  function renderImport() {
    setHidden(el.importTable, false);

    const created = state.incoming.filter((row) => row.decision === 'new').length;
    const existing = state.incoming.filter((row) => row.decision === 'exact').length;
    const waiting = undecided().length;

    el.importSummary.textContent = [
      `${plural(state.incoming.length, 'row')} read`,
      `${created} new`,
      `${existing} already on the roster`,
      waiting ? `${waiting} to decide` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    el.importSkipped.replaceChildren(
      ...state.skipped.map((entry) =>
        h('li', { class: 'problem' }, `Row ${entry.row} skipped. ${entry.reason}.`),
      ),
    );
    setHidden(el.importSkipped, state.skipped.length === 0);

    el.importRows.replaceChildren(...state.incoming.map(importRow));
    el.importRun.disabled = waiting > 0 || state.incoming.length === 0;
  }

  function importRow(row) {
    const name = `${row.first_name} ${row.last_name}`;

    const outcome = () => {
      if (row.decision === 'exact') {
        return h(
          'span',
          { class: 'import-outcome', dataset: { kind: 'exact' } },
          row.match ? `Already on the roster: ${row.match.display_name}` : 'Already on the roster',
        );
      }
      if (row.decision === 'new') return h('span', { class: 'import-outcome', dataset: { kind: 'new' } }, 'New member');
      return h('span', { class: 'import-outcome', dataset: { kind: 'wait' } }, 'Needs a decision');
    };

    const cell = h('td', { class: 'import-decision' }, outcome());

    if (row.verdict === 'fuzzy') {
      cell.append(
        h(
          'div',
          { class: 'import-choice' },
          h('span', { class: 'muted small' }, `${row.match.display_name} · ${row.why}`),
          h(
            'div',
            { class: 'import-buttons' },
            h(
              'button',
              {
                type: 'button',
                class: 'button button-small',
                'aria-pressed': String(row.decision === 'exact'),
                onClick: () => {
                  row.decision = 'exact';
                  renderImport();
                },
              },
              'Link member',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'button button-small',
                'aria-pressed': String(row.decision === 'new'),
                onClick: () => {
                  row.decision = 'new';
                  renderImport();
                },
              },
              'Add as new',
            ),
          ),
        ),
      );
    }

    return h(
      'tr',
      { dataset: { row: String(row.row), verdict: row.verdict, decision: row.decision ?? 'none' } },
      h('td', { class: 'import-line' }, String(row.row)),
      h('td', {}, name),
      h('td', { class: 'roster-email' }, row.email ?? ''),
      cell,
    );
  }

  async function runImport(event) {
    event.preventDefault();
    if (undecided().length) return;
    el.importDialog.close();

    const toCreate = state.incoming.filter((row) => row.decision === 'new');
    const toEnroll = state.incoming
      .filter((row) => row.decision === 'exact' && row.match)
      .map((row) => row.match.id);

    setBusy(true);
    try {
      if (toCreate.length) {
        const created = await insert(
          'members',
          toCreate.map((row) => ({
            first_name: row.first_name,
            last_name: row.last_name,
            email: row.email,
          })),
        );
        for (const member of created ?? []) toEnroll.push(member.id);
      }

      if (toEnroll.length) {
        await insert(
          'member_enrollments',
          toEnroll.map((memberId) => ({
            member_id: memberId,
            academic_year_id: ctx.year.id,
          })),
        );
      }

      const said = `${plural(toCreate.length, 'member')} added, ${toEnroll.length} on the roster.`;
      ctx.note(said);
      announce(said);
      state.incoming = [];
      await load();
      ctx.onRosterChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * The three columns the import reads, so a file exported here can be handed
   * to next year's officers and imported straight back.
   */
  function exportRows() {
    return [
      ['first_name', 'last_name', 'email'],
      ...visibleMembers().map((member) => [
        member.first_name,
        member.last_name,
        member.email ?? '',
      ]),
    ];
  }

  function exportCsv() {
    const rows = exportRows();
    downloadCsv(csvFilename('roster', ctx.year.label), rows);
    announce(`${plural(rows.length - 1, 'member')} exported.`);
  }

  // -------------------------------------------------------------------------

  function setBusy(on) {
    state.busy = on;
    for (const node of el.duplicatesList.querySelectorAll('button')) node.disabled = on;
    for (const node of el.rows.querySelectorAll('button')) node.disabled = on;
    el.add.disabled = on;
    el.importButton.disabled = on;
  }

  function wire() {
    el.search.addEventListener('input', () => {
      state.query = el.search.value;
      render();
    });
    el.add.addEventListener('click', openAdd);
    el.addForm.addEventListener('submit', addMember);
    el.removeForm.addEventListener('submit', confirmRemove);
    el.importButton.addEventListener('click', openImport);
    el.importFile.addEventListener('change', onFileChosen);
    el.importForm.addEventListener('submit', runImport);
    el.exportButton.addEventListener('click', exportCsv);

    for (const dialog of [el.addDialog, el.removeDialog, el.importDialog]) {
      dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    }
  }

  return {
    mount() {
      wire();
      return load();
    },
    reload: load,
    hasLoaded: () => state.loaded,
    // For the checks, so the preview and the export can be driven without a
    // file picker in between.
    preview: (people) => matchRoster(people, state.members),
    exportRows,
  };
}
