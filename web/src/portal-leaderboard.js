// The leaderboard: everybody's point total, and the breakdown behind each one.
//
// This is the spreadsheet the club actually reads. The old Google Sheet was one
// link anybody in PDSA could open and scroll, and the totals on it were the
// whole social function of the point system, so the replacement carries the same
// list rather than hiding it behind a member's own name.
//
// ONE REQUEST, NOT ONE PER ROW OPENED. portal_leaderboard() ships every member's
// per-category totals with the list, so tapping a row is a class change rather
// than a round trip. A few hundred members and ten categories is a small payload
// and hundreds of requests is not.
//
// The rank comes from Postgres, with ties sharing a rank. Nothing here counts
// anything: it draws the numbers it is given, in the order they arrive.
//
// A figure in the breakdown is a bare number. There is one unit, and the
// category beside it names what is being counted, so "GBMs 12" reads the way the
// officer's board reads and needs no noun after it. The one place a noun belongs
// is the total, which the member's own screen says in points.

import { rpc } from './api.js';
import { $, h, announce, setHidden, plural } from './ui.js';

const number = (value) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
};

export function createLeaderboard(ctx) {
  const el = {
    loading: $('board-loading'),
    list: $('board-list'),
    meta: $('board-meta'),
  };

  const state = {
    loaded: false,
    loading: false,
    open: null, // the member id whose breakdown is showing
  };

  async function open() {
    if (state.loaded || state.loading) return;
    state.loading = true;
    setHidden(el.loading, false);
    try {
      const board = await rpc('portal_leaderboard', {});
      state.loaded = true;
      render(board);
    } catch (err) {
      ctx.fail(err, () => {
        state.loading = false;
        return open();
      });
    } finally {
      state.loading = false;
      setHidden(el.loading, true);
    }
  }

  function render(board) {
    const members = board?.members ?? [];
    const categories = board?.categories ?? [];

    el.meta.textContent = [board?.year?.label, plural(members.length, 'member')]
      .filter(Boolean)
      .join(' · ');

    if (!members.length) {
      el.list.replaceChildren(h('li', { class: 'muted small' }, 'Nobody on the roster yet.'));
      return;
    }

    el.list.replaceChildren(...members.map((member) => row(member, categories)));
    announce(`${plural(members.length, 'member')} on the leaderboard`);
  }

  /**
   * One member, and the breakdown underneath.
   *
   * The whole row is the button, because a phone gets one thumb and a chevron
   * the size of a full stop is not a target. aria-expanded is what says the row
   * opens something at all.
   */
  function row(member, categories) {
    const item = h('li', { class: 'board-row', dataset: { member: member.member_id } });

    const breakdown = h('div', { class: 'board-breakdown', hidden: true });
    for (const category of categories) {
      const total = Number(member.totals?.[category.id] ?? 0);
      breakdown.append(
        h(
          'p',
          { class: 'board-figure', dataset: { zero: String(total === 0) } },
          h('span', { class: 'board-figure-name' }, category.name),
          h('span', { class: 'board-figure-value' }, number(total)),
        ),
      );
    }

    const button = h(
      'button',
      {
        type: 'button',
        class: 'board-button',
        'aria-expanded': 'false',
        onClick: () => toggle(member.member_id, button, breakdown),
      },
      h('span', { class: 'board-rank' }, `${member.rank}`),
      h('span', { class: 'board-name' }, member.display_name),
      member.is_honorary
        ? h(
            'span',
            { class: 'board-star', title: 'Honorary Member' },
            h('span', { 'aria-hidden': 'true' }, '★'),
            h('span', { class: 'visually-hidden' }, 'Honorary Member'),
          )
        : null,
      h('span', { class: 'board-points' }, number(member.point_total)),
    );

    item.append(button, breakdown);
    return item;
  }

  /** One breakdown open at a time, so the list stays a list. */
  function toggle(memberId, button, breakdown) {
    const showing = state.open === memberId;
    for (const node of el.list.querySelectorAll('.board-breakdown')) node.hidden = true;
    for (const node of el.list.querySelectorAll('.board-button')) {
      node.setAttribute('aria-expanded', 'false');
    }

    if (showing) {
      state.open = null;
      return;
    }
    state.open = memberId;
    breakdown.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  return { open };
}
