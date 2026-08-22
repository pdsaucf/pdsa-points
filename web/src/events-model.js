// What an event is, with no DOM in it: the credit-row rule, the check-in
// window default, the diffing an edit does against what is already written,
// and the URL a QR code encodes. Same split as category-model.js and
// requirement-model.js: the panel module (events.js) renders, this decides.
//
// CHECK-IN OPENS THE MOMENT AN EVENT EXISTS. checkin_opens_at is never
// written by this screen, so it stays NULL, and NULL reads as "open" (see
// eventStatus below): the QR code works as soon as it is printed. There is no
// opens field anywhere in the form.
//
// AT MOST ONE CATEGORY ROW MAY BE "MEMBER TYPES THE NUMBER" PER EVENT. The
// database enforces this with the one_submitted_value_per_event unique index
// (docs/01-data-model.md section 4), which means a second one, once written,
// is refused rather than merely wrong. validateCategoryRows() catches it
// before any request goes out, because a rejected write after the officer
// has already pressed Save is a worse failure than not offering the choice.

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EVIDENCE_KINDS = [
  { value: 'shirt_photo', label: 'Member shirt' },
  { value: 'receipt_photo', label: 'Receipt' },
  { value: 'other_photo', label: 'Other' },
];

const DEFAULT_PROMPT = {
  shirt_photo: 'Photo of you in your PDSA shirt',
  receipt_photo: 'Photo of your receipt',
  other_photo: 'A photo',
};

/** What a member would see by default, for the prompt field's placeholder. */
export function defaultPromptFor(kind) {
  return DEFAULT_PROMPT[kind] ?? DEFAULT_PROMPT.other_photo;
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/**
 * `occurred_on` ('YYYY-MM-DD') at 11:59 PM local time, as the ISO string
 * checkin_closes_at is written as. Parsed and built by parts, never by
 * `new Date(string)`: a bare date string reads as UTC midnight, which is the
 * previous evening for everybody west of Greenwich.
 */
export function defaultCloseTime(occurredOn) {
  const [y, m, d] = String(occurredOn ?? '')
    .slice(0, 10)
    .split('-')
    .map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 0, 0).toISOString();
}

