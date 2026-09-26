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
// laptop open, and a stranger with the link. The five functions it calls are
// SECURITY DEFINER and shaped: they answer with the club-facing figures and
// nothing else. The reasoning, including what that does expose, is written out
// in supabase/migrations/20260817110000_public_member_portal.sql.
//
// THE VERDICT IS STILL POSTGRES'S. is_honorary and every requirement's pass or
// fail arrive from fn_member_requirement_status() through the scorecard call.
// Nothing here decides whether somebody is honorary (invariant 2). It uses the
// server's row types only to separate measured requirements from grouping rows,
// then draws the values and verdicts it is given.
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
import {
  attendancePdfFilename,
  buildAttendancePdf,
  loadAttendancePdfFonts,
  saveAttendancePdf,
} from './attendance-pdf.js';
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
  lookupSeq: 0,
  card: null,
  attendance: null,
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

function showNoMatch() {
  setHidden(el.noMatch, false);
  el.noMatchTitle.focus();
  announce('Name not found. Check the spelling. Only paid members are listed.');
}

async function lookupMember() {
  if (app.looking) return;

  const lookupSeq = ++app.lookupSeq;
  const name = el.lookupName.value.trim();
  if (!name) {
    refuse('Type your full name.');
    el.lookupName.focus();
    return;
  }

  setHidden(el.lookupError, true);
  setHidden(el.noMatch, true);
  clearMessage();
  setLooking(true);
  announce('Looking up member.');
  const isCurrent = () =>
    lookupSeq === app.lookupSeq && el.lookupName.value.trim() === name;
  try {
    const rows = await rpc('portal_find_members', {
      p_name: name,
    });
    if (!isCurrent()) return;
    const found = Array.isArray(rows) ? rows : [];

    if (!found.length) {
      showNoMatch();
      return;
    }
    if (found.length === 1) {
      await show(found[0].member_id, { isCurrent });
      return;
    }
    offerCandidates(found);
  } catch (err) {
    if (!isCurrent()) return;
    fail(err, lookupMember);
  } finally {
    setLooking(false);
  }
}

function onLookup(event) {
  event.preventDefault();
  return lookupMember();
}

