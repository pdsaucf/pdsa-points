// The events screen: what the QR code on the wall points at.
//
// TWO STATES, ONE PANEL. The list and the form are the same screen: the form
// replaces the list in place rather than opening as a modal, and Cancel or
// Save return to the list. There is no separate route for "new" versus
// "edit"; both use the same form, told apart by whether an event is already
// on screen.
//
// CHECK-IN OPENS THE MOMENT AN EVENT EXISTS. There is no "opens" field
// anywhere below: checkin_opens_at is never written by this screen, which is
// what lets the QR code work the instant an officer presses Save. See
// events-model.js for the reasoning.
//
// review_policy AND is_published ARE NOT ON THIS SCREEN. Every event this
// screen creates keeps review_policy at its default, manual_review: every
// attendance record is approved by a person (invariant 6), and turning that
// off is not a decision this form offers. is_published keeps its default of
// true.
//
// CREATING IS THREE REQUESTS WITH NO TRANSACTION ACROSS THEM. PostgREST
// cannot wrap an insert into events, event_categories and
// event_evidence_requirements in one transaction, so a failure partway
// through leaves a real, incomplete event behind. save() below is honest
// about that: it says exactly what was written and what was not, and leaves
// the officer on the form, now editing the event that exists, rather than
// bouncing to the list and claiming success.

import { select, insert, patch, remove } from './rest.js';
import { uniqueSlug } from './category-model.js';
import { nextOrder } from './requirement-model.js';
import { encodeQR, qrToSvgElement, qrDrawToCanvas } from './qr.js';
import { createEventDetail } from './event-detail.js';
import {
  EVENT_SORTS,
  EVENT_STATUS_FILTERS,
  EVIDENCE_KINDS,
  categoryTabs,
  defaultPromptFor,
  defaultCloseTime,
  duplicateDraft,
  filterEvents,
  sortEvents,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  eventStatus,
  parseCredit,
  validateCategoryRows,
  diffCategoryRows,
  diffEvidenceRow,
  buildCheckinUrl,
  qrFileName,
} from './events-model.js';
import { $, h, announce, setHidden, shortDate, plural } from './ui.js';

const EVENT_SELECT = [
  'id,title,occurred_on,location,term_id,checkin_token,checkin_closes_at',
  'event_categories(category_id,credit_mode,fixed_credit,categories(id,name))',
  'event_evidence_requirements(id,kind,is_required,prompt)',
].join(',');

const NOT_CHANGED = 'Nothing was changed. Reload the page.';

// Thrown when a write comes back refused. PostgREST answers a write the
// policy turns down with HTTP 200 and an empty array rather than an error, so
// every insert here counts the rows it got back: a screen that does not is
// free to report a category link, or a photo requirement, that the event does
// not actually have.
const NOT_WRITTEN = 'The change was refused. Reload the page and try again.';

let rowKeySeq = 0;
const rowKey = () => {
  rowKeySeq += 1;
  return `row-${rowKeySeq}`;
};

