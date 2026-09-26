// The public events page: /events.
//
// Members open this to read what is coming up. There is no name to type, no
// lookup, and no personalization: /me already answers "what did I attend",
// this page answers "what is happening". docs/05-events-page.md.
//
// INVARIANT 3 HOLDS HERE EXACTLY AS IT DOES FOR /me AND /c. This page calls
// one SECURITY DEFINER function, portal_events(), and touches no table. It
// sends the anon key and never a session, so it behaves the same for a
// member, an officer with a laptop open, and a stranger with the link.
//
// WHAT IS SHARED WITH THE OTHER SCREENS
//
//   src/api.js            the anonymous request path, with the retry budgets
//                          and the per-attempt timeout. Same one /me and /c use.
//   src/ui.js              the DOM helpers, including announce().
//   src/events-model.js    todayInNewYork(), so "Today" is computed the same
//                          way the admin event list computes it.
//   src/portal-record.js   easternTime(), so a time reads the same way it
//                          does on a member's own attendance record.

import { IS_CONFIGURED } from '../config.js';
import { rpc } from './api.js';
import { RpcError, NetworkError } from './errors.js';
import { todayInNewYork } from './events-model.js';
import { easternTime } from './portal-record.js';
import { $, h, announce, setHidden } from './ui.js';

const el = {};

function cacheElements() {
  Object.assign(el, {
    message: $('screen-message'),
    messageTitle: $('screen-message-title'),
    messageBody: $('screen-message-body'),
    messageAction: $('screen-message-action'),
    loading: $('loading'),
    empty: $('empty'),
    groups: $('event-groups'),
  });
}

// ---------------------------------------------------------------------------
// The message strip
// ---------------------------------------------------------------------------

function clearMessage() {
  setHidden(el.message, true);
  el.messageTitle.textContent = '';
  el.messageBody.textContent = '';
  setHidden(el.messageAction, true);
  el.messageAction.onclick = null;
}

/**
 * Turns anything thrown by api.js into copy for this page.
 *
 * A page-specific register rather than a reuse of member-errors.js: this
 * screen has no name to be wrong and nobody to be "not on this year's
 * roster", so the one failure that can reach a reader here is the request
 * itself not landing.
 */
function describeEventsError(err) {
  if (err instanceof NetworkError) {
    return {
      title: 'No connection',
      body: 'Nothing is lost. Try again when you have a signal.',
    };
  }
  if (err instanceof RpcError && err.status >= 500) {
    return { title: 'Not responding', body: 'Wait a few seconds, then try again.' };
  }
  return { title: 'Could not load events', body: 'Try again.' };
}

function fail(err) {
  const copy = describeEventsError(err);
  el.messageTitle.textContent = copy.title;
  el.messageBody.textContent = copy.body;
  el.messageAction.textContent = 'Try again';
  el.messageAction.onclick = () => {
    clearMessage();
    load();
  };
  setHidden(el.messageAction, false);
  setHidden(el.message, false);
  announce(`${copy.title}. ${copy.body}`);
}

// ---------------------------------------------------------------------------
// Drawing one event
// ---------------------------------------------------------------------------

/** A value parses as a link only when it is an actual http(s) URL. */
function isHttpUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const factRow = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));

/**
 * 'GBMs 2 · Volunteering Varies', named category by category so nothing here
 * ever prints a total: an event with one from_submission category has no
 * fixed figure to sum, and "0" would read as a promise this page cannot make.
 */
function pointsLabel(categories) {
  if (!categories?.length) return null;
  return categories
    .map((category) => {
      const value =
        category.credit_mode === 'from_submission' ? 'Varies' : String(Number(category.fixed_credit ?? 0));
      return `${category.name} ${value}`;
    })
    .join(', ');
}

function eventCard(event) {
  const facts = [];
  if (event.location) facts.push(factRow('Location', event.location));
  if (event.attire) facts.push(factRow('Attire', event.attire));
  const points = pointsLabel(event.categories);
  if (points) facts.push(factRow('Points', points));
  // A non-URL sign-up is a fact like any other; a URL becomes its own button
  // below instead, so it is never printed twice.
  if (event.signup && !isHttpUrl(event.signup)) facts.push(factRow('Sign up', event.signup));

  const time =
    event.starts_at && event.ends_at
      ? h('p', { class: 'event-card-time' }, `${easternTime(event.starts_at)} to ${easternTime(event.ends_at)}`)
      : null;

  return h(
    'article',
    { class: 'event-card' },
    h('h3', { class: 'event-card-title' }, event.title),
    time,
    facts.length ? h('dl', { class: 'event-card-facts' }, ...facts) : null,
    event.description ? h('p', { class: 'event-card-description' }, event.description) : null,
    isHttpUrl(event.signup)
      ? h(
          'a',
          {
            class: 'button button-primary event-card-signup',
            href: event.signup,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'Sign up',
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Grouping by date
// ---------------------------------------------------------------------------

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

/** 'Today', or 'Thursday, Sep 10' for occurred_on ('YYYY-MM-DD'), parsed by parts. */
function dateHeadingLabel(occurredOn, today) {
  if (occurredOn === today) return 'Today';
  const [y, m, d] = String(occurredOn).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(occurredOn);
  return weekdayFormatter.format(new Date(y, m - 1, d));
}

/**
 * portal_events() already returns events ascending by date, so grouping
 * consecutive rows sharing one occurred_on is enough: nothing here re-sorts.
 */
function groupByDate(events) {
  const groups = [];
  for (const event of events) {
    const date = String(event.occurred_on).slice(0, 10);
    const current = groups.at(-1);
    if (!current || current.date !== date) groups.push({ date, events: [event] });
    else current.events.push(event);
  }
  return groups;
}

function renderGroups(events) {
  const today = todayInNewYork();
  el.groups.replaceChildren(
    ...groupByDate(events).map((group) =>
      h(
        'section',
        { class: 'event-date-group' },
        h(
          'h2',
          { class: 'event-date-heading', dataset: { today: String(group.date === today) } },
          dateHeadingLabel(group.date, today),
        ),
        h('div', { class: 'event-cards' }, ...group.events.map(eventCard)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load() {
  clearMessage();
  setHidden(el.loading, false);
  setHidden(el.empty, true);
  setHidden(el.groups, true);
  try {
    const answer = await rpc('portal_events', {});
    const events = Array.isArray(answer?.events) ? answer.events : [];
    setHidden(el.loading, true);
    if (!events.length) {
      setHidden(el.empty, false);
      return;
    }
    renderGroups(events);
    setHidden(el.groups, false);
  } catch (err) {
    setHidden(el.loading, true);
    fail(err);
  }
}

// ---------------------------------------------------------------------------

export function start() {
  cacheElements();
  $('footer-year').textContent = new Date().getFullYear();

  if (!IS_CONFIGURED) {
    el.messageTitle.textContent = 'This page is not connected yet';
    el.messageBody.textContent = 'Ask an officer.';
    setHidden(el.messageAction, true);
    setHidden(el.message, false);
    setHidden(el.loading, true);
    return;
  }

  load();
}