/** An ISO timestamp, as the value a `datetime-local` input holds. */
export function toDatetimeLocalValue(isoTimestamp) {
  if (!isoTimestamp) return '';
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` input's value, as the ISO string the database wants. */
export function fromDatetimeLocalValue(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * "Open" when check-in has no closing time or it has not passed yet,
 * "Closed" otherwise. checkin_opens_at is never set by this screen (see the
 * file header), so it never enters this decision.
 */
export function eventStatus(checkinClosesAt, now = new Date()) {
  if (!checkinClosesAt) return 'Open';
  const closes = new Date(checkinClosesAt);
  if (Number.isNaN(closes.getTime())) return 'Open';
  return closes.getTime() > now.getTime() ? 'Open' : 'Closed';
}

// ---------------------------------------------------------------------------
// Category rows: what an event counts toward
// ---------------------------------------------------------------------------

/**
 * At most one row may read the number off the submission. Checked before any
 * request goes out: the database's one_submitted_value_per_event index would
 * refuse a second one anyway, and a refusal after Save is a worse failure
 * than the choice not being offered.
 *
 * @param {Array<{category_id: string, credit_mode: 'fixed'|'from_submission'}>} rows
 * @returns {string|null} an error to show, or null when the rows are fine
 */
/**
 * The credit box, as the number that reaches the database.
 *
 * It arrives as whatever is in the input, which is a string and may be empty.
 * An empty box previously became 0, and 0 is a credit value the database
 * accepts without complaint, so clearing the field awarded every attendee of
 * that event nothing at all and nothing on screen said so. NaN is returned
 * for anything that is not a number, and validateCategoryRows() refuses it
 * before any request goes out.
 *
 * A NEGATIVE NUMBER IS DELIBERATELY ALLOWED. event_categories.fixed_credit
 * carries a comment in migration 05 saying so: it is how an officer records a
 * correction without deleting history. Only blank and non-numeric are wrong.
 */
export function parseCredit(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  return Number(text);
}

export function validateCategoryRows(rows) {
  const submitted = (rows ?? []).filter((row) => row.credit_mode === 'from_submission');
  if (submitted.length > 1) {
    return 'Only one category can ask the member to type the number.';
  }
  const withCategory = (rows ?? []).filter((row) => row.category_id);
  const missing = (rows ?? []).some((row) => !row.category_id);
  if (missing) return 'Pick a category for every row, or remove it.';

  // A blank or non-numeric credit box. Caught here rather than coerced,
  // because every coercion of it lands on a number the database will store
  // and members will be scored against.
  const badCredit = (rows ?? []).some(
    (row) => row.credit_mode !== 'from_submission' && !Number.isFinite(row.fixed_credit),
  );
  if (badCredit) return 'Type a credit for every category.';
  const seen = new Set();
  for (const row of withCategory) {
    if (seen.has(row.category_id)) return 'The same category is on this event twice.';
    seen.add(row.category_id);
  }
  return null;
}

/**
 * What editing has to write to event_categories: rows that are new, rows
 * whose credit changed, and links that came off the list entirely.
 *
 * Compared by category_id, since that is the table's identity for this
 * event; sort order is not part of it because event_categories carries none.
 *
 * @param {Array<{category_id: string, credit_mode: string, fixed_credit: number|null}>} existing
 * @param {Array<{category_id: string, credit_mode: string, fixed_credit: number|null}>} desired
 */
export function diffCategoryRows(existing, desired) {
  const existingById = new Map((existing ?? []).map((row) => [row.category_id, row]));
  const desiredById = new Map((desired ?? []).map((row) => [row.category_id, row]));

  const toInsert = [];
  const toUpdate = [];
  const toRemove = [];

  for (const [categoryId, row] of desiredById) {
    const before = existingById.get(categoryId);
    if (!before) {
      toInsert.push(row);
      continue;
    }
    const creditChanged =
      before.credit_mode !== row.credit_mode ||
      Number(before.fixed_credit ?? 0) !== Number(row.fixed_credit ?? 0);
    if (creditChanged) toUpdate.push(row);
  }

  for (const [categoryId, row] of existingById) {
    if (!desiredById.has(categoryId)) toRemove.push(row);
  }

  return { toInsert, toUpdate, toRemove };
}

// ---------------------------------------------------------------------------
// The one evidence requirement
// ---------------------------------------------------------------------------

/**
 * What editing has to write to event_evidence_requirements: an event carries
 * at most one row (invariant: "Require a photo" is a single on/off, one
 * kind, no optional third state).
 *
 * @param {{id: string, kind: string, prompt: string|null}|null} existing
 * @param {{kind: string, prompt: string|null}|null} desired null means "not required"
 * @returns {{action: 'none'|'insert'|'patch'|'remove', payload: object|null, id: string|null}}
 */
export function diffEvidenceRow(existing, desired) {
  if (!existing && !desired) return { action: 'none', payload: null, id: null };
  if (!existing && desired) return { action: 'insert', payload: desired, id: null };
  if (existing && !desired) return { action: 'remove', payload: null, id: existing.id };

  const changed = existing.kind !== desired.kind || (existing.prompt ?? null) !== (desired.prompt ?? null);
  if (!changed) return { action: 'none', payload: null, id: existing.id };
  return { action: 'patch', payload: desired, id: existing.id };
}

// ---------------------------------------------------------------------------
// The QR code's payload
// ---------------------------------------------------------------------------

/**
 * The check-in URL for one event, built from the admin page's own location
 * so it resolves correctly whether this is production or the mock: '../c/'
 * relative to wherever /admin/ is actually being served from, with the
 * event's token as the ?e= parameter the check-in page reads
 * (web/src/checkin.js).
 */
export function buildCheckinUrl(currentHref, checkinToken) {
  const url = new URL('../c/', currentHref);
  url.searchParams.set('e', checkinToken);
  return url.toString();
}

/** 'soap-carving-2026-03-05.png', for the QR download's filename. */
export function qrFileName(title, occurredOn) {
  const slug =
    String(title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'event';
  const date = String(occurredOn ?? '').slice(0, 10) || 'undated';
  return `${slug}-${date}.png`;
}

// ---------------------------------------------------------------------------
// The list: category tabs, search, status, sort
// ---------------------------------------------------------------------------
//
// All of it is client side and deliberately so. The whole year is at most a
// few hundred events, they are already loaded for the list, and a round trip
// per keystroke would make the search worse rather than better. Nothing here
// re-reads the server, so a filter can never disagree with the row under it.

/** The tab for events that carry no category at all. Not a category id. */
export const NO_CATEGORY_TAB = 'none';

export const EVENT_SORTS = [
  { value: 'date_desc', label: 'Newest first' },
  { value: 'date_asc', label: 'Oldest first' },
  { value: 'title', label: 'Title' },
  { value: 'attendance', label: 'Most check-ins' },
];

export const EVENT_STATUS_FILTERS = [
  { value: 'all', label: 'Any status' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'pending', label: 'Waiting on review' },
];

/** The category ids one event counts toward. */
const categoryIdsOf = (event) =>
  (event.event_categories ?? []).map((link) => link.category_id).filter(Boolean);

/**
 * The tabs above the list: All, then every category some event this year
 * actually uses, then "No category" when at least one event has none.
 *
 * Driven by the events on screen rather than by the category table, because a
 * tab for a category nothing is filed under filters to an empty list and
 * teaches the officer nothing. Retired categories therefore still get a tab
 * while last year's events point at them, which is invariant 4 working as
 * intended: the history goes on resolving.
 *
 * @param {Array} events the year's events, with event_categories embedded
 * @param {Array<{id: string, name: string, sort_order: number}>} categories
 * @returns {Array<{id: string, name: string, count: number}>}
 */
export function categoryTabs(events, categories) {
  const counts = new Map();
  let uncategorised = 0;

  for (const event of events ?? []) {
    const ids = categoryIdsOf(event);
    if (!ids.length) {
      uncategorised += 1;
      continue;
    }
    for (const id of new Set(ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const order = new Map((categories ?? []).map((row, index) => [row.id, index]));
  const named = [...counts.entries()]
    .map(([id, count]) => ({
      id,
      name: (categories ?? []).find((row) => row.id === id)?.name ?? 'Unknown category',
      count,
    }))
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));

  const tabs = [{ id: 'all', name: 'All', count: (events ?? []).length }, ...named];
  if (uncategorised) tabs.push({ id: NO_CATEGORY_TAB, name: 'No category', count: uncategorised });
  return tabs;
}

/**
 * The list, narrowed by the tab, the search box and the status picker. Every
 * one of the three is applied, so a search inside a category stays inside it.
 *
 * @param {Array} events
 * @param {{tab?: string, query?: string, status?: string}} filters
 * @param {Date} now what "Open" is measured against
 */
export function filterEvents(events, { tab = 'all', query = '', status = 'all' } = {}, now = new Date()) {
  const needle = String(query ?? '').trim().toLowerCase();

  return (events ?? []).filter((event) => {
    if (tab === NO_CATEGORY_TAB) {
      if (categoryIdsOf(event).length) return false;
    } else if (tab !== 'all') {
      if (!categoryIdsOf(event).includes(tab)) return false;
    }

    if (needle) {
      const haystack = `${event.title ?? ''} ${event.location ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (status === 'open' && eventStatus(event.checkin_closes_at, now) !== 'Open') return false;
    if (status === 'closed' && eventStatus(event.checkin_closes_at, now) !== 'Closed') return false;
    if (status === 'pending' && !(event.counts?.pending > 0)) return false;

    return true;
  });
}

