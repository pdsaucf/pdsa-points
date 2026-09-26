import { IS_CONFIGURED } from '../config.js';
import { currentSession, forgetSession, signOut, googleSignInUrl, completeGoogleSignIn, STORAGE_KEY } from './auth.js';
import { select, callRpc } from './rest.js';
import { describeOfficer } from './officer-errors.js';
import { createEvents } from './events.js';
import { createReview } from './review.js';
import { createRequirements } from './requirements.js';
import { createCategories } from './categories.js';
import { createProgress } from './progress.js';
import { createRoster } from './roster.js';
import { createMember } from './member.js';
import { createAccess } from './access.js';
import { createStorage } from './storage.js';
import { createSearch } from './search.js';
import { $, h, announce, setHidden, wireMenu } from './ui.js';
import { installButtonIcons } from './icons.js';

// The panels, in tab order. Each one is mounted once and reloaded when the
// year changes, so switching tabs costs nothing. Events is first: it is where
// an officer's day starts (make the event, print the code), and the app lands
// on it (see start()). The last four sit behind the Settings menu.
const TABS = ['events', 'review', 'progress', 'roster', 'requirements', 'categories', 'storage', 'access'];
const SETTINGS_TABS = ['requirements', 'categories', 'storage', 'access'];

// One member, in full. It is not a tab: it is opened from a name on the board
// or on the roster and closed back to whichever of those it came from, so
// clicking a name never loses the officer's place.
const PANELS = [...TABS, 'member'];

const PANEL_RECOVERY = {
  events: 'Events',
  review: 'Review',
  requirements: 'Requirements',
  categories: 'Categories',
  progress: 'Progress',
  roster: 'Roster',
  member: 'Member',
  storage: 'Storage',
  access: 'Access',
};

const el = {};
const app = {
  session: null,
  role: null,
  access: null,
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
  storageReloadQueue: Promise.resolve(),
  tab: 'events',
  returnTab: 'roster',
  now: () => new Date(),
};

let quietFailureDepth = 0;

async function quietRefresh(run) {
  quietFailureDepth += 1;
  try {
    return await run();
  } finally {
    quietFailureDepth -= 1;
  }
}

// ---------------------------------------------------------------------------
// Whole-screen states
// ---------------------------------------------------------------------------

function showView(name) {
  setHidden(el.boot, name !== 'boot');
  setHidden(el.signin, name !== 'signin');
  setHidden(el.denied, name !== 'denied');
  setHidden(el.appView, name !== 'app');
}

