// One member, in full.
//
// This is the screen that answers "I think I am missing a GBM", which is the
// email an officer gets every week and which the spreadsheet could only answer
// by scrolling sideways through thirteen tabs. So it carries three things and
// no decoration:
//
//   progress    every category, its total and the target it is measured
//               against
//   checklist   the Honorary rule, requirement by requirement, with the verdict
//               on each. Read from fn_member_requirement_status(), which is the
//               same function v_member_status uses for is_honorary, so the
//               checklist and the star on the board can never disagree
//   records     every attendance record for the year: what it was for, when,
//               what credit it carried, where it came from, and who decided it
//
// AND ONE WRITE. An officer can add a record by hand, because that is how the
// spreadsheet workflow actually operated: somebody says "I was there, I signed
// the sheet", and an officer puts it in. It is filed as source = officer_entry
// and it is NOT written as approved. It goes in pending and then through
// review_records(), for the same reason the review queue does: that function is
// what stamps the reviewer, writes the audit row, and refuses the approvals
// that have to be refused. Nothing here writes `status` directly, and invariant
// 6 holds, because the officer pressing the button IS the person approving it.

import { select, insert, patch, callRpc } from './rest.js';
import { READ_ONLY } from './officer-errors.js';
import { buildTree, flatten } from './requirement-model.js';
import { firstJoinedOn } from './joined.js';
import { $, h, announce, setHidden, plural, shortDate, monthYear } from './ui.js';

// What the source column says, in an officer's words rather than the enum's.
// The first three match the wording review.js already uses.
const SOURCE = {
  self_checkin: 'Scanned',
  officer_entry: 'Added by an officer',
  import: 'Imported',
  member_request: 'Member portal',
};

const STATUS = {
  approved: 'Approved',
  pending: 'Pending',
  rejected: 'Declined',
};

const RECORD_SELECT = [
  'id',
  'status',
  'source',
  'submitted_value',
  'submitted_at',
  'reviewed_by',
  'reviewed_at',
  'review_note',
  'events!inner(id,title,occurred_on,academic_year_id,event_categories(credit_mode,fixed_credit,categories(id,name,unit,unit_label)))',
].join(',');

