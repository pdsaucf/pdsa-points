// Signing in, for the checks.
//
// The public admin screen offers Google sign-in. These checks retain the
// low-level shared password-grant fallback, including its fixed account and
// server-side passcode verification. No passcode form is exposed by the page.

import assert from 'node:assert/strict';

import { MOCK_PASSCODE } from './admin-fixtures.mjs';

// auth.js IS NOT IMPORTED AT THE TOP OF THIS FILE, AND MUST NOT BE. It imports
// config.js, which reads globalThis.__PDSA_CONFIG__ once, at evaluation time.
// Every verify file sets that global in its module body, which runs AFTER the
// whole static import graph has already been evaluated: a static import here
// would therefore resolve config.js against the real project, and the checks
// would quietly run against production Supabase instead of the mock. That is
// why the verify files import auth.js dynamically too, and why this one reaches
// for it inside the function rather than beside the others.

const ANON_KEY = 'mock-anon-key';

/**
 * @param {string} email one of the addresses in ACCOUNTS
 * @param {number} port the mock this file started
 */
export async function signInAs(email, port) {
  const { adoptSession, forgetSession } = await import('../src/auth.js');
  forgetSession();

  const res = await fetch(`http://localhost:${port}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password: MOCK_PASSCODE }),
  });

  assert.equal(res.status, 200, `the passcode was refused for ${email}`);
  const session = adoptSession(await res.json());
  assert.ok(session, `no session came back for ${email}`);
  return session;
}
