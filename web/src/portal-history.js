import { rpc } from './api.js';
import { $, h, announce, setHidden } from './ui.js';
import { categoryCredit, eventDate, timeDetails } from './portal-record.js';

const FILTERS = [
  { value: 'attended', label: 'Approved' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'declined', label: 'Declined' },
];

const STATUS = {
  attended: 'Approved',
  waiting: 'Waiting',
  declined: 'Declined',
};

export function createHistory() {
  const el = {
    card: $('history'),
    meta: $('history-meta'),
    filters: $('history-filters'),
    loading: $('history-loading'),
    error: $('history-error'),
    retry: $('history-retry'),
    empty: $('history-empty'),
    tableWrap: $('history-table-wrap'),
    tableBody: $('history-table-body'),
    cards: $('history-cards'),
  };

  let current = null;
  let answer = null;
  let filter = 'attended';
  let readyHandler = null;
  let validateHandler = null;

  el.retry.addEventListener('click', () => {
    if (current) load(current, { onReady: readyHandler, validate: validateHandler });
  });

  const recordEvents = () =>
    (answer?.events ?? [])
      .filter((event) => STATUS[event.status])
      .sort(
        (a, b) =>
          String(b.occurred_on ?? '').localeCompare(String(a.occurred_on ?? '')) ||
          String(a.title ?? '').localeCompare(String(b.title ?? '')),
      );

  function creditList(event, className) {
    return h(
      'ul',
      { class: className },
      ...(event.categories ?? []).map((category) => h('li', {}, categoryCredit(category))),
    );
  }

  function tableRow(event) {
    const time = timeDetails(event);
    return h(
      'tr',
      { dataset: { status: event.status } },
      h('th', { scope: 'row' }, event.title),
      h('td', { class: 'record-number' }, eventDate(event.occurred_on)),
      h('td', { class: 'record-number' }, time.range),
      h('td', { class: 'record-number' }, time.duration),
      h('td', {}, creditList(event, 'credit-list')),
      h('td', {}, h('span', { class: 'record-status', dataset: { status: event.status } }, STATUS[event.status])),
    );
  }

  function card(event) {
    const time = timeDetails(event);
    return h(
      'article',
      { class: 'record-card', dataset: { status: event.status } },
      h(
        'div',
        { class: 'record-card-head' },
        h('h3', {}, event.title),
        h('span', { class: 'record-status', dataset: { status: event.status } }, STATUS[event.status]),
      ),
      h(
        'dl',
        { class: 'record-details' },
        h('div', {}, h('dt', {}, 'Date'), h('dd', { class: 'record-number' }, eventDate(event.occurred_on))),
        h('div', {}, h('dt', {}, 'Time'), h('dd', { class: 'record-number' }, time.range)),
        time.recorded
          ? h('div', {}, h('dt', {}, 'Duration'), h('dd', { class: 'record-number' }, time.duration))
          : null,
        h('div', {}, h('dt', {}, 'Categories and credit'), h('dd', {}, creditList(event, 'credit-list'))),
      ),
    );
  }

  function paintFilters() {
    const rows = recordEvents();
    el.filters.replaceChildren(
      ...FILTERS.map((item) => {
        const count = rows.filter((event) => event.status === item.value).length;
        return h(
          'button',
          {
            type: 'button',
            class: 'record-filter',
            'aria-pressed': String(filter === item.value),
            onClick: () => {
              filter = item.value;
              paint();
            },
          },
          `${item.label} ${count}`,
        );
      }),
    );
  }

  function paint() {
    paintFilters();
    const shown = recordEvents().filter((event) => event.status === filter);
    el.meta.textContent = `${shown.length} ${shown.length === 1 ? 'event' : 'events'}`;
    el.tableBody.replaceChildren(...shown.map(tableRow));
    el.cards.replaceChildren(...shown.map(card));
    setHidden(el.empty, shown.length > 0);
    setHidden(el.tableWrap, shown.length === 0);
    setHidden(el.cards, shown.length === 0);
  }

  async function load(memberId, { onReady = null, validate = null } = {}) {
    current = memberId;
    answer = null;
    filter = 'attended';
    readyHandler = onReady;
    validateHandler = validate;
    setHidden(el.card, false);
    setHidden(el.loading, false);
    setHidden(el.error, true);
    setHidden(el.empty, true);
    setHidden(el.tableWrap, true);
    setHidden(el.cards, true);
    el.filters.replaceChildren();
    announce('Loading attendance.');

    try {
      const loaded = await rpc('portal_attendance', { p_member_id: memberId });
      if (current !== memberId) return;
      if (validateHandler && !validateHandler(loaded)) {
        throw new Error('Attendance response did not match the requested member.');
      }
      answer = loaded;
      setHidden(el.loading, true);
      paint();
      readyHandler?.(loaded);
      announce('Attendance loaded.');
    } catch {
      if (current !== memberId) return;
      setHidden(el.loading, true);
      setHidden(el.error, false);
      announce('Attendance unavailable.');
    }
  }

  function clear() {
    current = null;
    answer = null;
    readyHandler = null;
    validateHandler = null;
    setHidden(el.card, true);
    setHidden(el.loading, true);
    setHidden(el.error, true);
    el.filters.replaceChildren();
    el.tableBody.replaceChildren();
    el.cards.replaceChildren();
  }

  return { load, clear };
}