export function createMember(ctx) {
  const el = {
    panel: $('panel-member'),
    loading: $('loading-member'),
    body: $('member-body'),
    back: $('member-back'),
    name: $('member-name'),
    meta: $('member-meta'),
    points: $('member-points'),
    honorary: $('member-honorary'),
    edit: $('member-edit'),
    progress: $('member-progress'),
    checklist: $('member-checklist'),
    checklistNote: $('member-checklist-note'),
    records: $('member-records'),
    recordsCount: $('member-records-count'),
    addRecord: $('member-add-record'),
    recordDialog: $('record-dialog'),
    recordForm: $('record-form'),
    recordEvent: $('record-event'),
    recordValue: $('record-value'),
    recordValueField: $('record-value-field'),
    recordValueLabel: $('record-value-label'),
    recordError: $('record-error'),
    editDialog: $('member-edit-dialog'),
    editForm: $('member-edit-form'),
    editFirst: $('member-edit-first'),
    editLast: $('member-edit-last'),
    editPreferred: $('member-edit-preferred'),
    editEmail: $('member-edit-email'),
    editError: $('member-edit-error'),
  };

  const state = {
    memberId: null,
    member: null,
    joined: null,
    status: null,
    categories: [],
    totals: new Map(),
    checklist: [],
    records: [],
    reviewers: new Map(), // user_id -> name
    events: [],
    busy: false,
  };

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function load(memberId) {
    state.memberId = memberId ?? state.memberId;
    if (!state.memberId) return;

    setHidden(el.loading, false);
    setHidden(el.body, true);

    const yearId = ctx.year.id;

    try {
      const [members, enrollments, categories, statuses, totals, records, reviewers] =
        await Promise.all([
          select('members', {
            select: 'id,first_name,last_name,preferred_name,display_name,email,created_at,archived_at,merged_into_id',
            filters: { id: `eq.${state.memberId}` },
            limit: 1,
          }),
          // Every year, not the selected one, because "Joined" is the earliest
          // of them. joined.js says why that has to be the same fact here as
          // on the roster.
          select('member_enrollments', {
            select: 'member_id,joined_on',
            filters: { member_id: `eq.${state.memberId}` },
          }),
          select('categories', {
            select: 'id,name,unit,unit_label,counts_toward_point_total,sort_order,archived_at',
            order: 'sort_order.asc',
          }),
          select('v_member_status', {
            select: 'member_id,point_total,is_honorary,requirement_set_id',
            filters: { member_id: `eq.${state.memberId}`, academic_year_id: `eq.${yearId}` },
            limit: 1,
          }),
          select('v_member_category_totals', {
            select: 'member_id,category_id,total',
            filters: { member_id: `eq.${state.memberId}`, academic_year_id: `eq.${yearId}` },
          }),
          select('attendance_records', {
            select: RECORD_SELECT,
            filters: {
              member_id: `eq.${state.memberId}`,
              'events.academic_year_id': `eq.${yearId}`,
            },
          }),
          select('profiles', { select: 'user_id,full_name' }),
        ]);

      state.member = members[0] ?? null;
      if (!state.member) {
        setHidden(el.loading, true);
        ctx.note('That member is gone. Reload the page.', 'warn');
        return;
      }

      // Every year they have ever been on, not the selected one. The read is
      // deliberately unfiltered by year for this: see joined.js.
      state.joined = firstJoinedOn(enrollments, state.member);
      state.status = statuses[0] ?? null;
      state.totals = new Map(totals.map((row) => [row.category_id, Number(row.total ?? 0)]));
      state.reviewers = new Map(reviewers.map((row) => [row.user_id, row.full_name]));

      // Newest first: the record somebody is asking about is nearly always the
      // one from last week.
      state.records = records.sort((a, b) =>
        String(b.events?.occurred_on ?? '').localeCompare(String(a.events?.occurred_on ?? '')),
      );

      const used = new Set(state.totals.keys());
      state.categories = categories.filter((row) => !row.archived_at || used.has(row.id));

      state.checklist = await loadChecklist(state.status?.requirement_set_id ?? null);

      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, () => load());
    }
  }

  /**
   * The Honorary checklist.
   *
   * fn_member_requirement_status() returns one row per requirement with the
   * value, the target and the verdict already decided. Nothing here re-decides
   * any of it; the tree is rebuilt only so a requirement inside a group is
   * drawn inside that group.
   */
  async function loadChecklist(setId) {
    if (!setId) return [];
    const rows = await callRpc('fn_member_requirement_status', {
      p_member_id: state.memberId,
      p_requirement_set_id: setId,
    });

    // The function already returns them in display order, so position stands in
    // for the sort column the rows do not carry.
    const shaped = (rows ?? []).map((row, index) => ({
      id: row.node_id,
      parent_id: row.parent_id,
      type: row.type,
      label: row.label,
      sort_order: index,
      value: Number(row.value ?? 0),
      target: Number(row.target ?? 0),
      passed: Boolean(row.passed),
    }));

    const { root } = buildTree(shaped);
    return flatten(root);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  const number = (value) => {
    const n = Number(value ?? 0);
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  };

  function render() {
    setHidden(el.loading, true);
    setHidden(el.body, false);

    const member = state.member;
    el.name.textContent = member.display_name;

    el.meta.textContent = [
      member.email || 'No email on file',
      state.joined ? `Joined ${monthYear(state.joined)}` : null,
      ctx.year.label,
    ]
      .filter(Boolean)
      .join(' · ');

    el.points.textContent = number(state.status?.point_total ?? 0);
    setHidden(el.honorary, !state.status?.is_honorary);
    setHidden(el.edit, !ctx.canReview);
    setHidden(el.addRecord, !ctx.canReview);

    renderProgress();
    renderChecklist();
    renderRecords();
  }

  function renderProgress() {
    el.progress.replaceChildren(
      ...state.categories.map((category) => {
        const total = state.totals.get(category.id) ?? 0;
        return h(
          'div',
          { class: 'progress-row' },
          h('span', { class: 'progress-label' }, category.name),
          h('span', { class: 'progress-value' }, number(total)),
        );
      }),
    );
    if (!state.categories.length) {
      el.progress.replaceChildren(h('p', { class: 'muted small' }, 'No categories yet.'));
    }
  }

  function renderChecklist() {
    if (!state.checklist.length) {
      setHidden(el.checklistNote, false);
      el.checklistNote.textContent = 'No rules are published for this year.';
      el.checklist.replaceChildren();
      return;
    }
    setHidden(el.checklistNote, true);

    // The root is the whole rule, and the star beside the name already says
    // whether it passed, so the list starts underneath it.
    const rows = state.checklist.slice(1);

    el.checklist.replaceChildren(
      ...rows.map(({ item, depth }) =>
        h(
          'li',
          {
            class: 'check-row',
            dataset: { passed: String(item.passed), depth: String(depth) },
          },
          h(
            'span',
            { class: 'check-mark', 'aria-hidden': 'true' },
            item.passed ? '✓' : '✗',
          ),
          h('span', { class: 'check-label' }, item.label),
          // A group's value is how many of its requirements passed, a measured
          // one's is the credit earned. Both read as "x of y", which is why
          // this line does not branch on which kind it is.
          h('span', { class: 'check-figures' }, `${number(item.value)} of ${number(item.target)}`),
          h('span', { class: 'visually-hidden' }, item.passed ? 'Met' : 'Not met'),
        ),
      ),
    );
  }

  function renderRecords() {
    el.recordsCount.textContent = plural(state.records.length, 'record');

    if (!state.records.length) {
      el.records.replaceChildren(
        h('tr', {}, h('td', { class: 'muted', colspan: '6' }, 'Nothing this year.')),
      );
      return;
    }

    el.records.replaceChildren(
      ...state.records.map((record) => {
        const event = record.events ?? {};
        const reviewer = record.reviewed_by ? state.reviewers.get(record.reviewed_by) : null;

        return h(
          'tr',
          { dataset: { record: record.id, status: record.status } },
          h('td', {}, event.title ?? ''),
          h('td', { class: 'record-date' }, shortDate(event.occurred_on)),
          h('td', {}, creditText(record)),
          h('td', {}, SOURCE[record.source] ?? record.source),
          h(
            'td',
            {},
            h('span', { class: 'record-status', dataset: { status: record.status } },
              STATUS[record.status] ?? record.status),
            record.review_note ? h('span', { class: 'record-note' }, record.review_note) : null,
          ),
          h('td', {}, reviewer ?? (record.reviewed_at ? 'Officer' : '')),
        );
      }),
    );
  }

  /** '1 GBMs', '3.5 Volunteering hours', for whatever the event counts toward. */
  function creditText(record) {
    const links = record.events?.event_categories ?? [];
    if (!links.length) return '';
    return links
      .map((link) => {
        const category = link.categories ?? {};
        const credit =
          link.credit_mode === 'fixed'
            ? Number(link.fixed_credit ?? 0)
            : Number(record.submitted_value ?? 0);
        const unit = category.unit_label ? ` ${category.unit_label}${credit === 1 ? '' : 's'}` : '';
        return `${number(credit)} ${category.name ?? ''}${unit}`.trim();
      })
      .join(' · ');
  }

  // -------------------------------------------------------------------------
  // Adding a record by hand
  // -------------------------------------------------------------------------

  async function openRecordDialog() {
    setHidden(el.recordError, true);
    el.recordValue.value = '';

    if (!state.events.length) {
      try {
        state.events = await select('events', {
          select: 'id,title,occurred_on,event_categories(credit_mode,categories(id,name,unit_label))',
          filters: { academic_year_id: `eq.${ctx.year.id}` },
          order: 'occurred_on.desc',
        });
      } catch (err) {
        ctx.fail(err, null);
        return;
      }
    }

    const taken = new Set(
      state.records.filter((row) => row.status !== 'rejected').map((row) => row.events?.id),
    );
    const offered = state.events.filter((event) => !taken.has(event.id));

    if (!offered.length) {
      ctx.note('This member already has a record for every event this year.', 'warn');
      return;
    }

    el.recordEvent.replaceChildren(
      ...offered.map((event) =>
        h('option', { value: event.id }, `${shortDate(event.occurred_on)} ${event.title}`),
      ),
    );
    onEventChosen();
    el.recordDialog.showModal();
  }

  /**
   * An event that reads a number off the check-in form still needs that number
   * when an officer files it by hand, and the label comes from the category
   * rather than from anything this file knows about hours.
   */
  function onEventChosen() {
    const event = state.events.find((row) => row.id === el.recordEvent.value);
    const link = (event?.event_categories ?? []).find(
      (row) => row.credit_mode === 'from_submission',
    );
    setHidden(el.recordValueField, !link);
    if (link) {
      const category = link.categories ?? {};
      const unit = category.unit_label ? `${category.unit_label}s` : 'amount';
      el.recordValueLabel.textContent = `${category.name} ${unit}`;
    }
  }

  async function addRecord(event) {
    event.preventDefault();
    const eventId = el.recordEvent.value;
    if (!eventId) return;

    const needsValue = !el.recordValueField.hidden;
    const value = Number(el.recordValue.value);
    if (needsValue && (!el.recordValue.value.trim() || !Number.isFinite(value) || value < 0)) {
      el.recordError.textContent = 'Type a number.';
      setHidden(el.recordError, false);
      el.recordValue.focus();
      return;
    }
    setHidden(el.recordError, true);
    el.recordDialog.close();

    setBusy(true);
    try {
      // Filed pending, then approved through the RPC. Two calls on purpose:
      // see the note at the top of this file.
      const created = await insert('attendance_records', [
        {
          event_id: eventId,
          member_id: state.memberId,
          source: 'officer_entry',
          submitted_value: needsValue ? value : null,
        },
      ]);
      const record = created?.[0];
      if (!record) throw new Error('nothing came back');

      await callRpc('review_records', {
        p_ids: [record.id],
        p_decision: 'approve',
        p_note: null,
      });

      const said = 'Record added.';
      ctx.note(said);
      announce(said);
      await load();
      ctx.onMemberChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Editing the member
  // -------------------------------------------------------------------------

  function openEditDialog() {
    setHidden(el.editError, true);
    el.editFirst.value = state.member.first_name ?? '';
    el.editLast.value = state.member.last_name ?? '';
    el.editPreferred.value = state.member.preferred_name ?? '';
    el.editEmail.value = state.member.email ?? '';
    el.editDialog.showModal();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const first = el.editFirst.value.trim();
    const last = el.editLast.value.trim();
    if (!first || !last) {
      el.editError.textContent = 'First and last name are both required.';
      setHidden(el.editError, false);
      return;
    }
    setHidden(el.editError, true);
    el.editDialog.close();

    setBusy(true);
    try {
      const rows = await patch(
        'members',
        { id: `eq.${state.memberId}` },
        {
          first_name: first,
          last_name: last,
          preferred_name: el.editPreferred.value.trim() || null,
          email: el.editEmail.value.trim() || null,
        },
      );
      if (!rows.length) {
        ctx.note('Nothing was changed. Reload the page.', 'warn');
        return;
      }
      ctx.note('Saved.');
      await load();
      ctx.onMemberChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    state.busy = on;
    el.addRecord.disabled = on;
    el.edit.disabled = on;
  }

  // -------------------------------------------------------------------------

  function wire() {
    el.back.addEventListener('click', () => ctx.closeMember());
    el.addRecord.addEventListener('click', openRecordDialog);
    el.edit.addEventListener('click', openEditDialog);
    el.recordEvent.addEventListener('change', onEventChosen);
    el.recordForm.addEventListener('submit', addRecord);
    el.editForm.addEventListener('submit', saveEdit);
    for (const dialog of [el.recordDialog, el.editDialog]) {
      dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    }
    if (!ctx.canReview) {
      el.addRecord.title = READ_ONLY;
      el.edit.title = READ_ONLY;
    }
  }

  return {
    mount() {
      wire();
    },
    open(memberId) {
      return load(memberId);
    },
    reload: () => load(),
    currentId: () => state.memberId,
  };
}