export function createEvents(ctx) {
  const el = {
    toolbar: $('events-toolbar'),
    count: $('events-count'),
    newButton: $('event-new'),
    search: $('events-search'),
    status: $('events-status'),
    sort: $('events-sort'),
    tabs: $('event-category-tabs'),
    loading: $('loading-events'),
    empty: $('empty-events'),
    emptyTitle: $('empty-events-title'),
    emptyBody: $('empty-events-body'),
    list: $('event-list'),
    detailView: $('event-detail-view'),

    formView: $('event-form-view'),
    form: $('event-form'),
    formTitle: $('event-form-title'),
    error: $('event-error'),
    cancel: $('event-cancel'),
    save: $('event-save'),

    title: $('event-title'),
    date: $('event-date'),
    closes: $('event-closes'),
    noClose: $('event-no-close'),
    location: $('event-location'),
    termField: $('event-term-field'),
    term: $('event-term'),

    categories: $('event-categories'),
    categoryAdd: $('event-category-add'),

    evidenceRequired: $('event-evidence-required'),
    evidenceFields: $('event-evidence-fields'),
    evidenceKind: $('event-evidence-kind'),
    evidencePrompt: $('event-evidence-prompt'),

    newCategoryDialog: $('event-new-category-dialog'),
    newCategoryForm: $('event-new-category-form'),
    newCategoryName: $('event-new-category-name'),
    newCategoryError: $('event-new-category-error'),

    qrDialog: $('qr-dialog'),
    qrTitle: $('qr-title'),
    qrMeta: $('qr-meta'),
    qrImage: $('qr-image'),
    qrUrl: $('qr-url'),
    qrCopy: $('qr-copy'),
    qrCopyStatus: $('qr-copy-status'),
    qrDownload: $('qr-download'),
    qrPreview: $('qr-preview'),
  };

  const state = {
    events: [],
    categories: [],
    terms: [],
    loaded: false,
    busy: false,

    view: 'list', // 'list' | 'detail' | 'form'
    // The year the screen on display was built for. A load that comes back
    // for a different one is a year change, not a refresh, and everything
    // open has to close. Null until the first load, so opening the screen is
    // never mistaken for a change.
    viewYearId: null,
    // Bumped by every load(). A response whose token is no longer current is
    // dropped rather than written to state: the detail screen's afterChange
    // fires a quiet reload for the year it is on, and the year selector fires
    // a loud one for the year just picked, and those two can land in either
    // order. Without this, the slower older one wins and the list ends up
    // showing one year's events under the other year's selector.
    loadToken: 0,
    // The three list controls. Held here rather than read off the DOM so that
    // a reload after a save lands on the same tab, search and order the
    // officer was looking at rather than resetting the screen under them.
    tab: 'all',
    query: '',
    status: 'all',
    sort: 'date_desc',
    editingEvent: null, // the row being edited, or the row Save just created
    formReturn: 'list', // where Cancel and Save go back to: 'list' or 'detail'
    // Set only by Duplicate: the fields a new event opens with, copied from
    // an existing one. Cleared the moment the form reads it, so the next New
    // event is blank.
    draft: null,
    categoryRows: [], // [{ key, category_id, credit_mode, fixed_credit }]
    evidence: null, // { kind, prompt } or null for "not required"
    closesAutoLinked: true, // whether the close time still tracks the date field
    // What is actually written, once a create has partially landed: used so
    // a retry diffs against what exists rather than trying to insert twice.
    existingCategoryLinks: [],
    existingEvidence: null,
  };

  const activeCategories = () => state.categories.filter((row) => !row.archived_at);

  // One event's own screen. It owns the attendee list and every write against
  // attendance_records; what it borrows from here is the four things that are
  // this screen's to decide: the form, the QR code, the preview and the copy.
  const detail = createEventDetail(ctx, {
    openForm: (event) => openForm(event),
    openQr: (event) => openQr(event),
    previewCheckin: (event) => previewCheckin(event),
    duplicate: (event) => duplicate(event),
    backToList: () => showList(),
    // An approve, a decline, a removal or an added member all move the counts
    // on the row behind this screen, and the review queue's badge with them.
    afterChange: async () => {
      await load({ quiet: true });
      ctx.onEventsChanged?.();
    },
  });

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * @param {{quiet?: boolean}} options quiet re-reads without putting the
   *   loading state up, for a refresh that happens underneath a screen the
   *   officer is still working on.
   */
  async function load({ quiet = false } = {}) {
    state.loadToken += 1;
    const token = state.loadToken;
    // The year this request is FOR, captured now. ctx.year is the shell's
    // live value and may have moved on by the time the response lands.
    const yearId = ctx.year.id;

    // The loading state belongs to the list. Putting it up over the form or
    // an open event replaces what the officer is working on with a spinner.
    if (!quiet && state.view === 'list') {
      setHidden(el.loading, false);
      setHidden(el.empty, true);
      setHidden(el.list, true);
    }
    try {
      const [events, categories, terms] = await Promise.all([
        select('events', {
          select: EVENT_SELECT,
          filters: { academic_year_id: `eq.${ctx.year.id}` },
          order: 'occurred_on.desc',
        }),
        select('categories', { select: 'id,slug,name,sort_order,archived_at', order: 'sort_order.asc' }),
        select('terms', {
          select: 'id,label',
          filters: { academic_year_id: `eq.${ctx.year.id}` },
          order: 'starts_on.asc',
        }),
      ]);

      const counts = await loadCounts(events.map((row) => row.id));

      // Superseded while it was in flight. Nothing is written and nothing is
      // drawn: a later load is already on its way or already landed, and the
      // rows in hand may be from a year nobody is looking at any more.
      if (token !== state.loadToken) return;

      state.events = events.map((row) => ({ ...row, counts: counts.get(row.id) ?? { approved: 0, pending: 0 } }));
      state.categories = categories;
      state.terms = terms;
      state.loaded = true;

      // THE YEAR SELECTOR IS GLOBAL, AND THIS SCREEN IS NOT EXEMPT FROM IT.
      // An open event belongs to the year it was opened in, and so does a
      // half-filled form: saving one after the switch would write the event
      // into the year the officer is no longer looking at, because
      // academic_year_id is read at Save and not at New. So both close, and
      // the officer lands on the list for the year they just picked.
      // The backstop. yearChanged() above already took the screen down when
      // the officer used the selector; this catches a year that moved by any
      // other route, and a load that raced one. The note is not repeated here:
      // the caller that knows a form was open is the one that says so.
      const movedYear = state.viewYearId !== null && state.viewYearId !== yearId;
      state.viewYearId = yearId;
      if (movedYear && state.view !== 'list') {
        detail.dismiss();
        hideForm();
        state.view = 'list';
      }

      setHidden(el.loading, true);
      paint();
    } catch (err) {
      if (token !== state.loadToken) return;
      setHidden(el.loading, true);
      ctx.fail(err, () => load());
    }
  }

  /**
   * Redraw whatever is on screen, without changing which of the three states
   * that is.
   *
   * load() is called after a save, after an approve on the detail screen, and
   * whenever the year changes, and only the last of those means "go back to
   * the list". A load that called showList() unconditionally used to close
   * the event an officer was working through the moment they approved
   * somebody on it.
   */
  function paint() {
    if (state.view === 'list') showList();
    // The detail screen and the form each own the screen while they are up,
    // and each one decides for itself when it is finished with it.
  }

  /** One follow-up read for every event's counts, never one request per row. */
  async function loadCounts(eventIds) {
    const counts = new Map();
    if (!eventIds.length) return counts;

    const records = await select('attendance_records', {
      select: 'event_id,status',
      filters: { event_id: `in.(${eventIds.join(',')})`, status: `in.(approved,pending)` },
    });

    for (const record of records) {
      const entry = counts.get(record.event_id) ?? { approved: 0, pending: 0 };
      if (record.status === 'approved') entry.approved += 1;
      else if (record.status === 'pending') entry.pending += 1;
      counts.set(record.event_id, entry);
    }
    return counts;
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  function showList() {
    state.view = 'list';
    setHidden(el.formView, true);
    setHidden(el.toolbar, false);
    setHidden(el.newButton, false);
    setHidden(el.detailView, true);

    renderTabs();

    const shown = sortEvents(
      filterEvents(state.events, { tab: state.tab, query: state.query, status: state.status }),
      state.sort,
    );

    el.count.textContent = shown.length ? plural(shown.length, 'event') : '';

    if (!shown.length) {
      // Two different empty states, because they need two different next
      // steps: an officer with no events at all is being asked to make one,
      // and an officer whose filter matched nothing is being told the filter
      // did that rather than the year being empty.
      const filtered = state.events.length > 0;
      el.emptyTitle.textContent = filtered ? 'No events match' : 'No events yet';
      el.emptyBody.textContent = filtered
        ? 'Clear the search, or pick another tab.'
        : 'Create the first event for this year.';
      setHidden(el.empty, false);
      setHidden(el.list, true);
      return;
    }

    setHidden(el.empty, true);
    setHidden(el.list, false);
    el.list.replaceChildren(...shown.map(renderRow));
  }

  /**
   * The tabs above the list: All, then every category this year's events
   * actually use. A tab whose category disappears from the year (the last
   * event on it was retagged, or deleted) takes the selection back to All
   * rather than leaving the list filtered by something no longer offered.
   */
  function renderTabs() {
    const tabs = categoryTabs(state.events, state.categories);
    if (!tabs.some((tab) => tab.id === state.tab)) state.tab = 'all';

    el.tabs.replaceChildren(
      ...tabs.map((tab) =>
        h(
          'button',
          {
            type: 'button',
            class: 'filter-tab',
            'aria-selected': String(tab.id === state.tab),
            onClick: () => {
              state.tab = tab.id;
              showList();
            },
          },
          tab.name,
          h('span', { class: 'pill', dataset: { zero: String(tab.count === 0) } }, String(tab.count)),
        ),
      ),
    );
    setHidden(el.tabs, tabs.length <= 1);
  }

  function renderRow(event) {
    const status = eventStatus(event.checkin_closes_at);
    const links = event.event_categories ?? [];
    const evidence = event.event_evidence_requirements?.[0] ?? null;

    const chips = h(
      'span',
      { class: 'chip-row' },
      ...(links.length
        ? links.map((link) =>
            h(
              'span',
              { class: 'category-chip' },
              h(
                'span',
                {},
                `${link.categories?.name ?? 'Unknown category'} · ${creditLabel(link)}`,
              ),
            ),
          )
        : [h('span', { class: 'muted small' }, 'No categories')]),
    );

    const actions = h('div', { class: 'rule-actions' });
    actions.append(
      h(
        'button',
        {
          type: 'button',
          class: 'button button-small',
          'aria-label': `QR code for ${event.title}`,
          onClick: () => openQr(event),
        },
        'QR',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'button button-small',
          'aria-label': `Edit ${event.title}`,
          onClick: () => openForm(event),
        },
        'Edit',
      ),
    );

    return h(
      'div',
      { class: 'event-row', dataset: { id: event.id } },
      h('span', { class: 'event-date' }, shortDate(event.occurred_on)),
      h(
        'span',
        { class: 'event-title-cell' },
        // The title is the way in. Every other control on the row does one
        // narrow thing (print the code, change the fields); this opens the
        // event itself, which is where the attendees are.
        h(
          'button',
          { type: 'button', class: 'event-open', onClick: () => openDetail(event) },
          event.title,
        ),
        evidence ? h('span', { class: 'muted small' }, 'photo required') : null,
      ),
      chips,
      h(
        'span',
        { class: 'event-counts muted small' },
        `${event.counts.approved} approved · ${event.counts.pending} pending`,
      ),
      h('span', { class: 'event-status', dataset: { status: status.toLowerCase() } }, status),
      actions,
    );
  }

  function creditLabel(link) {
    if (link.credit_mode === 'from_submission') return 'member types the number';
    return String(Number(link.fixed_credit ?? 0));
  }

  // -------------------------------------------------------------------------
  // One event, in full
  // -------------------------------------------------------------------------

  function openDetail(event) {
    state.view = 'detail';
    ctx.clearMessage();
    setHidden(el.formView, true);
    setHidden(el.toolbar, true);
    setHidden(el.tabs, true);
    setHidden(el.list, true);
    setHidden(el.empty, true);
    return detail.open(event);
  }

  /**
   * The check-in page, exactly as it reaches a member's phone.
   *
   * Same URL the QR code encodes, so what is previewed is what is printed:
   * anything else would be a second implementation of the thing this screen
   * exists to hand out. Opened in its own tab rather than in a frame, because
   * the check-in page is a separate document with its own session storage and
   * its own camera prompt, and an officer who checks in from the preview has
   * filed a real check-in, which is worth being obvious about.
   */
  function previewCheckin(event) {
    if (!event) return;
    const url = buildCheckinUrl(window.location.href, event.checkin_token);
    window.open?.(url, '_blank', 'noopener,noreferrer');
  }

  /**
   * The same event again, on today's date. Nothing is written: this opens the
   * New event form filled in, so the copy is created by the ordinary Save
   * path and gets its own check-in token from the database.
   */
  function duplicate(event) {
    state.draft = duplicateDraft(event, todayIsoDate());
    const from = state.view;
    openForm(null);
    // Duplicate is pressed from the event being copied, so Cancel goes back to
    // it: the officer has not finished with it, they were making a second one.
    // Save is different, and stays on the list, because what they now want to
    // see is the copy they just made rather than the original.
    if (from === 'detail') state.formReturn = 'detail';
  }

  // -------------------------------------------------------------------------
  // The form: create and edit share every field below
  // -------------------------------------------------------------------------

  function todayIsoDate() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function openForm(event = null) {
    // Read once and cleared, so Duplicate fills this form in and the next New
    // event opens blank. Ignored entirely when an event is being edited.
    const draft = event ? null : state.draft;
    state.draft = null;

    // Edit pressed on the detail screen goes back to it, not to the list:
    // Cancel should return an officer to where they were, and after a save
    // they are still working through that event's attendees.
    state.formReturn = state.view === 'detail' && event ? 'detail' : 'list';
    state.view = 'form';
    state.editingEvent = event;
    setHidden(el.error, true);
    el.error.textContent = '';

    el.formTitle.textContent = event ? 'Edit event' : 'New event';
    el.title.value = event?.title ?? draft?.title ?? '';
    el.date.value = event?.occurred_on ?? draft?.occurred_on ?? todayIsoDate();
    el.location.value = event?.location ?? draft?.location ?? '';

    state.closesAutoLinked = !event;
    if (event?.checkin_closes_at) {
      el.noClose.checked = false;
      el.closes.value = toDatetimeLocalValue(event.checkin_closes_at);
      el.closes.disabled = false;
    } else if (event) {
      // An existing event with no close time: the officer chose that, so it
      // stays chosen rather than growing a default the moment the form opens.
      el.noClose.checked = true;
      el.closes.value = '';
      el.closes.disabled = true;
    } else {
      el.noClose.checked = false;
      el.closes.value = toDatetimeLocalValue(defaultCloseTime(el.date.value));
      el.closes.disabled = false;
    }

    setHidden(el.termField, state.terms.length === 0);
    el.term.replaceChildren(
      h('option', { value: '' }, 'No term'),
      ...state.terms.map((term) => h('option', { value: term.id }, term.label)),
    );
    el.term.value = event?.term_id ?? draft?.term_id ?? '';

    const links = event?.event_categories ?? draft?.categories ?? [];
    state.categoryRows = links.length
      ? links.map((link) => ({
          key: rowKey(),
          category_id: link.category_id,
          credit_mode: link.credit_mode,
          fixed_credit: link.fixed_credit ?? 1,
        }))
      : [{ key: rowKey(), category_id: '', credit_mode: 'fixed', fixed_credit: 1 }];
    // What is already WRITTEN, which for a duplicate is nothing: the copy is
    // a new event, so every category row on it is an insert.
    state.existingCategoryLinks = event
      ? links.map((link) => ({
          category_id: link.category_id,
          credit_mode: link.credit_mode,
          fixed_credit: link.fixed_credit,
        }))
      : [];

    const evidenceRow = event?.event_evidence_requirements?.[0] ?? null;
    state.evidence = evidenceRow
      ? { kind: evidenceRow.kind, prompt: evidenceRow.prompt }
      : draft?.evidence ?? null;
    state.existingEvidence = evidenceRow ? { id: evidenceRow.id, kind: evidenceRow.kind, prompt: evidenceRow.prompt } : null;

    renderCategoryRows();
    renderEvidenceFields();

    setHidden(el.list, true);
    setHidden(el.empty, true);
    setHidden(el.tabs, true);
    setHidden(el.toolbar, true);
    setHidden(el.detailView, true);
    setHidden(el.formView, false);
    el.title.focus();
  }

  /**
   * Visibility only: hides the form and brings the toolbar back, without
   * touching the list's own contents. Split out from closeForm() so a save
   * can hide the form the instant it starts reloading, rather than leaving
   * it up through the round trip: load() shows its own loading state and
   * then renders the list exactly once, at the end, and a form still on
   * screen underneath that loading state is the overlap this exists to
   * avoid.
   */
  function hideForm() {
    state.editingEvent = null;
    setHidden(el.formView, true);
    // Always the list, whatever the form was opened from: a save reloads, and
    // paint() has to have somewhere to draw. An edit that came from an event's
    // own screen is put back on it by returnAfterSave(), after the reload.
    state.view = 'list';
  }

  /** Cancel: back where the form was opened from, with nothing to reload. */
  function closeForm() {
    const wasOn = state.formReturn === 'detail' ? detail.currentId() : null;
    hideForm();
    const event = wasOn ? state.events.find((row) => row.id === wasOn) : null;
    if (event) openDetail(event);
    else showList();
  }

  /**
   * After a save that reloaded the list: an edit opened from an event's own
   * screen puts the officer back on it, now showing what they just saved.
   */
  function returnAfterSave() {
    if (state.formReturn !== 'detail') return;
    const event = state.events.find((row) => row.id === detail.currentId());
    if (event) openDetail(event);
  }

  // -- categories -------------------------------------------------------

  function renderCategoryRows() {
    el.categories.replaceChildren(...state.categoryRows.map(renderCategoryRow));
  }

  function renderCategoryRow(row) {
    const usedElsewhere = new Set(
      state.categoryRows.filter((other) => other.key !== row.key).map((other) => other.category_id),
    );
    const available = activeCategories().filter(
      (category) => category.id === row.category_id || !usedElsewhere.has(category.id),
    );

    const categoryPicker = h(
      'select',
      {
        class: 'select',
        'aria-label': 'Category',
        onChange: (event) => {
          const value = event.target.value;
          if (value === 'new') {
            event.target.value = row.category_id ?? '';
            newCategory(row);
            return;
          }
          row.category_id = value;
        },
      },
      h('option', { value: '' }, 'Choose a category'),
      ...available.map((category) => h('option', { value: category.id, selected: category.id === row.category_id }, category.name)),
      h('option', { value: 'new' }, 'New event category…'),
    );

    const creditInput = h('input', {
      class: 'input event-credit',
      type: 'number',
      min: '0',
      step: '0.5',
      value: String(Number(row.fixed_credit ?? 1)),
      disabled: row.credit_mode === 'from_submission',
      'aria-label': 'Credit',
      onInput: (event) => {
        // Kept as the raw string, not coerced here. An emptied box used to
        // become 0, which is a real credit value the database accepts
        // happily, so clearing the field awarded nobody anything and said
        // nothing about it. Validation at Save is what turns this into a
        // number, and refuses when it is not one.
        row.fixed_credit = event.target.value;
      },
    });

    // At most one row on the event may read the number off the submission
    // (the database's one_submitted_value_per_event index, see
    // events-model.js). validateCategoryRows() still refuses this at Save as
    // the backstop, but a checkbox another row already holds is disabled
    // here, so the constraint is visible on the row an officer would tick
    // rather than punitive after the fact.
    const anotherRowHasSubmission = state.categoryRows.some(
      (other) => other.key !== row.key && other.credit_mode === 'from_submission',
    );

    const submissionToggle = h('label', { class: 'event-checkbox event-checkbox-inline' },
      h('input', {
        type: 'checkbox',
        checked: row.credit_mode === 'from_submission',
        disabled: anotherRowHasSubmission,
        onChange: (event) => {
          row.credit_mode = event.target.checked ? 'from_submission' : 'fixed';
          renderCategoryRows();
        },
      }),
      'Member types the number',
    );

    const removeButton = h(
      'button',
      {
        type: 'button',
        class: 'button button-small button-danger',
        'aria-label': 'Remove category',
        onClick: () => {
          state.categoryRows = state.categoryRows.filter((other) => other.key !== row.key);
          if (!state.categoryRows.length) {
            state.categoryRows.push({ key: rowKey(), category_id: '', credit_mode: 'fixed', fixed_credit: 1 });
          }
          renderCategoryRows();
        },
      },
      'Remove',
    );

    return h(
      'div',
      { class: 'event-category-row' },
      categoryPicker,
      creditInput,
      submissionToggle,
      removeButton,
    );
  }

  async function newCategory(row) {
    const made = await askForCategory();
    if (!made) return;

    let category = null;
    try {
      const rows = await insert('categories', [
        {
          slug: uniqueSlug(made.name, state.categories.map((c) => c.slug)),
          name: made.name,
          sort_order: nextOrder(state.categories),
        },
      ]);
      category = rows?.[0];
      if (!category) throw new Error('nothing came back');
    } catch (err) {
      ctx.fail(err, null);
      return;
    }

    state.categories.push(category);
    ctx.onCategoriesChanged?.();
    if (row) row.category_id = category.id;
    renderCategoryRows();
    const said = `${category.name} added.`;
    ctx.note(said);
    announce(said);
  }

  function askForCategory() {
    el.newCategoryName.value = '';
    setHidden(el.newCategoryError, true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        el.newCategoryForm.removeEventListener('submit', onSubmit);
        el.newCategoryDialog.removeEventListener('close', onClose);
        resolve(value);
      };
      const onSubmit = (event) => {
        const name = el.newCategoryName.value.trim();
        if (!name) {
          event.preventDefault();
          setHidden(el.newCategoryError, false);
          el.newCategoryName.focus();
          return;
        }
        el.newCategoryDialog.close();
        finish({ name });
      };
      const onClose = () => finish(null);

      el.newCategoryForm.addEventListener('submit', onSubmit);
      el.newCategoryDialog.addEventListener('close', onClose, { once: true });
      el.newCategoryDialog.showModal();
      el.newCategoryName.focus();
    });
  }

  function addCategoryRow() {
    state.categoryRows.push({ key: rowKey(), category_id: '', credit_mode: 'fixed', fixed_credit: 1 });
    renderCategoryRows();
  }

  // -- photo requirement --------------------------------------------------

  function renderEvidenceFields() {
    el.evidenceRequired.checked = Boolean(state.evidence);
    setHidden(el.evidenceFields, !state.evidence);
    el.evidenceKind.value = state.evidence?.kind ?? EVIDENCE_KINDS[0].value;
    el.evidencePrompt.value = state.evidence?.prompt ?? '';
    el.evidencePrompt.placeholder = defaultPromptFor(el.evidenceKind.value);
  }

  function onEvidenceRequiredChange() {
    state.evidence = el.evidenceRequired.checked
      ? { kind: el.evidenceKind.value || EVIDENCE_KINDS[0].value, prompt: el.evidencePrompt.value.trim() || null }
      : null;
    renderEvidenceFields();
  }

  function onEvidenceKindChange() {
    if (!state.evidence) return;
    state.evidence.kind = el.evidenceKind.value;
    el.evidencePrompt.placeholder = defaultPromptFor(state.evidence.kind);
  }

  function onEvidencePromptChange() {
    if (!state.evidence) return;
    state.evidence.prompt = el.evidencePrompt.value.trim() || null;
  }

  // -------------------------------------------------------------------------
  // Close time and date wiring
  // -------------------------------------------------------------------------

  function onDateChange() {
    if (state.closesAutoLinked && !el.noClose.checked) {
      el.closes.value = toDatetimeLocalValue(defaultCloseTime(el.date.value));
    }
  }

  function onClosesInput() {
    state.closesAutoLinked = false;
  }

  function onNoCloseChange() {
    el.closes.disabled = el.noClose.checked;
    if (el.noClose.checked) {
      el.closes.value = '';
    } else if (state.closesAutoLinked) {
      el.closes.value = toDatetimeLocalValue(defaultCloseTime(el.date.value));
    }
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  function setBusy(on) {
    state.busy = on;
    el.save.disabled = on;
    el.cancel.disabled = on;
  }

  function fieldsFromForm() {
    return {
      title: el.title.value.trim(),
      occurred_on: el.date.value,
      location: el.location.value.trim() || null,
      term_id: el.term.value || null,
      checkin_closes_at: el.noClose.checked ? null : fromDatetimeLocalValue(el.closes.value),
    };
  }

  function showFormError(message) {
    el.error.textContent = message;
    setHidden(el.error, false);
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (state.busy) return;

    const fields = fieldsFromForm();
    if (!fields.title) {
      showFormError('Type a title.');
      el.title.focus();
      return;
    }
    if (!fields.occurred_on) {
      showFormError('Pick a date.');
      el.date.focus();
      return;
    }

    // A picker left on "Choose a category" is simply not counted, the same
    // as if that row had been removed: an event is allowed to carry no
    // categories yet (v_config_warnings flags that on the dashboard, this
    // screen does not block it).
    const desiredCategories = state.categoryRows
      .filter((row) => row.category_id)
      .map((row) => ({
        category_id: row.category_id,
        credit_mode: row.credit_mode,
        fixed_credit: row.credit_mode === 'from_submission' ? 1 : parseCredit(row.fixed_credit),
      }));
    const categoryError = validateCategoryRows(desiredCategories);
    if (categoryError) {
      showFormError(categoryError);
      return;
    }

    setHidden(el.error, true);
    ctx.clearMessage();
    setBusy(true);

    if (state.editingEvent) {
      await saveEdit(fields, desiredCategories);
    } else {
      await saveCreate(fields, desiredCategories);
    }

    setBusy(false);
  }

  async function saveCreate(fields, desiredCategories) {
    let created;
    try {
      // attempts: 1 turns OFF the transport retry every other call in this
      // codebase wants. A create carries no idempotency key, so a request
      // that Postgres COMMITTED and whose response was then lost would be
      // sent again and make a SECOND event, with its own id and its own
      // check-in token, published and missing its categories. An officer
      // pressing Save again after a visible failure is a decision; a retry
      // they never saw is not, and duplicate events are not something this
      // screen offers any way to clean up.
      const rows = await insert(
        'events',
        [{ ...fields, academic_year_id: ctx.year.id }],
        { attempts: 1 },
      );
      created = rows?.[0];
      if (!created) throw new Error('nothing came back');
    } catch (err) {
      ctx.fail(err, () => onSubmit({ preventDefault() {} }));
      return;
    }

    // From here the event exists. Anything that fails below is reported
    // honestly, and the form stays open, now editing this event, so retrying
    // does not attempt to create a second one.
    state.editingEvent = created;
    state.existingCategoryLinks = [];
    state.existingEvidence = null;

    if (desiredCategories.length) {
      try {
        const rows = await insert(
          'event_categories',
          desiredCategories.map((row) => ({ event_id: created.id, ...row })),
        );
        // PostgREST answers a refused write with 200 and an empty array.
        // Reading that as success reports categories the event does not have.
        if (rows.length !== desiredCategories.length) throw new Error(NOT_WRITTEN);
        state.existingCategoryLinks = rows.map((row) => ({
          category_id: row.category_id,
          credit_mode: row.credit_mode,
          fixed_credit: row.fixed_credit,
        }));
      } catch (err) {
        ctx.fail(err, null);
        showFormError(`${fields.title} was created. Categories were not saved. Try Save again.`);
        return;
      }
    }

    if (state.evidence) {
      try {
        const rows = await insert('event_evidence_requirements', [
          { event_id: created.id, kind: state.evidence.kind, is_required: true, prompt: state.evidence.prompt },
        ]);
        const row = rows?.[0];
        if (!row) throw new Error(NOT_WRITTEN);
        state.existingEvidence = { id: row.id, kind: row.kind, prompt: row.prompt };
      } catch (err) {
        ctx.fail(err, null);
        showFormError(`${fields.title} was created. The photo requirement was not saved. Try Save again.`);
        return;
      }
    }

    const said = `${fields.title} created.`;
    ctx.note(said);
    announce(said);
    hideForm();
    await load();
    ctx.onEventsChanged?.();
  }

  async function saveEdit(fields, desiredCategories) {
    const eventId = state.editingEvent.id;
    try {
      const rows = await patch('events', { id: `eq.${eventId}` }, fields);
      if (!rows.length) {
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
    } catch (err) {
      ctx.fail(err, null);
      return;
    }

    const { toInsert, toUpdate, toRemove } = diffCategoryRows(state.existingCategoryLinks, desiredCategories);
    try {
      if (toRemove.length) {
        const ids = toRemove.map((row) => row.category_id);
        const removed = await remove('event_categories', {
          event_id: `eq.${eventId}`,
          category_id: `in.(${ids.join(',')})`,
        });
        if (!removed.length) {
          ctx.note(NOT_CHANGED, 'warn');
          return;
        }
      }
      for (const row of toUpdate) {
        const updated = await patch(
          'event_categories',
          { event_id: `eq.${eventId}`, category_id: `eq.${row.category_id}` },
          { credit_mode: row.credit_mode, fixed_credit: row.fixed_credit },
        );
        if (!updated.length) {
          ctx.note(NOT_CHANGED, 'warn');
          return;
        }
      }
      if (toInsert.length) {
        const added = await insert(
          'event_categories',
          toInsert.map((row) => ({ event_id: eventId, ...row })),
        );
        if (added.length !== toInsert.length) throw new Error(NOT_WRITTEN);
      }
    } catch (err) {
      ctx.fail(err, null);
      // What is on screen no longer describes what is stored, and the next
      // Save would diff against a picture that includes links this one did
      // not write. Re-read rather than guess.
      await load();
      return;
    }
    state.existingCategoryLinks = desiredCategories;

    const desiredEvidence = state.evidence
      ? { kind: state.evidence.kind, prompt: state.evidence.prompt, is_required: true }
      : null;
    const evidenceDiff = diffEvidenceRow(state.existingEvidence, desiredEvidence);
    try {
      if (evidenceDiff.action === 'insert') {
        const rows = await insert('event_evidence_requirements', [{ event_id: eventId, ...evidenceDiff.payload }]);
        const row = rows?.[0];
        if (!row) throw new Error(NOT_WRITTEN);
        state.existingEvidence = { id: row.id, kind: row.kind, prompt: row.prompt };
      } else if (evidenceDiff.action === 'patch') {
        const rows = await patch(
          'event_evidence_requirements',
          { id: `eq.${evidenceDiff.id}` },
          evidenceDiff.payload,
        );
        if (!rows.length) {
          ctx.note(NOT_CHANGED, 'warn');
          return;
        }
        state.existingEvidence = { id: rows[0].id, kind: rows[0].kind, prompt: rows[0].prompt };
      } else if (evidenceDiff.action === 'remove') {
        const rows = await remove('event_evidence_requirements', { id: `eq.${evidenceDiff.id}` });
        if (!rows.length) {
          ctx.note(NOT_CHANGED, 'warn');
          return;
        }
        state.existingEvidence = null;
      }
    } catch (err) {
      ctx.fail(err, null);
      return;
    }

    const said = `${fields.title} saved.`;
    ctx.note(said);
    announce(said);
    hideForm();
    await load();
    ctx.onEventsChanged?.();
    returnAfterSave();
  }

  // -------------------------------------------------------------------------
  // The QR dialog
  // -------------------------------------------------------------------------

  function openQr(event) {
    const url = buildCheckinUrl(window.location.href, event.checkin_token);
    const qr = encodeQR(url);

    el.qrTitle.textContent = event.title;
    el.qrMeta.textContent = shortDate(event.occurred_on);
    el.qrImage.replaceChildren(qrToSvgElement(qr, { pixelSize: 240 }));
    el.qrUrl.textContent = url;
    el.qrCopyStatus.textContent = '';

    el.qrDownload.onclick = () => downloadQr(qr, event);
    el.qrCopy.onclick = () => copyLink(url);
    el.qrPreview.onclick = () => previewCheckin(event);

    el.qrDialog.showModal();
  }

  function downloadQr(qr, event) {
    const canvas = document.createElement('canvas');
    qrDrawToCanvas(qr, canvas, { pixelSize: 512 });
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = qrFileName(event.title, event.occurred_on);
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function copyLink(url) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        copyLinkFallback(url);
      }
      el.qrCopyStatus.textContent = 'Copied.';
    } catch {
      try {
        copyLinkFallback(url);
        el.qrCopyStatus.textContent = 'Copied.';
      } catch {
        el.qrCopyStatus.textContent = 'Could not copy. Select the link instead.';
      }
    }
  }

  function copyLinkFallback(url) {
    const input = document.createElement('textarea');
    input.value = url;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    if (!ok) throw new Error('execCommand copy refused');
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wire() {
    el.newButton.addEventListener('click', () => openForm(null));
    el.cancel.addEventListener('click', closeForm);

    el.search.addEventListener('input', () => {
      state.query = el.search.value;
      showList();
    });
    el.status.replaceChildren(
      ...EVENT_STATUS_FILTERS.map((option) => h('option', { value: option.value }, option.label)),
    );
    el.status.value = state.status;
    el.status.addEventListener('change', () => {
      state.status = el.status.value;
      showList();
    });
    el.sort.replaceChildren(
      ...EVENT_SORTS.map((option) => h('option', { value: option.value }, option.label)),
    );
    el.sort.value = state.sort;
    el.sort.addEventListener('change', () => {
      state.sort = el.sort.value;
      showList();
    });

    el.form.addEventListener('submit', onSubmit);
    el.categoryAdd.addEventListener('click', addCategoryRow);
    el.date.addEventListener('change', onDateChange);
    el.closes.addEventListener('input', onClosesInput);
    el.noClose.addEventListener('change', onNoCloseChange);
    el.evidenceRequired.addEventListener('change', onEvidenceRequiredChange);
    el.evidenceKind.addEventListener('change', onEvidenceKindChange);
    el.evidencePrompt.addEventListener('input', onEvidencePromptChange);

    el.newCategoryDialog.querySelector('[data-close]')?.addEventListener('click', () => el.newCategoryDialog.close());
    el.qrDialog.querySelector('[data-close]')?.addEventListener('click', () => el.qrDialog.close());
  }

  /**
   * The year in the top bar just changed.
   *
   * Called BEFORE the reload, and synchronously, which is the whole point. The
   * post-load check below is still there as a backstop, but it lands only when
   * the requests come back: on a slow connection that leaves the old event, or
   * a filled-in form, on screen and pressable under a selector that already
   * names the new year, and a Save in that gap writes the event into the new
   * year with the old year's fields. If the load fails outright, the backstop
   * never runs at all.
   *
   * So the screen is taken down the moment the officer picks a year, and the
   * reload paints the list for the year they picked.
   */
  function yearChanged() {
    const wasEditing = state.view === 'form';
    detail.dismiss();
    hideForm();
    state.view = 'list';
    // Nothing on screen belongs to the new year yet, so the list is emptied
    // rather than left showing the old year's rows while the read is in
    // flight. showList() is what fills it, once load() lands.
    state.events = [];
    setHidden(el.list, true);
    setHidden(el.empty, true);
    setHidden(el.detailView, true);
    setHidden(el.toolbar, false);
    if (wasEditing) ctx.note('Not saved. The year changed.', 'warn');
  }

  return {
    mount() {
      wire();
      detail.mount();
      return load();
    },
    reload: () => load(),
    yearChanged,
    hasLoaded: () => state.loaded,
  };
}
