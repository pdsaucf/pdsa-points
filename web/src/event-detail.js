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
import {
  ATTENDANCE_STATUS,
  ATTENDANCE_SOURCES,
  attendeeCsvFilename,
  attendeeCsvRows,
  attendeeName,
  addableMembers,
  canDeleteEvent,
  collectsTypedValue,
  eventStats,
  eventStatus,
  sortAttendees,
  typedValueCategory,
} from './events-model.js';
import { $, h, announce, setHidden, plural, shortDate, clockTime } from './ui.js';

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
  'id,title,occurred_on,location,term_id,checkin_token,checkin_closes_at',
  'event_categories(category_id,credit_mode,fixed_credit,categories(id,name))',
  'event_evidence_requirements(id,kind,is_required,prompt)',
].join(',');

const SOURCE_LABEL = Object.fromEntries(ATTENDANCE_SOURCES.map((row) => [row.value, row.label]));

// PostgREST answers a write its policy refuses with 200 and an empty array, so
// every delete below counts what came back. Same sentence the events form uses
// for the same reason.
const NOT_WRITTEN = 'The change was refused. Reload the page and try again.';

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
    chips: $('event-detail-chips'),

    qr: $('event-detail-qr'),
    preview: $('event-detail-preview'),
    edit: $('event-detail-edit'),
    duplicate: $('event-detail-duplicate'),
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
    addSearch: $('attendee-add-search'),
    addList: $('attendee-add-list'),
    addValueField: $('attendee-add-value-field'),
    addValueLabel: $('attendee-add-value-label'),
    addValue: $('attendee-add-value'),
    addError: $('attendee-add-error'),
    addSubmit: $('attendee-add-submit'),
    addCount: $('attendee-add-count'),

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
    // The add dialog's own state: who is ticked, and what is typed in its
    // search box. Kept here rather than read off the DOM so a re-render of
    // the list cannot lose a tick.
    picked: new Set(),
    query: '',
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
          select: RECORD_SELECT,
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

    el.meta.textContent = [shortDate(event.occurred_on), event.location]
      .filter(Boolean)
      .join(' · ');

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
                `${link.categories?.name ?? 'Unknown category'} · ${
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
      parts.push(stats.sources.map((source) => `${source.label} ${source.count}`).join(' · '));
    }
    if (stats.firstAt && stats.lastAt) {
      parts.push(
        stats.firstAt === stats.lastAt
          ? clockTime(stats.firstAt)
          : `${clockTime(stats.firstAt)} to ${clockTime(stats.lastAt)}`,
      );
    }
    el.sources.textContent = parts.join(' · ');
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
    setHidden(el.approveAll, approvable === 0);
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
    for (const node of [el.approveAll, el.add, el.exportCsv, el.duplicate]) {
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

  /** Waiting, and linked to a member, which is what review_records() will take. */
  const approvableIds = () =>
    (state.records ?? [])
      .filter((record) => record.status === 'pending' && record.member_id)
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
    el.removeWho.textContent = `${attendeeName(record)} · ${
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
            ? `${attendeeName(record)} removed · Photo waiting on Storage`
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
        ? `${attendeeName(record)} removed · Photo waiting on Storage`
        : `${attendeeName(record)} removed`;
      await refreshAfterAttendanceChange(said, photoWaiting ? 'warn' : 'ok');
      if (storageChanged) await ctx.onStorageChanged?.();
    } finally {
      if (!state.refreshLocked) setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Adding people by hand
  // -------------------------------------------------------------------------
  //
  // A sheet of paper with twelve names on it is the case this exists for, so
  // the dialog takes as many at a time as an officer ticks. Each one is filed
  // pending and the whole batch is approved in one review_records() call.

  function openAddDialog() {
    state.picked = new Set();
    state.query = '';
    el.addSearch.value = '';
    el.addValue.value = '';
    setHidden(el.addError, true);

    const offered = addableMembers(state.roster, state.records);
    if (!offered.length) {
      ctx.note('Everybody on the roster already has a record for this event.', 'warn');
      return;
    }

    setHidden(el.addValueField, !typed());
    el.addValueLabel.textContent = typedValueCategory(state.event) ?? 'Amount';

    renderAddList();
    el.addDialog.showModal();
    el.addSearch.focus();
  }

  function renderAddList() {
    const needle = state.query.trim().toLowerCase();
    const offered = addableMembers(state.roster, state.records).filter((member) =>
      needle ? String(member.display_name).toLowerCase().includes(needle) : true,
    );

    el.addList.replaceChildren(
      ...(offered.length
        ? offered.map((member) =>
            h(
              'label',
              { class: 'attendee-pick' },
              h('input', {
                type: 'checkbox',
                checked: state.picked.has(member.id),
                onChange: (event) => {
                  if (event.target.checked) state.picked.add(member.id);
                  else state.picked.delete(member.id);
                  renderAddCount();
                },
              }),
              h('span', {}, member.display_name),
            ),
          )
        : [h('p', { class: 'muted small' }, 'No match on the roster.')]),
    );
    renderAddCount();
  }

  function renderAddCount() {
    el.addCount.textContent = state.picked.size
      ? plural(state.picked.size, 'member')
      : 'Nobody picked';
    el.addSubmit.disabled = state.picked.size === 0;
  }

  async function addPicked(event) {
    event.preventDefault();
    const memberIds = [...state.picked];
    if (!memberIds.length) return;

    const needsValue = typed();
    const value = Number(el.addValue.value);
    if (needsValue && (!el.addValue.value.trim() || !Number.isFinite(value) || value < 0)) {
      el.addError.textContent = 'Type a number.';
      setHidden(el.addError, false);
      el.addValue.focus();
      return;
    }
    setHidden(el.addError, true);
    el.addDialog.close();

    ctx.clearMessage();
    setBusy(true);
    try {
      // ONE CALL, ONE TRANSACTION. This used to be an insert followed by
      // review_records(), and the gap between them was two bugs at once: an
      // approval that failed after the insert committed left records nobody
      // was told about sitting pending, and the decision about whether this
      // event wants a typed number was made here, from an event row read when
      // the screen opened. add_officer_attendance() reads event_categories
      // itself, under a lock, and refuses rather than filing credit worth
      // zero. See supabase/migrations/20260822100000_officer_attendance_entry.sql.
      const recordsBeforeCall = new Set(state.records.map((row) => row.id));
      let filed;
      try {
        filed = await callRpc('add_officer_attendance', {
          p_event_id: state.event.id,
          p_member_ids: memberIds,
          p_submitted_value: needsValue ? value : null,
        });
      } catch (err) {
        if (
          err instanceof NetworkError &&
          (await addedRecordsWereFiled(memberIds, needsValue ? value : null, recordsBeforeCall))
        ) {
          filed = memberIds;
        } else {
          ctx.fail(err, null);
          // Re-read the event after a definitive refusal. Its credit mode or
          // attendance may have changed while the dialog was open.
          await reload();
          return;
        }
      }

      const count = Array.isArray(filed) ? filed.length : memberIds.length;
      await refreshAfterAttendanceChange(`${plural(count, 'member')} added`);
    } finally {
      if (!state.refreshLocked) setBusy(false);
    }
  }

  async function addedRecordsWereFiled(memberIds, submittedValue, recordsBeforeCall) {
    try {
      const rows = await select('attendance_records', {
        select: 'id,member_id,status,source,submitted_value,reviewed_by',
        filters: {
          event_id: `eq.${state.event.id}`,
          member_id: idFilter(memberIds),
        },
      });
      return memberIds.every((memberId) =>
        rows.some(
          (row) =>
            !recordsBeforeCall.has(row.id) &&
            row.member_id === memberId &&
            row.status === 'approved' &&
            row.source === 'officer_entry' &&
            row.reviewed_by === ctx.userId &&
            (submittedValue === null
              ? row.submitted_value === null
              : Number(row.submitted_value) === submittedValue),
        ),
      );
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // The event itself
  // -------------------------------------------------------------------------

  function askToDelete() {
    if (!canDeleteEvent(state.records)) return;
    el.deleteWhat.textContent = `${state.event.title} · ${shortDate(state.event.occurred_on)}`;
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
    el.remove.addEventListener('click', askToDelete);

    el.approveAll.addEventListener('click', approveAllWaiting);
    el.add.addEventListener('click', openAddDialog);
    el.exportCsv.addEventListener('click', exportAttendees);

    el.addForm.addEventListener('submit', addPicked);
    el.removeForm.addEventListener('submit', confirmRemove);
    el.deleteForm.addEventListener('submit', confirmDelete);
    el.addSearch.addEventListener('input', () => {
      state.query = el.addSearch.value;
      renderAddList();
    });

    for (const dialog of [el.addDialog, el.removeDialog, el.deleteDialog]) {
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
