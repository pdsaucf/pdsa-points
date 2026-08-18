// A member's own event history: every event of the year and what they did
// about each one.
//
// THIS IS THE GRID THE SPREADSHEET HAD. Its member-facing tab was one row per
// member and one column per event, a 1 where they attended and a blank where
// they did not, and people read it to see what they had missed and what was
// left. A point total on its own cannot answer either question, which is why
// migration 23 reversed migration 21's decision to keep individual records off
// this page. The reasoning is in that migration, not repeated here.
//
// NOTHING IS DECIDED IN THIS FILE (invariants 1 and 2). portal_attendance()
// returns the sections already grouped, already ordered and already carrying
// their status, and this draws them. No category is named here, no threshold
// is applied, and the number next to an attended event is the credit the
// server computed for that record: fixed_credit, or the number the member
// typed at check-in, decided once in v_attendance_credit.
//
// WHY THE SECTIONS COLLAPSE. A club year is around a hundred events across
// thirteen categories, and drawn flat that is a page nobody scrolls to the
// bottom of. So a category the member has any record in opens, and one they
// have never touched stays shut with its event count on the summary. Their own
// history is never behind an interaction they have to discover; the events
// they have not been to are. <details> rather than a scripted toggle, so it
// works from the keyboard without this file reimplementing that.

import { rpc } from './api.js';
import { $, h, setHidden, shortDate } from './ui.js';

const number = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
};

// What each state puts in the row's last column, and what a screen reader
// hears. `none` shows nothing, the way the spreadsheet's blank cell read: a
// word for every event they did not attend would be a page of "Not attended".
// It still says so out loud, because a blank is not a state to a screen reader.
const STATUS = {
  attended: { word: null, spoken: 'Attended' },
  waiting: { word: 'Waiting', spoken: 'Waiting for review' },
  declined: { word: 'Declined', spoken: 'Declined' },
  upcoming: { word: 'Upcoming', spoken: 'Upcoming' },
  none: { word: null, spoken: 'Not attended' },
};

export function createHistory() {
  const el = {
    card: $('history'),
    list: $('history-list'),
  };

  // Who the most recent load() call was for. "Not you?" then a second lookup
  // fires a second request before the first has answered, and network order
  // is not call order: without this, a slow first answer can land after the
  // second and paint one member's attendance under another member's name and
  // points. A stale answer is a no-op rather than a render or a clear, so it
  // neither overwrites what the current member is looking at nor blanks a
  // history that already loaded correctly.
  let current = null;

  function eventRow(event) {
    const state = STATUS[event.status] ?? STATUS.none;
    // Attended reads as its credit, which is the spreadsheet's 1 and is the
    // only number on the row that means anything.
    const mark = event.status === 'attended' ? number(event.credit ?? 0) : state.word;

    return h(
      'li',
      { class: 'event-row', dataset: { status: event.status } },
      h('span', { class: 'event-title' }, event.title),
      h('span', { class: 'event-date' }, shortDate(event.occurred_on)),
      h('span', { class: 'event-mark' }, mark ?? ''),
      h('span', { class: 'visually-hidden' }, state.spoken),
    );
  }

  function section(category) {
    const events = category.events ?? [];
    const attended = events.filter((event) => event.status !== 'none' && event.status !== 'upcoming');
    const open = attended.length > 0;

    return h(
      'details',
      { class: 'event-group', open },
      h(
        'summary',
        { class: 'event-group-head' },
        h('span', { class: 'event-group-name' }, category.name),
        h('span', { class: 'event-group-figure' }, number(category.total)),
      ),
      h('ul', { class: 'event-list' }, ...events.map(eventRow)),
    );
  }

  /**
   * Loaded after the scorecard, and failing silently the way the requirements
   * box does. Somebody who came here for their points still gets them if this
   * call does not come back: the figures above are the answer, and this is the
   * detail behind them.
   */
  async function load(memberId) {
    current = memberId;
    try {
      const answer = await rpc('portal_attendance', { p_member_id: memberId });
      if (current !== memberId) return; // superseded while this was in flight
      const categories = answer?.categories ?? [];
      if (!categories.length) {
        clear();
        return;
      }
      el.list.replaceChildren(...categories.map(section));
      setHidden(el.card, false);
    } catch {
      if (current !== memberId) return;
      clear();
    }
  }

  function clear() {
    current = null;
    setHidden(el.card, true);
    el.list.replaceChildren();
  }

  return { load, clear };
}
