// Earlier check-ins: when somebody who checked in before they joined finally
// lands on the roster, offer to link those unresolved check-ins to them.
//
// The rendering and the write both live here once, because roster.js needs
// this after adding somebody by hand and after a CSV import, and member.js
// needs it as a durable section on every member's own screen. Three call
// sites, one implementation: web/src/review.js's renderSuggestions() is the
// pattern this follows for a reusable row of candidates built with ui.js's
// h().
//
// fn_retroactive_match_candidates() and link_retroactive_matches()
// (supabase/migrations/20260814140000_retroactive_matching.sql) are the
// contract everything below draws from. Nothing here re-derives a match:
// every write is exactly the record ids an officer checked, never a name to
// go match again.

import { callRpc } from './rest.js';
import { describeRetroOutcome } from './officer-errors.js';
import { h, shortDate } from './ui.js';

/** Read-only. Raises PDS03 for an unknown or archived member. */
export function loadCandidates(memberId) {
  return callRpc('fn_retroactive_match_candidates', { p_member_id: memberId });
}

/** The write half. Takes exactly the record ids an officer confirmed. */
export function linkCandidates(memberId, recordIds) {
  return callRpc('link_retroactive_matches', {
    p_member_id: memberId,
    p_record_ids: recordIds,
  });
}

/**
 * The shared candidate-list UI. One instance owns its own DOM (`.root`) and
 * its own selection and outcome state, so roster.js can drop one into a
 * dialog and member.js can drop a different instance into an inline section
 * without either file reaching into the other's internals.
 *
 * exact_email candidates start checked, name_match candidates start
 * unchecked (per-record checkboxes, never a single "link all"). Linking a
 * batch replaces each submitted row's control with its own outcome, read off
 * describeRetroOutcome(). A followed_merge on any row, from the read or from
 * the write, shows one line and a way to reach the survivor.
 *
 * @param {{canReview: boolean, openMember: (id: string) => void, fail: Function}} ctx
 */
export function createCandidatePicker(ctx) {
  const state = {
    memberId: null,
    candidates: [],
    selected: new Set(),
    outcomes: new Map(), // record_id -> outcome row
    busy: false,
    followedMerge: false,
    resolvedMemberId: null,
  };

  const list = h('ul', { class: 'retro-list' });
  const mergeLine = h('p', { class: 'muted small', hidden: true });
  const linkButton = h(
    'button',
    { type: 'button', class: 'button button-primary', onClick: link },
    'Link selected',
  );
  const root = h(
    'div',
    { class: 'retro-picker' },
    mergeLine,
    h('p', { class: 'muted small' }, 'Not approved yet.'),
    list,
    h('div', { class: 'retro-actions' }, linkButton),
  );

  function toggle(recordId, checked) {
    if (checked) state.selected.add(recordId);
    else state.selected.delete(recordId);
    syncButton();
  }

  function syncButton() {
    linkButton.disabled = state.busy || !ctx.canReview || state.selected.size === 0;
  }

  function candidateRow(candidate) {
    const id = candidate.record_id;
    const outcome = state.outcomes.get(id);
    const certain = candidate.reason === 'exact_email';
    const percent = Math.round(Number(candidate.score) * 100);
    const reasonText = certain ? 'Same email address' : `${percent}% name match`;

    const body = h(
      'span',
      { class: 'suggestion-body' },
      h('span', { class: 'suggestion-name' }, candidate.claimed_name || 'No name typed'),
      h(
        'span',
        { class: 'muted small' },
        `${candidate.event_title} · ${shortDate(candidate.occurred_on)}`,
      ),
    );

    if (outcome) {
      // already_linked means the record's member_id was already set at write
      // time, full stop. It does NOT mean it belongs to this member: most
      // often it means somebody else does, and this member got nothing. That
      // is worth an officer's attention, not the same green treatment as a
      // record that actually landed.
      const ok = outcome.outcome === 'linked';
      return h(
        'li',
        {},
        h(
          'div',
          { class: 'retro-row' },
          body,
          // The certain/uncertain distinction stays visible after a
          // decision too: an officer looking back at a resolved row has to
          // be able to tell whether they confirmed an identity match or a
          // guessed resemblance, not just whether it landed.
          h('span', { class: 'suggestion-why muted small' }, reasonText),
          h(
            'p',
            { class: 'card-outcome retro-outcome', dataset: ok ? {} : { kind: 'error' } },
            describeRetroOutcome(outcome.outcome),
          ),
        ),
      );
    }

    return h(
      'li',
      {},
      h(
        'label',
        { class: 'suggestion suggestion-row', dataset: { certain: String(certain) } },
        h('input', {
          type: 'checkbox',
          checked: state.selected.has(id),
          disabled: state.busy || !ctx.canReview,
          onChange: (event) => toggle(id, event.target.checked),
        }),
        body,
        h('span', { class: 'suggestion-why' }, reasonText),
      ),
    );
  }

  function render() {
    list.replaceChildren(...state.candidates.map(candidateRow));
    mergeLine.hidden = !state.followedMerge;
    if (state.followedMerge) {
      const survivorId = state.resolvedMemberId;
      mergeLine.replaceChildren(
        'This member was merged. ',
        h(
          'button',
          { type: 'button', class: 'button button-small', onClick: () => ctx.openMember(survivorId) },
          'Open the current record',
        ),
      );
    }
    syncButton();
  }

  /**
   * Fetches candidates for one member. The list is cleared before the request
   * goes out, so a failure (or a call for a different member landing after
   * this one) never leaves a stale candidate on screen with the wrong id
   * attached to its checkbox.
   */
  async function load(memberId) {
    state.memberId = memberId;
    state.selected = new Set();
    state.outcomes = new Map();
    state.candidates = [];
    state.followedMerge = false;
    state.resolvedMemberId = null;
    render();

    const rows = await loadCandidates(memberId);
    if (state.memberId !== memberId) return state.candidates; // superseded

    state.candidates = rows ?? [];
    for (const row of state.candidates) {
      if (row.reason === 'exact_email') state.selected.add(row.record_id);
    }
    const withMerge = state.candidates.find((row) => row.followed_merge);
    if (withMerge) {
      state.followedMerge = true;
      state.resolvedMemberId = withMerge.resolved_member_id;
    }
    render();
    return state.candidates;
  }

  async function link() {
    const ids = [...state.selected];
    if (!ids.length) return;
    state.busy = true;
    render();
    try {
      const results = await linkCandidates(state.memberId, ids);
      for (const result of results ?? []) {
        state.outcomes.set(result.record_id, result);
        state.selected.delete(result.record_id);
        if (result.followed_merge) {
          state.followedMerge = true;
          state.resolvedMemberId = result.resolved_member_id;
        }
      }
    } catch (err) {
      ctx.fail(err, link);
    } finally {
      state.busy = false;
      render();
    }
  }

  return {
    root,
    load,
  };
}
