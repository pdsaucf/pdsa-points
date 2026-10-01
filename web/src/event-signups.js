// The sign-up sheet on one event's own screen. docs/09-event-signups.md.
//
// A spreadsheet of who signed up on /events: their place in line, whether
// they confirmed, whether they actually came, and their answers, one column
// per question. Officers filter it by state, export it, add somebody who
// signed up in person, and remove somebody.
//
// NOTHING HERE DECIDES GOING OR WAITLIST. v_event_signups ranks confirmed
// sign-ups by confirmation time against the event's spots, and this screen
// draws what it says.

import { select, callRpc } from './rest.js';
import { downloadCsv } from './csv.js';
import { normaliseName, rankMembers } from './match.js';
import { qrFileName } from './events-model.js';
import { $, h, announce, setHidden, plural, shortDate, clockTime } from './ui.js';

const SIGNUP_SELECT = [
  'id,event_id,member_id,name,email,answers,status,state,reply,waitlist_position',
  'created_at,confirmed_at,cancelled_at,cancelled_by,confirm_by,email_at,added_by_officer',
].join(',');

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'going', label: 'Going' },
  { value: 'waitlist', label: 'Waitlist' },
  { value: 'dropped', label: 'Dropped' },
  { value: 'cancelled', label: 'Cancelled' },
];

// The order rows sit in: the line first, then everybody out of it.
const STATE_ORDER = { going: 0, waitlist: 1, dropped: 2, cancelled: 3 };

/** What the Status cell says. */
export function signupStateLabel(row) {
  switch (row.state) {
    case 'going':
      return 'Going';
    case 'waitlist':
      return `Waitlist ${row.waitlist_position}`;
    case 'dropped':
      return 'Dropped';
    case 'cancelled':
      return row.cancelled_by === 'officer' ? 'Removed' : 'Cancelled';
    default:
      return row.state;
  }
}

/** Which filter tab a row is counted under. */
const filterOf = (row) => row.state;

const when = (instant) => (instant ? `${shortDate(String(instant).slice(0, 10))}, ${clockTime(instant)}` : '');

/** The Confirmed cell: what the person did with the email, or when it goes out. */
export function replyLabel(row) {
  switch (row.reply) {
    case 'confirmed':
      return row.added_by_officer ? 'Added by officer' : 'Confirmed';
    case 'awaiting':
      return `No reply, due ${when(row.confirm_by)}`;
    case 'scheduled':
      return `Email ${when(row.email_at)}`;
    default:
      return row.state === 'dropped' ? 'No reply' : '';
  }
}

/**
 * Whether this sign-up turned into attendance. Members match by roster id,
 * guests by name against an unmatched check-in.
 *
 * @returns {'attended'|'review'|'no_show'|null} null while the event is ahead
 */
export function attendanceOf(row, records, eventIsPast) {
  if (row.state !== 'going' && row.state !== 'waitlist') return null;
  const mine = records.filter((record) =>
    row.member_id
      ? record.member_id === row.member_id
      : !record.member_id && normaliseName(record.claimed_name ?? '') === normaliseName(row.name));
  if (mine.some((record) => record.status === 'approved')) return 'attended';
  if (mine.some((record) => record.status === 'pending')) return 'review';
  return eventIsPast ? 'no_show' : null;
}

const ATTENDED_LABEL = { attended: 'Attended', review: 'To review', no_show: 'No-show' };

