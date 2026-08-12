// The whole Supabase client, in about a hundred lines of fetch.
//
// This page calls four RPCs and PUTs one object, so supabase-js would be a
// large download to save a small amount of code, on the one connection in this
// product that is guaranteed to be bad: venue wifi with sixty phones on it.
// The anon key goes in both `apikey` and `Authorization`, which is what
// PostgREST and Storage expect.
//
// Retries live here rather than in the UI, because every caller wants the same
// policy: a request that never got an answer is worth repeating, and so is
// PDS09, which means "too busy, come back" and not "no".
//
// P2 ADDED THREE THINGS AND CHANGED NONE.
//
// The admin review queue is a signed-in surface, so it sends an officer's JWT
// in `Authorization` instead of the anon key, and it reads tables through
// PostgREST rather than calling only RPCs. Both wanted the retry policy above,
// so rather than a second copy of it living in web/src/rest.js:
//
//   * `rpc()` takes an optional `opts.accessToken`
//   * `withRetries`, `requestOnce`, `authHeaders` and `API_BASE` are exported
//
// The check-in page passes no accessToken and imports none of the new exports,
// so every request it makes is byte for byte the request it made before.

import { SUPABASE_URL, SUPABASE_ANON_KEY, EVIDENCE_BUCKET } from '../config.js';
import { RpcError, NetworkError } from './errors.js';

const BASE = SUPABASE_URL.replace(/\/+$/, '');

// Roughly 0.4s, 1.2s, 3s, 6s. Long enough to ride out a lift or a crowded
// access point, short enough that somebody holding a phone does not think it
// has hung.
const TRANSPORT_BACKOFF_MS = [400, 1200, 3000, 6000];

// PDS09 is a different animal and needs a different schedule. The limiter
// counts per calendar minute (date_trunc('minute', now())), so a tripped
// bucket does not ease off gradually: it clears when the minute rolls over.
// Backing off for ten seconds and giving up would fail a member who is inside
// a full window, and the ceilings they can legitimately reach are tight
// (3 unmatched submits per nonce per minute, 6 upload grants, 10 submits). So
// these waits add up to just past a minute, which is the longest a bucket can
// hold anybody.
const RATE_LIMIT_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];

const ATTEMPT_TIMEOUT_MS = 15000;

/**
 * The wait between retries.
 *
 * This is the default, and it is the only one the page ever uses: nothing in
 * `web/c/` or `web/src/checkin.js` passes a `sleep`, so in production every
 * call takes this exact function with no branch anywhere deciding otherwise.
 *
 * The rate-limit ladder adds up to just over a minute, which is correct
 * behaviour and a poor thing to sit through in a test suite, so `withRetries`
 * accepts a replacement. It is an argument rather than a global, an env var or
 * a window property on purpose: there is no ambient switch for a page script
 * to find and nothing a member's browser could set. Reaching it means calling
 * rpc() yourself with your own options object, which needs script running in
 * the page already, and script running in the page can simply call the RPC.
 *
 * Note that this seam covers the backoff only. The per-attempt timeout in
 * attemptSignal() keeps using a real timer either way, so a test with a
 * compressed clock still gives each request its real fifteen seconds.
 */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Full jitter on the low side only: two hundred phones that all failed at the
// same instant should not all retry at the same instant either.
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

/**
 * `apikey` always identifies the project. `Authorization` is what says who is
 * asking: the anon key when nobody is signed in, and an officer's access token
 * when somebody is. Passing no token is the check-in page's case and keeps the
 * exact headers it has always sent.
 */
function headers(extra = {}, accessToken = null) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    ...extra,
  };
}

/** An AbortSignal that fires on the caller's signal or on our own timeout. */
function attemptSignal(outer, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  const forward = () => controller.abort(outer.reason);
  if (outer) {
    if (outer.aborted) forward();
    else outer.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    },
  };
}

function isAbort(err, outer) {
  return outer?.aborted && (err?.name === 'AbortError' || err === outer.reason);
}

/** "Come back shortly", from the limiter or from a gateway in front of it. */
function isRateLimited(err) {
  return err instanceof RpcError && (err.code === 'PDS09' || err.status === 429);
}

/**
 * Retryable means: we may not have been heard. A PDS03 or a PDS05 is a
 * decision, and repeating it just wastes the member's time and their
 * allowance.
 */