function showSignIn(status = '') {
  showView('signin');
  el.googleStatus.textContent = status;
  el.signinGoogle.disabled = false;
  el.signinGoogle.focus({ preventScroll: true });
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
function fail(err, retry, context = null, refresh = null) {
  const copy = describeOfficer(err, context);
  if (err?.code === 'PDS07' || err?.status === 403) {
    note('This action is not permitted.', 'warn');
    recheckAccess();
    return;
  }

  if (copy.recover === 'signin') {
    forgetSession();
    showSignIn(copy.title);
    return;
  }

  // A committed attendance mutation keeps its success strip while the
  // screens derived from it refresh in the background. Those reload methods
  // already preserve their last good state on failure. Replacing the success
  // with a secondary read error makes the completed mutation look refused.
  if (quietFailureDepth > 0) return;

  el.screenMessage.dataset.tone = 'warn';
  el.screenMessageTitle.textContent = copy.title;
  el.screenMessageBody.textContent = copy.body;

  if (copy.recover === 'refresh') {
    el.screenMessageAction.textContent = refresh?.label ?? 'Reload';
    el.screenMessageAction.onclick = () => {
      clearMessage();
      (refresh?.run ?? retry)?.();
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
    const identity = await callRpc('leadership_session', {});
    app.role = identity?.role;
    if (!['admin', 'officer'].includes(app.role)) {
      showDenied('This account has no PDSA access. Contact the Secretary.');
      return;
    }
    app.years = await select('academic_years', {
      select: 'id,label,is_current,starts_on',
      order: 'starts_on.desc',
    });
  } catch (err) {
    showDenied('Sign-in could not be checked. Try again.');
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

function context(panelName) {
  const panel = PANEL_RECOVERY[panelName];
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
    get isAdmin() { return app.role === 'admin'; },
    now: app.now,
    // Pass the original error through unchanged so describeOfficer can still
    // distinguish RpcError, NetworkError and an expired session. A refresh is
    // always the panel's read-only reload, never a mutation retry callback.
    fail: (err, retry, copyContext = null) =>
      fail(
        err,
        retry,
        { panel, ...(copyContext ?? {}) },
        {
          label: `Reload ${panel}`,
          run: () => app[panelName]?.reload(),
        },
      ),
    note,
    clearMessage,
    quietRefresh,
    setReviewCount: (count) => setCount(el.tabReviewCount, count),
    openMember,
    closeMember,
    // The member page's Remove. The dialog and the write belong to the
    // roster, which is also what has to reload afterwards.
    removeFromYear: (member, onRemoved) => app.roster?.askRemove(member, { onRemoved }),
    // An event's own screen sends an officer here for the one record it
    // cannot decide: a check-in with no member linked. The queue is where the
    // roster suggestions are, so this opens it already narrowed to that event
    // rather than leaving them to find it among the year's.
    openReview: (eventId) => {
      selectTab('review');
      app.review?.focusEvent(eventId);
    },
    openEvent: (eventId) => {
      selectTab('events');
      app.events?.open(eventId, { returnToReview: true });
    },
    // A record added by hand, or a name edited, changes a number the board and
    // the roster are both showing. They reload rather than being patched in
    // place, because the point total and the honorary star are the database's
    // answer and not something this screen may recompute.
    onMemberChanged: () =>
      quietRefresh(() =>
        Promise.allSettled([
          app.progress?.reload(),
          app.roster?.reload(),
          app.member?.currentId() ? app.member.reload() : undefined,
        ]),
      ),
    // A Remove that carried evidence creates or finishes purge bookkeeping
    // while the Storage panel is mounted but may be hidden. Reload it now so
    // opening Storage never shows the snapshot from before the removal.
    onStorageChanged: () => {
      const reload = () => quietRefresh(() => app.storage?.reload());
      const next = app.storageReloadQueue.then(reload, reload);
      app.storageReloadQueue = next.catch(() => undefined);
      return next;
    },
    onRosterChanged: () => quietRefresh(() => app.progress?.reload()),
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
    onEventsChanged: () =>
      quietRefresh(() => Promise.allSettled([app.review?.reload(), app.progress?.reload()])),
  };
}

function showPanel(name) {
  for (const panel of PANELS) setHidden(el.panels[panel], panel !== name);
  for (const tab of TABS) {
    el.tabs[tab].setAttribute('aria-selected', String(tab === name));
  }
  el.settingsToggle.dataset.active = String(SETTINGS_TABS.includes(name));
}

function selectTab(tab) {
  if (app.role === 'officer' && !['events', 'roster', 'progress'].includes(tab)) return;
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

  const email = app.session.user.email || '';
  el.who.textContent = email || 'Signed in';
  el.accountInitial.textContent = (email.trim()[0] ?? '?').toUpperCase();

  el.yearSelect.replaceChildren(
    ...app.years.map((year) => h('option', { value: year.id }, year.label)),
  );
  el.yearSelect.value = app.year.id;

  app.events = createEvents(context('events'));
  app.progress = createProgress(context('progress'));
  app.roster = createRoster(context('roster'));
  app.member = createMember(context('member'));
  for (const name of ['review', ...SETTINGS_TABS]) {
    setHidden(el.tabs[name], app.role !== 'admin');
  }
  setHidden(el.settingsMenu, app.role !== 'admin');
  createSearch({
    get year() {
      return app.year;
    },
    openMember,
    openEvent: (eventId) => {
      selectTab('events');
      app.events?.open(eventId);
    },
    fail: (err, retry) => fail(err, retry, { panel: 'Search' }),
  }).mount();
  if (app.role === 'admin') {
    app.review = createReview(context('review'));
    app.requirements = createRequirements(context('requirements'));
    app.categories = createCategories(context('categories'));
    app.storage = createStorage(context('storage'));
    app.access = createAccess(context('access'));
    app.review.mount();
    app.requirements.mount();
    app.categories.mount();
    app.storageReloadQueue = Promise.resolve(app.storage.mount());
    app.access.mount();
  }
  app.events.mount();
  app.progress.mount();
  app.roster.mount();
  app.member.mount();

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

    signinGoogle: $('signin-google'),
    googleStatus: $('google-status'),

    deniedBody: $('denied-body'),
    deniedSignout: $('denied-signout'),

    yearSelect: $('year-select'),
    tabs: {
      events: $('tab-events'),
      review: $('tab-review'),
      progress: $('tab-progress'),
      roster: $('tab-roster'),
      requirements: $('tab-requirements'),
      categories: $('tab-categories'),
      storage: $('tab-storage'),
      access: $('tab-access'),
    },
    panels: {
      events: $('panel-events'),
      review: $('panel-review'),
      progress: $('panel-progress'),
      roster: $('panel-roster'),
      requirements: $('panel-requirements'),
      categories: $('panel-categories'),
      storage: $('panel-storage'),
      access: $('panel-access'),
      member: $('panel-member'),
    },
    tabReviewCount: $('tab-review-count'),
    settingsMenu: $('settings-menu'),
    settingsToggle: $('settings-toggle'),
    settingsList: $('settings-list'),
    accountToggle: $('account-toggle'),
    accountList: $('account-list'),
    accountInitial: $('account-initial'),
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
  el.signinGoogle.addEventListener('click', async () => {
    el.signinGoogle.disabled = true;
    el.googleStatus.textContent = '';
    try {
      window.location.assign(await googleSignInUrl());
    } catch {
      showSignIn('Google sign-in failed. Try again.');
    }
  });
  $('denied-retry').addEventListener('click', guard);
  window.addEventListener('focus', recheckAccess);
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) window.location.reload();
  });
  el.deniedSignout.addEventListener('click', endSession);
  el.signout.addEventListener('click', endSession);
  for (const name of TABS) {
    el.tabs[name].addEventListener('click', () => selectTab(name));
  }
  wireMenu(el.settingsToggle, el.settingsList);
  wireMenu(el.accountToggle, el.accountList);

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

export function start({ now = () => new Date() } = {}) {
  app.now = now;
  installButtonIcons();
  cacheElements();
  wire();
  selectTab('events');

  if (!IS_CONFIGURED) {
    showDenied('No database is connected. An admin needs to fill in web/config.js.');
    el.deniedSignout.hidden = true;
    return;
  }

  completeGoogleSignIn().then(guard).catch(() => {
    showSignIn('Google sign-in did not complete. Try again.');
  });
}

let checkingAccess = false;
async function recheckAccess() {
  if (checkingAccess || !app.role || !currentSession()) return;
  checkingAccess = true;
  try {
    const identity = await callRpc('leadership_session', {});
    if (identity?.role !== app.role) window.location.replace(window.location.pathname);
  } catch (err) {
    if (err?.status === 401) { forgetSession(); showSignIn(); }
  } finally { checkingAccess = false; }
}