function answerText(question, answers) {
  const value = answers?.[question.id];
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function createSignupSheet(ctx, host) {
  const el = {
    block: $('signup-block'),
    summary: $('signup-summary'),
    filters: $('signup-filters'),
    empty: $('signup-empty'),
    table: $('signup-table'),
    head: $('signup-head'),
    rows: $('signup-rows'),
    add: $('signup-add'),
    exportButton: $('signup-export'),

    addDialog: $('signup-add-dialog'),
    addForm: $('signup-add-form'),
    addName: $('signup-add-name'),
    addChoices: $('signup-add-choices'),
    addGuest: $('signup-add-guest'),
    addEmail: $('signup-add-email'),
    addError: $('signup-add-error'),

    removeDialog: $('signup-remove-dialog'),
    removeForm: $('signup-remove-form'),
    removeWho: $('signup-remove-who'),
  };

  const state = {
    event: null,
    records: [],
    roster: [],
    rows: [],
    filter: 'all',
    loadToken: 0,
    busy: false,
    addPick: null, // a member id, 'guest', or null
    removing: null,
  };

  const questions = () =>
    [...(state.event?.event_signup_questions ?? [])].sort((a, b) => a.position - b.position);

  const eventIsPast = () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return String(state.event?.occurred_on ?? '') < today;
  };

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Called by the event screen after every read of the event. */
  async function show(event, records, roster) {
    state.event = event;
    state.records = records ?? [];
    state.roster = roster ?? [];
    state.loadToken += 1;
    const token = state.loadToken;
    try {
      const rows = await select('v_event_signups', {
        select: SIGNUP_SELECT,
        filters: { event_id: `eq.${event.id}` },
      });
      if (token !== state.loadToken) return;
      state.rows = rows;
    } catch (err) {
      if (token !== state.loadToken) return;
      state.rows = [];
      ctx.fail(err, () => show(event, records, roster));
    }
    render();
  }

  function dismiss() {
    state.loadToken += 1;
    state.event = null;
    state.rows = [];
    setHidden(el.block, true);
  }

  /** Any sign-up at all, cancelled ones included: the event is not empty. */
  const hasAny = () => state.rows.length > 0;

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function sortedRows() {
    return [...state.rows].sort((a, b) =>
      (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9)
      || String(a.confirmed_at ?? a.created_at).localeCompare(String(b.confirmed_at ?? b.created_at)));
  }

  /**
   * Place in line by sign-up id, over every sign-up and never a filtered
   * view: the database's own order (created_at, then id), going then the
   * waitlist after it.
   */
  function placesInLine() {
    const line = state.rows
      .filter((row) => row.state === 'going' || row.state === 'waitlist')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
    return new Map(line.map((row, index) => [row.id, index + 1]));
  }

  function render() {
    const event = state.event;
    const shown = Boolean(event?.signups_enabled) || state.rows.length > 0;
    setHidden(el.block, !shown);
    if (!shown) return;

    const count = (name) => state.rows.filter((row) => filterOf(row) === name).length;
    const going = count('going');
    const parts = [event.signup_capacity ? `${going} of ${event.signup_capacity} spots filled` : `${going} going`];
    if (count('waitlist')) parts.push(`${count('waitlist')} on waitlist`);
    const confirmed = state.rows.filter((row) => row.reply === 'confirmed').length;
    if (state.rows.some((row) => row.reply === 'awaiting' || row.reply === 'confirmed')) {
      parts.push(`${confirmed} confirmed`);
    }
    const attended = state.rows.filter((row) => attendanceOf(row, state.records, eventIsPast()) === 'attended').length;
    if (going || attended) parts.push(`${attended} attended`);
    el.summary.textContent = parts.join(', ');

    el.filters.replaceChildren(
      ...FILTERS.map((filter) => {
        const n = filter.value === 'all' ? state.rows.length : count(filter.value);
        return h(
          'button',
          {
            type: 'button',
            class: 'filter-tab',
            'aria-pressed': String(state.filter === filter.value),
            'aria-selected': String(state.filter === filter.value),
            onClick: () => {
              state.filter = filter.value;
              render();
            },
          },
          filter.label,
          h('span', { class: 'pill', dataset: { zero: String(n === 0) } }, String(n)),
        );
      }),
    );

    const rows = sortedRows().filter((row) => state.filter === 'all' || filterOf(row) === state.filter);
    el.exportButton.disabled = state.rows.length === 0;
    setHidden(el.empty, rows.length > 0);
    setHidden(el.table, rows.length === 0);
    el.empty.textContent = state.rows.length ? 'No sign-ups in this view' : 'No sign-ups';
    if (!rows.length) return;

    const qs = questions();
    el.head.replaceChildren(
      h(
        'tr',
        {},
        h('th', { scope: 'col', class: 'signup-col-spot' }, '#'),
        h('th', { scope: 'col' }, 'Name'),
        h('th', { scope: 'col' }, 'Status'),
        h('th', { scope: 'col' }, 'Confirmed'),
        h('th', { scope: 'col' }, 'Attended'),
        h('th', { scope: 'col' }, 'Signed up'),
        ...qs.map((question) => h('th', { scope: 'col' }, question.prompt)),
        h('th', { scope: 'col' }, 'Email'),
        h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Actions')),
      ),
    );

    // The # column is a place in line: going first, then the waitlist after.
    const spots = placesInLine();
    el.rows.replaceChildren(...rows.map((row) => renderRow(row, spots.get(row.id) ?? null, qs)));
  }

  function renderRow(row, spot, qs) {
    const attended = attendanceOf(row, state.records, eventIsPast());
    const live = row.state !== 'cancelled';
    return h(
      'tr',
      { dataset: { state: row.state } },
      h('td', { class: 'signup-col-spot' }, spot ? String(spot) : ''),
      h(
        'td',
        { class: 'signup-col-name' },
        h('span', {}, row.name),
        row.member_id ? null : h('span', { class: 'signup-tag' }, 'Guest'),
      ),
      h(
        'td',
        {},
        h('span', { class: 'signup-state', dataset: { state: row.state } }, signupStateLabel(row)),
      ),
      h('td', {}, h('span', { class: 'signup-reply', dataset: { reply: row.reply ?? 'none' } }, replyLabel(row))),
      h(
        'td',
        {},
        attended
          ? h('span', { class: 'signup-attended', dataset: { attended } }, ATTENDED_LABEL[attended])
          : null,
      ),
      h('td', { class: 'signup-col-when' }, when(row.created_at)),
      ...qs.map((question) => h('td', { class: 'signup-col-answer' }, answerText(question, row.answers))),
      h('td', { class: 'signup-col-email' }, row.email ?? ''),
      h(
        'td',
        { class: 'signup-col-actions' },
        live
          ? h(
              'button',
              {
                type: 'button',
                class: 'button button-small',
                'aria-label': `Remove ${row.name}`,
                disabled: state.busy,
                onClick: () => askToRemove(row),
              },
              'Remove',
            )
          : null,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  function exportCsv() {
    const qs = questions();
    const spots = placesInLine();
    const rows = [
      ['#', 'Name', 'Member', 'Email', 'Status', 'Confirmed', 'Attended', 'Signed up', ...qs.map((q) => q.prompt)],
      ...sortedRows().map((row) => {
        const spot = spots.get(row.id);
        const attended = attendanceOf(row, state.records, eventIsPast());
        return [
          spot ? String(spot) : '',
          row.name,
          row.member_id ? 'Member' : 'Guest',
          row.email ?? '',
          signupStateLabel(row),
          replyLabel(row),
          attended ? ATTENDED_LABEL[attended] : '',
          row.created_at ?? '',
          ...qs.map((question) => answerText(question, row.answers)),
        ];
      }),
    ];
    downloadCsv(qrFileName(state.event.title, state.event.occurred_on).replace(/\.png$/, '-signups.csv'), rows);
    announce(`${plural(rows.length - 1, 'sign-up')} exported`);
  }

  // -------------------------------------------------------------------------
  // Adding by hand
  // -------------------------------------------------------------------------

  function openAdd() {
    el.addForm.reset();
    state.addPick = null;
    setHidden(el.addError, true);
    renderAddChoices();
    el.addDialog.showModal();
    el.addName.focus();
  }

  function renderAddChoices() {
    const typed = el.addName.value.trim();
    // Prefix matches first, the way a person scans a list, then the fuzzy
    // ranking for a misspelling.
    const key = normaliseName(typed);
    const prefix = key
      ? state.roster.filter((member) => normaliseName(member.display_name).split(' ').some((part) => part.startsWith(key))
          || normaliseName(member.display_name).startsWith(key))
      : [];
    const fuzzy = typed.length >= 3 ? rankMembers({ name: typed }, state.roster, { limit: 6 }).map((row) => row.member) : [];
    const matches = [...new Map([...prefix, ...fuzzy].map((member) => [member.id, member])).values()].slice(0, 6);
    if (state.addPick && state.addPick !== 'guest' && !matches.some((m) => m.id === state.addPick)) {
      state.addPick = null;
    }
    const choice = (value, label, detail) =>
      h(
        'label',
        { class: 'signup-add-choice' },
        h('input', {
          type: 'radio',
          name: 'signup-add-pick',
          value,
          checked: state.addPick === value,
          onChange: () => {
            state.addPick = value;
            setHidden(el.addGuest, value !== 'guest');
          },
        }),
        h('span', {}, label),
        detail ? h('span', { class: 'muted small' }, detail) : null,
      );
    el.addChoices.replaceChildren(
      ...matches.map((member) => choice(member.id, member.display_name, 'Member')),
      ...(typed ? [choice('guest', typed, 'Guest, not on the roster')] : []),
    );
    setHidden(el.addChoices, !typed);
    setHidden(el.addGuest, state.addPick !== 'guest');
  }

  async function submitAdd(event) {
    event.preventDefault();
    if (state.busy) return;
    const name = el.addName.value.trim();
    if (!state.addPick) {
      el.addError.textContent = name ? 'Pick a member or Guest' : 'Type a name';
      setHidden(el.addError, false);
      return;
    }
    state.busy = true;
    try {
      await callRpc('add_event_signup', {
        p_event_id: state.event.id,
        p_member_id: state.addPick === 'guest' ? null : state.addPick,
        p_name: state.addPick === 'guest' ? name : null,
        p_email: state.addPick === 'guest' ? el.addEmail.value.trim() || null : null,
        p_answers: {},
      });
      el.addDialog.close();
      const said = `${name} added`;
      ctx.note(said);
      announce(said);
      await host.afterChange?.();
    } catch (err) {
      el.addError.textContent = err?.message ?? 'Not added';
      setHidden(el.addError, false);
    } finally {
      state.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Removing
  // -------------------------------------------------------------------------

  function askToRemove(row) {
    state.removing = row;
    el.removeWho.textContent = `${row.name}, ${signupStateLabel(row)}`;
    el.removeDialog.showModal();
  }

  async function confirmRemove(event) {
    event.preventDefault();
    const row = state.removing;
    state.removing = null;
    el.removeDialog.close();
    if (!row || state.busy) return;
    state.busy = true;
    render();
    try {
      await callRpc('remove_event_signup', { p_signup_id: row.id });
      const said = `${row.name} removed`;
      ctx.note(said);
      announce(said);
      await host.afterChange?.();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      state.busy = false;
      render();
    }
  }

  function mount() {
    el.add.addEventListener('click', openAdd);
    el.exportButton.addEventListener('click', exportCsv);
    el.addName.addEventListener('input', renderAddChoices);
    el.addForm.addEventListener('submit', submitAdd);
    el.removeForm.addEventListener('submit', confirmRemove);
    el.addDialog.querySelector('[data-close]')?.addEventListener('click', () => el.addDialog.close());
    el.removeDialog.querySelector('[data-close]')?.addEventListener('click', () => el.removeDialog.close());
  }

  return { mount, show, dismiss, hasAny };
}
