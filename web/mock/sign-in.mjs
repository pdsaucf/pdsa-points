// Signing in, for the checks.
//
// The product signs in exactly one way: the passcode box posts the passcode to
// GoTrue's password grant against one shared account, and web/src/auth.js names
// that account itself so no caller can pick a different one
// (signInWithPasscode). That is deliberate, and it is checked in verify-admin.
//
// These files need more than that one account, because a good half of what they
// prove is that officer, admin, viewer and member are told apart by the
// database rather than by the screen. So this helper names the account and
// posts to the same endpoint the box does, with the same shape of body. It is
// not a back door around the sign-in: it is the same door, held open for a
// caller that has to be somebody specific.
//
// Four verify files had a copy of this, all four identical.

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
