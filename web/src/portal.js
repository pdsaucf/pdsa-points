// The member portal shell: /me.
//
// Signing in, working out which of four screens this account is on, and handing
// the page to whichever one it is. docs/04-member-ui.md is the design, and the
// branch it draws is not a preference: an account that is not linked to a
// roster row must never be shown somebody's data, so the screen is chosen by
// what start_portal_session() says and by nothing this file infers.
//
//   linked                    the progress screen and the record list
//   not linked, no claim      "which of these is you", roster search
//   claim pending             waiting for an officer, and nothing else
//   claim rejected            the officer's reason, and a way to try again
//
// WHAT IS SHARED WITH THE OFFICER SCREENS, AND WHY EACH ONE IS SHARED.
//
//   src/auth.js       magic-link sign-in, the session, refresh, sign out. Not
//                     officer-specific: the only officer-shaped thing in it was
//                     create_user: false, which is now an argument (see
//                     sendMagicLink) because this portal is the one surface
//                     where signing in for the first time IS creating the
//                     account. docs/04 has 355 members arriving with no email
//                     on file, so a portal that could only sign in addresses an
//                     admin had already provisioned would serve nobody.
//   src/rest.js       authenticated reads and RPCs, with the 401-then-refresh
//                     recovery and the two retry budgets from api.js.
//   src/ui.js         the DOM helpers, including announce(), so this page talks
//                     to a screen reader exactly as the admin app does.
//   src/format.js     pluralUnit and valueFieldLabel, used by the missing
//                     credit form for the same reason the check-in page uses
//                     them: the label comes from the category, and nothing in
//                     the client knows the word "hours".
//   src/requirement-model.js  buildTree, flatten and unitWord. The progress
//                     list is the published rule set, drawn, so it needs the
//                     same tree the requirements editor works in.
//
// WHAT IS NOT SHARED, ON PURPOSE. officer-errors.js. A member reading "Reload
// the queue" is a member reading somebody else's job. src/member-errors.js is
// the same idea in their register, and the reasoning is at the top of it.
//
// NO ROLE GUARD. Unlike /admin/, every signed-in account is welcome here.
// start_portal_session() gives an account with no profiles row the role
// `member`, and an officer who opens this page sees their own progress if they
// are linked and the claim screen if they are not, which is what migration 18
// describes and is why search_roster_for_claim() checks "not linked" rather
// than "is a member".

import { IS_CONFIGURED } from '../config.js';
import {
  sendMagicLink,
  parseAuthRedirect,
  adoptSession,
  currentSession,
  forgetSession,
  signOut,
} from './auth.js';
import { select, callRpc } from './rest.js';
import { describeMember, describeMemberSignIn } from './member-errors.js';
import { createClaim } from './portal-claim.js';
import { createProgress } from './portal-progress.js';
import { $, announce, setHidden } from './ui.js';

const VIEWS = ['boot', 'signin', 'blocked', 'search', 'pending', 'rejected', 'portal'];

const el = {};
const app = {
  session: null, // start_portal_session()'s answer
  years: [],
  year: null,
  claim: null, // the claim screens
  progress: null, // the progress screen and the record list
  wired: false,
};

// ---------------------------------------------------------------------------
// Whole-screen states
// ---------------------------------------------------------------------------

function showView(name) {
  for (const view of VIEWS) setHidden(el.views[view], view !== name);
  setHidden(el.topbar, !currentSession());
}

function showSignIn(message) {
  showView('signin');
  if (message) {
    el.signinMessageTitle.textContent = message.title;
    el.signinMessageBody.textContent = ` ${message.body}`;
    setHidden(el.signinMessage, false);
    announce(`${message.title}. ${message.body}`);
  } else {
    setHidden(el.signinMessage, true);
  }
  el.signinEmail.focus({ preventScroll: true });
}

function showBlocked(title, body) {
  showView('blocked');
  el.blockedTitle.textContent = title;
  el.blockedBody.textContent = body;
  announce(`${title}. ${body}`);
}

// ---------------------------------------------------------------------------
// The two strips every screen talks through
// ---------------------------------------------------------------------------

function clearMessage() {
  setHidden(el.message, true);
  el.messageTitle.textContent = '';
  el.messageBody.textContent = '';
  setHidden(el.messageAction, true);
  el.messageAction.onclick = null;
  setHidden(el.note, true);
  el.note.textContent = '';
}

/** A plain confirmation. Never a refusal: those go through fail(). */
function note(text) {
  setHidden(el.message, true);
  el.note.textContent = text;
  setHidden(el.note, false);
}

/**
 * Something went wrong. The copy and what the button does both come from
 * member-errors.js, so no screen has to decide whether a given failure is worth
 * pressing again.
 */
