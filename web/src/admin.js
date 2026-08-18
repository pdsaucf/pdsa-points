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
//   admin    everything, including publishing the requirements
//   officer  the whole review queue
//   viewer   reads the queue, decides nothing. fn_is_staff() lets them see it,
//            and fn_assert_officer() would refuse every action, so the buttons
//            are not offered rather than offered and then refused
//   member   refused outright, with a pointer at the portal that is theirs

import { IS_CONFIGURED } from '../config.js';
import { signInWithPasscode, currentSession, forgetSession, signOut } from './auth.js';
import { select } from './rest.js';
import { describeOfficer, describeSignIn } from './officer-errors.js';
import { createReview } from './review.js';
import { createRequirements } from './requirements.js';
import { createCategories } from './categories.js';
import { createProgress } from './progress.js';
import { createRoster } from './roster.js';
import { createMember } from './member.js';
import { createStorage } from './storage.js';
import { $, h, announce, setHidden } from './ui.js';

const REVIEWING_ROLES = ['officer', 'admin'];
const READING_ROLES = ['officer', 'admin', 'viewer'];

// The six panels, in tab order. Each one is mounted once and reloaded when the
// year changes, so switching tabs costs nothing.
const TABS = ['review', 'progress', 'roster', 'requirements', 'categories', 'storage'];

// One member, in full. It is not a tab: it is opened from a name on the board
// or on the roster and closed back to whichever of those it came from, so
// clicking a name never loses the officer's place.
const PANELS = [...TABS, 'member'];

const el = {};
const app = {
  session: null,
  profile: null,
  years: [],
  year: null,
  review: null,
  requirements: null,
  categories: null,
  progress: null,
  roster: null,
  member: null,
  storage: null,
  tab: 'review',
  returnTab: 'roster',
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

/**
 * The passcode screen. `status` is said only to a screen reader: the visible
 * signal is the box itself, because a sentence on this page would undo the
 * reason it looks the way it does.
 */
function showSignIn(status) {
  showView('signin');
  el.signinPasscode.setAttribute('aria-invalid', String(Boolean(status)));
  el.signinStatus.textContent = status ?? '';
  if (status) announce(status);
  el.signinPasscode.focus({ preventScroll: true });
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

  // The roster's refused-import list is the rest of this same report: the
  // strip says what an import wrote, the list says which lines it could not.
  // Leaving the list up after the strip has gone offers an officer a set of
  // line numbers with nothing left on screen saying which run they came from,
  // and the run they came from may be two files ago.
  app.roster?.clearReport?.();
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
 *
 */
function fail(err, retry) {
  const copy = describeOfficer(err);

  if (copy.recover === 'signin') {
    forgetSession();
    showSignIn(copy.title);
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
  const passcode = el.signinPasscode.value;
  if (!passcode) {
    showSignIn('Enter the passcode.');
    return;
  }

  // No "Signing in…" label to change, because there is no button. The box goes
  // read-only for the round trip so a second Enter cannot start a second one.
  el.signinPasscode.readOnly = true;
  el.signinPasscode.setAttribute('aria-invalid', 'false');
  try {
    await signInWithPasscode(passcode);
    el.signinPasscode.value = '';
    guard();
  } catch (err) {
    el.signinPasscode.select();
    showSignIn(describeSignIn(err));
  } finally {
    el.signinPasscode.readOnly = false;
  }
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
    // Either way this lands on the passcode box, which is the only thing the
    // officer can do about it. The session is cleared only when the failure
    // says the session is the problem: a dropped connection is not a reason to
    // make somebody type the passcode again once the wifi comes back.
    if (copy.recover === 'signin') forgetSession();
    showSignIn(copy.title);
    return;
  }

  const profile = profiles[0] ?? null;

  // Signed in with no profile row at all. That is an account nobody has set
  // up, which is different from an account that is set up as something else.
  if (!profile) {
    showDenied('This account has no role yet. An admin needs to set one.');
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
    // The requirements screen copies a set from another year, and names the
    // year a category's rules live in, so it needs the whole calendar.
    get years() {
      return app.years;
    },
    userId: app.profile.user_id,
    role: app.profile.role,
    canReview: REVIEWING_ROLES.includes(app.profile.role),
    // Publishing a requirement set is the one action an officer is refused.
    // req_sets_write in migration 11 admits an officer for drafts only, so the
    // screen says so rather than offering a button the database will turn down.
    canPublish: app.profile.role === 'admin',
    fail,
    note,
    clearMessage,
    setReviewCount: (count) => setCount(el.tabReviewCount, count),
    openMember,
    closeMember,
    // A record added by hand, or a name edited, changes a number the board and
    // the roster are both showing. They reload rather than being patched in
    // place, because the point total and the honorary star are the database's
    // answer and not something this screen may recompute.
    onMemberChanged: () => {
      app.progress?.reload();
      app.roster?.reload();
    },
    onRosterChanged: () => {
      app.progress?.reload();
    },
    // The requirements screen can make a category, so the screen that manages
    // them re-reads rather than showing a list that is one row short.
    onCategoriesChanged: () => {
      app.categories?.reload();
    },
  };
}

function showPanel(name) {
  for (const panel of PANELS) setHidden(el.panels[panel], panel !== name);
  for (const tab of TABS) {
    el.tabs[tab].setAttribute('aria-selected', String(tab === name));
  }
}

function selectTab(tab) {
  app.tab = tab;
  showPanel(tab);
  clearMessage();
}

function openMember(memberId) {
  app.returnTab = app.tab === 'member' ? app.returnTab : app.tab;
  app.tab = 'member';
  showPanel('member');
  clearMessage();
  app.member?.open(memberId);
}

function closeMember() {
  selectTab(app.returnTab);
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
  app.requirements = createRequirements(ctx);
  app.categories = createCategories(ctx);
  app.progress = createProgress(ctx);
  app.roster = createRoster(ctx);
  app.member = createMember(ctx);
  app.storage = createStorage(ctx);

  app.review.mount();
  app.requirements.mount();
  app.categories.mount();
  app.progress.mount();
  app.roster.mount();
  app.member.mount();
  app.storage.mount();
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
    signinPasscode: $('signin-passcode'),
    signinStatus: $('signin-status'),

    deniedBody: $('denied-body'),
    deniedSignout: $('denied-signout'),

    yearSelect: $('year-select'),
    tabs: {
      review: $('tab-review'),
      progress: $('tab-progress'),
      roster: $('tab-roster'),
      requirements: $('tab-requirements'),
      categories: $('tab-categories'),
      storage: $('tab-storage'),
    },
    panels: {
      review: $('panel-review'),
      progress: $('panel-progress'),
      roster: $('panel-roster'),
      requirements: $('panel-requirements'),
      categories: $('panel-categories'),
      storage: $('panel-storage'),
      member: $('panel-member'),
    },
    tabReviewCount: $('tab-review-count'),
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
  for (const name of TABS) {
    el.tabs[name].addEventListener('click', () => selectTab(name));
  }

  el.yearSelect.addEventListener('change', () => {
    const year = app.years.find((y) => y.id === el.yearSelect.value);
    if (!year) return;
    app.year = year;
    clearMessage();
    app.review?.reload();
    // Requirements are scoped to the year in the top bar, so this is the one
    // control that decides which rules are on screen.
    app.requirements?.reload();
    // Every number on these three is per year: the totals, the star, who is on
    // the roster, and which records a member has. A year change that left them
    // showing last year's figures is the "why do the numbers look wrong"
    // question the year selector exists to answer.
    app.progress?.reload();
    app.roster?.reload();
    if (app.tab === 'member') app.member?.reload();
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

  guard();
}
