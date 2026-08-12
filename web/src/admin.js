// The admin shell: signing in, working out what this account is allowed to do,
// and handing the screen to the review queue.
//
// THE GUARD IS THE POINT OF THIS FILE. An unauthenticated visitor to /admin/
// gets the sign-in form, never a half-drawn queue that fills with 401s. A
// signed-in member gets a plain sentence saying this is not their screen, not
// an empty queue that looks broken. Both of those are RLS decisions really: the
// database would refuse them anyway. What this adds is that the refusal is
// legible before it happens rather than as a wall of failed requests.
//
// Roles come from profiles.role, read through PostgREST under the caller's own
// policy (profiles_read_own). Three of the four values reach this screen:
//
//   admin    everything, including finishing an account claim
//   officer  the whole review queue
//   viewer   reads the queue, decides nothing. fn_is_staff() lets them see it,
//            and fn_assert_officer() would refuse every action, so the buttons
//            are not offered rather than offered and then refused
//   member   refused outright, with a pointer at the portal that is theirs

import { IS_CONFIGURED } from '../config.js';
import {
  sendMagicLink,
  parseAuthRedirect,
  adoptSession,
  currentSession,
  forgetSession,
  signOut,
} from './auth.js';
import { select } from './rest.js';
import { describeOfficer, describeSignIn } from './officer-errors.js';
import { createReview } from './review.js';
import { createClaims } from './claims.js';
import { $, h, announce, setHidden } from './ui.js';

const REVIEWING_ROLES = ['officer', 'admin'];
const READING_ROLES = ['officer', 'admin', 'viewer'];

const el = {};
const app = {
  session: null,
  profile: null,
  years: [],
  year: null,
  review: null,
  claims: null,
  tab: 'review',
};

// ---------------------------------------------------------------------------
// Whole-screen states
// ---------------------------------------------------------------------------

function showView(name) {
  setHidden(el.boot, name !== 'boot');
  setHidden(el.signin, name !== 'signin');
  setHidden(el.denied, name !== 'denied');
  setHidden(el.appView, name !== 'app');
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

function showDenied(body) {
  showView('denied');
  el.deniedBody.textContent = body;
  announce(body);
}

// ---------------------------------------------------------------------------
// The message strip the panels talk through
// ---------------------------------------------------------------------------

function clearMessage() {
  setHidden(el.screenMessage, true);
  el.screenMessageTitle.textContent = '';
  el.screenMessageBody.textContent = '';
  setHidden(el.screenMessageAction, true);
  el.screenMessageAction.onclick = null;
}

/** A plain confirmation, or a warning. Never an error: those go through fail(). */
function note(text, tone = 'ok') {
  el.screenMessage.dataset.tone = tone;
  el.screenMessageTitle.textContent = text;
  el.screenMessageBody.textContent = '';
  setHidden(el.screenMessageAction, true);
  setHidden(el.screenMessage, false);
}

/**
 * Something went wrong. The copy comes from officer-errors.js, and what the
 * button does comes from the same place, so no caller has to work out whether
 * a given failure is worth retrying.
 */
function fail(err, retry) {
  const copy = describeOfficer(err);

  if (copy.recover === 'signin') {
    forgetSession();
    showSignIn({ title: copy.title, body: copy.body });
    return;
  }

  el.screenMessage.dataset.tone = 'warn';
  el.screenMessageTitle.textContent = copy.title;
  el.screenMessageBody.textContent = copy.body;

  if (copy.recover === 'refresh') {
    el.screenMessageAction.textContent = 'Reload the queue';
    el.screenMessageAction.onclick = () => {
      clearMessage();
      app.review?.reload();
      app.claims?.reload();
    };
    setHidden(el.screenMessageAction, false);
  } else if (copy.recover === 'retry' && retry) {
    el.screenMessageAction.textContent = 'Try again';
    el.screenMessageAction.onclick = () => {
      clearMessage();
      retry();
    };
    setHidden(el.screenMessageAction, false);
  } else {
    setHidden(el.screenMessageAction, true);
  }

  setHidden(el.screenMessage, false);
  announce(`${copy.title}. ${copy.body}`);
}

// ---------------------------------------------------------------------------
// Counts in the tabs
// ---------------------------------------------------------------------------

function setCount(node, count) {
  node.textContent = String(count);
  node.dataset.zero = String(count === 0);
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
      body: 'Use the address your officer account was set up with.',
    });
    return;
  }

  el.signinSubmit.disabled = true;
  el.signinSubmitLabel.textContent = 'Sending…';
  try {
    // Back to this exact page, with no hash and no query of our own, so the
    // tokens GoTrue appends are the only thing in the fragment.
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    await sendMagicLink(email, redirectTo);
    showSignIn({
      title: 'Check your inbox.',
      body: `If ${email} has an officer account, a sign-in link is on its way. It works once.`,
    });
  } catch (err) {
    showSignIn(describeSignIn(err));
  } finally {
    el.signinSubmit.disabled = false;
    el.signinSubmitLabel.textContent = 'Email me a sign-in link';
  }
}

/**
 * The tokens arrive in the URL fragment. They are taken out of the address bar
 * straight away: a sign-in link that stays in the history, or gets pasted into
 * a chat, is a live session anybody can pick up.
 */
