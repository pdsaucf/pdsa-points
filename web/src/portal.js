// The member portal: /me.
//
// A member types their name and reads their points. That is the whole product
// on this page, and it is a much smaller page than it was.
//
// The earlier signed-in member account and claim flow has been removed. The club
// does not have addresses for its members and is not collecting any, so the
// identifying question is asked directly: what is your name.
//
// NOTHING ON THIS PAGE IS AUTHENTICATED, and that is deliberate rather than
// convenient. Every call goes through api.js, which sends the anon key and never
// a session, so this page behaves the same for a member, an officer with a
// laptop open, and a stranger with the link. The four functions it calls are
// SECURITY DEFINER and shaped: they answer with the club-facing figures and
// nothing else. The reasoning, including what that does expose, is written out
// in supabase/migrations/20260817110000_public_member_portal.sql.
//
// THE VERDICT IS STILL POSTGRES'S. is_honorary and every requirement's pass or
// fail arrive from fn_member_requirement_status() through the scorecard call.
// Nothing here decides whether somebody is honorary (invariant 2), and nothing
// here knows what a threshold is: it draws the rows it is given.
//
// WHAT IS SHARED WITH THE OTHER SCREENS
//
//   src/api.js       the anonymous request path, with the retry budgets and the
//                    per-attempt timeout. The check-in page uses the same one.
//   src/ui.js        the DOM helpers, including announce(), so this page talks
//                    to a screen reader the way the admin app does.
//   src/requirement-model.js  buildTree and flatten. The requirement list is
//                    the published rule set, drawn.

import { IS_CONFIGURED } from '../config.js';
import { rpc } from './api.js';
import { describeMember } from './member-errors.js';
import { createScorecard } from './portal-scorecard.js';
import { createLeaderboard } from './portal-leaderboard.js';
import { createHistory } from './portal-history.js';
import { $, h, announce, setHidden } from './ui.js';
import { installButtonIcons } from './icons.js';

const el = {};
const app = {
  scorecard: null,
  history: null,
  leaderboard: null,
  tab: 'points',
  candidates: [],
  looking: false,
};

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

