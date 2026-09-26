// One event, opened from the events list: who came, and what to do about it.
//
// WHY THIS IS NOT THE REVIEW QUEUE. The queue is organised by decision: every
// pending record in the year, triaged so the routine ones cost one press
// between them. This screen is organised by event, and it holds the records
// the queue has already finished with. The two questions an officer actually
// asks here are "who is down as having come to this" and "add the four people
// who signed the paper sheet", and neither of them is answerable from a queue
// that empties as it is worked.
//
// So a record with a triage flag is still the queue's job. An unmatched name
// cannot be approved (the check constraint on attendance_records forbids it,
// and review_records() raises PDS06), so this screen does not offer Approve on
// one. It offers Review, which opens the queue on this event, where the roster
// suggestions live.
//
// NOTHING HERE WRITES `status`. Approve and Decline go through
// review_records(), exactly as review.js and member.js do: that function is
// what stamps the reviewer, writes the audit row, and refuses the approvals
// that have to be refused. Adding somebody by hand files the row pending and
// then approves it through the same call, which is invariant 6 holding rather
// than being skipped: the officer pressing the button is the person approving.
//
// REMOVE IS NOT DECLINE, AND IS OFFERED SECOND. attendance_records is one
// table with a status precisely so that un-approving is symmetric with
// approving and a rejection keeps its reason, so Decline is the answer to
// "this should not count" and it keeps the history. Remove is for a row that
// should never have existed: a test check-in, a duplicate typed twice. It
// deletes, and a photo attached to it is deleted from the bucket first, since
// the alternative is bytes in the bucket that nothing in the database points
// at and no purge run will ever find.

import { select, remove, callRpc, deleteEvidenceObjects } from './rest.js';
import { NetworkError } from './errors.js';
import { downloadCsv } from './csv.js';
import { parsePastedNames } from './name-parser.js';
import { normaliseName, rankMembers } from './match.js';
import {
  ATTENDANCE_STATUS,
  ATTENDANCE_SOURCES,
  attendeeCsvFilename,
  attendeeCsvRows,
  attendeeName,
  canDeleteEvent,
  collectsTypedValue,
  eventPublishStatus,
  eventStats,
  eventStatus,
  sortAttendees,
  typedValueCategory,
} from './events-model.js';
import { $, h, announce, setHidden, plural, shortDate, clockTime } from './ui.js';
import { isMemberEnteredValue } from './flags.js';

const RECORD_SELECT = [
  'id',
  'member_id',
  'claimed_name',
  'status',
  'source',
  'submitted_value',
  'submitted_at',
  'review_note',
  'flags',
  'members(id,display_name)',
  'attendance_evidence(id,object_path)',
].join(',');

// The same shape the list reads, because this screen re-reads the event for
// itself rather than trusting the copy it was handed. See open().
const EVENT_SELECT = [
  'id,title,occurred_on,starts_at,ends_at,term_id,checkin_token,checkin_closes_at,config_version',
  'location,attire,signup,description,is_published,release_at,is_visible',
  'event_categories(category_id,credit_mode,fixed_credit,categories(id,name))',
  'event_evidence_requirements(id,kind,is_required,prompt)',
].join(',');

const SOURCE_LABEL = Object.fromEntries(ATTENDANCE_SOURCES.map((row) => [row.value, row.label]));

// PostgREST answers a write its policy refuses with 200 and an empty array, so
// every delete below counts what came back. Same sentence the events form uses
// for the same reason.
const NOT_WRITTEN = 'The change was refused. Reload the page and try again.';

const ATTENDANCE_FUZZY_FLOOR = 0.3;

