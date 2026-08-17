// Every refusal the member portal can put in front of somebody, written from
// their side of the screen.
//
// A SECOND REGISTER, NOT A REUSE OF officer-errors.js. The same PDS code means a
// different thing to each audience and needs a different next step from each.
// Every recovery on the officer side is written for somebody holding a laptop
// with a queue open, which is why "Reload the queue" is a sentence that fits
// there and is meaningless here.
//
// The codes are raised by the portal functions in
// supabase/migrations/20260817110000_public_member_portal.sql. The rule from
// that file holds here too: branch on the CODE, never on the sentence.
//
// THERE IS NO SIGN-IN AND NO ACCOUNT ANY MORE, so this is a much smaller set
// than it was. The portal makes anonymous calls, which cannot expire, cannot be
// the wrong account, and cannot be refused for who they belong to. What is left
// is PDS03, which the portal functions raise for the one case a member can
// actually cause (a name that is not on this year's roster), and the transport
// failures every screen in this product shares.

import { RpcError, NetworkError } from './errors.js';

// No body: the heading names the state and the button says what to do, so a
// sentence between them would only repeat one of the two.
const OUT_OF_DATE = {
  title: 'This page is out of date',
  body: '',
  recover: 'reload',
};

const BY_CODE = {
  // The sentence is the function's own, written in the second person ("Nobody
  // by that name is on this years roster"), so the heading names the state and
  // the sentence carries the specifics.
  PDS03: (message) => ({
    title: 'Not on this years roster',
    body: message || 'Check the spelling, or ask an officer.',
    recover: 'none',
  }),

  // The limiter counts per calendar minute, so a full bucket clears when the
  // minute rolls over. api.js has already waited out a whole window by the
  // time this copy is reached.
  PDS09: () => ({
    title: 'Too many tries',
    body: 'Wait a minute, then try again.',
    recover: 'retry',
  }),
};

const HTTP_FALLBACK = {
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
 *   'reload'  the screen is out of date, read it again
 *   'retry'   worth pressing again as is
 *   'none'    nothing here will help, so no button
 *
 * @param {unknown} err
 * @returns {{title: string, body: string, recover: 'reload'|'retry'|'none'}}
 */
export function describeMember(err) {
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

export { RpcError, NetworkError };
