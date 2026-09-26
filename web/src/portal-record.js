const EASTERN = 'America/New_York';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN,
  month: 'short',
  day: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN,
  hour: 'numeric',
  minute: '2-digit',
});

export const number = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
};

export function eventDate(value) {
  const [year, month, day] = String(value ?? '').slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return String(value ?? '');
  return dateFormatter.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

// The screen already names the academic year, so a row carries month and day.
export function shortEventDate(value) {
  const [year, month, day] = String(value ?? '').slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return String(value ?? '');
  return shortDateFormatter.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function easternTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return timeFormatter.format(date);
}

export function durationMinutes(event) {
  if (!event?.starts_at || !event?.ends_at) return null;
  const start = new Date(event.starts_at).getTime();
  const end = new Date(event.ends_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 60000);
}

export function durationLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'Time not recorded';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} min`;
  if (!remainder) return `${hours} hr`;
  return `${hours} hr ${remainder} min`;
}

export function timeDetails(event) {
  const minutes = durationMinutes(event);
  if (minutes === null) {
    return { recorded: false, range: 'Time not recorded', duration: '' };
  }
  return {
    recorded: true,
    range: `${easternTime(event.starts_at)} to ${easternTime(event.ends_at)}`,
    duration: durationLabel(minutes),
    minutes,
  };
}

export function categoryCredit(category) {
  const credit = category?.credit;
  return credit === null || credit === undefined
    ? String(category?.name ?? '')
    : `${category?.name ?? ''}: ${number(credit)}`;
}

export function approvedRecordSummary(events) {
  const approved = (events ?? []).filter((event) => event.status === 'attended');
  let recordedMinutes = 0;
  let missingTimes = 0;
  for (const event of approved) {
    const minutes = durationMinutes(event);
    if (minutes === null) missingTimes += 1;
    else recordedMinutes += minutes;
  }
  return { approved, recordedMinutes, missingTimes };
}
