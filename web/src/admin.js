// The admin shell: signing in and handing the screen to the admin tools.
//
// THE GUARD IS THE POINT OF THIS FILE. An unauthenticated visitor to /admin/
// gets the sign-in form, never a half-drawn queue that fills with 401s. A
// A valid session is the complete authorization decision. The page uses one
// fixed GoTrue user behind one shared passcode, with no profiles or role layer.

import { IS_CONFIGURED } from '../config.js';
import { signInWithPasscode, currentSession, forgetSession, signOut } from './auth.js';
import { select } from './rest.js';
import { describeOfficer, describeSignIn } from './officer-errors.js';
import { createEvents } from './events.js';
import { createReview } from './review.js';
import { createRequirements } from './requirements.js';
import { createCategories } from './categories.js';
import { createProgress } from './progress.js';
import { createRoster } from './roster.js';
import { createMember } from './member.js';
import { createStorage } from './storage.js';
import { $, h, announce, setHidden } from './ui.js';
import { installButtonIcons } from './icons.js';

// The six panels, in tab order. Each one is mounted once and reloaded when
// the year changes, so switching tabs costs nothing. Events is first: it is
// where an officer's day starts (make the event, print the code), and the
// app lands on it (see start()).
const TABS = ['events', 'review', 'progress', 'roster', 'requirements', 'storage'];

// One member, in full. It is not a tab: it is opened from a name on the board
// or on the roster and closed back to whichever of those it came from, so
// clicking a name never loses the officer's place.
const PANELS = [...TABS, 'member'];

const el = {};
const app = {
  session: null,
  years: [],
  year: null,
  events: null,
  review: null,
  requirements: null,
  categories: null,
  progress: null,
  roster: null,
  member: null,
  storage: null,
  tab: 'events',
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
    userId: app.session.user.id,
    fail,
    note,
    clearMessage,
    setReviewCount: (count) => setCount(el.tabReviewCount, count),
    openMember,
    closeMember,
    // An event's own screen sends an officer here for the one record it
    // cannot decide: a check-in with no member linked. The queue is where the
    // roster suggestions are, so this opens it already narrowed to that event
    // rather than leaving them to find it among the year's.
    openReview: (eventId) => {
      selectTab('review');
      app.review?.focusEvent(eventId);
    },
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
    // Requirements and Events can make a category inline. The manager in the
    // Honorary requirements workspace re-reads the shared category table.
    onCategoriesChanged: () => {
      app.categories?.reload();
    },
    // Renaming, reordering or retiring a category changes every screen that
    // consumes the shared category table.
    onCategoryManagerChanged: () => {
      app.requirements?.reload();
      app.events?.reload();
      app.progress?.reload();
    },
    // A new or edited event can change which events the review queue's
    // filter offers, and an event's categories changing can change the
    // board underneath it.
    onEventsChanged: () => {
      app.review?.reload();
      app.progress?.reload();
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

  el.who.textContent = app.session.user.email || 'Signed in';

  el.yearSelect.replaceChildren(
    ...app.years.map((year) => h('option', { value: year.id }, year.label)),
  );
  el.yearSelect.value = app.year.id;

  const ctx = context();
  app.events = createEvents(ctx);
  app.review = createReview(ctx);
  app.requirements = createRequirements(ctx);
  app.categories = createCategories(ctx);
  app.progress = createProgress(ctx);
  app.roster = createRoster(ctx);
  app.member = createMember(ctx);
  app.storage = createStorage(ctx);

  app.events.mount();
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
      events: $('tab-events'),
      review: $('tab-review'),
      progress: $('tab-progress'),
      roster: $('tab-roster'),
      requirements: $('tab-requirements'),
      storage: $('tab-storage'),
    },
    panels: {
      events: $('panel-events'),
      review: $('panel-review'),
      progress: $('panel-progress'),
      roster: $('panel-roster'),
      requirements: $('panel-requirements'),
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
    // Synchronously, before any request goes out: an event or a form left up
    // through a slow reload is pressable under a selector that already names
    // the new year, and saving in that gap writes into the year the officer
    // is no longer looking at.
    app.events?.yearChanged();
    app.events?.reload();
    app.review?.reload();
    // Requirements are scoped to the year in the top bar, so this is the one
    // control that decides which rules are on screen.
    app.requirements?.reload();
    // Each category's usage count is per year, so a year change without this
    // would leave last year's counts on screen under this year's selector.
    app.categories?.reload();
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
  installButtonIcons();
  cacheElements();
  wire();
  selectTab('events');

  if (!IS_CONFIGURED) {
    showDenied('No database is connected. An admin needs to fill in web/config.js.');
    el.deniedSignout.hidden = true;
    return;
  }

  guard();
}
