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
// review_policy IS NOT ON THIS SCREEN. Every event this screen creates keeps
// review_policy at its default, manual_review: every attendance record is
// approved by a person (invariant 6), and turning that off is not a decision
// this form offers.
//
// is_published IS NOT ON THIS FORM EITHER, on purpose. A new event now
// defaults to queued (docs/05-events-page.md), and publishing is a separate
// action, Publish/Unpublish, on the list card and on the detail toolbar,
// wired to set_event_published() rather than saved through this form's
// save_event_config() call. The other way an event becomes visible needs no
// button at all: every Monday at 8:00 AM America/New_York, a queued event
// dated within the next 14 days drops on its own, gated by the
// events_auto_publish row this screen also reads and writes above the list.
// Both routes land on the same is_visible computed column, which is what the
// dashed-versus-solid card border and the release_at line below are drawn
// from.
//
// Event fields, category links and the photo requirement are saved by one RPC.
// They commit together because changing a category link immediately changes
// the derived points for approved attendance.

import { select, insert, remove, patch, callRpc } from './rest.js';
import { eventsStartupOptions } from './events-contract.js';
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
  eventPublishStatus,
  filterEvents,
  sortEvents,
  todayDividerIndex,
  todayInNewYork,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  toNewYorkDatetimeLocalValue,
  fromNewYorkDatetimeLocalValue,
  eventStatus,
  parseCredit,
  validateCategoryRows,
  buildCheckinUrl,
  qrFileName,
  releasesAfterEvent,
  releaseAtLabel,
} from './events-model.js';
import { $, h, chevron, announce, setHidden, shortDate, plural } from './ui.js';


// Thrown when a write comes back refused. PostgREST answers a write the
// policy turns down with HTTP 200 and an empty array rather than an error, so
// every insert here counts the rows it got back: a screen that does not is
// free to report a category link, or a photo requirement, that the event does
// not actually have.

let rowKeySeq = 0;
const rowKey = () => {
  rowKeySeq += 1;
  return `row-${rowKeySeq}`;
};

// Past events: rows drawn on first open, then added a page at a time.
const PAST_FIRST = 5;
const PAST_STEP = 10;