function captureRedirect() {
  const result = parseAuthRedirect(window.location.href);
  if (!result) return null;

  window.history.replaceState(null, '', window.location.pathname);

  if (result.error) {
    return {
      error: {
        title: 'That sign-in link did not work',
        body: result.error.description || 'Links work once and expire. Ask for a new one below.',
      },
    };
  }

  adoptSession(result.session);
  return { signedIn: true };
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

async function guard() {
  showView('boot');

  const session = currentSession();
  if (!session) {
    showSignIn();
    return;
  }
  app.session = session;

  let profiles;
  try {
    profiles = await select('profiles', {
      select: 'user_id,full_name,role,member_id',
      filters: { user_id: `eq.${session.user.id}` },
      limit: 1,
    });
  } catch (err) {
    const copy = describeOfficer(err);
    if (copy.recover === 'signin') {
      forgetSession();
      showSignIn({ title: copy.title, body: copy.body });
    } else {
      showSignIn({
        title: 'Could not check your account',
        body: `${copy.body} Send yourself a new link.`,
      });
    }
    return;
  }

  const profile = profiles[0] ?? null;

  // Signed in with no profile row at all. That is an account nobody has set
  // up, which is different from an account that is set up as something else.
  if (!profile) {
    showDenied('This address has no account yet. An admin needs to add it.');
    return;
  }

  app.profile = profile;

  if (!READING_ROLES.includes(profile.role)) {
    showDenied(
      profile.role === 'member'
        ? 'This is a member account.'
        : 'An admin can give this account officer access.',
    );
    return;
  }

  try {
    app.years = await select('academic_years', {
      select: 'id,label,is_current,starts_on',
      order: 'starts_on.desc',
    });
  } catch (err) {
    fail(err, guard);
    showView('app');
    return;
  }

  app.year = app.years.find((y) => y.is_current) ?? app.years[0] ?? null;
  if (!app.year) {
    showDenied('No academic year is set up yet. An admin needs to add one.');
    return;
  }

  startApp();
}

// ---------------------------------------------------------------------------
// The product
// ---------------------------------------------------------------------------

function context() {
  return {
    get year() {
      return app.year;
    },
    userId: app.profile.user_id,
    role: app.profile.role,
    canReview: REVIEWING_ROLES.includes(app.profile.role),
    fail,
    note,
    clearMessage,
    setReviewCount: (count) => setCount(el.tabReviewCount, count),
    setClaimCount: (count) => setCount(el.tabClaimsCount, count),
  };
}

function selectTab(tab) {
  app.tab = tab;
  el.tabReview.setAttribute('aria-selected', String(tab === 'review'));
  el.tabClaims.setAttribute('aria-selected', String(tab === 'claims'));
  setHidden(el.panelReview, tab !== 'review');
  setHidden(el.panelClaims, tab !== 'claims');
  clearMessage();
}

function startApp() {
  showView('app');

  el.who.textContent = [
    app.profile.full_name || app.session.user.email || 'Signed in',
    app.profile.role,
  ]
    .filter(Boolean)
    .join(' · ');

  el.yearSelect.replaceChildren(
    ...app.years.map((year) => h('option', { value: year.id }, year.label)),
  );
  el.yearSelect.value = app.year.id;

  const ctx = context();
  app.review = createReview(ctx);
  app.claims = createClaims(ctx);

  app.review.mount();
  app.claims.mount();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function cacheElements() {
  Object.assign(el, {
    boot: $('view-boot'),
    signin: $('view-signin'),
    denied: $('view-denied'),
    appView: $('view-app'),

    signinForm: $('signin-form'),
    signinEmail: $('signin-email'),
    signinSubmit: $('signin-submit'),
    signinSubmitLabel: $('signin-submit-label'),
    signinMessage: $('signin-message'),
    signinMessageTitle: $('signin-message-title'),
    signinMessageBody: $('signin-message-body'),

    deniedBody: $('denied-body'),
    deniedSignout: $('denied-signout'),

    yearSelect: $('year-select'),
    tabReview: $('tab-review'),
    tabClaims: $('tab-claims'),
    tabReviewCount: $('tab-review-count'),
    tabClaimsCount: $('tab-claims-count'),
    panelReview: $('panel-review'),
    panelClaims: $('panel-claims'),
    who: $('who'),
    signout: $('signout'),

    screenMessage: $('screen-message'),
    screenMessageTitle: $('screen-message-title'),
    screenMessageBody: $('screen-message-body'),
    screenMessageAction: $('screen-message-action'),
  });
}

async function endSession() {
  await signOut();
  window.location.replace(window.location.pathname);
}

function wire() {
  el.signinForm.addEventListener('submit', onSignInSubmit);
  el.deniedSignout.addEventListener('click', endSession);
  el.signout.addEventListener('click', endSession);
  el.tabReview.addEventListener('click', () => selectTab('review'));
  el.tabClaims.addEventListener('click', () => selectTab('claims'));

  el.yearSelect.addEventListener('change', () => {
    const year = app.years.find((y) => y.id === el.yearSelect.value);
    if (!year) return;
    app.year = year;
    clearMessage();
    app.review?.reload();
  });
}

export function start() {
  cacheElements();
  wire();
  selectTab('review');

  if (!IS_CONFIGURED) {
    showDenied('No database is connected. An admin needs to fill in web/config.js.');
    el.deniedSignout.hidden = true;
    return;
  }

  const redirect = captureRedirect();
  if (redirect?.error) {
    showSignIn(redirect.error);
    return;
  }

  guard();
}
