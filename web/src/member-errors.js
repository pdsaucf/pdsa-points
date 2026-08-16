// Every refusal the member portal can put in front of somebody, written from
// their side of the screen.
//
// A THIRD REGISTER, NOT A REUSE OF officer-errors.js. The same PDS code means a
// different thing to each audience and needs a different next step from each.
// PDS05 tells an officer "somebody else already has a live record for that
// event, so this one cannot be moved onto them"; it tells a member "that event
// is already on your list, go and look at it". Every recovery on the officer
// side is written for somebody holding a laptop with a queue open, which is why
// "Reload the queue" is a sentence that fits there and is meaningless here.
//
// The codes are raised by supabase/migrations/20260814130000_member_portal.sql
// and by the RPCs migration 10 defines. The rule from those files holds here
// too: branch on the CODE, never on the sentence.
//
// WHY THERE IS NO `stage` ARGUMENT, where officer-errors.js needs one. Over
// there, one code arrives from two calls that need different headings. Here
// every code has one meaning across the whole portal:
//
//   PDS07  raised by four of the six functions, and by all four for the same
//          practical reason: this account is not in the state the screen
//          thinks it is. It is signed in and not linked, or linked when the
//          screen believed it was not. Loading the page again reads the state
//          afresh and lands on the right screen, whichever of those it was.
//   PDS03  the actual validation failure, in a sentence the function wrote in
//          the second person ("You are not on the roster for that year"). The
//          heading names the state and the sentence carries the specifics,
//          because telling the four cases apart from the code is impossible
//          and telling them apart from the sentence is the thing this file
//          exists not to do.
//
// The portal also refuses several PDS03 cases before they are sent: a note
// nobody typed, a number an event needs, and a member who is not on this year's
// roster at all. Those have their own copy at the field, where somebody can fix
// them, and the refusals below are the backstop for the same cases arriving
// from the database anyway.

import { RpcError, NetworkError } from './errors.js';
import { SessionExpiredError } from './auth.js';

/** Said in more than one place, so each is written once. */
const SESSION_EXPIRED = {
  title: 'Sign-in expired',
  body: 'Send yourself a new link.',
  recover: 'signin',
};

// No body: the heading names the state and the button says what to do, so a
// sentence between them would only repeat one of the two.
const OUT_OF_DATE = {
  title: 'This page is out of date',
  body: '',
  recover: 'reload',
};

const BY_CODE = {
  PDS07: () => OUT_OF_DATE,

  PDS03: (message) => ({
    title: 'That was not sent',
    body: message || 'Check what you typed.',
    recover: 'none',
  }),

  // request_missing_credit(), on an event the member already has a live record
  // for. It is usually the answer they were looking for: it is there, it is
  // just not approved yet.
  PDS05: () => ({
    title: 'Already on your list',
    body: 'That event is in your records.',
    recover: 'reload',
  }),

  // The limiter counts per calendar minute, so a full bucket clears when the
  // minute rolls over. api.js has already waited out a whole window by the
  // time this copy is reached.
  PDS09: () => ({
    title: 'Too many tries',
    body: 'Wait a minute, then try again.',
    recover: 'retry',
  }),

  // file_member_claim(): this account already has a claim waiting. Nothing has
  // gone wrong and there is nothing to do, so loading the page again puts them
  // on the screen that says so.
  PDS13: () => ({
    title: 'You already asked',
    body: 'An officer is checking it.',
    recover: 'reload',
  }),

  // file_member_claim(): somebody else holds a live claim on that member. That
  // is either the wrong name picked or two roster rows for one person, and an
  // officer has to look at it. No recovery button: the screen they are on is
  // the search, and picking a different name is the next step.
  PDS14: () => ({
    title: 'Already claimed',
    body: 'Another account is claiming that person. Ask an officer.',
    recover: 'none',
  }),
};

const HTTP_FALLBACK = {
  401: SESSION_EXPIRED,
  403: {
    title: 'Not allowed',
    body: 'Ask an officer.',
    recover: 'none',
  },
  404: {
    title: 'Cannot reach your points',
    body: 'Try again in a few minutes.',
    recover: 'retry',
  },
  409: OUT_OF_DATE,
};

/**
 * Turns anything thrown by rest.js or auth.js into copy the portal can render.
 *
 * `recover` is what the button under the message should do:
 *   'signin'  the session is finished, back to the sign-in screen
 *   'reload'  the screen is out of date, read the account again
 *   'retry'   worth pressing again as is
 *   'none'    nothing here will help, so no button
 *
 * @param {unknown} err
 * @returns {{title: string, body: string, recover: 'signin'|'reload'|'retry'|'none'}}
 */
export function describeMember(err) {
  if (err instanceof SessionExpiredError) return SESSION_EXPIRED;

  if (err instanceof NetworkError) {
    return {
      title: 'No connection',
      body: 'Nothing you typed is lost. Try again when you have a signal.',
      recover: 'retry',
    };
  }

  if (err instanceof RpcError) {
    const build = BY_CODE[err.code];
    if (build) return build(err.message);

    if (err.status && HTTP_FALLBACK[err.status]) return HTTP_FALLBACK[err.status];

    if (err.status >= 500) {
      return {
        title: 'Not responding',
        body: 'Wait a few seconds, then try again.',
        recover: 'retry',
      };
    }
  }

  return {
    title: 'That did not go through',
    body: 'Try again.',
    recover: 'retry',
  };
}

/**
 * The sign-in screen has its own small set, because GoTrue has its own codes.
 *
 * Deliberately different from the officer version in one way that matters:
 * accounts here are not provisioned by an admin. A member signing in for the
 * first time is creating the account, so the copy never implies the address
 * has to be known already.
 */
export function describeMemberSignIn(err) {
  if (err instanceof NetworkError) {
    return {
      title: 'No connection',
      body: 'The link could not be sent. Try again in a moment.',
    };
  }

  if (err instanceof RpcError) {
    if (err.status === 429 || err.code === 'over_email_send_rate_limit') {
      return {
        title: 'A link was just sent',
        body: 'Wait a minute, then check your inbox and your spam folder.',
      };
    }
    if (err.status === 422 || err.status === 400) {
      return {
        title: 'Check that address',
        body: 'Type the email you want the link sent to.',
      };
    }
  }

  return {
    title: 'The link could not be sent',
    body: 'Try again in a moment.',
  };
}

export { RpcError, NetworkError, SessionExpiredError };
