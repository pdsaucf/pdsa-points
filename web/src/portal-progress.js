// What a member sees once their account is linked: their progress toward
// Honorary Member, their records, and the one thing they can ask for.
//
// NOTHING ON THIS SCREEN IS DECIDED HERE (invariants 1 and 2).
//
//   the list itself   fn_member_requirement_status() returns one row per
//                     requirement in the PUBLISHED set, with the value, the
//                     target and the verdict already decided. A category added
//                     in September appears here in September, and nothing in
//                     this file names a category, a threshold or a unit.
//   is_honorary       read from v_member_status, which is the root
//                     requirement's verdict evaluated in Postgres.
//   point_total       read from v_member_status. It sums only the categories
//                     flagged as counting toward it, which is what excludes
//                     Volunteering hours, and that flag is a row rather than a
//                     rule anybody wrote in JavaScript.
//
// The only arithmetic below is the width of a bar, from two numbers the server
// sent, and that bar is decorative: the same two numbers are on screen in words
// beside it, because a fill is exactly what a member using a screen reader, or
// one who cannot tell the two colours apart, gets nothing from.
//
// THE RECORD LIST CARRIES THREE THINGS docs/04-member-ui.md calls out as
// mattering more than they look:
//
//   * PENDING RECORDS ARE VISIBLE, so "I checked in, did it work?" is
//     answerable by the member, at 8pm, without emailing anyone.
//   * A DECLINED RECORD SHOWS ITS REASON. review_note is what an officer
//     typed, and hiding it just generates the email asking for it.
//   * AN EVENT THAT COUNTS FOR TWO CATEGORIES SHOWS BOTH, so counting twice
//     reads as correct rather than as a bug.
//
// "SOMETHING'S MISSING?" FILES A REQUEST, NOT A CREDIT. request_missing_credit()
// writes an ordinary pending attendance record, sourced member_request, into
// the same review queue as a scanned check-in. Invariant 6 is the whole design
// of it: there is no argument by which this screen could ask for anything but
// pending, and the copy never says the credit is there. It says it was sent.

import { select, callRpc } from './rest.js';
import { describeMember } from './member-errors.js';
import { buildTree, flatten, unitWord } from './requirement-model.js';
import { valueFieldLabel } from './format.js';
import { $, h, announce, setHidden, shortDate } from './ui.js';

// What the status column says, in a member's words. The officer screens have
// their own set: "Declined" is a decision somebody made, "Not counted" is what
// it means for the person reading it.
const STATUS = {
  approved: 'Counted',
  pending: 'In review',
  rejected: 'Not counted',
};

const MARK = {
  approved: '✓',
  pending: '⏳',
  rejected: '✗',
};

const RECORD_SELECT = [
  'id',
  'status',
  'source',
  'submitted_value',
  'submitted_at',
  'review_note',
  'member_note',
  'events!inner(id,title,occurred_on,academic_year_id,' +
    'event_categories(credit_mode,categories(id,name,unit,unit_label)))',
].join(',');

const EVENT_SELECT =
  'id,title,occurred_on,event_categories(credit_mode,categories(id,name,unit,unit_label))';

