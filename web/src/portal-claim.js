// The three screens an account that is not linked to a roster row can be on.
//
// docs/04-member-ui.md: sign-in is a claim, not a lookup. The imported roster
// carries names and no email addresses, so somebody whose sign-in address the
// club has never seen picks themselves out of the roster and an officer
// confirms it. Until that happens profiles.member_id stays null and this
// account sees no member's data, which is the whole point of the flow.
//
// EVERY CALL HERE IS AN RPC, because every one of them does something a member
// is not allowed to do directly.
//
//   search_roster_for_claim()  a member cannot read the roster. This returns
//                              names and ids, ten rows, three letters minimum,
//                              rate limited, and it hides anybody already
//                              linked or already claimed. Nothing else about a
//                              member comes back: no email, no join date, no
//                              totals.
//   file_member_claim()        writes the claim, and turns the two partial
//                              unique indexes into two different situations:
//                              PDS13 is "you already asked" and PDS14 is
//                              "somebody else is claiming that person". They
//                              need different screens, which is why they are
//                              different codes.
//
// THE REJECTED SCREEN SHOWS THE OFFICER'S REASON. member_claims.review_note is
// what an officer typed, and hiding it only generates the email asking for it.
// It is deliberately not member_claims.note, which is the member's own words
// and is shown back to them on the pending screen instead.

import { callRpc } from './rest.js';
import { $, h, announce, setHidden, plural, shortDate } from './ui.js';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LENGTH = 3;

export function createClaim(ctx) {
  const el = {
    search: $('claim-search'),
    results: $('claim-results'),
    hint: $('claim-hint'),
    confirm: $('claim-confirm'),
    chosen: $('claim-chosen'),
    note: $('claim-note'),
    error: $('claim-error'),
    send: $('claim-send'),
    back: $('claim-back'),
    pendingWho: $('pending-who'),
    rejectedWho: $('rejected-who'),
    rejectedReason: $('rejected-reason'),
    rejectedRetry: $('rejected-retry'),
  };

  const state = {
    picked: null, // { id, display_name }
    timer: null,
    abort: null,
    seq: 0,
    busy: false,
  };

  // -------------------------------------------------------------------------
  // Searching
  // -------------------------------------------------------------------------

  function setHint(text) {
    el.hint.textContent = text;
  }

  function onInput() {
    clearTimeout(state.timer);
    const query = el.search.value.trim();

    if (query.length < MIN_SEARCH_LENGTH) {
      state.abort?.abort();
      el.results.replaceChildren();
      setHint(query ? 'Keep typing.' : '');
      return;
    }

    state.timer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(query) {
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    const seq = (state.seq += 1);

    try {
      const rows = await callRpc('search_roster_for_claim', { p_q: query }, { signal: abort.signal });
      // A slower earlier request landing after a faster later one would put the
      // wrong names under somebody's finger.
      if (seq !== state.seq) return;
      renderResults(Array.isArray(rows) ? rows : []);
    } catch (err) {
      if (abort.signal.aborted || seq !== state.seq) return;
      ctx.fail(err, () => runSearch(query));
    }
  }

  function renderResults(rows) {
    el.results.replaceChildren(
      ...rows.map((row) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'result',
              dataset: { id: row.id },
              onClick: () => pick(row),
            },
            row.display_name,
          ),
        ),
      ),
    );

    // A search that finds nothing is a real answer here: the roster hides
    // anybody already linked or already claimed, so "not on the list" is
    // sometimes "somebody already has that name".
    setHint(rows.length ? '' : 'No names match. Ask an officer.');
    announce(rows.length ? `${plural(rows.length, 'name')}.` : 'No names match.');
  }

  // -------------------------------------------------------------------------
  // Picking one, and filing it
  // -------------------------------------------------------------------------

  function pick(row) {
    state.picked = row;
    el.chosen.textContent = row.display_name;
    el.note.value = '';
    setHidden(el.error, true);
    setHidden(el.confirm, false);
    announce(`${row.display_name} picked.`);
  }

  function unpick() {
    state.picked = null;
    setHidden(el.confirm, true);
    el.search.focus({ preventScroll: true });
  }

  async function send(event) {
    event.preventDefault();
    if (!state.picked || state.busy) return;

    setBusy(true);
    setHidden(el.error, true);
    ctx.clearMessage();

    try {
      await callRpc('file_member_claim', {
        p_member_id: state.picked.id,
        p_note: el.note.value.trim() || null,
      });
      announce('Sent. An officer will confirm it.');
      // Read the account again rather than drawing the pending screen from
      // what was just typed: the claim on that screen is the one the database
      // holds, including anything an officer has already done to it.
      await ctx.reload();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    state.busy = on;
    el.send.disabled = on;
  }

  // -------------------------------------------------------------------------
  // Drawing the three screens
  // -------------------------------------------------------------------------

  /** 'Abigail Catto · asked Aug 11', the metadata line under a heading. */
  const who = (claim) =>
    [claim.member_name, claim.requested_at ? `asked ${shortDate(claim.requested_at)}` : null]
      .filter(Boolean)
      .join(' · ');

  function showSearch() {
    state.picked = null;
    el.search.value = '';
    el.results.replaceChildren();
    setHidden(el.confirm, true);
    setHint('');
    el.search.focus({ preventScroll: true });
    announce('Find your name.');
  }

  function showPending(claim) {
    el.pendingWho.textContent = who(claim);
    announce('Waiting for an officer.');
  }

  function showRejected(claim) {
    el.rejectedWho.textContent = who(claim);
    const reason = claim.review_note ?? '';
    el.rejectedReason.textContent = reason;
    setHidden(el.rejectedReason, !reason);
    announce(reason ? `Not confirmed. ${reason}` : 'Not confirmed.');
  }

  function wire() {
    el.search.addEventListener('input', onInput);
    el.confirm.addEventListener('submit', send);
    el.back.addEventListener('click', unpick);
    // Rejecting a claim frees both the account and the member: both partial
    // unique indexes exclude rejected rows, so trying again is a real offer
    // rather than a button that leads back to the same refusal. The shell owns
    // which screen is on, so it is the one that swaps them over.
    el.rejectedRetry.addEventListener('click', () => {
      ctx.clearMessage();
      ctx.retryClaim();
    });
  }

  return {
    mount() {
      wire();
    },
    showSearch,
    showPending,
    showRejected,
  };
}
