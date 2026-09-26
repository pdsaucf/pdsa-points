// One search box for the whole admin: a member or an event, from any screen.
//
// Opened from the top bar, or with Ctrl K (Cmd K on a Mac). It reads the
// roster and the selected year's events on each open, so a member added a
// minute ago is findable, and then matches as the officer types without
// going back to the network between keystrokes.
// Members come from every year, the way the roster's import matching reads
// them: the person being looked up may not have enrolled yet this year.

import { select } from './rest.js';
import { $, h, setHidden, shortDate } from './ui.js';

const LIMIT = 8;

/** Lower case, accents dropped, so "Jose" finds "José". */
function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * 0 when a word starts with the query, 1 when it only appears inside one,
 * null when it does not appear. Every word of the query must be present.
 */
export function matchRank(text, query) {
  const haystack = fold(text);
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let rank = 0;
  for (const word of words) {
    const at = haystack.indexOf(word);
    if (at < 0) return null;
    const startsWord = at === 0 || /\s|-|'/.test(haystack[at - 1]);
    if (!startsWord) rank = 1;
  }
  return rank;
}

export function createSearch(ctx) {
  const el = {
    open: $('search-open'),
    shortcut: $('search-shortcut'),
    dialog: $('search-dialog'),
    input: $('search-input'),
    results: $('search-results'),
    empty: $('search-empty'),
  };

  const state = {
    members: [],
    events: [],
    items: [],
    active: 0,
    loading: false,
  };

  async function load() {
    const yearId = ctx.year.id;
    const [members, events] = await Promise.all([
      select('members', {
        select: 'id,display_name',
        filters: { archived_at: 'is.null', merged_into_id: 'is.null' },
        order: 'display_name.asc',
      }),
      select('events', {
        select: 'id,title,occurred_on',
        filters: { academic_year_id: `eq.${yearId}` },
        order: 'occurred_on.desc',
      }),
    ]);
    state.members = members;
    state.events = events;
  }

  function results(query) {
    const ranked = [];
    for (const member of state.members) {
      const rank = matchRank(member.display_name, query);
      if (rank !== null) ranked.push({ kind: 'member', rank, row: member, label: member.display_name });
    }
    for (const event of state.events) {
      const rank = matchRank(event.title, query);
      if (rank !== null) ranked.push({ kind: 'event', rank, row: event, label: event.title });
    }
    return ranked
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
      .slice(0, LIMIT);
  }

  function render() {
    const query = el.input.value;
    state.items = query.trim() ? results(query) : [];
    state.active = Math.min(state.active, Math.max(state.items.length - 1, 0));

    el.results.replaceChildren(
      ...state.items.map((item, index) =>
        h(
          'li',
          {
            id: `search-result-${index}`,
            class: 'search-result',
            role: 'option',
            'aria-selected': String(index === state.active),
            onClick: () => choose(item),
          },
          h('span', { class: 'search-result-label' }, item.label),
          h(
            'span',
            { class: 'search-result-kind muted small' },
            item.kind === 'member' ? 'Member' : shortDate(item.row.occurred_on),
          ),
        ),
      ),
    );
    if (state.items.length) {
      el.input.setAttribute('aria-activedescendant', `search-result-${state.active}`);
    } else {
      el.input.removeAttribute('aria-activedescendant');
    }
    setHidden(el.empty, state.loading || !query.trim() || state.items.length > 0);
  }

  function choose(item) {
    el.dialog.close();
    if (item.kind === 'member') ctx.openMember(item.row.id);
    else ctx.openEvent(item.row.id);
  }

  async function show() {
    if (el.dialog.open) return;
    // Never over another dialog. A confirmation belongs to the screen that
    // opened it, and navigating underneath it would point its button at
    // whatever this search opens instead.
    if (document.querySelector('dialog[open]')) return;
    el.input.value = '';
    state.active = 0;
    render();
    el.dialog.showModal();
    el.input.focus();
    state.loading = true;
    try {
      await load();
    } catch (err) {
      el.dialog.close();
      ctx.fail(err, show);
      return;
    } finally {
      state.loading = false;
    }
    render();
  }

  function onInputKey(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!state.items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      state.active = (state.active + step + state.items.length) % state.items.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = state.items[state.active];
      if (item) choose(item);
    }
  }

  function wire() {
    const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
    el.shortcut.textContent = mac ? '⌘K' : 'Ctrl K';
    el.open.addEventListener('click', show);
    el.input.addEventListener('input', () => {
      state.active = 0;
      render();
    });
    el.input.addEventListener('keydown', onInputKey);
    // A click on the backdrop lands on the dialog element itself.
    el.dialog.addEventListener('click', (event) => {
      if (event.target === el.dialog) el.dialog.close();
    });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        show();
      }
    });
  }

  return { mount: wire };
}
