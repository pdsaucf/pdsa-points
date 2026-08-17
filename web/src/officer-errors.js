// Every refusal the review queue can hit, written for the officer holding the
// laptop rather than the member holding the phone.
//
// This is a separate file from errors.js on purpose. The same PDS code means a
// different thing to each audience and needs a different next step from each.
// PDS05 tells a member "you are already checked in, you are done"; it tells an
// officer "somebody else already has a live record for that event, so this one
// cannot be moved onto them". Folding both into one dictionary would mean
// every message had to be vague enough to suit both, which is how error copy
// ends up saying nothing.
//
// The codes are raised by supabase/migrations/20260811101000_rpcs.sql. The
// audience rule from that file holds here too: branch on the CODE, never on
// the sentence.
//
// No jargon, per docs/03-admin-ui.md. Nothing below says schema, node, RLS,
// policy, constraint or row.

import { RpcError, NetworkError } from './errors.js';
import { SessionExpiredError } from './auth.js';

/** Said in two places, so it is written once. */
const SESSION_EXPIRED = {
  title: 'Sign-in expired',
  body: 'Send yourself a new link. Nothing you have approved is affected.',
  recover: 'signin',
};

const NOT_AN_OFFICER = {
  title: 'This account cannot review check-ins',
  body: 'Ask an admin for officer access.',
  recover: 'none',
};

/** Shown on a card whose buttons are not offered, so it says why they are not. */
export const READ_ONLY = 'Read only: this account cannot approve or decline.';

const BY_CODE = {
  // Raised by review_records() when an approve would touch a record with no
  // member attached. The queue is built so this is unreachable (an unmatched
  // card has no approve button until it has been resolved), so reaching it
  // means something changed underneath: another officer resolved it, or the
  // page has been open a while. Either way the fix is the same and it is on
  // this screen.
  PDS06: () => ({
    title: 'Member not matched',
    body: 'Link this check-in to a member, or add them as a new member, then approve it.',
    recover: 'refresh',
  }),

  PDS07: () => NOT_AN_OFFICER,

  PDS05: () => ({
    title: 'Already has a record for this event',
    body: 'Check that event in the queue, or decline this check-in as a duplicate.',
    recover: 'refresh',
  }),

  PDS03: (message) => ({
    title: 'That was not accepted',
    body: message || 'Check what was entered, then try again.',
    recover: 'none',
  }),

  PDS09: () => ({
    title: 'The database is busy',
    body: 'Wait a few seconds, then press the button again. Nothing was lost.',
    recover: 'retry',
  }),
};

const HTTP_FALLBACK = {
  401: SESSION_EXPIRED,
  403: NOT_AN_OFFICER,
  404: {
    title: 'Cannot reach the database',
    body: 'An admin needs to check the connection details for this site.',
    recover: 'none',
  },
  409: {
    title: 'Conflicts with an existing record',
    body: 'Reload the queue, then try again.',
    recover: 'refresh',
  },
};

/**
 * Turns anything thrown by rest.js or auth.js into copy the screen can render.
 *
 * `recover` is what the button under the message should do:
 *   'signin'   the session is finished, go back to the sign-in screen
 *   'refresh'  the screen is out of date, reload the queue
 *   'retry'    worth pressing again as is
 *   'none'     nothing here will help, so no button
 *
 * @param {unknown} err
 * @returns {{title: string, body: string, recover: 'signin'|'refresh'|'retry'|'none'}}
 */
export function describeOfficer(err) {
  if (err instanceof SessionExpiredError) return SESSION_EXPIRED;

  if (err instanceof NetworkError) {
    return {
      title: 'No connection to the database',
      body: 'Check the wifi, then press the button again. Nothing on screen is lost.',
      recover: 'retry',
    };
  }

  if (err instanceof RpcError) {
    const build = BY_CODE[err.code];
    if (build) return build(err.message);

    if (err.status && HTTP_FALLBACK[err.status]) return HTTP_FALLBACK[err.status];

    if (err.status >= 500) {
      return {
        title: 'The database is not responding',
        body: 'Wait a few seconds, then press the button again.',
        recover: 'retry',
      };
    }
  }

  return {
    title: 'That did not go through',
    body: 'Reload the queue, then try again.',
    recover: 'refresh',
  };
}

/**
 * link_retroactive_matches() outcomes, one per requested record id. This is a
 * return value read off a row, never a raised error, so it is a lookup table
 * of its own rather than folded into BY_CODE above.
 *
 * Rendered next to the specific record it is about (its event and date are
 * already on screen beside it), so the copy here says only what happened to
 * that one record, not the record itself again.
 */
const RETRO_OUTCOME = {
  linked: 'Linked',
  // The record's member_id was already set at write time. Most often that is
  // a different officer, or a different flow, getting there first for
  // somebody else entirely; the member this officer meant to link got
  // nothing. It can also be a harmless double-submit to the same member, and
  // the RPC response does not say which, so this stays a flag worth a look
  // rather than a claim about whose record it now is.
  already_linked: 'Already linked to somebody',
  not_pending: 'Somebody already decided this one',
  wrong_year: 'Not enrolled for that year',
  not_found: 'No longer exists',
  conflict: 'Already has a record for this event',
};

/** @param {string} outcome one of link_retroactive_matches()'s six outcomes */
export function describeRetroOutcome(outcome) {
  return RETRO_OUTCOME[outcome] ?? 'Unknown outcome.';
}

/** The sign-in screen has its own small set, because GoTrue has its own codes. */
export function describeSignIn(err) {
  if (err instanceof NetworkError) {
    return {
      title: 'No connection',
      body: 'The link could not be sent. Try again in a moment.',
    };
  }

  if (err instanceof RpcError) {
    // Signups are off (create_user: false), so an address with no officer
    // account can land here on some GoTrue versions rather than a quiet 200.
    // The copy stays deliberately neutral: telling a stranger which addresses
    // have accounts is not information this page should hand out.
    if (err.status === 422 || err.status === 400) {
      return {
        title: 'Check your inbox',
        body: 'If that address has an officer account, a sign-in link is on its way.',
      };
    }
    if (err.status === 429 || err.code === 'over_email_send_rate_limit') {
      return {
        title: 'A link was just sent',
        body: 'Wait a minute, then check the inbox and the spam folder.',
      };
    }
  }

  return {
    title: 'The link could not be sent',
    body: 'Try again in a moment. If it keeps happening, an admin needs to check the site settings.',
  };
}

export { RpcError, NetworkError, SessionExpiredError };