/** Every nonblank pasted line, reconciled with the roster and this event. */
export function buildAttendancePastePreview(text, roster, records, choices = new Map()) {
  const { entries } = parsePastedNames(text);
  const live = (records ?? []).filter((record) => record.status !== 'rejected');
  const byName = new Map();
  for (const member of roster ?? []) {
    const key = normaliseName(member.display_name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(member);
  }

  return entries.map((entry) => {
    if (entry.kind === 'invalid') {
      return { ...entry, status: 'invalid', label: 'Needs full name', disposition: 'invalid' };
    }
    if (entry.kind === 'repeated') {
      return { ...entry, status: 'repeated', label: 'Repeated', disposition: 'repeated' };
    }

    const normalizedName = normaliseName(entry.name);
    const exact = byName.get(normalizedName) ?? [];
    const ranked = rankMembers({ name: entry.name }, roster ?? [], {
      limit: 3,
      floor: ATTENDANCE_FUZZY_FLOOR,
    });
    const suggestions = exact.length
      ? exact.map((member) => ({ member, percent: 100 }))
      : ranked;
    const storedChoice = choices.get(entry.row);
    const choice = storedChoice?.normalized_name === normalizedName &&
      storedChoice?.source_text === text &&
      !(storedChoice?.kind === 'unmatched' && exact.length)
      ? storedChoice
      : null;

    if (choice?.kind === 'member') {
      const member = (roster ?? []).find((row) => row.id === choice.member_id);
      if (member) {
        const unmatched = live.find(
          (record) => !record.member_id && normaliseName(record.claimed_name) === normalizedName,
        );
        const recorded = unmatched ?? live.find((record) => record.member_id === member.id);
        return {
          ...entry,
          status: recorded ? 'recorded' : 'member',
          label: unmatched ? 'Needs review' : recorded ? 'Already recorded' : 'Member',
          disposition: 'member',
          member,
          suggestions,
          record: recorded ?? null,
          needsReview: Boolean(unmatched),
        };
      }
    }

    if (choice?.kind === 'unmatched') {
      const recorded = live.find(
        (record) => !record.member_id && normaliseName(record.claimed_name) === normaliseName(entry.name),
      );
      return {
        ...entry,
        status: recorded ? 'recorded' : 'unmatched',
        label: recorded ? 'Already recorded' : 'Not on roster',
        disposition: 'unmatched',
        member: null,
        suggestions,
      };
    }

    if (exact.length === 1) {
      const member = exact[0];
      const unmatched = live.find(
        (record) => !record.member_id && normaliseName(record.claimed_name) === normalizedName,
      );
      const recorded = unmatched ?? live.find((record) => record.member_id === member.id);
      return {
        ...entry,
        status: recorded ? 'recorded' : 'member',
        label: unmatched ? 'Needs review' : recorded ? 'Already recorded' : 'Member',
        disposition: 'member',
        member,
        suggestions,
        record: recorded ?? null,
        needsReview: Boolean(unmatched),
      };
    }

    if (suggestions.length) {
      return {
        ...entry,
        status: 'choice',
        label: 'Choose member',
        disposition: null,
        member: null,
        suggestions,
      };
    }

    const recorded = live.find(
      (record) => !record.member_id && normaliseName(record.claimed_name) === normaliseName(entry.name),
    );
    return {
      ...entry,
      status: recorded ? 'recorded' : 'unmatched',
      label: recorded ? 'Already recorded' : 'Not on roster',
      disposition: 'unmatched',
      member: null,
      suggestions: [],
    };
  });
}

/** Rebuilds only the outcomes an attendance snapshot can prove. */
export function reconstructAttendanceBatchOutcomes(
  entries,
  _current,
  before,
  _options = {},
) {
  const liveBefore = (before ?? []).filter((row) => row.status !== 'rejected');
  const seenMembers = new Set();
  const seenNames = new Set();
  const results = [];

  for (const entry of entries ?? []) {
    if (entry.disposition === 'invalid' || entry.disposition === 'repeated') {
      results.push({ ...entry, outcome: entry.disposition, record_id: null });
      continue;
    }

    if (entry.disposition === 'member') {
      if (seenMembers.has(entry.member_id)) {
        results.push({ ...entry, outcome: 'repeated', record_id: null });
        continue;
      }
      seenMembers.add(entry.member_id);
      const existing = liveBefore.find((row) => row.member_id === entry.member_id);
      if (existing) {
        results.push({ ...entry, outcome: 'already_recorded', record_id: existing.id });
        continue;
      }
      return null;
    }

    const norm = normaliseName(entry.claimed_name);
    if (seenNames.has(norm)) {
      results.push({ ...entry, outcome: 'repeated', record_id: null });
      continue;
    }
    seenNames.add(norm);
    const existing = liveBefore.find(
      (row) => !row.member_id && normaliseName(row.claimed_name) === norm,
    );
    if (existing) {
      results.push({ ...entry, outcome: 'already_recorded', record_id: existing.id });
      continue;
    }
    // Only the recovery RPC can attribute a new row to this batch. A snapshot
    // can prove old live rows, invalid input, and repeated input, but nothing
    // written after the before snapshot belongs to this call by inspection.
    return null;
  }
  return results;
}

/**
 * @param {object} ctx the admin shell's context: year, fail, note, openMember
 * @param {{openForm: Function, openQr: Function, previewCheckin: Function,
 *   backToList: Function, afterChange: Function}} host what the events screen
 *   owns and this screen borrows
 */
export function createEventDetail(ctx, host) {
  const el = {
    view: $('event-detail-view'),
    loading: $('loading-event-detail'),
    body: $('event-detail-body'),
    back: $('event-detail-back'),
    title: $('event-detail-title'),
    meta: $('event-detail-meta'),
    status: $('event-detail-status'),
    publishStatus: $('event-detail-publish-status'),
    chips: $('event-detail-chips'),

    qr: $('event-detail-qr'),
    preview: $('event-detail-preview'),
    edit: $('event-detail-edit'),
    duplicate: $('event-detail-duplicate'),
    publish: $('event-detail-publish'),
    remove: $('event-detail-delete'),

    stats: $('event-detail-stats'),
    sources: $('event-detail-sources'),
    window: $('event-detail-window'),

    attendeeCount: $('attendee-count'),
    approveAll: $('attendee-approve-all'),
    add: $('attendee-add'),
    exportCsv: $('attendee-export'),
    table: $('attendee-table'),
    rows: $('attendee-rows'),
    empty: $('empty-attendees'),
    typedHead: $('attendee-value-head'),

    addDialog: $('attendee-add-dialog'),
    addForm: $('attendee-add-form'),
    addNames: $('attendee-add-names'),
    addList: $('attendee-add-list'),
    addValueField: $('attendee-add-value-field'),
    addValueLabel: $('attendee-add-value-label'),
    addValue: $('attendee-add-value'),
    addError: $('attendee-add-error'),
    addSubmit: $('attendee-add-submit'),
    addCount: $('attendee-add-count'),
    addResultDialog: $('attendee-add-result-dialog'),
    addResultSummary: $('attendee-add-result-summary'),
    addResultList: $('attendee-add-result-list'),

    removeDialog: $('attendee-remove-dialog'),
    removeForm: $('attendee-remove-form'),
    removeWho: $('attendee-remove-who'),
    removeNote: $('attendee-remove-note'),

    deleteDialog: $('event-delete-dialog'),
    deleteForm: $('event-delete-form'),
    deleteWhat: $('event-delete-what'),
  };

  const state = {
    event: null,
    records: [],
    roster: [],
    enrolled: 0,
    // Bumped on every open(). A response that resumes after the officer has
    // gone back to the list, or opened a different event, checks its own
    // captured token before it paints anything. Same guard member.js keeps.
    loadToken: 0,
    busy: false,
    // A mutation committed but its authoritative re-read failed. The old DOM
    // remains disabled until a later open() proves current state and clears
    // this lock, so stale buttons cannot repeat the completed mutation.
    refreshLocked: false,
    addRows: [],
    addChoices: new Map(),
    // The record the Remove dialog is asking about. Held here rather than
    // closed over by a listener added per press, so the form is wired once.
    removing: null,
  };

  const typed = () => collectsTypedValue(state.event);

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function open(event, { quietFailure = false } = {}) {
    state.event = event;
    state.loadToken += 1;
    const token = state.loadToken;

    setHidden(el.view, false);
    setHidden(el.body, true);
    setHidden(el.loading, false);
    renderHeader();

    try {
      const [fresh, records, enrolments] = await Promise.all([
        // The event row itself, not the copy the list handed over. What an
        // event counts toward, and whether it asks the member for a number,
        // are edited from another screen and from another officer's laptop,
        // and this screen decides what to draw and what to send from them.
        // Re-read here so a reload after every write refreshes it too.
        select('events', { select: EVENT_SELECT, filters: { id: `eq.${event.id}` } }),
        select('attendance_records', {
          select: ctx.isAdmin === false ? RECORD_SELECT.replace(',attendance_evidence(id,object_path)', '') : RECORD_SELECT,
          filters: { event_id: `eq.${event.id}` },
          order: 'submitted_at.asc',
        }),
        // The denominator under "of the roster". Read as ids rather than a
        // count header, because the same read is what the add dialog offers
        // as the list of people who could be added.
        select('member_enrollments', {
          select: 'member_id,members(id,display_name,archived_at,merged_into_id)',
          filters: {
            academic_year_id: `eq.${ctx.year.id}`,
            'members.archived_at': 'is.null',
            'members.merged_into_id': 'is.null',
          },
        }),
      ]);
      if (token !== state.loadToken) return false;

      if (!fresh.length) {
        // Deleted from under the officer, by another officer or another tab.
        ctx.note('That event is gone.', 'warn');
        close();
        await host.afterChange?.();
        return true;
      }
      state.event = fresh[0];
      state.records = records;
      state.roster = enrolments
        .map((row) => row.members)
        .filter(Boolean)
        .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
      state.enrolled = state.roster.length;

      // This is the successful authoritative read a post-commit refresh lock
      // was waiting for. Only now may the old action controls become usable.
      if (state.refreshLocked) {
        state.refreshLocked = false;
        setBusy(false);
      }

      setHidden(el.loading, true);
      render();
      return true;
    } catch (err) {
      if (token !== state.loadToken) return false;
      setHidden(el.loading, true);
      if (!quietFailure) ctx.fail(err, () => open(event));
      return false;
    }
  }

  /** Re-reads this event's records after a write, without a full page load. */
  async function reload(options) {
    if (!state.event) return false;
    return open(state.event, options);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function renderHeader() {
    const event = state.event;
    el.title.textContent = event.title ?? '';

    const status = eventStatus(event.checkin_closes_at);
    el.status.textContent = status;
    el.status.dataset.status = status.toLowerCase();

    el.meta.textContent = shortDate(event.occurred_on);

    const publish = eventPublishStatus(event, host.autoPublishEnabled?.() ?? true);
    // Not visible: the button always offers to force it early. Visible: it
    // is offered only when it would actually take effect, the same rule the
    // list card follows (see eventPublishStatus's own comment).
    const offerButton = !publish.visible || publish.canUnpublish;
    setHidden(el.publish, !offerButton);
    if (offerButton) el.publish.textContent = publish.visible ? 'Unpublish' : 'Publish';
    el.publishStatus.textContent = publish.detail ? `${publish.label}, ${publish.detail}` : publish.label;
    el.publishStatus.dataset.visible = String(publish.visible);
    el.publishStatus.dataset.warn = String(publish.warn);

    const links = event.event_categories ?? [];
    el.chips.replaceChildren(
      ...(links.length
        ? links.map((link) =>
            h(
              'span',
              { class: 'category-chip' },
              h(
                'span',
                {},
                `${link.categories?.name ?? 'Unknown category'}, ${
                  link.credit_mode === 'from_submission'
                    ? 'member types the number'
                    : String(Number(link.fixed_credit ?? 0))
                }`,
              ),
            ),
          )
        : [h('span', { class: 'muted small' }, 'No categories')]),
    );

    el.window.textContent = event.checkin_closes_at
      ? `Check-in closes ${shortDate(event.checkin_closes_at.slice(0, 10))} ${clockTime(
          event.checkin_closes_at,
        )}`
      : 'Check-in has no close time';
  }

  function render() {
    renderHeader();
    renderStats();
    renderAttendees();
    setHidden(el.body, false);
  }

  function statTile(label, value, tone) {
    return h(
      'div',
      { class: 'event-stat', dataset: tone ? { tone } : {} },
      h('span', { class: 'event-stat-value' }, String(value)),
      h('span', { class: 'event-stat-label' }, label),
    );
  }

  function renderStats() {
    const stats = eventStats(state.records);

    const tiles = [
      statTile('Approved', stats.approved, 'ok'),
      statTile('Waiting', stats.pending, stats.pending ? 'warn' : null),
      statTile('Declined', stats.declined),
    ];
    if (stats.unmatched) tiles.push(statTile('Not matched', stats.unmatched, 'warn'));
    if (state.enrolled) {
      tiles.push(statTile('Of the roster', `${percent(stats.approved, state.enrolled)}%`));
    }
    el.stats.replaceChildren(...tiles);

    const parts = [];
    if (stats.sources.length) {
      parts.push(stats.sources.map((source) => `${source.label} ${source.count}`).join(', '));
    }
    if (stats.firstAt && stats.lastAt) {
      parts.push(
        stats.firstAt === stats.lastAt
          ? clockTime(stats.firstAt)
          : `${clockTime(stats.firstAt)} to ${clockTime(stats.lastAt)}`,
      );
    }
    el.sources.textContent = parts.join(', ');
    setHidden(el.sources, !parts.length);

    // Deleting an event Postgres would refuse is not a button worth offering:
    // attendance_records.event_id is `on delete restrict`.
    const deletable = canDeleteEvent(state.records);
    el.remove.disabled = !deletable;
    el.remove.title = deletable ? 'Delete this event' : 'Events with check-ins cannot be deleted';

    // Only the records this button will actually send. An unmatched name is
    // waiting too, and it is exactly what the button cannot approve, so a
    // label counting it promises an officer something the database refuses.
    const approvable = approvableIds().length;
    setHidden(el.approveAll, ctx.isAdmin === false || approvable === 0);
    setHidden(el.add, ctx.isAdmin === false);
    el.approveAll.textContent = `Approve ${approvable} waiting`;
    el.approveAll.disabled = state.busy;
  }

  const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

  function renderAttendees() {
    const rows = sortAttendees(state.records);
    el.attendeeCount.textContent = rows.length ? plural(rows.length, 'record') : '';
    setHidden(el.typedHead, !typed());
    setHidden(el.exportCsv, rows.length === 0);

    if (!rows.length) {
      setHidden(el.table, true);
      setHidden(el.empty, false);
      return;
    }
    setHidden(el.empty, true);
    setHidden(el.table, false);
    el.rows.replaceChildren(...rows.map(renderAttendee));
  }

  function renderAttendee(record) {
    const name = attendeeName(record);
    const known = Boolean(record.member_id);

    const nameCell = known
      ? h(
          'button',
          {
            type: 'button',
            class: 'board-name',
            onClick: () => ctx.openMember(record.member_id),
          },
          name,
        )
      : h('span', { class: 'attendee-unmatched' }, name);

    return h(
      'tr',
      { dataset: { record: record.id, status: record.status } },
      h(
        'td',
        {},
        nameCell,
        known ? null : h('span', { class: 'attendee-why muted small' }, 'Member not matched'),
      ),
      h(
        'td',
        {},
        h(
          'span',
          { class: 'record-status', dataset: { status: record.status } },
          ATTENDANCE_STATUS[record.status] ?? record.status,
        ),
        record.review_note ? h('span', { class: 'record-note' }, record.review_note) : null,
      ),
      h('td', {}, SOURCE_LABEL[record.source] ?? record.source),
      h('td', { class: 'record-date' }, clockTime(record.submitted_at)),
      typed() ? h('td', { class: 'board-number' }, valueText(record)) : null,
      h('td', {}, h('div', { class: 'rule-actions' }, ...actionsFor(record))),
    );
  }

  const valueText = (record) =>
    record.submitted_value === null || record.submitted_value === undefined
      ? ''
      : String(Number(record.submitted_value));

  /**
   * What one row offers.
   *
   * A record with no member gets Review rather than Approve, for the reason
   * at the top of this file: approving it is refused by the database, and the
   * roster suggestions that fix it live in the queue.
   */
  function actionsFor(record) {
    if (ctx.isAdmin === false) return [];
    const buttons = [];
    const disabled = state.busy;

    if (!record.member_id) {
      buttons.push(
        h(
          'button',
          {
            type: 'button',
            class: 'button button-small',
            disabled,
            onClick: () => ctx.openReview?.(state.event.id),
          },
          'Review',
        ),
      );
    } else if (record.status !== 'approved') {
      buttons.push(
        h(
          'button',
          {
            type: 'button',
            class: 'button button-small',
            disabled,
            'aria-label': `Approve ${attendeeName(record)}`,
            onClick: () => decide([record.id], 'approve'),
          },
          'Approve',
        ),
      );
    }

    if (record.status !== 'rejected') {
      buttons.push(
        h(
          'button',
          {
            type: 'button',
            class: 'button button-small',
            disabled,
            'aria-label': `Decline ${attendeeName(record)}`,
            onClick: () => decide([record.id], 'reject'),
          },
          'Decline',
        ),
      );
    }

    buttons.push(
      h(
        'button',
        {
          type: 'button',
          class: 'button button-small button-danger',
          disabled,
          'aria-label': `Remove ${attendeeName(record)}`,
          onClick: () => askToRemove(record),
        },
        'Remove',
      ),
    );

    return buttons;
  }

  // -------------------------------------------------------------------------
  // Deciding
  // -------------------------------------------------------------------------

  function setBusy(on) {
    state.busy = on;
    for (const node of [el.approveAll, el.add, el.exportCsv, el.duplicate, el.publish]) {
      node.disabled = on;
    }
    // Delete answers to the event's own state as well as to a write in
    // flight, so it cannot simply follow `on` back to enabled.
    el.remove.disabled = on || !canDeleteEvent(state.records);
    renderAttendees();
  }

  const idFilter = (ids) => `in.(${[...new Set(ids)].join(',')})`;

  async function refreshAfterAttendanceChange(said, tone = 'ok') {
    ctx.note(said, tone);
    announce(said);
    const refreshed = await reload({ quietFailure: true });
    if (!refreshed) {
      state.refreshLocked = true;
      // Keep the committed result visible. open() was quiet, but repeating
      // the note also protects against any synchronous shell work between
      // the mutation response and this failed read.
      ctx.note(said, tone);
      return false;
    }
    if (ctx.quietRefresh) await ctx.quietRefresh(() => host.afterChange?.());
    else await host.afterChange?.();
    await ctx.onMemberChanged?.();
    return true;
  }

  async function decisionWasApplied(ids, decision) {
    try {
      const rows = await select('attendance_records', {
        select: 'id,status,reviewed_by',
        filters: { id: idFilter(ids) },
      });
      const wanted = new Set(ids);
      const status = decision === 'approve' ? 'approved' : 'rejected';
      return (
        rows.length === wanted.size &&
        rows.every(
          (row) => wanted.has(row.id) && row.status === status && row.reviewed_by === ctx.userId,
        )
      );
    } catch {
      return false;
    }
  }

  async function decide(ids, decision) {
    if (state.busy || !ids.length) return;
    ctx.clearMessage();
    setBusy(true);
    try {
      let count;
      try {
        count = await callRpc('review_records', {
          p_ids: ids,
          p_decision: decision,
          p_note: null,
        });
      } catch (err) {
        if (err instanceof NetworkError && (await decisionWasApplied(ids, decision))) {
          count = ids.length;
        } else {
          ctx.fail(err, null);
          return;
        }
      }
      const said = `${plural(Number(count ?? ids.length), 'record')} ${
        decision === 'approve' ? 'approved' : 'declined'
      }`;
      await refreshAfterAttendanceChange(said);
    } finally {
      if (!state.refreshLocked) setBusy(false);
    }
  }

  /** Waiting, linked, and safe for one bulk decision. */
  const approvableIds = () =>
    (state.records ?? [])
      .filter(
        (record) =>
          record.status === 'pending' &&
          record.member_id &&
          !isMemberEnteredValue(record),
      )
      .map((record) => record.id);

  function approveAllWaiting() {
    const ids = approvableIds();
    if (!ids.length) {
      ctx.note('Every waiting record on this event needs a member linked first.', 'warn');
      return;
    }
    decide(ids, 'approve');
  }

  // -------------------------------------------------------------------------
  // Removing one record
  // -------------------------------------------------------------------------

  function askToRemove(record) {
    state.removing = record;
    el.removeWho.textContent = `${attendeeName(record)}, ${
      ATTENDANCE_STATUS[record.status] ?? record.status
    }`;
    el.removeNote.textContent = photoPathsOf(record).length
      ? 'The attached photo will also be removed'
      : 'Decline to keep this record in event history';
    el.removeDialog.showModal();
  }

  const photoPathsOf = (record) =>
    (record?.attendance_evidence ?? []).map((row) => row.object_path).filter(Boolean);

  async function recordWasRemoved(recordId) {
    try {
      const rows = await select('attendance_records', {
        select: 'id',
        filters: { id: `eq.${recordId}` },
        limit: 1,
      });
      return rows.length === 0;
    } catch {
      return false;
    }
  }

  async function purgeRunWasFinished(runId) {
    try {
      const rows = await select('v_purge_runs_outstanding', {
        select: 'purge_run_id',
        filters: { purge_run_id: `eq.${runId}` },
        limit: 1,
      });
      return rows.length === 0;
    } catch {
      return false;
    }
  }

  function confirmRemove(event) {
    event.preventDefault();
    const record = state.removing;
    state.removing = null;
    el.removeDialog.close();
    if (record) removeRecord(record, photoPathsOf(record));
  }

  async function removeRecord(record, paths) {
    if (state.busy) return;
    ctx.clearMessage();
    setBusy(true);
    try {
      // THE INTENT IS WRITTEN DOWN BEFORE THE BYTES GO, AND THAT IS THE WHOLE
      // POINT. Storage and Postgres are two systems with no transaction across
      // them, so the client cannot make this safe by choosing an order:
      // deleting the object first destroys a photo irreversibly when the row
      // delete then fails, and deleting the row first strands bytes that no
      // operator tool can name (purge_orphaned_uploads() only sees grants that
      // were never consumed, and submit_checkin() consumes them).
      //
      // remove_attendance_record() deletes the row and writes a purge run for
      // its photos in one transaction, so the paths are recorded as meant to be
      // gone before anything is. What is left below is the same two-step
      // handoff the storage screen uses for every other purge, and a browser
      // that dies halfway leaves an outstanding run that screen can finish.
      let outcome;
      try {
        outcome = await callRpc('remove_attendance_record', { p_record_id: record.id });
      } catch (err) {
        if (err instanceof NetworkError && (await recordWasRemoved(record.id))) {
          const photoWaiting = paths.length > 0;
          const said = photoWaiting
            ? `${attendeeName(record)} removed, photo waiting on Storage`
            : `${attendeeName(record)} removed`;
          await refreshAfterAttendanceChange(said, photoWaiting ? 'warn' : 'ok');
          // With the response gone, the purge run id is unavailable. The saved
          // intent is still discoverable by Storage, which is the recovery path.
          if (photoWaiting) await ctx.onStorageChanged?.();
          return;
        }
        ctx.fail(err, null, { title: 'Record not removed' });
        await reload();
        return;
      }

      const pending = outcome?.object_paths ?? paths;
      const storageChanged = Boolean(outcome?.purge_run_id);
      let photoWaiting = false;
      if (outcome?.purge_run_id && pending.length) {
        let deleted = [];
        try {
          deleted = await deleteEvidenceObjects(pending);
        } catch {
          deleted = [];
        }
        if (deleted.length) {
          try {
            await callRpc('finish_purge_run', {
              p_run_id: outcome.purge_run_id,
              p_object_paths: deleted,
            });
          } catch (err) {
            // The bytes are gone and the bookkeeping is not, which the storage
            // screen shows as an outstanding run. Same sentence it uses.
            if (!(err instanceof NetworkError) || !(await purgeRunWasFinished(outcome.purge_run_id))) {
              deleted = [];
            }
          }
        }
        if (deleted.length !== pending.length) {
          photoWaiting = true;
        }
      }

      const said = photoWaiting
        ? `${attendeeName(record)} removed, photo waiting on Storage`
        : `${attendeeName(record)} removed`;
      await refreshAfterAttendanceChange(said, photoWaiting ? 'warn' : 'ok');
      if (storageChanged) await ctx.onStorageChanged?.();
    } finally {
      if (!state.refreshLocked) setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Adding attendance from a pasted list
  // -------------------------------------------------------------------------

  function openAddDialog() {
    state.addRows = [];
    state.addChoices = new Map();
    el.addNames.value = '';
    el.addValue.value = '';
    setHidden(el.addError, true);
    setHidden(el.addValueField, !typed());
    el.addValueLabel.textContent = typedValueCategory(state.event) ?? 'Amount';
    renderAddPreview();
    el.addDialog.showModal();
    el.addNames.focus();
  }

  function chooseAddMember(row, memberId) {
    state.addChoices.set(row.row, {
      kind: 'member',
      member_id: memberId,
      normalized_name: normaliseName(row.name),
      source_text: el.addNames.value,
    });
    renderAddPreview();
  }

  function leaveAddUnmatched(row) {
    state.addChoices.set(row.row, {
      kind: 'unmatched',
      normalized_name: normaliseName(row.name),
      source_text: el.addNames.value,
    });
    renderAddPreview();
  }

  function openSuggestedMember(memberId) {
    el.addDialog.close();
    ctx.openMember(memberId);
  }

  function reviewPreservedAttendance() {
    el.addDialog.close();
    ctx.openReview?.(state.event.id);
  }

  function addPreviewRow(row) {
    const suggestions = row.status === 'choice'
      ? h(
          'div',
          { class: 'attendance-paste-suggestions' },
          ...row.suggestions.map((suggestion) =>
            h(
              'div',
              { class: 'attendance-paste-suggestion' },
              h('span', {}, suggestion.member.display_name),
              h(
                'button',
                {
                  type: 'button',
                  class: 'button button-small button-quiet',
                  onClick: () => openSuggestedMember(suggestion.member.id),
                },
                'Open member',
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'button button-small',
                  onClick: () => chooseAddMember(row, suggestion.member.id),
                },
                'Link member',
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'button button-small',
              onClick: () => leaveAddUnmatched(row),
            },
            'Not on roster',
          ),
        )
      : null;
    const review = row.needsReview
      ? h(
          'button',
          { type: 'button', class: 'button button-small', onClick: reviewPreservedAttendance },
          'Review',
        )
      : null;

    return h(
      'div',
      { class: 'attendance-paste-row', dataset: { status: row.status, line: String(row.row) } },
      h(
        'span',
        { class: 'attendance-paste-line', 'aria-label': `Line ${row.row}` },
        String(row.row),
      ),
      h(
        'span',
        { class: 'attendance-paste-name' },
        row.name ?? row.raw,
        row.member && row.member.display_name !== row.name
          ? h('span', { class: 'muted small' }, row.member.display_name)
          : null,
      ),
      h('span', { class: 'attendance-paste-badge' }, row.label),
      review,
      suggestions,
    );
  }

  function renderAddPreview() {
    state.addRows = buildAttendancePastePreview(
      el.addNames.value,
      state.roster,
      state.records,
      state.addChoices,
    );
    el.addList.replaceChildren(...state.addRows.map(addPreviewRow));

    const members = state.addRows.filter((row) => row.status === 'member').length;
    const unmatched = state.addRows.filter((row) => row.status === 'unmatched').length;
    const recorded = state.addRows.filter((row) => row.status === 'recorded').length;
    const review = state.addRows.filter((row) =>
      ['choice', 'invalid', 'repeated'].includes(row.status),
    ).length;
    el.addCount.textContent = [
      plural(members, 'member'),
      `${unmatched} not on roster`,
      `${recorded} already recorded`,
      `${review} needs review`,
    ].join(', ');
    const unresolved = state.addRows.some((row) => row.status === 'choice');
    const actionable = state.addRows.some((row) => ['member', 'unmatched'].includes(row.status));
    el.addSubmit.disabled = unresolved || !actionable;
  }

  const batchEntries = () => {
    const batchKey = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return state.addRows.map((row) => ({
      line: row.row,
      claimed_name: row.name ?? row.raw,
      disposition: row.disposition,
      member_id: row.member?.id ?? null,
      batch_key: batchKey,
    }));
  };

  function outcomesCoverEntries(outcomes, entries) {
    if (!Array.isArray(outcomes) || outcomes.length !== entries.length) return false;
    const counts = new Map();
    for (const outcome of outcomes) {
      const line = Number(outcome?.line);
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return entries.every((entry) => counts.get(Number(entry.line)) === 1);
  }

  async function addPasted(event) {
    event.preventDefault();
    renderAddPreview();
    if (el.addSubmit.disabled) return;

    const needsValue = typed();
    const value = Number(el.addValue.value);
    if (needsValue && (!el.addValue.value.trim() || !Number.isFinite(value) || value < 0)) {
      el.addError.textContent = 'Type a number.';
      setHidden(el.addError, false);
      el.addValue.focus();
      return;
    }
    setHidden(el.addError, true);

    ctx.clearMessage();
    setBusy(true);
    try {
      const entries = batchEntries();
      const recordsBeforeCall = [...state.records];
      let outcomes;
      try {
        outcomes = await callRpc('add_officer_attendance_batch', {
          p_event_id: state.event.id,
          p_entries: entries,
          p_submitted_value: needsValue ? value : null,
        });
      } catch (err) {
        if (err instanceof NetworkError) {
          outcomes = await recoverBatchOutcomes(entries, needsValue ? value : null, recordsBeforeCall);
        }
        if (!outcomes) {
          ctx.fail(err, null);
          await reload();
          return;
        }
      }

      if (!outcomesCoverEntries(outcomes, entries)) {
        ctx.note('Attendance result incomplete. Reload and check the event.', 'warn');
        await reload();
        return;
      }

      el.addDialog.close();
      const added = outcomes.filter((row) => row.outcome === 'added').length;
      const waiting = outcomes.filter((row) => row.outcome === 'waiting_for_member_link').length;
      await refreshAfterAttendanceChange(
        `${added} added, ${waiting} waiting for member links`,
        waiting ? 'warn' : 'ok',
      );
      showAddResults(outcomes);
    } finally {
      if (!state.refreshLocked) setBusy(false);
    }
  }

  async function recoverBatchOutcomes(entries, submittedValue, before) {
    try {
      try {
        const outcomes = await callRpc('recover_officer_attendance_batch', {
          p_event_id: state.event.id,
          p_batch_key: entries[0]?.batch_key,
        });
        if (outcomesCoverEntries(outcomes, entries)) {
          return outcomes;
        }
      } catch {
        // The before snapshot below can still prove pre-existing live rows.
      }

      const current = await select('attendance_records', {
        select: 'id,member_id,claimed_name,status,source,submitted_value,reviewed_by,flags',
        filters: { event_id: `eq.${state.event.id}` },
      });
      return reconstructAttendanceBatchOutcomes(entries, current, before, { submittedValue });
    } catch {
      return null;
    }
  }

  function showAddResults(outcomes) {
    const labels = {
      added: 'Added',
      waiting_for_member_link: 'Waiting for member link',
      already_recorded: 'Already recorded',
      repeated: 'Repeated',
      invalid: 'Needs full name',
    };
    const added = outcomes.filter((row) => row.outcome === 'added').length;
    const waiting = outcomes.filter((row) => row.outcome === 'waiting_for_member_link').length;
    el.addResultSummary.textContent = `${added} added, ${waiting} waiting for member links`;
    el.addResultList.replaceChildren(
      ...outcomes.map((row) =>
        h(
          'div',
          { class: 'attendance-paste-result', dataset: { outcome: row.outcome } },
          h(
            'span',
            { class: 'attendance-paste-line', 'aria-label': `Line ${row.line}` },
            String(row.line),
          ),
          h('span', { class: 'attendance-paste-name' }, row.claimed_name),
          h('span', { class: 'attendance-paste-badge' }, labels[row.outcome] ?? 'Needs review'),
        ),
      ),
    );
    el.addResultDialog.showModal();
  }

  // -------------------------------------------------------------------------
  // Publishing: separate from saving configuration, on purpose (see the
  // header comment in supabase/migrations/20260903120000_events_page.sql and
  // web/src/events.js). set_event_published() is its own RPC and this button
  // is the only thing on this screen that calls it.
  // -------------------------------------------------------------------------

  async function togglePublish() {
    if (state.busy || !state.event) return;
    // The button offered is always the opposite of whether the event is
    // currently VISIBLE, not of is_published: see eventPublishStatus() for
    // why those are different questions once the Monday drop is involved.
    const publish = eventPublishStatus(state.event, host.autoPublishEnabled?.() ?? true);
    const publishing = !publish.visible;
    ctx.clearMessage();
    setBusy(true);
    try {
      await callRpc('set_event_published', {
        p_event_id: state.event.id,
        p_published: publishing,
      });
      const said = publishing ? `${state.event.title} published.` : `${state.event.title} unpublished.`;
      await refreshAfterAttendanceChange(said);
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      if (!state.refreshLocked) setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // The event itself
  // -------------------------------------------------------------------------

  function askToDelete() {
    if (!canDeleteEvent(state.records)) return;
    el.deleteWhat.textContent = `${state.event.title}, ${shortDate(state.event.occurred_on)}`;
    el.deleteDialog.showModal();
  }

  function confirmDelete(event) {
    event.preventDefault();
    el.deleteDialog.close();
    // Re-asked rather than trusted: the officer may have approved somebody on
    // this event in another tab since the dialog opened, and the button that
    // opened it is the only thing that checked.
    if (!canDeleteEvent(state.records)) return;
    deleteEvent();
  }

  async function deleteEvent() {
    if (state.busy) return;
    const event = state.event;
    ctx.clearMessage();
    setBusy(true);
    try {
      // event_categories and event_evidence_requirements are `on delete
      // cascade`, so the event row is the only delete this needs.
      const gone = await remove('events', { id: `eq.${event.id}` });
      if (!gone.length) throw new Error(NOT_WRITTEN);

      const said = `${event.title} deleted.`;
      ctx.note(said);
      announce(said);
      // The list is refreshed before it comes back, so it never draws a row
      // for the event that was just deleted.
      await host.afterChange?.();
      close();
    } catch (err) {
      // A race: somebody checked in between this screen loading and this
      // button being pressed, so `on delete restrict` refuses with a real
      // foreign-key error rather than an empty array. Re-reading is what
      // makes Delete go disabled again, the same answer categories.js gives
      // to the same race. Without it the button stays live over an event
      // that can no longer be deleted, and every press repeats the refusal.
      ctx.fail(err, null);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  function exportAttendees() {
    const rows = attendeeCsvRows(sortAttendees(state.records), { typed: typed() });
    downloadCsv(attendeeCsvFilename(state.event.title, state.event.occurred_on), rows);
    announce(`${plural(rows.length - 1, 'record')} exported.`);
  }

  // -------------------------------------------------------------------------

  /**
   * Tear the screen down without deciding where the officer goes next.
   *
   * Split from close() because the year selector needs the first half and not
   * the second: events.js is what puts the list back up in that case, after
   * its own reload, and a backToList() from here would draw the list twice.
   */
  function dismiss() {
    // Bumped so a read still in flight for the event being dismissed cannot
    // come back and paint it over whatever replaces this screen.
    state.loadToken += 1;
    state.event = null;
    state.records = [];
    setHidden(el.view, true);
  }

  function close() {
    dismiss();
    host.backToList();
  }

  function wire() {
    el.back.addEventListener('click', close);
    el.qr.addEventListener('click', () => host.openQr(state.event));
    el.preview.addEventListener('click', () => host.previewCheckin(state.event));
    el.edit.addEventListener('click', () => host.openForm(state.event));
    el.duplicate.addEventListener('click', () => host.duplicate(state.event));
    el.publish.addEventListener('click', togglePublish);
    el.remove.addEventListener('click', askToDelete);

    el.approveAll.addEventListener('click', approveAllWaiting);
    el.add.addEventListener('click', openAddDialog);
    el.exportCsv.addEventListener('click', exportAttendees);

    el.addForm.addEventListener('submit', addPasted);
    el.removeForm.addEventListener('submit', confirmRemove);
    el.deleteForm.addEventListener('submit', confirmDelete);
    el.addNames.addEventListener('input', () => {
      state.addChoices.clear();
      renderAddPreview();
    });

    for (const dialog of [el.addDialog, el.addResultDialog, el.removeDialog, el.deleteDialog]) {
      dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    }
    // Cancelling leaves nothing armed: a dialog dismissed with Esc closes
    // without passing through the Cancel button.
    el.removeDialog.addEventListener('close', () => {
      state.removing = null;
    });
  }

  return {
    mount: wire,
    open,
    close,
    dismiss,
    currentId: () => state.event?.id ?? null,
  };
}