function onLookupInput() {
  app.lookupSeq += 1;
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

function attendanceSnapshotMatches(attendance, memberId) {
  const snapshot = attendance?.scorecard;
  return Boolean(
    snapshot?.member?.id === memberId &&
      attendance?.member?.id === memberId &&
      snapshot?.year?.id &&
      snapshot.year.id === attendance?.year?.id,
  );
}

async function show(memberId, { isCurrent = null } = {}) {
  activeMemberId = memberId;
  setHidden(el.pickBlock, true);
  clearMessage();
  setLooking(true);
  try {
    const card = await rpc('portal_scorecard', { p_member_id: memberId });
    if (activeMemberId !== memberId) return; // superseded while this was in flight
    if (isCurrent && !isCurrent()) return;
    app.card = card;
    app.attendance = null;
    app.scorecard.render(card);
    syncNameParam(card?.member?.display_name ?? '');
    el.app.classList.add('results-view');
    el.download.disabled = true;
    setHidden(el.downloadError, true);
    setHidden(el.lookupForm, true);
    setHidden(el.noMatch, true);
    // The About Q&A remains after the attendance record in this same section.
    // Its initial introduction and general requirements would repeat the
    // member-specific Requirement progress, so only that introductory region
    // is put away on successful results.
    setHidden(el.honorary, false);
    setHidden(el.honoraryIntro, true);
    // Not awaited. The figures are the answer and they are already on screen;
    // the event list is the detail behind them and arrives when it arrives.
    // load() carries its own guard against this same staleness.
    app.history.load(memberId, {
      validate: (attendance) => attendanceSnapshotMatches(attendance, memberId),
      onReady: (attendance) => {
        if (activeMemberId !== memberId) return;
        const snapshot = attendance.scorecard;
        app.scorecard.render(snapshot, { focus: false, announceStatus: false });
        app.card = snapshot;
        app.attendance = attendance;
        el.download.disabled = false;
      },
    });
    // The name they typed is not cleared: pressing "Not you?" puts them back on
    // the form with it still in the box, which is what somebody who mistyped
    // one letter needs.
  } catch (err) {
    if (activeMemberId !== memberId) return;
    if (isCurrent && !isCurrent()) return;
    fail(err, () => show(memberId, { isCurrent }));
  } finally {
    if (activeMemberId === memberId) setLooking(false);
  }
}

// The address carries the name on screen, so a bookmark or a home screen icon
// opens straight to these points. The check-in page already links here the
// same way.
function syncNameParam(name) {
  try {
    const url = new URL(window.location.href);
    if (name) url.searchParams.set('name', name);
    else url.searchParams.delete('name');
    window.history.replaceState(null, '', url);
  } catch {
    // The address is a convenience. The points are already on screen.
  }
}

function forget() {
  activeMemberId = null;
  syncNameParam('');
  app.scorecard.clear();
  app.history.clear();
  app.card = null;
  app.attendance = null;
  el.download.disabled = true;
  setHidden(el.downloadError, true);
  setHidden(el.noMatch, true);
  setHidden(el.lookupForm, false);
  el.app.classList.remove('results-view');
  setHidden(el.honorary, false);
  setHidden(el.honoraryIntro, false);
  setHidden(el.pickBlock, app.candidates.length < 2);
  el.lookupName.focus();
}

async function downloadPdf() {
  if (!app.card || !app.attendance) return;
  const card = app.card;
  const attendance = app.attendance;
  const memberId = activeMemberId;
  el.download.disabled = true;
  setHidden(el.downloadError, true);
  announce('Preparing download.');
  try {
    const fonts = await loadAttendancePdfFonts();
    if (activeMemberId !== memberId || app.card !== card || app.attendance !== attendance) return;
    if (!attendanceSnapshotMatches(attendance, memberId) || attendance.scorecard !== card) {
      throw new Error('Attendance data changed before the download was ready.');
    }
    const blob = buildAttendancePdf({
      card,
      attendance,
      ...fonts,
    });
    saveAttendancePdf(blob, attendancePdfFilename(card));
    announce('PDF downloaded.');
  } catch {
    if (activeMemberId !== memberId || app.card !== card || app.attendance !== attendance) return;
    setHidden(el.downloadError, false);
    announce('Download failed.');
  } finally {
    if (activeMemberId === memberId && app.card === card && app.attendance === attendance) {
      el.download.disabled = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function cacheElements() {
  Object.assign(el, {
    app: $('app'),
    message: $('screen-message'),
    messageTitle: $('screen-message-title'),
    messageBody: $('screen-message-body'),
    messageAction: $('screen-message-action'),

    tabPoints: $('tab-points'),
    tabBoard: $('tab-board'),
    viewPoints: $('view-points'),
    viewBoard: $('view-board'),

    lookupForm: $('lookup-form'),
    lookupName: $('lookup-name'),
    lookupError: $('lookup-error'),
    lookupSubmit: $('lookup-submit'),
    lookupSubmitLabel: $('lookup-submit-label'),

    noMatch: $('no-match'),
    noMatchTitle: $('no-match-title'),
    noMatchBoard: $('no-match-board'),

    pickBlock: $('pick-block'),
    pickList: $('pick-list'),

    download: $('score-download'),
    downloadError: $('download-error'),
    downloadRetry: $('download-retry'),
    honorary: $('honorary'),
    honoraryIntro: $('honorary-intro'),
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
  el.lookupName.addEventListener('input', onLookupInput);
  el.tabPoints.addEventListener('click', () => selectTab('points'));
  el.tabBoard.addEventListener('click', () => selectTab('board'));
  $('score-change').addEventListener('click', forget);
  el.noMatchBoard.addEventListener('click', () => selectTab('board'));
  el.download.addEventListener('click', downloadPdf);
  el.downloadRetry.addEventListener('click', downloadPdf);

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

  const queryName = new URLSearchParams(window.location.search).get('name');
  if (queryName?.trim()) {
    el.lookupName.value = queryName;
    lookupMember();
  }
}
