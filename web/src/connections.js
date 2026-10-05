// Settings, Connections: the Member Calendar and the sign-up emails.
//
// Admin only. Two background jobs run every five minutes on the server
// (sync-calendar and send-signup-emails) and write how their last run went to
// app_settings (calendar_status, email_status). This screen reads those, and
// writes the two calendar settings, google_calendar_id and
// google_calendar_enabled. Nothing secret is read or shown here: the keys live
// on the server, and the only identity shown is the service account's
// address, which is meant to be shared.

import { select, patch } from './rest.js';
import { $, announce, setHidden } from './ui.js';

const KEYS = ['google_calendar_id', 'google_calendar_enabled', 'calendar_status', 'email_status'];

// A status older than this means the job is not running at all.
const STALE_MS = 20 * 60 * 1000;

/**
 * The Calendar ID, from whatever was pasted: the ID itself, or the embed or
 * share URL Google Calendar shows, which carries it as ?src= or ?cid=.
 */
export function calendarIdFrom(text) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const id = url.searchParams.get('src') ?? url.searchParams.get('cid');
    if (id) {
      // cid is base64 in share links.
      if (url.searchParams.get('cid') && !id.includes('@')) {
        try {
          return atob(id);
        } catch {
          return id;
        }
      }
      return id;
    }
  } catch {
    // Not a URL: the ID as typed.
  }
  return value;
}

/** '3 min ago', 'just now', '2 h ago' */
function ago(instant, now = Date.now()) {
  const ms = now - new Date(instant).getTime();
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * One section's state pill and detail line.
 *
 * @returns {{tone: 'ok'|'warn'|'off'|'error', label: string, detail: string}}
 */
export function describeCalendar(settings, now = Date.now()) {
  const status = settings.calendar_status ?? {};
  const enabled = settings.google_calendar_enabled === true;
  const calendarId = settings.google_calendar_id ?? '';
  if (!status.checked_at) {
    return { tone: 'off', label: 'Not set up', detail: 'The server sync has not run yet' };
  }
  const checked = `checked ${ago(status.checked_at, now)}`;
  if (now - new Date(status.checked_at).getTime() > STALE_MS) {
    return { tone: 'error', label: 'Not running', detail: `Last ${checked}` };
  }
  if (!enabled || !calendarId) {
    return { tone: 'off', label: 'Off', detail: `Posting is off, ${checked}` };
  }
  if (!status.ok) {
    return { tone: 'error', label: 'Problem', detail: `${status.error ?? 'The last run failed'}, ${checked}` };
  }
  if (status.calendar_id && status.calendar_id !== calendarId) {
    return { tone: 'warn', label: 'Switching', detail: 'Moves to the new calendar within 5 minutes' };
  }
  const name = status.calendar_name ? `Posting to ${status.calendar_name}` : 'Posting';
  return { tone: 'ok', label: 'Connected', detail: `${name}, ${checked}` };
}

export function describeEmail(settings, now = Date.now()) {
  const status = settings.email_status ?? {};
  if (!status.checked_at) {
    return { tone: 'off', label: 'Not set up', detail: 'The email job has not run yet' };
  }
  const checked = `checked ${ago(status.checked_at, now)}`;
  if (now - new Date(status.checked_at).getTime() > STALE_MS) {
    return { tone: 'error', label: 'Not running', detail: `Last ${checked}` };
  }
  if (!status.ok) {
    return { tone: 'error', label: 'Problem', detail: `${status.error ?? 'The last run failed'}, ${checked}` };
  }
  return { tone: 'ok', label: 'Working', detail: `Sending from ${status.from}, ${checked}` };
}

export function createConnections(ctx) {
  const el = {
    calendarState: $('calendar-state'),
    calendarDetail: $('calendar-detail'),
    form: $('calendar-form'),
    calendarId: $('calendar-id'),
    enabled: $('calendar-enabled'),
    error: $('calendar-error'),
    serviceEmail: $('calendar-service-email'),
    copy: $('calendar-copy'),
    emailState: $('email-state'),
    emailDetail: $('email-detail'),
  };

  let settings = {};
  let busy = false;

  async function load() {
    try {
      const rows = await select('app_settings', {
        select: 'key,value',
        filters: { key: `in.(${KEYS.join(',')})` },
      });
      settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      render();
    } catch (err) {
      ctx.fail(err, () => load());
    }
  }

  function paintState(node, detail, state) {
    node.textContent = state.label;
    node.dataset.tone = state.tone;
    detail.textContent = state.detail;
  }

  function render() {
    paintState(el.calendarState, el.calendarDetail, describeCalendar(settings));
    paintState(el.emailState, el.emailDetail, describeEmail(settings));
    el.calendarId.value = settings.google_calendar_id ?? '';
    el.enabled.checked = settings.google_calendar_enabled === true;
    const address = settings.calendar_status?.service_email ?? '';
    el.serviceEmail.textContent = address || 'Shown after the one-time server setup';
    el.serviceEmail.dataset.empty = String(!address);
    setHidden(el.copy, !address);
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const id = calendarIdFrom(el.calendarId.value);
    if (el.enabled.checked && !id) {
      el.error.textContent = 'Paste the Calendar ID first';
      setHidden(el.error, false);
      el.calendarId.focus();
      return;
    }
    if (id && !id.includes('@')) {
      el.error.textContent = 'A Calendar ID ends in @group.calendar.google.com or an email address';
      setHidden(el.error, false);
      el.calendarId.focus();
      return;
    }
    setHidden(el.error, true);
    busy = true;
    try {
      const [a, b] = await Promise.all([
        patch('app_settings', { key: 'eq.google_calendar_id' }, { value: id }),
        patch('app_settings', { key: 'eq.google_calendar_enabled' }, { value: el.enabled.checked }),
      ]);
      if (!a.length || !b.length) {
        ctx.note('Not saved, reload the page', 'warn');
        return;
      }
      const said = el.enabled.checked ? 'Calendar saved, syncs within 5 minutes' : 'Calendar posting off';
      ctx.note(said);
      announce(said);
      await load();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      busy = false;
    }
  }

  async function copy() {
    const address = settings.calendar_status?.service_email;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      ctx.note('Address copied');
    } catch {
      ctx.note('Select the address and copy it', 'warn');
    }
  }

  return {
    mount() {
      el.form.addEventListener('submit', save);
      el.copy.addEventListener('click', copy);
      el.calendarId.addEventListener('change', () => {
        el.calendarId.value = calendarIdFrom(el.calendarId.value);
      });
      return load();
    },
    reload: load,
  };
}