export function createProgress(ctx) {
  const el = {
    title: $('progress-title'),
    figures: $('progress-figures'),
    bar: $('progress-bar'),
    barFill: $('progress-bar-fill'),
    state: $('progress-state'),
    list: $('progress-list'),
    points: $('progress-points'),
    note: $('progress-note'),

    recordsList: $('records-list'),
    recordsEmpty: $('records-empty'),

    missingOpen: $('missing-open'),
    missingClosed: $('missing-closed'),
    form: $('missing-form'),
    event: $('missing-event'),
    valueField: $('missing-value-field'),
    valueLabel: $('missing-value-label'),
    value: $('missing-value'),
    noteField: $('missing-note'),
    error: $('missing-error'),
    send: $('missing-send'),
    cancel: $('missing-cancel'),
  };

  const state = {
    status: null, // v_member_status, this member, this year
    checklist: [], // fn_member_requirement_status(), as a tree
    units: new Map(), // requirement id -> 'hours', where the club named a unit
    records: [],
    events: [], // published, this year
    busy: false,
  };

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function load() {
    const memberId = ctx.memberId;
    const yearId = ctx.year?.id;
    if (!memberId || !yearId) return;

    try {
      const [statuses, records, events] = await Promise.all([
        select('v_member_status', {
          select: 'member_id,point_total,is_honorary,requirement_set_id',
          filters: { member_id: `eq.${memberId}`, academic_year_id: `eq.${yearId}` },
          limit: 1,
        }),
        select('attendance_records', {
          select: RECORD_SELECT,
          filters: {
            member_id: `eq.${memberId}`,
            'events.academic_year_id': `eq.${yearId}`,
          },
        }),
        select('events', {
          select: EVENT_SELECT,
          filters: { academic_year_id: `eq.${yearId}`, is_published: 'is.true' },
          order: 'occurred_on.desc',
        }),
      ]);

      state.status = statuses[0] ?? null;
      state.events = events;

      // Newest first: the one somebody is asking about is nearly always the
      // one from last week.
      state.records = records.sort((a, b) =>
        String(b.events?.occurred_on ?? '').localeCompare(String(a.events?.occurred_on ?? '')),
      );

      await loadChecklist(state.status?.requirement_set_id ?? null);
      render();
    } catch (err) {
      ctx.fail(err, load);
    }
  }

  /**
   * The requirements, and the word each one counts in.
   *
   * The verdicts come from fn_member_requirement_status(), which is the same
   * function v_member_status uses for is_honorary, so this list and the state
   * beside the heading can never disagree. The tree is rebuilt only so a
   * requirement inside a group is drawn inside that group.
   *
   * The second read is for the unit word alone. The function answers with a
   * value and a target and no unit, and "29.5 of 25" is a worse sentence than
   * "29.5 of 25 hours". The word comes from the categories the requirement
   * measures, exactly as it does on the check-in page, so a club that renames
   * `hour` renames it here.
   */
  async function loadChecklist(setId) {
    state.checklist = [];
    state.units = new Map();
    if (!setId) return;

    const [rows, nodes] = await Promise.all([
      callRpc('fn_member_requirement_status', {
        p_member_id: ctx.memberId,
        p_requirement_set_id: setId,
      }),
      select('requirement_nodes', {
        select: 'id,requirement_node_categories(category_id,categories(id,unit,unit_label))',
        filters: { requirement_set_id: `eq.${setId}` },
      }),
    ]);

    for (const node of nodes) {
      const categories = (node.requirement_node_categories ?? [])
        .map((link) => link.categories)
        .filter(Boolean);
      // Only where the club gave the unit a word. A requirement measured in
      // plain event counts reads "9 of 9", which is what the design shows: an
      // invented "9 of 9 events" is noise on every line of the list.
      if (categories.length && categories.every((category) => category.unit_label)) {
        state.units.set(node.id, unitWord(categories));
      }
    }

    // The function already returns them in display order, so position stands
    // in for the sort column the rows do not carry.
    const shaped = (rows ?? []).map((row, index) => ({
      id: row.node_id,
      parent_id: row.parent_id,
      type: row.type,
      label: row.label,
      sort_order: index,
      value: Number(row.value ?? 0),
      target: Number(row.target ?? 0),
      passed: Boolean(row.passed),
    }));

    const { root } = buildTree(shaped);
    state.checklist = flatten(root);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** 29.5 stays 29.5, 5.00 becomes 5. A column of numbers reads badly otherwise. */
  const number = (value) => {
    const n = Number(value ?? 0);
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  };

  function render() {
    renderProgress();
    renderRecords();
    renderMissingButton();
  }

  function renderProgress() {
    const root = state.checklist[0]?.item ?? null;

    el.title.textContent = [root?.label, ctx.year?.label].filter(Boolean).join(' ');
    el.points.textContent = `${number(state.status?.point_total ?? 0)} points total`;

    // Honorary is the database's answer, rendered. The word is what carries it:
    // a gold pill with no text in it would be a colour and nothing else.
    const honorary = Boolean(state.status?.is_honorary);
    el.state.textContent = honorary ? 'Honorary' : '';
    setHidden(el.state, !honorary);

    if (!state.status) {
      // Enrolled for another year, or not on the roster at all. There is no
      // row to draw and inventing zeros would read as "you have done nothing".
      el.title.textContent = ctx.year?.label ?? '';
      el.figures.textContent = '';
      setHidden(el.bar, true);
      el.list.replaceChildren();
      el.points.textContent = '';
      el.note.textContent = "You are not on this year's roster.";
      setHidden(el.note, false);
      return;
    }

    if (!root) {
      el.figures.textContent = '';
      setHidden(el.bar, true);
      el.list.replaceChildren();
      el.note.textContent = 'No requirements are published for this year.';
      setHidden(el.note, false);
      return;
    }

    setHidden(el.note, true);
    el.figures.textContent = `${number(root.value)} of ${number(root.target)} met`;

    const share = root.target > 0 ? Math.min(100, Math.round((root.value / root.target) * 100)) : 0;
    el.barFill.setAttribute('style', `width: ${share}%`);
    setHidden(el.bar, false);

    // The root is the whole rule and its figures are in the line above, so the
    // list starts underneath it.
    el.list.replaceChildren(...state.checklist.slice(1).map(row));
  }

  function row({ item, depth }) {
    const unit = state.units.get(item.id) ?? '';
    const measured = item.type !== 'group';

    // A group whose rule is "some of these" is the one place a tick with no
    // figures would look wrong: two of its three requirements are visibly not
    // met and the group passed anyway. Where a group needs all of them, the
    // ticks below it already say the same thing, so it stays quiet.
    const showFigures = measured || item.target < (item.children?.length ?? 0);

    return h(
      'li',
      {
        class: 'check-row',
        dataset: { met: String(item.passed), depth: String(depth) },
      },
      h('span', { class: 'check-mark', 'aria-hidden': 'true' }, item.passed ? '✓' : '○'),
      h('span', { class: 'check-label' }, item.label),
      showFigures
        ? h(
            'span',
            { class: 'check-figures' },
            [`${number(item.value)} of ${number(item.target)}`, measured ? unit : 'met']
              .filter(Boolean)
              .join(' '),
          )
        : null,
      // Never the colour alone, and never the glyph alone either.
      h('span', { class: 'visually-hidden' }, item.passed ? 'Met' : 'Not met'),
    );
  }

  function renderRecords() {
    setHidden(el.recordsEmpty, state.records.length > 0);
    el.recordsList.replaceChildren(...state.records.map(recordRow));
  }

  function recordRow(record) {
    const event = record.events ?? {};

    return h(
      'li',
      { class: 'record', dataset: { record: record.id, status: record.status } },
      h(
        'div',
        { class: 'record-main' },
        h('span', { class: 'record-date' }, shortDate(event.occurred_on)),
        h('span', { class: 'record-title' }, event.title ?? ''),
        h('span', { class: 'record-categories' }, categoryText(record)),
      ),
      h(
        'p',
        { class: 'record-status' },
        h('span', { class: 'record-mark', 'aria-hidden': 'true' }, MARK[record.status] ?? ''),
        STATUS[record.status] ?? record.status,
      ),
      // Why it was turned down. The officer wrote this and the member is who
      // it was written for.
      record.status === 'rejected' && record.review_note
        ? h('p', { class: 'record-note' }, record.review_note)
        : null,
      // Their own words on a request they filed, so a pending one says what
      // they actually asked about.
      record.member_note ? h('p', { class: 'quote' }, record.member_note) : null,
    );
  }

  /**
   * 'Socials', or 'Tabling, Volunteering 3.5 hours'.
   *
   * Every category the event counts for, because an event counting twice is
   * the thing that looks like a bug when only half of it is on screen. The
   * number is shown for a category that reads one off the submission, since
   * "did my 3.5 hours land" is the question those records exist to answer.
   */
  function categoryText(record) {
    const links = record.events?.event_categories ?? [];
    return links
      .map((link) => {
        const category = link.categories ?? {};
        if (link.credit_mode !== 'from_submission' || record.submitted_value === null) {
          return category.name ?? '';
        }
        const unit = unitWord([category]);
        return `${category.name} ${number(record.submitted_value)}${unit ? ` ${unit}` : ''}`;
      })
      .filter(Boolean)
      .join(', ');
  }

  // -------------------------------------------------------------------------
  // "Something's missing?"
  // -------------------------------------------------------------------------

  /** Events this member could still ask about: published, and not already on the list. */
  function offerableEvents() {
    const taken = new Set(
      state.records.filter((record) => record.status !== 'rejected').map((record) => record.events?.id),
    );
    return state.events.filter((event) => !taken.has(event.id));
  }

  function renderMissingButton() {
    const offered = offerableEvents();
    const enrolled = Boolean(state.status);

    setHidden(el.missingOpen, !enrolled || offered.length === 0);
    setHidden(el.form, true);

    if (!enrolled) {
      el.missingClosed.textContent = 'Ask an officer to add you to this year.';
      setHidden(el.missingClosed, false);
      return;
    }
    if (!offered.length) {
      el.missingClosed.textContent = 'Every event is already on your list.';
      setHidden(el.missingClosed, false);
      return;
    }
    setHidden(el.missingClosed, true);
  }

  function openForm() {
    const offered = offerableEvents();
    if (!offered.length) {
      renderMissingButton();
      return;
    }

    el.event.replaceChildren(
      ...offered.map((event) =>
        h('option', { value: event.id }, `${shortDate(event.occurred_on)} ${event.title}`),
      ),
    );
    // Set rather than assumed: an unset select reads as the first option in a
    // browser and as nothing at all everywhere else.
    el.event.value = offered[0].id;

    el.noteField.value = '';
    el.value.value = '';
    setHidden(el.error, true);
    setHidden(el.missingOpen, true);
    setHidden(el.form, false);
    onEventChosen();
    announce('Say what is missing.');
  }

  function closeForm() {
    setHidden(el.form, true);
    setHidden(el.error, true);
    renderMissingButton();
  }

  /** The category that reads a number off the submission, if this event has one. */
  function valueLink(eventId) {
    const event = state.events.find((row) => row.id === eventId);
    return (event?.event_categories ?? []).find((link) => link.credit_mode === 'from_submission') ?? null;
  }

  /**
   * An event that collects a number still needs that number here, and the label
   * comes from the category rather than from anything this file knows about
   * hours. Same rule, and the same helper, as the check-in page.
   */
  function onEventChosen() {
    const link = valueLink(el.event.value);
    setHidden(el.valueField, !link);
    if (!link) return;
    const category = link.categories ?? {};
    el.valueLabel.textContent = valueFieldLabel({
      category: category.name,
      unit_label: category.unit_label,
    });
  }

  function showFormError(text) {
    el.error.textContent = text;
    setHidden(el.error, false);
    announce(text);
  }

  async function submitMissing(event) {
    event.preventDefault();
    if (state.busy) return;

    const eventId = el.event.value;
    if (!eventId) return;

    // The sentence request_missing_credit() raises for an empty note, said
    // here where it can still be fixed.
    const note = el.noteField.value.trim();
    if (!note) {
      showFormError('Say what is missing.');
      el.noteField.focus({ preventScroll: true });
      return;
    }

    const link = valueLink(eventId);
    let value = null;
    if (link) {
      const typed = el.value.value.trim();
      value = Number(typed);
      if (!typed || !Number.isFinite(value) || value < 0) {
        showFormError('Type a number.');
        el.value.focus({ preventScroll: true });
        return;
      }
    }

    setBusy(true);
    setHidden(el.error, true);
    ctx.clearMessage();

    try {
      await callRpc('request_missing_credit', {
        p_event_id: eventId,
        p_note: note,
        p_value: value,
      });
      // Never "added", never "counted". An officer decides it, and until they
      // do it sits in the list below as In review.
      const said = 'Sent for review.';
      ctx.note(said);
      announce(said);
      closeForm();
      await load();
    } catch (err) {
      const copy = describeMember(err);
      if (copy.recover === 'signin') {
        ctx.fail(err, null);
        return;
      }
      // Kept at the form rather than at the top of the page: the refusals that
      // arrive here are about the event they just picked, and picking another
      // one is the next thing they do.
      showFormError([copy.title, copy.body].filter(Boolean).join('. '));
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    state.busy = on;
    el.send.disabled = on;
  }

  // -------------------------------------------------------------------------

  function wire() {
    el.missingOpen.addEventListener('click', openForm);
    el.cancel.addEventListener('click', closeForm);
    el.event.addEventListener('change', onEventChosen);
    el.form.addEventListener('submit', submitMissing);
  }

  return {
    mount() {
      wire();
    },
    open: load,
    reload: load,
  };
}