/**
 * A copy of the list in the chosen order. Never sorts in place: the caller's
 * array is the year as loaded, and the order on screen is a view of it.
 */
export function sortEvents(events, sort = 'date_desc') {
  const rows = [...(events ?? [])];
  const byDate = (a, b) => String(a.occurred_on ?? '').localeCompare(String(b.occurred_on ?? ''));

  switch (sort) {
    case 'date_asc':
      return rows.sort(byDate);
    case 'title':
      return rows.sort(
        (a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')) || byDate(a, b),
      );
    case 'attendance': {
      // Approved plus waiting, not approved alone: an event whose queue has
      // not been worked yet is the busiest event there is, and an order that
      // sorted it to the bottom would hide exactly the one an officer is
      // looking for.
      const live = (row) => Number(row.counts?.approved ?? 0) + Number(row.counts?.pending ?? 0);
      return rows.sort((a, b) => live(b) - live(a) || byDate(b, a));
    }
    default:
      return rows.sort((a, b) => byDate(b, a));
  }
}

// ---------------------------------------------------------------------------
// One event: who came, and what the numbers say
// ---------------------------------------------------------------------------
//
// WHAT IS COUNTED HERE, AND WHAT IS NOT. These are counts of rows on one
// event: approved, waiting, declined, where each came from, and when the
// first and last check-in arrived. They are not point totals and not the
// honorary verdict, which are the database's answers (invariant 2) and are
// read from v_member_status wherever they appear. Nothing below sums a
// credit, and nothing below decides whether anybody passed anything.

export const ATTENDANCE_SOURCES = [
  { value: 'self_checkin', label: 'Scanned' },
  { value: 'officer_entry', label: 'Added by an officer' },
  { value: 'import', label: 'Imported' },
  { value: 'member_request', label: 'Member portal' },
];

export const ATTENDANCE_STATUS = {
  approved: 'Approved',
  pending: 'Waiting',
  rejected: 'Declined',
};

/**
 * @param {Array<{status: string, source: string, member_id: string|null,
 *   submitted_at: string|null}>} records every record on the event, any status
 */
export function eventStats(records) {
  const rows = records ?? [];
  const sources = new Map();
  let approved = 0;
  let pending = 0;
  let declined = 0;
  let unmatched = 0;
  let firstAt = null;
  let lastAt = null;

  for (const row of rows) {
    if (row.status === 'approved') approved += 1;
    else if (row.status === 'pending') pending += 1;
    else if (row.status === 'rejected') declined += 1;

    // Counted across every status: a name nobody has matched is work
    // outstanding whether or not it has been declined yet.
    if (!row.member_id) unmatched += 1;

    sources.set(row.source, (sources.get(row.source) ?? 0) + 1);

    const at = row.submitted_at ? new Date(row.submitted_at) : null;
    if (at && !Number.isNaN(at.getTime())) {
      if (!firstAt || at < firstAt) firstAt = at;
      if (!lastAt || at > lastAt) lastAt = at;
    }
  }

  return {
    total: rows.length,
    approved,
    pending,
    declined,
    unmatched,
    sources: ATTENDANCE_SOURCES.filter((source) => sources.has(source.value)).map((source) => ({
      ...source,
      count: sources.get(source.value),
    })),
    firstAt: firstAt ? firstAt.toISOString() : null,
    lastAt: lastAt ? lastAt.toISOString() : null,
  };
}

/** What to call somebody on the attendee list: their name, or what they typed. */
export function attendeeName(record) {
  const known = record?.members?.display_name;
  if (known) return known;
  const claimed = String(record?.claimed_name ?? '').trim();
  return claimed || 'No name';
}

// Waiting first, because those are the rows an officer opened this screen to
// deal with. Declined last, since they are history rather than work.
const STATUS_RANK = { pending: 0, approved: 1, rejected: 2 };

export function sortAttendees(records) {
  return [...(records ?? [])].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
      attendeeName(a).localeCompare(attendeeName(b)),
  );
}

