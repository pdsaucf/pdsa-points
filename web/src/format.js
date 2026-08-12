// Small formatting helpers. Nothing here decides anything, it only labels.

/**
 * `occurred_on` is a date column, so it arrives as 'YYYY-MM-DD' with no zone.
 * Parsing it with `new Date(string)` would read it as UTC midnight and show the
 * previous day to anybody west of Greenwich, which is everybody at this club.
 */
export function formatEventDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(isoDate);
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** 'Check-in closes at 9:00 PM', from a timestamptz. */
export function formatCloseTime(isoTimestamp) {
  if (!isoTimestamp) return '';
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** 'Thanks, Abigail.' Display names are 'First Last', so the first word is the name. */
export function firstName(displayName) {
  const trimmed = String(displayName ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.includes(',')) {
    // 'Catto, Abigail' sorts that way in some rosters.
    const after = trimmed.split(',')[1]?.trim();
    if (after) return after.split(/\s+/)[0];
  }
  return trimmed.split(/\s+/)[0];
}

/**
 * The number field label, built from whatever the event actually collects.
 * Nothing here knows the word "hours": `collect_value` carries the category
 * name and the unit label, and a Volunteering event is the only reason those
 * currently say "hour".
 *
 * `unit_label` is singular in the schema ('hour'), and the field asks for a
 * quantity, so it is pluralised for the label. A label that already ends in an
 * "s" is left alone.
 */
export function pluralUnit(unitLabel) {
  const label = String(unitLabel ?? '').trim();
  if (!label) return '';
  return /s$/i.test(label) ? label : `${label}s`;
}

export function valueFieldLabel(collectValue) {
  if (!collectValue) return '';
  const unit = pluralUnit(collectValue.unit_label);
  const category = String(collectValue.category ?? '').trim();
  if (unit && category) return `${category} ${unit}`;
  if (unit) return unit.charAt(0).toUpperCase() + unit.slice(1);
  return category || 'Amount';
}

/** '184 KB', for the photo status line. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Default prompts, for an event that requires a photo but names no prompt. */
const PROMPT_BY_KIND = {
  shirt_photo: 'Photo of you in your PDSA shirt',
  receipt_photo: 'Photo of your receipt',
  other_photo: 'Photo for this event',
};

export function evidencePrompt(requirement) {
  const prompt = String(requirement?.prompt ?? '').trim();
  if (prompt) return prompt;
  return PROMPT_BY_KIND[requirement?.kind] ?? 'Photo for this event';
}
