// Every error this page can put in front of a member, written from their side
// of the screen. They are standing in a queue holding a phone, so each message
// says what happened and what to do next, and never says "error".
//
// The PDS* codes are raised by supabase/migrations/20260811101000_rpcs.sql.
// Codes PDS06, PDS07 and PDS08 belong to officer-only RPCs and cannot reach
// this page; they are mapped anyway so an unexpected one never renders blank.

/** A PDS* or HTTP error carried back from PostgREST or Storage. */
export class RpcError extends Error {
  constructor(code, message, status, hint) {
    super(message || code);
    this.name = 'RpcError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

/** The request never got an answer: no signal, DNS, TLS, timeout, dropped socket. */
export class NetworkError extends Error {
  constructor(message, cause) {
    super(message || 'The network request did not complete.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

// Said in more than one place, so each is written once.
const ALREADY_CHECKED_IN = {
  title: 'You are already checked in',
  body: 'Nothing else to do.',
  retry: false,
  alreadyDone: true,
};

const SHOW_AN_OFFICER = {
  title: 'This page is not set up correctly',
  body: 'Show this screen to an officer.',
  retry: false,
};

const BY_CODE = {
  PDS01: () => ({
    title: 'This check-in link is not valid',
    body: 'Ask an officer for the current QR code, then scan it again.',
    retry: false,
  }),

  // PDS02 and PDS10 were one code, and telling them apart meant reading the
  // server's sentence. They are separate codes now because they ask the member
  // for opposite things: wait, or go and find somebody. Branch on the code and
  // never on the message, so both sides can reword freely.
  PDS02: () => ({
    title: 'Check-in has not opened yet',
    body: 'This is the right link. Check-in opens shortly before the event starts.',
    retry: true,
  }),

  PDS10: () => ({
    title: 'Check-in for this event has closed',
    body: 'If you were there, find an officer: they can add you from the roster.',
    retry: false,
  }),

  PDS03: (message) => ({
    title: 'Check what you entered',
    body: message || 'Check your name and any numbers, then try again.',
    retry: true,
  }),

  // PDS04 is raised at four places for four reasons, and the code alone does
  // not separate them:
  //
  //   create_evidence_upload  this event does not collect that kind of photo
  //   create_evidence_upload  YOU have too many uploads pending (3 per client)
  //   create_evidence_upload  the EVENT has too many pending (1200)
  //   submit_checkin          that grant expired or was already used
  //
  // Two things separate them without reading a sentence. Which call raised it
  // splits the last one off cleanly: only submit_checkin can tell a member
  // their photo is gone, and only there is "take it again" the right answer.
  //
  // For the grant cases, the page knows something the code does not: how many
  // grants IT has been issued and not yet submitted. If that is already at the
  // per-client cap then this refusal is the member's own retaken photos, with
  // certainty rather than as a guess. The config case cannot be hiding behind
  // that count, because the check that raises it runs before any grant is
  // issued and depends only on the event and the kind, so a client holding
  // three grants for this kind has already proved the event collects it.
  //
  // Below that count the page genuinely cannot tell a full event from a
  // misconfigured one, so the copy stops guessing and gives the next three
  // things to try, in the order that fixes the most likely cause first. A
  // reload is what recovers the config case, because a fresh context stops
  // asking for the photo at all.
  PDS04: (message, stage, details = {}) => {
    if (stage === 'submit') {
      return {
        title: 'The photo needs taking again',
        body: 'The upload expired. Take it again, then check in.',
        retry: true,
        retakePhoto: true,
      };
    }

    if (details.outstandingGrants >= 3) {
      return {
        title: 'Your earlier photos are still sending',
        body: 'Wait a few seconds, then tap the photo button again.',
        retry: true,
        offerSkipPhoto: true,
      };
    }

    return {
      title: 'The photo could not be started',
      body: 'Tap the photo button again. If that does not work, reload this page, or check in without the photo.',
      retry: true,
      offerSkipPhoto: true,
    };
  },

  PDS05: () => ALREADY_CHECKED_IN,

  PDS06: () => ({
    title: 'This needs an officer',
    body: 'Show this screen to an officer.',
    retry: false,
  }),

  PDS07: () => ({
    title: 'This needs an officer',
    body: 'Show this screen to an officer.',
    retry: false,
  }),

  PDS08: () => ({
    title: 'This event is not set up yet',
    body: 'Tell an officer.',
    retry: true,
  }),

  // The limiter counts per calendar minute, so a full bucket clears when the
  // minute rolls over. api.js has already waited out a whole window by the
  // time this copy is reached.
  PDS09: () => ({
    title: 'Lots of people are checking in',
    body: 'Tap the button again. Nothing you typed is lost.',
    retry: true,
  }),
};

const HTTP_FALLBACK = {
  400: {
    title: 'Something went wrong',
    body: 'Try again. If it keeps happening, show this screen to an officer.',
    retry: true,
  },
  401: SHOW_AN_OFFICER,
  403: SHOW_AN_OFFICER,
  404: SHOW_AN_OFFICER,
  409: ALREADY_CHECKED_IN,
  413: {
    title: 'That photo is too large',
    body: 'Take it again at a lower resolution.',
    retry: true,
    retakePhoto: true,
  },
};

/**
 * Turns any thrown value into copy the page can render.
 * @param {unknown} err
 * @param {'context'|'search'|'grant'|'upload'|'submit'} [stage] which call raised it
 * @param {{outstandingGrants?: number}} [details] what the page knows and the code does not
 * @returns {{title: string, body: string, retry: boolean, retakePhoto?: boolean,
 *   offerSkipPhoto?: boolean, alreadyDone?: boolean}}
 */
export function describe(err, stage, details) {
  if (err instanceof NetworkError) {
    return {
      title: 'No connection right now',
      body: 'Nothing you typed is lost. Tap the button again when you have a signal.',
      retry: true,
    };
  }

  if (err instanceof RpcError) {
    const build = BY_CODE[err.code];
    if (build) return build(err.message, stage, details);

    // Storage answers with its own error shapes, not PDS codes. A refusal here
    // is the RLS policy saying the grant is no longer live, which for the
    // member means one thing: the photo needs taking again.
    if (stage === 'upload' && [400, 403, 404].includes(err.status)) {
      return {
        title: 'The photo needs taking again',
        body: 'The upload window has passed. Take it again, then check in.',
        retry: true,
        retakePhoto: true,
      };
    }

    if (err.status && HTTP_FALLBACK[err.status]) return HTTP_FALLBACK[err.status];
    if (err.status >= 500) {
      return {
        title: 'Check-in is not responding',
        body: 'Wait a few seconds and try again.',
        retry: true,
      };
    }
  }

  return {
    title: 'Something went wrong',
    body: 'Try again. If it keeps happening, show this screen to an officer.',
    retry: true,
  };
}

/** Not configured yet: the placeholders in config.js are still in place. */
export const NOT_CONFIGURED = {
  title: 'Check-in is not connected yet',
  body: 'An officer needs to fill in web/config.js before an event.',
  retry: false,
};

/** No ?e= in the URL at all, so somebody typed the address by hand. */
export const NO_TOKEN = {
  title: 'This link is missing its event code',
  body: 'Scan the QR code at the event rather than typing the address.',
  retry: false,
};