/**
 * Members who may still be added to this event by hand.
 *
 * one_live_record_per_member_event allows exactly one non-declined record per
 * member per event, so anybody already holding one is left off the list
 * rather than offered and then refused. A member whose only record here was
 * declined is offered again, which is the same rule the index states.
 */
export function addableMembers(members, records) {
  const taken = new Set(
    (records ?? [])
      .filter((row) => row.member_id && row.status !== 'rejected')
      .map((row) => row.member_id),
  );
  return (members ?? []).filter((member) => !taken.has(member.id));
}

/**
 * Whether the event itself can be deleted.
 *
 * attendance_records.event_id is `on delete restrict`, so Postgres refuses to
 * drop an event anybody checked in to, including declined check-ins. Asked
 * here so the screen says why rather than offering a button that comes back
 * as a foreign key error.
 */
export function canDeleteEvent(records) {
  return (records ?? []).length === 0;
}

/**
 * The form fields for "Duplicate": the same event on today's date, with its
 * own title, categories and photo requirement, and none of its identity.
 *
 * Nothing is written. This produces what the New event form opens with, so
 * the copy is created by the same Save path as any other event and gets its
 * own check-in token from the database.
 */
export function duplicateDraft(event, today) {
  return {
    title: event?.title ?? '',
    occurred_on: today,
    location: event?.location ?? null,
    term_id: event?.term_id ?? null,
    categories: (event?.event_categories ?? []).map((link) => ({
      category_id: link.category_id,
      credit_mode: link.credit_mode,
      fixed_credit: link.fixed_credit ?? 1,
    })),
    evidence: event?.event_evidence_requirements?.[0]
      ? {
          kind: event.event_evidence_requirements[0].kind,
          prompt: event.event_evidence_requirements[0].prompt ?? null,
        }
      : null,
  };
}

