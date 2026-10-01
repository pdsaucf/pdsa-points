// The confirmation email an officer writes for an event's sign-ups.
//
// The database fills the placeholders in when the email is actually sent
// (fn_signup_email_render() in migration 30). This file does the same for the
// preview on the event form, and holds the same default wording, so what an
// officer previews is what a member receives. test/event_signups.test.mjs
// checks the defaults and the rendering against the database's.

/* The email is a letter, not UI copy: full sentences are the point. */
export const DEFAULT_SUBJECT = 'Confirm your spot: {event}';
export const DEFAULT_BODY = [
  '{name},',
  '',
  'You signed up for {event} on {date}, {time}, at {location}.', // copy-ok
  '',
  'Confirm by {confirm_by} to keep your spot. Sign-ups not confirmed by then are dropped, and the next person on the waitlist moves up.', // copy-ok
  '',
  'PDSA UCF',
].join('\n');

export const PLACEHOLDERS = [
  { token: '{name}', label: 'Name' },
  { token: '{event}', label: 'Event' },
  { token: '{date}', label: 'Date' },
  { token: '{time}', label: 'Time' },
  { token: '{location}', label: 'Location' },
  { token: '{confirm_by}', label: 'Confirm by' },
];

const NY = 'America/New_York';

/** 'Wednesday, October 7', for occurred_on ('YYYY-MM-DD'), read by parts. */
export function longDate(occurredOn) {
  const [y, m, d] = String(occurredOn ?? '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

const clock = (iso) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: NY });

/** '6:00 PM to 8:00 PM', or 'time TBA'. */
export function timeRange(startsAt, endsAt) {
  if (!startsAt || !endsAt) return 'time TBA';
  return `${clock(startsAt)} to ${clock(endsAt)}`;
}

/** 'Monday, October 5, 6:00 PM' */
export function confirmByLabel(instant) {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: NY });
  return `${day}, ${clock(instant)}`;
}

/**
 * The instant the email goes out: so many days before the event, at the
 * officer's time of day, New York time. Matches fn_signup_email_at().
 *
 * @param {string} occurredOn 'YYYY-MM-DD'
 * @param {number} daysBefore
 * @param {string} time 'HH:MM'
 */
export function emailAt(occurredOn, daysBefore, time) {
  const [y, m, d] = String(occurredOn ?? '').slice(0, 10).split('-').map(Number);
  const [hh, mm] = String(time ?? '18:00').split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh)) return null;
  // The wall-clock reading in New York, turned into an instant by finding
  // the offset New York had at that moment.
  const guess = Date.UTC(y, m - 1, d - Number(daysBefore || 0), hh, mm || 0);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: NY, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return asUtc - ms;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

/**
 * The subject or message with its placeholders filled in.
 *
 * @param {string} template
 * @param {{name: string, event: {title: string, occurred_on: string,
 *   starts_at?: string|null, ends_at?: string|null, location?: string|null},
 *   confirmBy: Date|string}} values
 */
export function renderEmail(template, { name, event, confirmBy }) {
  const values = {
    '{name}': name,
    '{event}': event.title ?? '',
    '{date}': longDate(event.occurred_on),
    '{time}': timeRange(event.starts_at, event.ends_at),
    '{location}': event.location || 'location TBA',
    '{confirm_by}': confirmByLabel(confirmBy),
  };
  return String(template ?? '').replace(/\{(name|event|date|time|location|confirm_by)\}/g, (token) => values[token]);
}
