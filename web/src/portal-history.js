import { rpc } from './api.js';
import { $, h, announce, setHidden } from './ui.js';
import { categoryCredit, shortEventDate, timeDetails } from './portal-record.js';

// Only statuses with at least one event get a filter, so the list below is
// always labelled by exactly one pressed filter and rows carry no status pill.
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

  function creditList(event) {
    return h(
      'ul',
      { class: 'credit-list' },
      ...(event.categories ?? []).map((category) => h('li', {}, categoryCredit(category))),
    );
  }

  // Blank when either actual instant is missing: the check-in window is never
  // used to infer one.
  function timeText(event) {
    const time = timeDetails(event);
    return time.recorded ? `${time.range} (${time.duration})` : '';
  }

  function tableRow(event) {
    return h(
      'tr',
      { dataset: { status: event.status } },
      h('th', { scope: 'row' }, event.title),
      h('td', { class: 'record-number' }, shortEventDate(event.occurred_on)),
      h('td', { class: 'record-number' }, timeText(event)),
      h('td', {}, creditList(event)),
    );
  }

  function card(event) {
    const time = timeText(event);
    return h(
      'article',
      { class: 'record-card', dataset: { status: event.status } },
      h('h3', {}, event.title),
      creditList(event),
      h(
        'p',
        { class: 'record-when record-number' },
        time ? `${shortEventDate(event.occurred_on)}, ${time}` : shortEventDate(event.occurred_on),
      ),
    );
  }

  function paintFilters(rows) {
    el.filters.replaceChildren(
      ...FILTERS.map((item) => {
        const count = rows.filter((event) => event.status === item.value).length;
        if (!count) return null;
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
      }).filter(Boolean),
    );
  }

  function paint() {
    const rows = recordEvents();
    // Approved first. A member with nothing approved yet opens on whatever
    // they do have, rather than an empty list above a filter that has it.
    if (!rows.some((event) => event.status === filter)) {
      filter = FILTERS.find((item) => rows.some((event) => event.status === item.value))?.value ?? 'attended';
    }
    paintFilters(rows);
    const shown = rows.filter((event) => event.status === filter);
    el.tableBody.replaceChildren(...shown.map(tableRow));
    el.cards.replaceChildren(...shown.map(card));
    setHidden(el.filters, rows.length === 0);
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
