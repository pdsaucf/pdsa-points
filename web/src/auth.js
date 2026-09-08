// Supabase password and Google PKCE sessions. Authorization is resolved in Postgres.
import { SUPABASE_URL, SUPABASE_ANON_KEY, OFFICER_ACCOUNT_EMAIL } from '../config.js';
import { RpcError, NetworkError } from './errors.js';
import { withRetries, requestOnce, API_BASE } from './api.js';

export const STORAGE_KEY = `pdsa:auth:${SUPABASE_URL}`;

// Refresh this far before the token actually expires, so a request never goes
// out holding one that dies in flight.
const REFRESH_SKEW_SECONDS = 90;

/** The session is gone and cannot be recovered without entering the passcode. */
export class SessionExpiredError extends Error {
  constructor(message) {
    super(message || 'That sign-in has expired.');
    this.name = 'SessionExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
// Looked up on every call rather than captured at import time, so a browser in
// private mode that throws on access degrades to memory, and so the checks in
// mock/verify-admin.mjs can install a stand-in before importing this module.

const memory = new Map();
let sessionEpoch = 0;

function readRaw() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? memory.get(STORAGE_KEY) ?? null;
  } catch {
    return memory.get(STORAGE_KEY) ?? null;
  }
}

function writeRaw(value) {
  memory.set(STORAGE_KEY, value);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, value);
  } catch {
    // Private browsing. The session then lasts as long as the tab, which is
    // worse than it should be and much better than refusing to sign in.
  }
}

function removeRaw() {
  memory.delete(STORAGE_KEY);
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // As above.
  }
}

// ---------------------------------------------------------------------------
// The session record
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   access_token: string,
 *   refresh_token: string,
 *   expires_at: number,     // epoch SECONDS, matching what GoTrue returns
 *   user: { id: string, email: string|null }
 * }} Session
 */

/**
 * The claims inside an access token, or null if it does not look like a JWT.
 *
 * NOT a security check, and nothing here is trusted. The signature is not
 * verified, because the browser has no key to verify it with and no reason to:
 * the database checks the signature on every request, and lying to yourself
 * about your own user id only produces queries that come back empty. It is
 * read for one practical reason, which is that knowing who is signed in
 * without a second round trip is worth twelve lines.
 */
export function decodeToken(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    // Decoded byte by byte rather than with escape/unescape, so a name with an
    // accent in it survives the trip.
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** GoTrue answers with expires_in on some paths and expires_at on others. */
function normaliseSession(raw) {
  if (!raw?.access_token || !raw?.refresh_token) return null;
  const claims = decodeToken(raw.access_token) ?? {};
  const expiresAt =
    Number(raw.expires_at) ||
    Number(claims.exp) ||
    Math.floor(Date.now() / 1000) + (Number(raw.expires_in) || 3600);
  return {
    access_token: String(raw.access_token),
    refresh_token: String(raw.refresh_token),
    expires_at: expiresAt,
    user: {
      // The token's own claims are the fallback for a response that carries
      // no user object. `sub` is the auth.users id every RLS policy in
      // migration 11 keys on.
      id: raw.user?.id ?? raw.user_id ?? claims.sub ?? null,
      email: raw.user?.email ?? claims.email ?? null,
    },
  };
}

/** The stored session, whether or not it has expired. Null when there is none. */
export function currentSession() {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.access_token ? parsed : null;
  } catch {
    removeRaw();
    return null;
  }
}

export function adoptSession(session) {
  const normalised = normaliseSession(session);
  if (!normalised) return null;
  writeRaw(JSON.stringify(normalised));
  return normalised;
}

export function forgetSession() {
  sessionEpoch += 1;
  removeRaw();
  try { globalThis.sessionStorage?.removeItem(`${STORAGE_KEY}:pkce`); } catch { /* Storage may be disabled. */ }
}

const secondsLeft = (session) =>
  (session?.expires_at ?? 0) - Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Talking to GoTrue
// ---------------------------------------------------------------------------

/**
 * GoTrue does not use the PDS codes, so its refusals arrive as
 * { error, error_description } or { msg } or { message } depending on the
 * endpoint and the version. All three are folded into RpcError so callers have
 * one shape to handle and the retry rules in api.js apply unchanged.
 */