export function createEvents(ctx) {
  const el = {
    toolbar: $('events-toolbar'),
    count: $('events-count'),
    newButton: $('event-new'),
    search: $('events-search'),
    status: $('events-status'),
    sort: $('events-sort'),
    tabs: $('event-category-tabs'),
    autoPublishToggle: $('events-auto-publish-toggle'),
    autoPublishNote: $('events-auto-publish-note'),
    loading: $('loading-events'),
    empty: $('empty-events'),
    emptyTitle: $('empty-events-title'),
    emptyBody: $('empty-events-body'),
    list: $('event-list'),
    detailView: $('event-detail-view'),
    detailBack: $('event-detail-back'),

    formView: $('event-form-view'),
    form: $('event-form'),
    formTitle: $('event-form-title'),
    error: $('event-error'),
    cancel: $('event-cancel'),
    save: $('event-save'),

    title: $('event-title'),
    date: $('event-date'),
    starts: $('event-starts'),
    ends: $('event-ends'),
    closes: $('event-closes'),
    noClose: $('event-no-close'),
    termField: $('event-term-field'),
    term: $('event-term'),

    location: $('event-location'),
    attire: $('event-attire'),
    signup: $('event-signup'),
    description: $('event-description'),

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

    publishAfterDialog: $('event-publish-after-dialog'),
    publishAfterForm: $('event-publish-after-form'),
    publishAfterMeta: $('event-publish-after-meta'),
  };

  const state = {
    events: [],
    categories: [],
    categoryLoad: 'loading', // 'loading' | 'ready' | 'error'
    categoryError: null,
    terms: [],
    termLoad: 'loading', // 'loading' | 'ready' | 'error'
    termError: null,
    // The global toggle above the list (app_settings.events_auto_publish).
    // Read alongside the events themselves, because a queued card's status
    // text depends on it: with the drop off, a card must not promise a date
    // that is never coming.
    autoPublishEnabled: true,
    autoPublishBusy: false,
    // The one card whose Publish/Unpublish button is mid-request, so its
    // button (and no other) disables while the write is in flight.
    publishBusyId: null,
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
    sort: 'date_asc',
    pastExpanded: false,
    // How many past events, counted back from today, have rows in the DOM.
    pastRevealed: PAST_FIRST,
    editingEvent: null, // the row being edited, or the row Save just created
    formReturn: 'list', // where Cancel and Save go back to: 'list' or 'detail'
    // Set only by Duplicate: the fields a new event opens with, copied from
    // an existing one. Cleared the moment the form reads it, so the next New
    // event is blank.
    draft: null,
    categoryRows: [], // [{ key, category_id, credit_mode, fixed_credit }]
    evidence: null, // { kind, prompt } or null for "not required"
    closesAutoLinked: true, // whether the close time still tracks the date field
    saveEventId: null, // stable across a failed create, so retry cannot duplicate it
    // Only a deliberate trip from a card into its detail gets a return
    // target. Quiet reloads repaint the list too, but must not move focus.
    detailOriginEventId: null,
    detailReturnReviewEventId: null,
  };

  function syncFormAvailability() {
    const unavailable = state.categoryLoad !== 'ready' || state.termLoad !== 'ready';
    el.newButton.disabled = unavailable;
    el.categoryAdd.disabled = unavailable;
    let label = '';
    if (state.categoryLoad === 'loading') label = 'Categories loading';
    else if (state.categoryLoad === 'error') label = 'Categories unavailable';
    else if (state.termLoad === 'loading') label = 'Terms loading';
    else if (state.termLoad === 'error') label = 'Terms unavailable';
    el.newButton.title = unavailable ? label : '';
    el.categoryAdd.title = unavailable ? label : '';
  }

  // One event's own screen. It owns the attendee list and every write against
  // attendance_records; what it borrows from here is the four things that are
  // this screen's to decide: the form, the QR code, the preview and the copy.
  const detail = createEventDetail(ctx, {
    openForm: (event) => openForm(event),
    openQr: (event) => openQr(event),
    previewCheckin: (event) => previewCheckin(event),
    duplicate: (event) => duplicate(event),
    // Read live rather than captured once: the officer can flip the toggle
    // above the list while an event's own screen is open behind it.
    autoPublishEnabled: () => state.autoPublishEnabled,
    backToList: () => {
      const reviewEventId = state.detailReturnReviewEventId;
      state.detailReturnReviewEventId = null;
      if (reviewEventId) {
        detail.dismiss();
        showList();
        ctx.openReview?.(reviewEventId);
        return;
      }
      showList({ restoreDetailFocus: true });
    },
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
    state.categoryLoad = 'loading';
    state.categoryError = null;
    state.termLoad = 'loading';
    state.termError = null;
    syncFormAvailability();

    // The loading state belongs to the list. Putting it up over the form or
    // an open event replaces what the officer is working on with a spinner.
    if (!quiet && state.view === 'list') {
      setHidden(el.loading, false);
      setHidden(el.empty, true);
      setHidden(el.list, true);
    }
    try {
      const categoriesRequest = select('categories', {
        select: 'id,slug,name,sort_order,archived_at',
        order: 'sort_order.asc',
      }).then(
        (categories) => {
          if (token === state.loadToken) {
            state.categories = categories;
            state.categoryLoad = 'ready';
            syncFormAvailability();
          }
          return categories;
        },
        (err) => {
          if (token === state.loadToken) {
            state.categories = [];
            state.categoryLoad = 'error';
            state.categoryError = err;
            syncFormAvailability();
          }
          throw err;
        },
      );
      const termsRequest = select('terms', {
        select: 'id,label',
        filters: { academic_year_id: `eq.${ctx.year.id}` },
        order: 'starts_on.asc',
      }).then(
        (terms) => {
          if (token === state.loadToken) {
            state.terms = terms;
            state.termLoad = 'ready';
            syncFormAvailability();
          }
          return terms;
        },
        (err) => {
          if (token === state.loadToken) {
            state.terms = [];
            state.termLoad = 'error';
            state.termError = err;
            syncFormAvailability();
          }
          throw err;
        },
      );
      const settingsRequest = select('app_settings', {
        select: 'value',
        filters: { key: 'eq.events_auto_publish' },
        limit: 1,
      }).then(
        (rows) => {
          if (token === state.loadToken) {
            // fn_setting_bool()'s own default (migration 29): the toggle
            // reads as on when nobody has ever written the row.
            state.autoPublishEnabled = rows?.[0] ? Boolean(rows[0].value) : true;
          }
        },
        () => {
          // The list still has to draw without this. Falling back to the
          // server's own default is closer to the truth than refusing the
          // whole screen over one settings row.
          if (token === state.loadToken) state.autoPublishEnabled = true;
        },
      );

      const [eventsResult, categoriesResult, termsResult] = await Promise.allSettled([
        select('events', eventsStartupOptions(ctx.year.id)),
        categoriesRequest,
        termsRequest,
        settingsRequest,
      ]);

      // Superseded while it was in flight. Nothing is written and nothing is
      // drawn: a later load is already on its way or already landed, and the
      // rows in hand may be from a year nobody is looking at any more.
      if (token !== state.loadToken) return;

      let eventsError = eventsResult.status === 'rejected' ? eventsResult.reason : null;
      if (!eventsError) {
        try {
          const events = eventsResult.value;
          const counts = await loadCounts(events.map((row) => row.id));
          if (token !== state.loadToken) return;
          state.events = events.map((row) => ({ ...row, counts: counts.get(row.id) ?? { approved: 0, pending: 0 } }));
        } catch (err) {
          eventsError = err;
        }
      }
      if (token !== state.loadToken) return;

      const startupError = eventsError ?? state.categoryError ?? state.termError;
      state.loaded = !startupError;

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
      if (movedYear) resetPast();
      if (movedYear && state.view !== 'list') {
        detail.dismiss();
        hideForm();
        state.view = 'list';
      }

      setHidden(el.loading, true);
      renderAutoPublishToggle();
      if (!eventsError) paint();
      if (startupError) {
        ctx.fail(startupError, () => load());
        return;
      }
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
  // The global auto-publish toggle
  // -------------------------------------------------------------------------
  // One row above the list, not a per-event checkbox: docs/05-events-page.md
  // says the Monday drop cannot be exempted per event, because an exemptible
  // fairness rule is not one. This is the only place events_auto_publish is
  // read or written.

  function renderAutoPublishToggle() {
    if (!el.autoPublishToggle) return;
    el.autoPublishToggle.checked = state.autoPublishEnabled;
    el.autoPublishToggle.disabled = state.autoPublishBusy;
    // The checkbox label already says WHAT happens; the note's own fact is
    // WHEN, or, off, that nothing will (CLAUDE.md: never repeat information
    // already visible elsewhere in the same component).
    el.autoPublishNote.textContent = state.autoPublishEnabled
      ? 'Next drop is Monday, 8:00 AM.'
      : 'No automatic drop. Queued events wait for Publish.';
  }

  async function changeAutoPublish(enabled) {
    if (state.autoPublishBusy) return;
    state.autoPublishBusy = true;
    renderAutoPublishToggle();
    try {
      const rows = await patch(
        'app_settings',
        { key: 'eq.events_auto_publish' },
        { value: enabled },
      );
      if (!rows.length) {
        ctx.note('Nothing was changed. Reload the page.', 'warn');
        return;
      }
      state.autoPublishEnabled = enabled;
      const said = enabled ? 'Automatic publishing turned on.' : 'Automatic publishing turned off.';
      ctx.note(said);
      announce(said);
      // Every queued card's status line, and which events count as visible at
      // all, depend on this flag: reload rather than patch the list in place.
      await load();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.autoPublishBusy = false;
      renderAutoPublishToggle();
    }
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  function showList({ restoreDetailFocus = false } = {}) {
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
      if (restoreDetailFocus) state.detailOriginEventId = null;
      return;
    }

    setHidden(el.empty, true);
    setHidden(el.list, false);
    const today = todayInNewYork(ctx.now?.() ?? new Date());
    const groupPast = state.tab === 'all' && state.status === 'all'
      && !state.query.trim() && state.sort === 'date_asc';
    const past = groupPast ? shown.filter((event) => event.occurred_on < today) : [];
    const previousToggle = el.list.querySelector('.event-past-toggle');
    const restoreDisclosureFocus = previousToggle && document.activeElement === previousToggle;
    if (restoreDetailFocus && past.some((event) => event.id === state.detailOriginEventId)) {
      state.pastExpanded = true;
      // The row the officer came back from must exist to take focus.
      const fromEnd = past.length - past.findIndex((event) => event.id === state.detailOriginEventId);
      state.pastRevealed = Math.max(state.pastRevealed, fromEnd);
    }
    const dividerIndex = todayDividerIndex(shown, state.sort, today);
    const children = [];
    if (past.length) children.push(renderPastEvents(past));
    shown.forEach((event, index) => {
      if (index === dividerIndex) children.push(renderTodayDivider());
      if (groupPast && event.occurred_on < today) return;
      children.push(renderRow(event));
    });
    el.list.replaceChildren(...children);
    if (restoreDisclosureFocus) el.list.querySelector('.event-past-toggle')?.focus();

    if (restoreDetailFocus) {
      const originId = state.detailOriginEventId;
      state.detailOriginEventId = null;
      if (!originId) return;
      el.list
        .querySelector(`[data-id="${CSS.escape(String(originId))}"]`)
        ?.querySelector('.event-view')
        ?.focus();
    }
  }

  function resetPast() {
    state.pastExpanded = false;
    state.pastRevealed = PAST_FIRST;
  }

  // Past rows are built only when the group is open, and only the ones nearest
  // today. Everything older is reached with Show earlier, which sits above
  // the rows so the older ones it adds appear right under it. With a search, a
  // filter or another sort the group is not used at all (see render), so every
  // match is in the list and no cap can hide one.
  function renderPastEvents(events) {
    const rows = h('div', { id: 'events-past-list', class: 'event-list', hidden: !state.pastExpanded });
    const more = h('button', {
      type: 'button',
      class: 'button event-past-more',
      onClick: () => {
        state.pastRevealed += PAST_STEP;
        fill();
      },
    }, 'Show earlier');
    function fill() {
      const shownCount = state.pastExpanded ? Math.min(state.pastRevealed, events.length) : 0;
      rows.replaceChildren(...events.slice(events.length - shownCount).map(renderRow));
      const remaining = state.pastExpanded && shownCount < events.length;
      const hadFocus = document.activeElement === more;
      setHidden(more, !remaining);
      if (hadFocus && !remaining) toggle.focus();
    }
    const arrow = chevron('down');
    arrow.setAttribute('class', 'event-past-chevron');
    arrow.setAttribute('width', '20');
    arrow.setAttribute('height', '20');
    const toggle = h('button', {
      type: 'button',
      class: 'event-past-toggle',
      'aria-label': `Past events (${events.length})`,
      'aria-expanded': String(state.pastExpanded),
      'aria-controls': 'events-past-list',
      onClick: () => {
        state.pastExpanded = !state.pastExpanded;
        toggle.setAttribute('aria-expanded', String(state.pastExpanded));
        setHidden(rows, !state.pastExpanded);
        fill();
      },
    }, h('span', { class: 'event-past-label' },
      'Past events', h('span', { class: 'pill' }, String(events.length))), arrow);
    fill();
    return h('div', { class: 'event-past-group' }, toggle, more, rows);
  }

  function renderTodayDivider() {
    return h(
      'div',
      { class: 'event-today-divider', role: 'separator', 'aria-label': 'Today' },
      h('span', { class: 'event-today-label' }, 'Today'),
      h('span', { class: 'event-today-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'event-today-line', 'aria-hidden': 'true' }),
    );
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
                `${link.categories?.name ?? 'Unknown category'}, ${creditLabel(link)}`,
              ),
            ),
          )
        : [h('span', { class: 'muted small' }, 'No categories')]),
    );

    // No injected clock, deliberately: release_at is an absolute instant the
    // server already computed from real wall time, and eventStatus() above
    // makes the same choice for checkin_closes_at rather than threading
    // ctx.now() through it.
    const publish = eventPublishStatus(event, state.autoPublishEnabled);
    // Not visible: Publish always offers to force it early. Visible: offered
    // only when it would actually take effect (see eventPublishStatus's own
    // comment) so the button is never a no-op dressed as a control.
    const publishButton = !publish.visible
      ? publishToggleButton(event, true, 'Publish')
      : publish.canUnpublish
        ? publishToggleButton(event, false, 'Unpublish')
        : null;

    // h()'s own children handling drops a null entry (publishButton is null
    // exactly when neither Publish nor Unpublish should be offered);
    // Node.append() does not; it stringifies null into a literal text node.
    // So this passes the buttons AS h()'s children, not through a follow-up
    // .append() call the way this used to read.
    const actions = h(
      'div',
      { class: 'event-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'button button-small button-primary event-view',
          'aria-label': `View event: ${event.title}`,
          onClick: () => openDetail(event, { rememberOrigin: true }),
        },
        'View event',
      ),
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
      publishButton,
    );

    return h(
      'div',
      { class: 'event-row', dataset: { id: event.id, visible: String(publish.visible) } },
      h('span', { class: 'event-date' }, shortDate(event.occurred_on)),
      h(
        'span',
        { class: 'event-title-cell' },
        h('h3', { class: 'event-title' }, event.title),
        evidence ? h('span', { class: 'muted small' }, 'photo required') : null,
      ),
      chips,
      h(
        'span',
        { class: 'event-counts muted small' },
        `${event.counts.approved} approved, ${event.counts.pending} waiting`,
      ),
      h(
        'span',
        {
          class: 'event-checkin-status',
          dataset: { status: status.toLowerCase() },
        },
        h('span', { class: 'event-status-dot', 'aria-hidden': 'true' }),
        `Check-in ${status.toLowerCase()}`,
      ),
      h(
        'span',
        {
          class: 'event-publish-status',
          dataset: { visible: String(publish.visible), warn: String(publish.warn) },
        },
        publish.label,
        publish.detail ? h('span', { class: 'event-publish-detail' }, publish.detail) : null,
      ),
      actions,
    );
  }

  function publishToggleButton(event, nextPublished, label) {
    return h(
      'button',
      {
        type: 'button',
        class: 'button button-small',
        disabled: state.publishBusyId === event.id,
        'aria-label': `${label} ${event.title}`,
        onClick: () => toggleRowPublish(event, nextPublished),
      },
      label,
    );
  }

  /** Publish or unpublish straight from the list card, no need to open the event. */
  async function toggleRowPublish(event, nextPublished) {
    if (state.publishBusyId) return;
    state.publishBusyId = event.id;
    showList();
    ctx.clearMessage();
    try {
      await callRpc('set_event_published', { p_event_id: event.id, p_published: nextPublished });
      const said = nextPublished ? `${event.title} published.` : `${event.title} unpublished.`;
      ctx.note(said);
      announce(said);
      await load({ quiet: true });
      ctx.onEventsChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.publishBusyId = null;
      if (state.view === 'list') showList();
    }
  }

  function creditLabel(link) {
    if (link.credit_mode === 'from_submission') return 'member types the number';
    return String(Number(link.fixed_credit ?? 0));
  }

  // -------------------------------------------------------------------------
  // One event, in full
  // -------------------------------------------------------------------------

  function openDetail(
    event,
    { rememberOrigin = false, returnToReviewEventId = null } = {},
  ) {
    if (rememberOrigin) state.detailOriginEventId = event.id;
    state.detailReturnReviewEventId = returnToReviewEventId;
    state.view = 'detail';
    ctx.clearMessage();
    setHidden(el.formView, true);
    setHidden(el.toolbar, true);
    setHidden(el.tabs, true);
    setHidden(el.list, true);
    setHidden(el.empty, true);
    const opened = detail.open(event);
    if (rememberOrigin) el.detailBack.focus();
    return opened;
  }

  async function open(eventId, { returnToReview = false } = {}) {
    let event = state.events.find((row) => row.id === eventId);
    if (!event) {
      await load();
      event = state.events.find((row) => row.id === eventId);
    }
    if (!event) return false;
    await openDetail(event, { returnToReviewEventId: returnToReview ? event.id : null });
    return true;
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
    if (state.categoryLoad !== 'ready' || state.termLoad !== 'ready') {
      const formError = state.categoryError ?? state.termError;
      if (formError) ctx.fail(formError, () => load());
      return;
    }
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
    state.saveEventId = event?.id ?? crypto.randomUUID();
    setHidden(el.error, true);
    el.error.textContent = '';

    el.formTitle.textContent = event ? 'Edit event' : 'New event';
    el.title.value = event?.title ?? draft?.title ?? '';
    el.date.value = event?.occurred_on ?? draft?.occurred_on ?? todayIsoDate();
    el.starts.value = toNewYorkDatetimeLocalValue(event?.starts_at ?? draft?.starts_at);
    el.ends.value = toNewYorkDatetimeLocalValue(event?.ends_at ?? draft?.ends_at);

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

    el.location.value = event?.location ?? draft?.location ?? '';
    el.attire.value = event?.attire ?? draft?.attire ?? '';
    // Not carried by Duplicate: a sign-up link is almost always specific to
    // one occurrence, and a stale form URL copied onto a new event is worse
    // than an officer having to paste it again.
    el.signup.value = event?.signup ?? '';
    el.description.value = event?.description ?? draft?.description ?? '';

    const links = event?.event_categories ?? draft?.categories ?? [];
    state.categoryRows = links.length
      ? links.map((link) => ({
          key: rowKey(),
          category_id: link.category_id,
          credit_mode: link.credit_mode,
          fixed_credit: link.fixed_credit ?? 1,
        }))
      : [{ key: rowKey(), category_id: '', credit_mode: 'fixed', fixed_credit: 1 }];
    const evidenceRow = event?.event_evidence_requirements?.[0] ?? null;
    state.evidence = evidenceRow
      ? { kind: evidenceRow.kind, prompt: evidenceRow.prompt }
      : draft?.evidence ?? null;

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
    const available = state.categories.filter(
      (category) =>
        (!category.archived_at || category.id === row.category_id) &&
        (category.id === row.category_id || !usedElsewhere.has(category.id)),
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
          renderCategoryRows();
        },
      },
      h('option', { value: '' }, 'Choose a category'),
      ...available.map((category) => h('option', { value: category.id, selected: category.id === row.category_id }, category.name)),
      ctx.isAdmin === false ? null : h('option', { value: 'new' }, 'New event category…'),
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
      starts_at: fromNewYorkDatetimeLocalValue(
        el.starts.value,
        state.editingEvent?.starts_at ?? null,
      ),
      ends_at: fromNewYorkDatetimeLocalValue(
        el.ends.value,
        state.editingEvent?.ends_at ?? null,
      ),
      term_id: el.term.value || null,
      checkin_closes_at: el.noClose.checked ? null : fromDatetimeLocalValue(el.closes.value),
      // save_event_config() blanks these to null itself when the box is
      // empty (nullif(btrim(...), '')), so the trim here only keeps what the
      // form shows in step with what the RPC will actually store.
      location: el.location.value.trim(),
      attire: el.attire.value.trim(),
      signup: el.signup.value.trim(),
      description: el.description.value.trim(),
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
    if (Boolean(el.starts.value) !== Boolean(el.ends.value)) {
      showFormError('Enter both event times, or leave both blank.');
      (el.starts.value ? el.ends : el.starts).focus();
      return;
    }
    if ((el.starts.value && !fields.starts_at) || (el.ends.value && !fields.ends_at)) {
      showFormError('Enter valid Eastern times.');
      return;
    }
    if (fields.starts_at && new Date(fields.ends_at) <= new Date(fields.starts_at)) {
      showFormError('Event end must be after event start.');
      el.ends.focus();
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

    await saveEvent(fields, desiredCategories);

    setBusy(false);
  }

  async function saveEvent(fields, desiredCategories) {
    const wasEdit = Boolean(state.editingEvent);
    const savedYearId = ctx.year.id;
    try {
      await callRpc('save_event_config', {
        p_event_id: state.saveEventId,
        p_academic_year_id: ctx.year.id,
        p_event: fields,
        p_categories: desiredCategories,
        p_evidence: state.evidence
          ? { kind: state.evidence.kind, prompt: state.evidence.prompt }
          : null,
        p_expected_config_version: wasEdit ? state.editingEvent.config_version : null,
        p_create: !wasEdit,
      });
    } catch (err) {
      if (err?.code === 'PDS15') {
        // The form is a stale snapshot. Close it and reload the authoritative
        // event before showing the conflict, so Reload cannot resubmit stale
        // categories or evidence.
        hideForm();
        await load();
      }
      ctx.fail(err, null);
      return;
    }

    const said = wasEdit ? `${fields.title} saved.` : `${fields.title} created.`;
    ctx.note(said);
    announce(said);
    hideForm();
    await load();
    ctx.onEventsChanged?.();
    if (wasEdit) returnAfterSave();
    // If the officer switched the year selector while save_event_config or
    // the load() above was still in flight, a newer load() from
    // yearChanged() can win the race and leave state.events holding a
    // different year's rows by now. Skip the offer rather than search a
    // year that isn't this save's own: today's UUID-keyed .find() would
    // just fail to match and no-op anyway, but this makes that intentional.
    if (ctx.year.id === savedYearId) {
      await maybeOfferImmediatePublish(state.events.find((row) => row.id === state.saveEventId));
    }
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
  // The publish-after-save dialog
  // -------------------------------------------------------------------------

  /**
   * A dialog that answers true when it is submitted and false when it is
   * dismissed. Modeled on requirements.js's decide(): close() fires its event
   * as a queued task, so the cancel path can still run after submit decided.
   */
  function decideDialog(dialog, form) {
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

  /**
   * docs/05-events-page.md: an event created late enough that its Monday
   * release lands after its own date will never auto-publish. Offered right
   * after Save because that is the one moment the officer is already
   * looking at this event; the alternative is hoping they notice the
   * "Publishes after the event" warning on the list later.
   *
   * release_at and is_visible are read off the reloaded row, never
   * recomputed here: the Monday arithmetic lives in Postgres on purpose.
   */
  async function maybeOfferImmediatePublish(event) {
    // Same reasoning as eventPublishStatus() in events-model.js: with the
    // auto-publish toggle off, fn_event_is_visible() never fires from the
    // Monday drop for any event, so there is no drop to promise here either.
    if (!event || event.is_visible || !state.autoPublishEnabled || !releasesAfterEvent(event)) return;
    el.publishAfterMeta.textContent =
      `${shortDate(event.occurred_on)} ${event.title}. Next drop is ${releaseAtLabel(event.release_at)}.`;
    const confirmed = await decideDialog(el.publishAfterDialog, el.publishAfterForm);
    if (!confirmed) return;
    try {
      await callRpc('set_event_published', { p_event_id: event.id, p_published: true });
      const said = `${event.title} published.`;
      ctx.note(said);
      announce(said);
      await load({ quiet: true });
      ctx.onEventsChanged?.();
    } catch (err) {
      ctx.fail(err, null);
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wire() {
    syncFormAvailability();
    el.newButton.addEventListener('click', () => openForm(null));
    el.autoPublishToggle?.addEventListener('change', () => changeAutoPublish(el.autoPublishToggle.checked));
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
    el.publishAfterDialog.querySelector('[data-close]')?.addEventListener('click', () => el.publishAfterDialog.close());
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
    resetPast();
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
      setHidden($('events-auto-publish'), ctx.isAdmin === false);
      wire();
      detail.mount();
      return load();
    },
    reload: () => load(),
    open,
    yearChanged,
    hasLoaded: () => state.loaded,
  };
}
