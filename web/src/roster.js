// The roster: who is on it, who is being added to it, and who is on it twice.
//
// Roster hygiene is the one thing the old setup gets right. All fourteen tabs
// carry the same 355 names with no duplicates, because they are all
// IMPORTRANGEd from one master list (docs/00-spreadsheet-findings.md). The new
// system has more ways in than that one list did, so this screen carries the
// defences that keep it clean:
//
//   IMPORT PREVIEWS EVERY ROW, and shows the fuzzy matches against every
//   member the club has ever had BEFORE anything is written. A row that looks
//   like somebody already here is not a decision this file makes. It is
//   offered to the officer, and the import cannot be run while one is still
//   unanswered. That is what stops an import quietly creating a second Abigail
//   Catto, and it is the reason the button is disabled rather than the row
//   defaulted.
//
//   MATCHING IS AGAINST EVERY LIVE MEMBER, NOT THIS YEAR'S ROSTER. The table
//   shows this year, which is right. Matching against this year would not be:
//   somebody who was here last year and has not been enrolled for this one is
//   invisible to that matcher, so an import treats them as new. With an email
//   that collides with the unique index and fails the run; without one it
//   quietly creates a second person. Same rule scripts/import_roster.py has
//   always used server-side, which matches against members and not against
//   member_enrollments.
//
//   EVERY WRITE IS ONE CALL. Adding somebody goes through
//   upsert_member_and_enroll(), which finds or creates the member and enrolls
//   them for the year in one transaction. Doing it as two requests left a
//   member row with no enrollment whenever the second one did not land, and
//   that person is then invisible on the screen that would have shown the
//   officer the problem.
//
//   THE IMPORT IS ONE CALL PER CHUNK, NOT ONE PER ROW. It used to loop over
//   the preview and call the single-row function once per line. The real file
//   is 355 rows (docs/00-spreadsheet-findings.md), so that was 355 sequential
//   round trips from a laptop on campus wifi, each one waiting for the last
//   and each one a fresh chance for the run to die halfway. It now sends
//   chunks of IMPORT_CHUNK rows to upsert_members_and_enroll(), which runs the
//   same single-row function over each of them server side, so there is still
//   exactly one implementation of who a row resolves to.
//
//   A REFUSED ROW DOES NOT COST THE RUN. Each row is its own subtransaction on
//   the server, so one archived member does not discard the other 354. What
//   comes back is a result per row in input order, carrying the officer's own
//   line number, and the lines that were refused are listed on screen with the
//   reason the database gave. Throwing that away and showing one error would
//   leave the officer to find the bad row by bisecting their own file.
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

import { select, remove, callRpc } from './rest.js';
import { READ_ONLY } from './officer-errors.js';
import { normaliseName, rankMembers, similarity } from './match.js';
import { csvFilename, downloadCsv, readRoster } from './csv.js';
import { firstJoinedIndex } from './joined.js';
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