/**
 * The attendee list as CSV rows, header included, in the order it is on
 * screen. The point of the export is a file somebody can hand to a chapter
 * advisor or paste into last year's spreadsheet, so it carries the words the
 * screen carries and not the enum values underneath them.
 *
 * `Value` is filled only for an event that asks the member to type a number.
 *
 * @param {Array} records already sorted, as sortAttendees() leaves them
 * @param {{typed?: boolean}} options whether the event collects a number
 */
export function attendeeCsvRows(records, { typed = false } = {}) {
  const header = ['Name', 'Status', 'Source', 'Checked in', ...(typed ? ['Value'] : []), 'Note'];
  const label = Object.fromEntries(ATTENDANCE_SOURCES.map((row) => [row.value, row.label]));

  const rows = (records ?? []).map((record) => [
    attendeeName(record),
    ATTENDANCE_STATUS[record.status] ?? record.status,
    label[record.source] ?? record.source,
    record.submitted_at ?? '',
    ...(typed ? [record.submitted_value ?? ''] : []),
    record.review_note ?? '',
  ]);

  return [header, ...rows];
}

/** 'soap-carving-2026-03-05-attendance.csv'. */
export function attendeeCsvFilename(title, occurredOn) {
  return qrFileName(title, occurredOn).replace(/\.png$/, '-attendance.csv');
}

/** Whether this event asks the member to type a number at check-in. */
export function collectsTypedValue(event) {
  return (event?.event_categories ?? []).some((link) => link.credit_mode === 'from_submission');
}

/** The category whose number the member types, for the label on the box. */
export function typedValueCategory(event) {
  const link = (event?.event_categories ?? []).find((row) => row.credit_mode === 'from_submission');
  return link?.categories?.name ?? null;
}