function fail(err, retry) {
  const copy = describeMember(err);
  el.messageTitle.textContent = copy.title;
  el.messageBody.textContent = copy.body;

  if (copy.recover === 'reload') {
    el.messageAction.textContent = 'Reload';
    el.messageAction.onclick = () => window.location.reload();
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
// The two tabs
// ---------------------------------------------------------------------------

function selectTab(tab) {
  app.tab = tab;
  setHidden(el.viewPoints, tab !== 'points');
  setHidden(el.viewBoard, tab !== 'board');
  el.tabPoints.setAttribute('aria-selected', String(tab === 'points'));
  el.tabBoard.setAttribute('aria-selected', String(tab === 'board'));
  clearMessage();

  // Read once, on the first visit. A member switching back and forth is not
  // asking for a fresh count of the whole club each time.
  if (tab === 'board') app.leaderboard.open();
}

// ---------------------------------------------------------------------------
// Looking yourself up
// ---------------------------------------------------------------------------

function refuse(message) {
  el.lookupError.textContent = message;
  setHidden(el.lookupError, false);
}

async function onLookup(event) {
  event.preventDefault();
  if (app.looking) return;

  const first = el.lookupFirst.value.trim();
  const last = el.lookupLast.value.trim();
  if (!first || !last) {
    refuse('Type your first and last name.');
    (first ? el.lookupLast : el.lookupFirst).focus();
    return;
  }

  setHidden(el.lookupError, true);
  clearMessage();
  setLooking(true);
  try {
    const rows = await rpc('portal_find_members', {
      p_first_name: first,
      p_last_name: last,
    });
    const found = Array.isArray(rows) ? rows : [];

    if (!found.length) {
      // Not a failure of the page, and not something a retry fixes, so it is
      // said at the field rather than in the strip at the top.
      refuse('Nobody by that name is on this years roster. Ask an officer.');
      return;
    }
    if (found.length === 1) {
      await show(found[0].member_id);
      return;
    }
    offerCandidates(found);
  } catch (err) {
    fail(err, () => onLookup(event));
  } finally {
    setLooking(false);
  }
}

function setLooking(on) {
  app.looking = on;
  el.lookupSubmit.disabled = on;
  el.lookupSubmitLabel.textContent = on ? 'Looking…' : 'Show my points';
}

/**
 * Two members with one name.
 *
 * The month they joined is the only thing left that tells them apart, so it is
 * on the button. Picking wrong costs nothing: this page reads and writes
 * nothing, and "Not you?" is on the scorecard.
 */
function offerCandidates(rows) {
  app.candidates = rows;
  el.pickList.replaceChildren(
    ...rows.map((row) =>
      h(
        'li',
        { class: 'result' },
        h(
          'button',
          {
            type: 'button',
            class: 'result-button',
            onClick: () => show(row.member_id),
          },
          h('span', { class: 'result-name' }, row.display_name),
          h('span', { class: 'result-meta' }, joinedLabel(row.joined_on)),
        ),
      ),
    ),
  );
  setHidden(el.pickBlock, false);
  announce('Two people have that name. Pick one.');
}

const joinedLabel = (isoDate) => {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  if (!y || !m) return '';
  return `joined ${new Date(y, m - 1, d || 1).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  })}`;
};

// Who show() last started looking up. Somebody can press "Not you?" and
// submit a second name before the first lookup answers, and the network gives
// no promise that answers arrive in the order the requests left: a slow first
// answer landing after the second would paint member A's points under member
// B's name. Every await below checks this before touching the screen, so a
// superseded answer is dropped rather than shown.
let activeMemberId = null;

async function show(memberId) {
  activeMemberId = memberId;
  setHidden(el.pickBlock, true);
  clearMessage();
  setLooking(true);
  try {
    const card = await rpc('portal_scorecard', { p_member_id: memberId });
    if (activeMemberId !== memberId) return; // superseded while this was in flight
    app.scorecard.render(card);
    setHidden(el.lookupForm, true);
    // Not awaited. The figures are the answer and they are already on screen;
    // the event list is the detail behind them and arrives when it arrives.
    // load() carries its own guard against this same staleness.
    app.history.load(memberId);
    // The name they typed is not cleared: pressing "Not you?" puts them back on
    // the form with it still in the boxes, which is what somebody who mistyped
    // one letter needs.
  } catch (err) {
    if (activeMemberId !== memberId) return;
    fail(err, () => show(memberId));
  } finally {
    if (activeMemberId === memberId) setLooking(false);
  }
}

function forget() {
  activeMemberId = null;
  app.scorecard.clear();
  app.history.clear();
  setHidden(el.lookupForm, false);
  setHidden(el.pickBlock, app.candidates.length < 2);
  el.lookupFirst.focus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function cacheElements() {
  Object.assign(el, {
    message: $('screen-message'),
    messageTitle: $('screen-message-title'),
    messageBody: $('screen-message-body'),
    messageAction: $('screen-message-action'),

    tabPoints: $('tab-points'),
    tabBoard: $('tab-board'),
    viewPoints: $('view-points'),
    viewBoard: $('view-board'),

    lookupForm: $('lookup-form'),
    lookupFirst: $('lookup-first'),
    lookupLast: $('lookup-last'),
    lookupError: $('lookup-error'),
    lookupSubmit: $('lookup-submit'),
    lookupSubmitLabel: $('lookup-submit-label'),

    pickBlock: $('pick-block'),
    pickList: $('pick-list'),
  });
}

export function start() {
  installButtonIcons();
  cacheElements();

  $('footer-year').textContent = new Date().getFullYear();

  const ctx = { fail, clearMessage };
  app.scorecard = createScorecard(ctx);
  app.history = createHistory();
  app.leaderboard = createLeaderboard(ctx);

  el.lookupForm.addEventListener('submit', onLookup);
  el.tabPoints.addEventListener('click', () => selectTab('points'));
  el.tabBoard.addEventListener('click', () => selectTab('board'));
  $('score-change').addEventListener('click', forget);

  if (!IS_CONFIGURED) {
    el.messageTitle.textContent = 'This page is not connected yet';
    el.messageBody.textContent = 'Ask an officer.';
    setHidden(el.message, false);
    setHidden(el.lookupForm, true);
    return;
  }

  // The requirements below the form are what this page says before anybody has
  // typed anything, so they are read on load rather than on demand.
  app.scorecard.loadRequirements();
}
