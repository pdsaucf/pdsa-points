// sync-calendar: keeps the Member Calendar in step with /events.
//
// docs/10-google-calendar.md. pg_cron calls this every five minutes. It asks
// calendar_sync_plan() what is live and what changed, adds, updates and
// removes Google Calendar events to match, and reports how the run went to
// calendar_status, which Settings, Connections shows.
//
// Secret, set once with `supabase secrets set`:
//   GOOGLE_SERVICE_ACCOUNT_JSON   the whole JSON key file of the service account
// Which calendar is NOT a secret: it is google_calendar_id in app_settings,
// changed from Settings, Connections by each new board.
//
// Google event ids are derived from the event id, so a second post of the
// same event updates it instead of duplicating it, and a run that dies
// halfway is finished by the next one.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const KEY_JSON = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? '';
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://points.pdsaucf.com').replace(/\/+$/, '');
const API = 'https://www.googleapis.com/calendar/v3';

type Upsert = {
  event_id: string;
  version: number;
  title: string;
  occurred_on: string;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  attire: string | null;
  description: string | null;
  members_only: boolean;
  signups_enabled: boolean;
};
type Delete = { event_id: string; calendar_id: string };

async function rpc(name: string, args: unknown = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${name} failed: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const report = (status: Record<string, unknown>) =>
  rpc('report_integration_status', { p_key: 'calendar_status', p_status: { ...status, checked_at: new Date().toISOString() } })
    .catch(() => null);

// -- Google sign-in as the service account ----------------------------------

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let text = '';
  for (const byte of raw) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function accessToken(key: { client_email: string; private_key: string }) {
  const pem = key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const signingKey = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(unsigned)),
  );
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${b64url(signature)}`,
    }),
  });
  if (!response.ok) throw new Error('Google refused the service account key');
  return (await response.json()).access_token as string;
}

// -- the calendar event ------------------------------------------------------

/** Google ids allow a to v and 0 to 9: a uuid without dashes qualifies. */
const googleId = (eventId: string) => `pdsa${eventId.replace(/-/g, '')}`;

function nextDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function calendarBody(event: Upsert) {
  const lines: string[] = [];
  if (event.members_only) lines.push('Paid members only');
  if (event.description) lines.push(event.description);
  if (event.attire) lines.push(`Attire: ${event.attire}`);
  const link = `${SITE_URL}/events/#event-${event.event_id}`;
  lines.push(event.signups_enabled ? `Sign up: ${link}` : `Details: ${link}`);
  return {
    id: googleId(event.event_id),
    status: 'confirmed',
    summary: event.members_only ? `${event.title} (Members only)` : event.title,
    location: event.location ?? undefined,
    description: lines.join('\n\n'),
    start: event.starts_at
      ? { dateTime: event.starts_at, timeZone: 'America/New_York' }
      : { date: event.occurred_on },
    end: event.ends_at
      ? { dateTime: event.ends_at, timeZone: 'America/New_York' }
      : { date: nextDay(event.occurred_on) },
  };
}

async function google(token: string, method: string, path: string, body?: unknown) {
  return fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const calendarPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}/events`;

/** Update in place, or create with the derived id. A deleted id is revived. */
async function put(token: string, calendarId: string, event: Upsert) {
  const body = calendarBody(event);
  const path = `${calendarPath(calendarId)}/${body.id}`;
  let response = await google(token, 'PUT', path, body);
  if (response.status === 404) response = await google(token, 'POST', calendarPath(calendarId), body);
  if (!response.ok) throw new Error(`Google refused ${event.title}: ${response.status}`);
}

async function remove(token: string, calendarId: string, eventId: string) {
  const response = await google(token, 'DELETE', `${calendarPath(calendarId)}/${googleId(eventId)}`);
  // Already gone counts as removed.
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`Google refused a removal: ${response.status}`);
  }
}

// -- the run -----------------------------------------------------------------

Deno.serve(async (req) => {
  if (!SERVICE_KEY || req.headers.get('Authorization') !== `Bearer ${SERVICE_KEY}`) {
    return new Response('Forbidden', { status: 403 });
  }

  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(KEY_JSON);
  } catch {
    await report({ ok: false, error: 'No service account key on the server' });
    return Response.json({ error: 'not set up' }, { status: 503 });
  }

  const plan = await rpc('calendar_sync_plan');
  if (!plan.enabled) {
    await report({ ok: true, service_email: key.client_email, enabled: false });
    return Response.json({ enabled: false });
  }

  let token: string;
  try {
    token = await accessToken(key);
  } catch (err) {
    await report({ ok: false, service_email: key.client_email, enabled: true, error: String((err as Error).message) });
    return Response.json({ error: 'sign-in failed' }, { status: 502 });
  }

  // Can the service account see the calendar at all? The most likely mistake
  // is a calendar not shared with it, and that deserves its own message.
  const probe = await google(token, 'GET', `/calendars/${encodeURIComponent(plan.calendar_id)}`);
  if (!probe.ok) {
    await report({
      ok: false,
      service_email: key.client_email,
      enabled: true,
      calendar_id: plan.calendar_id,
      error: probe.status === 404 || probe.status === 403
        ? 'Calendar not found or not shared with the service account'
        : `Google answered ${probe.status}`,
    });
    return Response.json({ error: 'calendar' }, { status: 502 });
  }
  const calendarName = (await probe.json()).summary ?? null;

  let posted = 0;
  let removed = 0;
  const errors: string[] = [];

  for (const item of plan.deletes as Delete[]) {
    try {
      await remove(token, item.calendar_id, item.event_id);
      await rpc('calendar_sync_removed', { p_event_id: item.event_id, p_calendar_id: item.calendar_id });
      removed += 1;
    } catch (err) {
      errors.push(String((err as Error).message));
    }
  }

  for (const item of plan.upserts as Upsert[]) {
    try {
      // Moving from another calendar: calendar_sync_posted() records the
      // removal owed there, and the next run's deletes carry it out.
      // Recorded first, so a run that dies after Google accepts the write
      // still leaves a trace the next plan cleans up.
      await rpc('calendar_sync_intent', { p_event_id: item.event_id, p_calendar_id: plan.calendar_id });
      await put(token, plan.calendar_id, item);
      await rpc('calendar_sync_posted', { p_event_id: item.event_id, p_calendar_id: plan.calendar_id, p_version: item.version });
      posted += 1;
    } catch (err) {
      errors.push(String((err as Error).message));
    }
  }

  await report({
    ok: errors.length === 0,
    service_email: key.client_email,
    enabled: true,
    calendar_id: plan.calendar_id,
    calendar_name: calendarName,
    posted,
    removed,
    error: errors[0] ?? null,
  });
  return Response.json({ posted, removed, errors: errors.length });
});
