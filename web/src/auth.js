// Officer sign-in, and the session behind every request the admin screens make.
//
// WHY THIS IS NOT @supabase/supabase-js
//
// The brief allowed the real client here if it earned its place. It does not,
// and the reason is specific rather than ideological:
//
//   * No CDN is allowed, so it would have to be vendored: a bundled ESM blob
//     committed into a repository whose stated property is "nothing is
//     compiled, bundled, minified or transpiled, so what is in the repo is
//     exactly what runs" (web/README.md). That sentence stops being true the
//     moment a build artifact lands in src/.
//   * The surface actually needed is three HTTP calls and one fragment parse:
//     POST /auth/v1/otp, POST /auth/v1/token?grant_type=refresh_token,
//     POST /auth/v1/logout, and reading #access_token= off the redirect. That
//     is the file below.
//   * What the library would add on top (storage, expiry-aware refresh,
//     single-flight, sign-out) is roughly a hundred lines, and those hundred
//     lines are the ones you actually want to be able to read when somebody is
//     locked out at 6pm before a GBM.
//   * It brings its own fetch policy, which would sit beside the deliberate
//     two-budget retry ladder in api.js rather than use it.
//
// The tradeoff is honest: this file is the piece of the product most likely to
// need updating if GoTrue changes its wire format. It is pinned to endpoints
// that have been stable across the v2 line, and every one of them is asserted
// against the mock in web/mock/verify-admin.mjs.
//
// SESSION STORAGE. localStorage, keyed per project URL, which is where
// supabase-js puts it too. The access token is a short-lived JWT and the
// refresh token is what actually matters; both are equally reachable by script
// running in the page, so sessionStorage or a cookie without HttpOnly (which a
// static site cannot set) would buy nothing. The mitigation that does work is
// that this page loads no third party script at all: no CDN, no analytics, no
// font host.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { RpcError, NetworkError } from './errors.js';
import { withRetries, requestOnce, API_BASE } from './api.js';

const STORAGE_KEY = `pdsa:auth:${SUPABASE_URL}`;

// Refresh this far before the token actually expires, so a request never goes
// out holding one that dies in flight.
const REFRESH_SKEW_SECONDS = 90;

/** The session is gone and cannot be recovered without a fresh magic link. */
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
 * read for one practical reason, which is that the redirect fragment carries
 * the token but not the user, and knowing who is signed in without a second
 * round trip is worth twelve lines.
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
      // The redirect fragment carries no user object, so the token's own
      // claims are the fallback. `sub` is the auth.users id every RLS policy
      // in migration 11 keys on.
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
  removeRaw();
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
 * Sends the magic link.
 *
 * `create_user: false` is the load-bearing argument. Officer accounts are
 * provisioned by an admin, and without this any address on earth could sign
 * itself up. The account it created would land on `profiles.role` default
 * 'viewer' and therefore see nothing, but "anyone can create a row in your
 * auth.users" is not a property worth having.
 *
 * The reply is deliberately not inspected for whether the address exists.
 * GoTrue answers 200 either way for exactly that reason, and the copy in the
 * UI matches: "if that address has an officer account, the link is on its way".
 */
export async function sendMagicLink(email, redirectTo, opts = {}) {
  const query = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
  await authFetch(`/auth/v1/otp${query}`, {
    body: { email: String(email).trim(), create_user: false },
    opts,
  });
  return true;
}

/**
 * Reads the session GoTrue put on the end of the redirect.
 *
 * Implicit flow, so the tokens arrive in the URL fragment and never reach a
 * server log. A refusal (expired link, already used) arrives the same way, or
 * as query parameters on some GoTrue versions, so both are read.
 *
 * Pure, and takes the href rather than reading location itself, so it can be
 * checked without a browser.
 *
 * @returns {{session: Session}|{error: {code: string, description: string}}|null}
 */
export function parseAuthRedirect(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const query = url.searchParams;
  const pick = (key) => hash.get(key) ?? query.get(key);

  const error = pick('error') ?? pick('error_code');
  if (error) {
    return {
      error: {
        code: pick('error_code') ?? error,
        description: pick('error_description')?.replace(/\+/g, ' ') ?? '',
      },
    };
  }

  const accessToken = pick('access_token');
  const refreshToken = pick('refresh_token');
  if (!accessToken || !refreshToken) return null;

  return {
    session: normaliseSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: Number(pick('expires_in')) || 3600,
      expires_at: Number(pick('expires_at')) || 0,
      // The user object is not in the fragment. It is filled in by the first
      // profile read, which the guard does anyway.
      user: null,
    }),
  };
}

// Single flight. Two requests noticing an expired token at the same instant
// must not both spend the refresh token: GoTrue rotates it, so the second call
// would present one that has just been retired and sign the officer out in the
// middle of a queue.
let refreshInFlight = null;

async function refreshSession(session) {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const body = await authFetch('/auth/v1/token?grant_type=refresh_token', {
        body: { refresh_token: session.refresh_token },
      });
      const next = adoptSession(body);
      if (!next) throw new SessionExpiredError();
      return next;
    } catch (err) {
      // A network failure is not proof the session is dead, and throwing the
      // officer back to sign-in over one dropped packet is its own bug. Only a
      // refusal from GoTrue clears the stored session.
      if (err instanceof NetworkError) throw err;
      forgetSession();
      throw new SessionExpiredError('That sign-in has expired. Send yourself a new link.');
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