function isTransportRetryable(err) {
  if (err instanceof NetworkError) return true;
  if (err instanceof RpcError) {
    // A PDS* code is a decision the function made, whatever HTTP status it
    // arrived under. This matters: PostgREST does not recognise the PDS class,
    // so a raise carrying errcode 'PDS01' may well surface as a 500 rather than
    // a 400. Without this line, "that link is not valid" would be retried four
    // times before it was shown, and every refusal on the page would take ten
    // seconds to appear. PDS09 is checked before this and is the one PDS code
    // that does get repeated.
    if (typeof err.code === 'string' && err.code.startsWith('PDS')) return false;
    if (err.status === 408 || err.status === 425) return true;
    if (err.status >= 500) return true;
  }
  return false;
}

/**
 * Two independent retry budgets, because the two failures mean different
 * things. `attempts` counts tries against a network that may not be listening;
 * `rateLimitAttempts` counts waits for a bucket that is full and will clear on
 * its own. Sharing one budget would let a few dropped packets eat the patience
 * a rate limit needs, or the other way round.
 */
async function withRetries(
  run,
  { attempts = 4, rateLimitAttempts = 5, onRetry, signal, sleep = realSleep } = {},
) {
  let transportTries = 0;
  let rateTries = 0;

  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (isAbort(err, signal)) throw err;

      let wait;
      let reason;
      if (isRateLimited(err)) {
        if (rateTries >= rateLimitAttempts) throw err;
        wait = RATE_LIMIT_BACKOFF_MS[Math.min(rateTries, RATE_LIMIT_BACKOFF_MS.length - 1)];
        rateTries += 1;
        reason = 'busy';
      } else if (isTransportRetryable(err)) {
        if (transportTries >= attempts - 1) throw err;
        wait = TRANSPORT_BACKOFF_MS[Math.min(transportTries, TRANSPORT_BACKOFF_MS.length - 1)];
        transportTries += 1;
        reason = 'network';
      } else {
        throw err;
      }

      const waitMs = jitter(wait);
      onRetry?.({ reason, waitMs, error: err });
      await sleep(waitMs);
    }
  }
}

async function once(url, init, outerSignal) {
  const attempt = attemptSignal(outerSignal, ATTEMPT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, signal: attempt.signal });
  } catch (err) {
    if (isAbort(err, outerSignal)) throw err;
    // fetch only rejects when no response arrived at all: offline, DNS, TLS,
    // a dropped socket, or our timeout. All of those are worth repeating.
    throw new NetworkError('The request did not reach the server.', err);
  } finally {
    attempt.done();
  }
  return res;
}

/**
 * Calls a Postgres function through PostgREST.
 * Argument names are the SQL parameter names, `p_token` and friends, exactly as
 * declared in supabase/migrations/20260811101000_rpcs.sql.
 */
export async function rpc(name, args, opts = {}) {
  return withRetries(async () => {
    const res = await once(
      `${BASE}/rest/v1/rpc/${name}`,
      {
        method: 'POST',
        headers: headers(
          {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          opts.accessToken,
        ),
        body: JSON.stringify(args ?? {}),
      },
      opts.signal,
    );

    const body = await res.text();
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }

    if (res.ok) return parsed;

    throw new RpcError(
      parsed?.code ?? `HTTP_${res.status}`,
      parsed?.message ?? parsed?.error ?? `Request failed with status ${res.status}.`,
      res.status,
      parsed?.hint,
    );
  }, opts);
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Sends the compressed photo straight to Storage, at the one path
 * create_evidence_upload() reserved for it. The RLS policy in migration 12
 * admits this write only while the grant is live, so the anon key is not what
 * makes it safe: the grant is.
 *
 * POST, not PUT. PUT on the Storage API is an update, and the bucket policies
 * grant anon INSERT only. See web/README.md.
 */
export async function uploadEvidence(objectPath, blob, opts = {}) {
  const bucket = opts.bucket ?? EVIDENCE_BUCKET;
  return withRetries(async () => {
    const res = await once(
      `${BASE}/storage/v1/object/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`,
      {
        method: 'POST',
        headers: headers({
          'Content-Type': blob.type || 'image/jpeg',
          'Cache-Control': 'max-age=31536000',
          'x-upsert': 'false',
        }),
        body: blob,
      },
      opts.signal,
    );

    if (res.ok) return true;

    // A retry after an answer we never saw lands here: the bytes are already in
    // the bucket and the path is unique to this grant, so this is a success we
    // did not get to hear the first time.
    if (res.status === 409) return true;

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw new RpcError(
      parsed?.error ?? `HTTP_${res.status}`,
      parsed?.message ?? `Upload failed with status ${res.status}.`,
      res.status,
    );
  }, opts);
}

export { RpcError, NetworkError };

// Used by web/src/rest.js and web/src/auth.js, which are the signed-in half of
// the product and want this exact retry policy rather than a second one that
// drifts from it. Nothing in web/c/ or web/src/checkin.js imports these.
export { withRetries, once as requestOnce, headers as authHeaders, BASE as API_BASE };
