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