function fail(err, retry) {
  const copy = describeMember(err);

  if (copy.recover === 'signin') {
    forgetSession();
    showSignIn({ title: copy.title, body: copy.body });
    return;
  }

  setHidden(el.note, true);
  el.messageTitle.textContent = copy.title;
  el.messageBody.textContent = copy.body;

  if (copy.recover === 'reload') {
    el.messageAction.textContent = 'Reload';
    el.messageAction.onclick = () => {
      clearMessage();
      openSession();
    };
    setHidden(el.messageAction, false);
  } else if (copy.recover === 'retry' && retry) {
    el.messageAction.textContent = 'Try again';
    el.messageAction.onclick = () => {
      clearMessage();
      retry();
    };
    setHidden(el.messageAction, false);
  } else {
    setHidden(el.messageAction, true);
  }

  setHidden(el.message, false);
  announce(`${copy.title}. ${copy.body}`);
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

async function onSignInSubmit(event) {
  event.preventDefault();
  const email = el.signinEmail.value.trim();
  if (!email || !email.includes('@')) {
    showSignIn({
      title: 'That is not an email address.',
      body: 'Type the address you want the link sent to.',
    });
    return;
  }

  el.signinSubmit.disabled = true;
  el.signinSubmitLabel.textContent = 'Sending…';
  try {
    // Back to this exact page, with no hash and no query of our own, so the
    // tokens GoTrue appends are the only thing in the fragment.
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    // createUser, unlike the officer screens. See the header of this file.
    await sendMagicLink(email, redirectTo, { createUser: true });
    showSignIn({
      title: 'Check your inbox.',
      body: `A link is on its way to ${email}. It works once.`,
    });
  } catch (err) {
    showSignIn(describeMemberSignIn(err));
  } finally {
    el.signinSubmit.disabled = false;
    el.signinSubmitLabel.textContent = 'Email me a link';
  }
}

/**
 * The tokens arrive in the URL fragment. They are taken out of the address bar
 * straight away: a sign-in link that stays in the history, or gets pasted into
 * a group chat, is a live session anybody can pick up.
 */
function captureRedirect() {
  const result = parseAuthRedirect(window.location.href);
  if (!result) return null;

  window.history.replaceState(null, '', window.location.pathname);

  if (result.error) {
    return {
      error: {
        title: 'That link did not work',
        body: result.error.description || 'Links work once and expire. Ask for a new one below.',
      },
    };
  }

  adoptSession(result.session);
  return { signedIn: true };
}

async function endSession() {
  await signOut();
  window.location.replace(window.location.pathname);
}

// ---------------------------------------------------------------------------
// The session, and the screen it lands on
// ---------------------------------------------------------------------------

/**
 * The first call the portal makes on every load.
 *
 * It is the one function in the schema that will serve an account with no
 * profiles row, which is every account the first time somebody completes a
 * magic-link sign-in. It creates that row as a member, links it when the
 * address matches exactly one live unclaimed roster row, and answers with
 * everything needed to choose a screen.
 */
async function openSession() {
  showView('boot');
  clearMessage();

  let session;
  try {
    session = await callRpc('start_portal_session');
  } catch (err) {
    fail(err, openSession);
    return;
  }
  app.session = session ?? {};

  el.who.textContent =
    app.session.member_name || currentSession()?.user?.email || 'Signed in';

  if (!app.years.length) {
    try {
      app.years = await select('academic_years', {
        select: 'id,label,is_current,starts_on',
        order: 'starts_on.desc',
      });
    } catch (err) {
      fail(err, openSession);
      return;
    }
  }
  app.year = app.years.find((year) => year.is_current) ?? app.years[0] ?? null;

  if (!app.year) {
    showBlocked('Nothing to show yet', 'No year has been set up.');
    return;
  }

  route();
}

function route() {
  const claim = app.session.claim ?? null;

  if (app.session.member_id) {
    showView('portal');
    app.progress.open();
    return;
  }

  if (claim?.status === 'rejected') {
    showView('rejected');
    app.claim.showRejected(claim);
    return;
  }

  if (claim) {
    // Pending, or the state that cannot happen: approved and still not linked.
    // review_member_claim() has a postcondition that refuses to report a link
    // it did not make, so an approved claim always comes with a member_id and
    // is answered by the branch above. Landing here means somebody is between
    // two writes, and "an officer is looking at it" is the only thing that is
    // true either way. Loading the page again is what resolves it.
    showView('pending');
    app.claim.showPending(claim);
    return;
  }

  showView('search');
  app.claim.showSearch();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function context() {
  return {
    get memberId() {
      return app.session?.member_id ?? null;
    },
    get memberName() {
      return app.session?.member_name ?? null;
    },
    get year() {
      return app.year;
    },
    fail,
    note,
    clearMessage,
    /** A claim was just filed, or an officer's decision needs reading again. */
    reload: openSession,
    /** Declined, and they want another go at picking their name. */
    retryClaim: () => {
      showView('search');
      app.claim.showSearch();
    },
  };
}

function cacheElements() {
  Object.assign(el, {
    views: Object.fromEntries(VIEWS.map((view) => [view, $(`view-${view}`)])),

    topbar: $('topbar'),
    who: $('who'),
    signout: $('signout'),

    message: $('screen-message'),
    messageTitle: $('screen-message-title'),
    messageBody: $('screen-message-body'),
    messageAction: $('screen-message-action'),
    note: $('screen-note'),

    signinEmail: $('signin-email'),
    signinSubmit: $('signin-submit'),
    signinSubmitLabel: $('signin-submit-label'),
    signinMessage: $('signin-message'),
    signinMessageTitle: $('signin-message-title'),
    signinMessageBody: $('signin-message-body'),

    blockedTitle: $('blocked-title'),
    blockedBody: $('blocked-body'),
  });
}

function wire() {
  el.views.signin.addEventListener('submit', onSignInSubmit);
  el.signout.addEventListener('click', endSession);
}

export function start() {
  cacheElements();
  wire();

  const ctx = context();
  app.claim = createClaim(ctx);
  app.progress = createProgress(ctx);
  app.claim.mount();
  app.progress.mount();

  if (!IS_CONFIGURED) {
    showBlocked('Not connected yet', 'An officer needs to finish setting up this site.');
    return;
  }

  const redirect = captureRedirect();
  if (redirect?.error) {
    showSignIn(redirect.error);
    return;
  }

  if (!currentSession()) {
    showSignIn();
    return;
  }

  openSession();
}