// How many rows go in one call to upsert_members_and_enroll(). The server caps
// a batch at 500, so this is a unit of work rather than the ceiling.
//
// One call is one transaction, whatever the per-row isolation does inside it,
// so a call that never lands takes its whole chunk with it. Four chunks for
// the real 355 row file means a dropped connection costs at most a hundred
// rows, and re-running the same file writes nothing for the ones that already
// landed, so pressing Import again is the recovery.
const IMPORT_CHUNK = 100;

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

    refusedZone: $('import-refused'),
    refusedTitle: $('import-refused-title'),
    refusedList: $('import-refused-list'),

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
    members: [], // this year's roster, with their status. What the table shows
    everyMember: [], // every live, unmerged member. What an import matches on
    enrolled: new Set(), // the ids in state.members, for telling the two apart
    status: new Map(),
    joined: new Map(),
    recordCounts: new Map(),
    duplicates: [],
    query: '',
    incoming: [], // the import preview, once a file has been read
    skipped: [],
    refused: [], // the lines the last import could not write, and why
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
      const [enrollments, statuses, duplicates, everyEnrollment, everyMember] = await Promise.all([
        select('member_enrollments', {
          select:
            'member_id,status,joined_on,members!inner(id,first_name,last_name,preferred_name,display_name,email,created_at,archived_at,merged_into_id)',
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
        // Deliberately NOT filtered to the selected year. See joined.js.
        select('member_enrollments', { select: 'member_id,joined_on' }),
        // Also deliberately not filtered to the year, and for the same kind of
        // reason: this is what an import matches against, and a returning
        // member is exactly the person a year filter would hide. See the note
        // at the top of this file.
        select('members', {
          select: 'id,first_name,last_name,display_name,email,created_at',
          filters: { archived_at: 'is.null', merged_into_id: 'is.null' },
          order: 'display_name.asc',
        }),
      ]);

      state.members = enrollments
        .map((row) => row.members)
        .filter(Boolean)
        .sort((a, b) => a.display_name.localeCompare(b.display_name));

      state.everyMember = everyMember;
      state.enrolled = new Set(state.members.map((member) => member.id));
      state.joined = firstJoinedIndex(everyEnrollment, state.members);
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

  // WHY THE JOIN DATES ARE A SECOND READ. The roster query above is filtered
  // to the selected year, because that filter is what decides who is on this
  // year's roster at all. Reusing its joined_on would make the column mean
  // "enrolled for this year", which puts the same month on nearly every row
  // and disagrees with the duplicate banner directly above it. joined.js has
  // the rest of that argument.
  //
  // The read carries no year filter and no id list. Not a list because the
  // real roster is 355 members (docs/00-spreadsheet-findings.md), and 355
  // uuids in an in.() is a query string long enough to be refused; the two
  // columns fetched are cheaper than that URL. It sits in the same
  // Promise.all as the rest, so it costs no extra round trip.

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

    renderRefused();
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

  /**
   * The lines the last import could not write.
   *
   * Outside the import dialog, because the dialog is closed by the time the
   * run finishes, and the officer needs the line number, the name and the
   * reason together to find the row in the file they still have open.
   *
   * WHERE THIS GETS CLEARED, AND WHY THERE. The list and the message strip
   * above it are one report: the strip says what landed, the list says what
   * did not, and neither one means anything without the other. So the list is
   * cleared wherever the strip is, through clearReport() below, which admin.js
   * calls from clearMessage(). That covers every way an officer moves on from
   * a run in one place: opening a new import, switching tabs, opening a
   * member, changing the year. Clearing it inside runImport() instead would
   * put the reset on the one path that must not have it, since the reload that
   * follows a run has to leave this run's refusals standing.
   */
  function renderRefused() {
    const rows = state.refused;
    setHidden(el.refusedZone, rows.length === 0);
    el.refusedTitle.textContent = rows.length ? `${plural(rows.length, 'row')} refused` : '';
    el.refusedList.replaceChildren(
      ...rows.map((entry) =>
        h(
          'li',
          { class: 'problem' },
          [`Row ${entry.row}`, entry.name, entry.message].filter(Boolean).join(' · '),
        ),
      ),
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
  // The one write
  // -------------------------------------------------------------------------

  /**
   * One person, found or created, and enrolled for the selected year, in one
   * transaction. Both Add and the import go through here.
   *
   * matchedId is the officer's answer from the preview: an exact match, or a
   * fuzzy one they pressed Link member on. Passing none leaves the function to
   * match on email and student id itself, which is what makes a re-run of an
   * interrupted import land on the row the first run created.
   *
   * @returns {Promise<{member_id: string, was_created: boolean, was_enrolled: boolean}>}
   */
  function enrollPerson(person, matchedId = null) {
    return callRpc('upsert_member_and_enroll', {
      p_first_name: person.first_name,
      p_last_name: person.last_name,
      p_email: person.email ?? null,
      p_ucf_nid: null,
      p_academic_year_id: ctx.year.id,
      p_matched_member_id: matchedId,
    });
  }

  /** Whoever this row resolved to, if the officer's answer was "same person". */
  const answeredMatch = (row) => (row.decision === 'exact' ? row.match?.id ?? null : null);

  /** An exact match who is not on this year's list yet: enrolled, not created. */
  const isReturning = (row) =>
    row.decision === 'exact' && Boolean(row.match) && !state.enrolled.has(row.match.id);

  /**
   * A chunk of the import, in one call.
   *
   * The rows carry the officer's own CSV line number, and the server echoes it
   * back on every result, so a refusal points at a line in the file they still
   * have open rather than at a position in a chunk they never saw.
   *
   * Resolution is not repeated here. upsert_members_and_enroll() runs
   * upsert_member_and_enroll() over each row, so the match tiers, the
   * tombstone walk and the archived check are the same ones the single Add
   * path goes through.
   *
   * @returns {Promise<Array<{row: number, member_id: string|null,
   *   was_created: boolean, was_enrolled: boolean, error?: string,
   *   message?: string}>>} one entry per row, in input order
   */
  function enrollBatch(rows) {
    return callRpc('upsert_members_and_enroll', {
      p_rows: rows.map((row) => ({
        row: row.row,
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email ?? null,
        matched_member_id: answeredMatch(row),
      })),
      p_academic_year_id: ctx.year.id,
    });
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
    //
    // An exact match who is NOT on this year's list is not a refusal either.
    // That is a returning member, and putting them on this year's roster is
    // exactly what the officer is asking for.
    const email = el.addEmail.value.trim() || null;
    const [matched] = matchRoster(
      [{ first_name: first, last_name: last, email, row: 1 }],
      state.everyMember,
    );
    const matchedId = matched.verdict === 'exact' ? matched.match.id : null;
    if (matchedId && state.enrolled.has(matchedId)) {
      el.addError.textContent = `${matched.match.display_name} is already on the roster.`;
      setHidden(el.addError, false);
      return;
    }

    setHidden(el.addError, true);
    el.addDialog.close();
    setBusy(true);
    try {
      const result = await enrollPerson({ first_name: first, last_name: last, email }, matchedId);
      const name = matchedId ? matched.match.display_name : `${first} ${last}`;
      const said = result?.was_created ? `${name} added.` : `${name} added to ${ctx.year.label}.`;
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
    // The previous run's report goes with it, list and strip together, so a
    // second file is never previewed underneath the first file's refusals.
    ctx.clearMessage();
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
    state.incoming = matchRoster(people, state.everyMember).map((row) => ({
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
    const returning = state.incoming.filter(isReturning).length;
    const existing = state.incoming.filter(
      (row) => row.decision === 'exact' && !isReturning(row),
    ).length;
    const waiting = undecided().length;

    el.importSummary.textContent = [
      `${plural(state.incoming.length, 'row')} read`,
      `${created} new`,
      returning ? `${returning} returning` : null,
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
      if (isReturning(row)) {
        // On the roster from an earlier year, off this one. The distinction is
        // worth a word: nobody is being created, and the officer is about to
        // put a name back on the list rather than leave it alone.
        return h(
          'span',
          { class: 'import-outcome', dataset: { kind: 'returning' } },
          `Returning member: ${row.match.display_name}`,
        );
      }
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

    const rows = state.incoming.filter((row) => row.decision !== null);

    setBusy(true);

    // Collected locally and handed to state at the end, so the reload in the
    // finally block cannot land between the run and the render.
    const refused = [];
    let created = 0;
    let done = 0;
    let unknown = 0;
    try {
      // A chunk at a time. Each row is still independently atomic on the
      // server, so a row that fails leaves its neighbours written and comes
      // back as a refusal rather than as the end of the run.
      for (let at = 0; at < rows.length; at += IMPORT_CHUNK) {
        const chunk = rows.slice(at, at + IMPORT_CHUNK);
        const results = await enrollBatch(chunk);

        // ONE RESULT PER ROW SENT, OR THE CHUNK IS NOT AN ANSWER. A response
        // that is short, or not an array at all, would otherwise have its
        // missing rows counted as neither written nor refused, and the officer
        // would be told the run succeeded. Not knowing what landed is the
        // failure this screen exists to prevent, so a chunk that does not
        // account for every row it was given ends the run.
        if (!Array.isArray(results) || results.length !== chunk.length) {
          unknown = rows.length - at;
          break;
        }

        // Input order, so a result and the row it came from share an index.
        // The line number is read off the result, because that is the one the
        // server will echo for a row the officer has to go and fix.
        results.forEach((result, index) => {
          const row = chunk[index];
          if (result?.error) {
            refused.push({
              row: result.row ?? row?.row,
              name: row ? `${row.first_name} ${row.last_name}` : '',
              message: result.message ?? '',
            });
            return;
          }
          if (result?.was_created) created += 1;
          done += 1;
        });
      }

      const said = `${plural(created, 'member')} added, ${done} on the roster.`;
      if (unknown) {
        // Re-running is safe: the import is idempotent, so whatever did land
        // is found rather than written again. The preview is left alone, so
        // nothing here reads as a finished run.
        const stalled = `${said} ${plural(unknown, 'row')} unknown. Import the file again.`;
        ctx.note(stalled, 'warn');
        announce(stalled);
      } else if (refused.length) {
        // The count of refusals is the heading over the list, so the strip
        // carries what landed and the list carries what did not.
        ctx.note(said, 'warn');
        announce(`${said} ${plural(refused.length, 'row')} refused.`);
        state.incoming = [];
      } else {
        ctx.note(said);
        announce(said);
        state.incoming = [];
      }
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      // Reloaded whether or not the run finished, so the screen shows what
      // actually landed and the next preview matches against it.
      try {
        await load();
      } catch {
        /* load() has already put its own failure on screen */
      }
      // After the reload, because load() redraws from state and this run's
      // refusals are the one thing on screen that outlives it.
      state.refused = refused;
      renderRefused();
      ctx.onRosterChanged?.();
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
    // The other half of admin.js's clearMessage(). See renderRefused().
    clearReport() {
      if (!state.refused.length) return;
      state.refused = [];
      renderRefused();
    },
    hasLoaded: () => state.loaded,
    // For the checks, so the preview and the export can be driven without a
    // file picker in between.
    preview: (people) => matchRoster(people, state.everyMember),
    exportRows,
  };
}