async function authFetch(path, { method = 'POST', body, accessToken, opts = {} } = {}) {
  return withRetries(async () => {
    const res = await requestOnce(
      `${API_BASE}${path}`,
      {
        method,
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      opts.signal,
    );

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (res.ok) return parsed ?? {};

    throw new RpcError(
      parsed?.error_code ?? parsed?.error ?? `HTTP_${res.status}`,
      parsed?.error_description ?? parsed?.msg ?? parsed?.message ?? `Sign-in failed with status ${res.status}.`,
      res.status,
    );
  }, { attempts: 3, rateLimitAttempts: 1, ...opts });
}

/**
 * Exchanges the passcode for a session.
 *
 * The address is fixed and public; the passcode is the only thing the officer
 * supplies and the only thing that is secret. GoTrue compares it against the
 * bcrypt hash on that account and answers 400 `invalid_grant` when it is wrong,
 * which is the one refusal the sign-in screen has to render.
 *
 * Signups are irrelevant to this endpoint: the password grant authenticates an
 * existing account and never creates one, so there is no `create_user` question
 * to get wrong.
 */
export async function signInWithPasscode(passcode, opts = {}) {
  const epoch = ++sessionEpoch;
  const body = await authFetch('/auth/v1/token?grant_type=password', {
    body: { email: OFFICER_ACCOUNT_EMAIL, password: String(passcode) },
    opts,
  });

  if (epoch !== sessionEpoch) throw new SessionExpiredError();
  const session = adoptSession(body);
  if (!session) {
    // A 200 with nothing usable in it. Treated as a refusal rather than as a
    // sign-in, because the alternative is a screen that says it worked and
    // then 401s on its first read.
    throw new RpcError('NO_SESSION', 'That sign-in did not complete.', 500);
  }
  return session;
}

// Single flight. Two requests noticing an expired token at the same instant
// must not both spend the refresh token: GoTrue rotates it, so the second call
// would present one that has just been retired and sign the officer out in the
// middle of a queue.
let refreshInFlight = null;

async function refreshSession(session) {
  if (refreshInFlight) return refreshInFlight;

  const epoch = sessionEpoch;
  refreshInFlight = (async () => {
    try {
      const body = await authFetch('/auth/v1/token?grant_type=refresh_token', {
        body: { refresh_token: session.refresh_token },
      });
      if (epoch !== sessionEpoch) throw new SessionExpiredError();
      const next = adoptSession(body);
      if (!next) throw new SessionExpiredError();
      return next;
    } catch (err) {
      // A network failure is not proof the session is dead, and throwing the
      // officer back to sign-in over one dropped packet is its own bug. Only a
      // refusal from GoTrue clears the stored session.
      if (err instanceof NetworkError) throw err;
      if (epoch === sessionEpoch) forgetSession();
      throw new SessionExpiredError('That sign-in has expired.');
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * A token that is good right now, refreshing first if the stored one is close
 * to expiry. Throws SessionExpiredError when there is nothing to work with,
 * which is the signal every caller turns into "back to sign-in".
 */
export async function accessToken({ force = false } = {}) {
  const session = currentSession();
  if (!session) throw new SessionExpiredError('You are not signed in.');
  if (!force && secondsLeft(session) > REFRESH_SKEW_SECONDS) return session.access_token;
  const next = await refreshSession(session);
  return next.access_token;
}

/**
 * Ends the session everywhere, then locally whatever the server said. A logout
 * that fails at the server but leaves the browser holding a live token is the
 * worse of the two failures, particularly on a shared officer laptop.
 */
export async function signOut() {
  const session = currentSession();
  forgetSession();
  if (!session) return;
  try {
    await authFetch('/auth/v1/logout', {
      body: {},
      accessToken: session.access_token,
      opts: { attempts: 1, rateLimitAttempts: 0 },
    });
  } catch {
    // The token expires on its own. Nothing here is worth blocking the UI for.
  }
}

// Per-tab storage prevents overlapping tabs overwriting one another's verifier.
// An unavailable durable store fails before redirect rather than losing the verifier.
const PKCE_KEY = `${STORAGE_KEY}:pkce`;
const base64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function googleSignInUrl() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const redirect = new URL('./', window.location.href);
  redirect.search = '';
  redirect.hash = '';
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, createdAt: Date.now() }));
  const url = new URL(`${API_BASE}/auth/v1/authorize`);
  url.search = new URLSearchParams({ provider: 'google', redirect_to: redirect.href,
    code_challenge: challenge, code_challenge_method: 's256', scopes: 'openid email profile' });
  return url.href;
}

export async function completeGoogleSignIn() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get('code');
  const failed = url.searchParams.has('error') || hash.has('error');
  const implicit = hash.has('access_token') || hash.has('refresh_token');
  if (!code && !failed && !implicit) return false;
  // Never adopt tokens or destinations from the URL, and remove sensitive callback
  // parameters before doing any network work or rendering links.
  window.history.replaceState(null, '', url.pathname);
  const stored = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (failed || implicit) throw new Error('Google sign-in did not complete. Try again.');
  let pending;
  try { pending = JSON.parse(stored); } catch { /* A missing verifier is refused below. */ }
  if (typeof pending?.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier) || !Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > 10 * 60 * 1000) {
    throw new Error('Sign-in expired. Try again in this tab.');
  }
  const epoch = ++sessionEpoch;
  const body = await authFetch('/auth/v1/token?grant_type=pkce', {
    body: { auth_code: code, code_verifier: pending.verifier },
    opts: { attempts: 1, rateLimitAttempts: 0 },
  });
  if (epoch !== sessionEpoch) throw new SessionExpiredError();
  if (!adoptSession(body)) throw new Error('Google sign-in did not complete. Try again.');
  return true;
}
