// send-signup-emails: the confirmation emails, sent on a five-minute timer.
//
// docs/09-event-signups.md. pg_cron calls this every five minutes (the SQL is
// in that doc). It asks signup_due_emails() for every confirmation now due,
// which hands back each raw token, address, subject and message already
// filled in, and sends each through Resend. One that fails to send goes back
// in the queue through signup_email_failed(). One that sent is acknowledged
// through signup_email_sent(), which is when its confirm window starts; a run
// that dies before acknowledging is reclaimed ten minutes later with the same
// token and the same Resend Idempotency-Key.
//
// Secrets, set with `supabase secrets set`:
//   RESEND_API_KEY      Resend API key
//   SIGNUP_EMAIL_FROM   e.g. "PDSA UCF <events@pdsaucf.com>", a domain verified in Resend
//   SITE_URL            optional, defaults to https://points.pdsaucf.com
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
//
// Only a caller holding a service-role key may run it: the timer passes one
// in Authorization, and nobody else has it. See isServiceRole().

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('SIGNUP_EMAIL_FROM') ?? '';
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://points.pdsaucf.com').replace(/\/+$/, '');

type Due = { signup_id: string; delivery_id: string; token: string; email: string; subject: string; body: string };

const escapeHtml = (value: string) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function rpc(name: string, args: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * 'sent', 'rejected' (Resend said no for good: retry with a fresh token), or
 * 'unknown' (no answer, a 5xx, a rate limit, or a 409 for a key still in
 * flight). An unknown outcome may have been delivered, so the delivery is
 * left alone: its lease runs out and the next run resends the identical
 * email under the identical Idempotency-Key, which Resend sends at most once.
 */
async function send(due: Due): Promise<'sent' | 'rejected' | 'unknown'> {
  const link = `${SITE_URL}/events/?signup=${due.token}`;
  const text = `${due.body}\n\nConfirm your spot: ${link}\nCancel instead: ${link}\n`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2a2721">` +
    `<p style="white-space:pre-wrap;margin:0 0 20px">${escapeHtml(due.body)}</p>` +
    `<p style="margin:0 0 12px"><a href="${link}" style="display:inline-block;padding:12px 22px;` +
    `background:#59328f;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">Confirm spot</a></p>` +
    `<p style="margin:0"><a href="${link}" style="color:#59328f">Cancel sign-up</a></p></div>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // A claim reclaimed after a run died carries the same delivery id and
      // token, so Resend sends it at most once.
      'Idempotency-Key': `signup-${due.delivery_id}`,
    },
    body: JSON.stringify({ from: FROM, to: [due.email], subject: due.subject, text, html }),
  });
  if (response.ok) return 'sent';
  if (response.status === 409 || response.status === 429 || response.status >= 500) return 'unknown';
  return 'rejected';
}

/**
 * Whether the caller holds a service-role key. The platform verifies every
 * key's signature before a request reaches this function (verify_jwt, pinned
 * on for this function in supabase/config.toml), so reading the role claim
 * of a verified key is enough. Comparing the header to
 * SUPABASE_SERVICE_ROLE_KEY byte for byte is not: a project can hold more
 * than one valid service-role key, and the timer sends the one an officer
 * copied from the dashboard.
 */
function isServiceRole(req: Request): boolean {
  const header = req.headers.get('Authorization') ?? '';
  if (SERVICE_KEY && header === `Bearer ${SERVICE_KEY}`) return true;
  const payload = header.replace(/^Bearer\s+/i, '').split('.')[1];
  if (!payload) return false;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return claims?.role === 'service_role';
  } catch {
    return false;
  }
}

// How the last run went, for Settings, Connections. Never the key.
const report = (status: Record<string, unknown>) =>
  rpc('report_integration_status', {
    p_key: 'email_status',
    p_status: { ...status, from: FROM || null, checked_at: new Date().toISOString() },
  }).catch(() => null);

Deno.serve(async (req) => {
  if (!isServiceRole(req)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!SUPABASE_URL || !RESEND_API_KEY || !FROM) {
    await report({ ok: false, error: 'Email sending is not set up on the server' });
    return Response.json({ error: 'Email is not set up' }, { status: 503 });
  }

  const due: Due[] = (await rpc('signup_due_emails', { p_limit: 100 })) ?? [];
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    const outcome = await send(row).catch(() => 'unknown' as const);
    if (outcome === 'sent') {
      sent += 1;
      await rpc('signup_email_sent', { p_signup_id: row.signup_id, p_delivery_id: row.delivery_id }).catch(() => null);
    } else if (outcome === 'rejected') {
      failed += 1;
      await rpc('signup_email_failed', { p_signup_id: row.signup_id }).catch(() => null);
    } else {
      // Left claimed: retried unchanged after the lease, see send().
      failed += 1;
    }
  }
  await report({ ok: failed === 0, sent, failed, error: failed ? `${failed} email(s) not sent, retrying next run` : null });
  return Response.json({ sent, failed });
});
