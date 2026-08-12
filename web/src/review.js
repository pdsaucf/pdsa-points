// The review queue.
//
// Every submission is reviewed by a person (invariant 6). The job of this
// screen is not to skip that step, it is to make the routine ones cost one
// decision between them and to make the broken ones impossible to miss. So the
// queue splits into two zones by the triage flags rather than presenting
// forty-seven identical rows:
//
//   Needs review   cards, one per record, each carrying the fix for whatever
//                  went wrong
//   Routine        a wall of photographs and one button
//
// THE ONE INTERACTION THAT MATTERS. A record with no member attached cannot be
// approved: the check constraint on attendance_records forbids it and
// review_records() raises PDS06 if you try. So an unmatched card does not offer
// Approve at all. It offers the roster suggestions, and once one is pressed the
// same card turns into an approvable one with the Approve button focused. The
// officer never meets a dead end and never meets a refusal they could have been
// spared.
//
// NOTHING HERE WRITES `status`. Approve and reject go through review_records(),
// linking goes through resolve_unmatched(). RLS would in fact let an officer
// UPDATE the column straight through PostgREST, so this is a line the client
// holds: those functions are also what stamp the reviewer, write the audit row,
// and refuse the approvals that must be refused.

import { select, insert, callRpc, signPhotoUrls, RpcError } from './rest.js';
import { describeOfficer, READ_ONLY } from './officer-errors.js';
import { FLAG_COPY, actionsFor, approveLabel, knownFlags, primaryFlag } from './flags.js';
import { rankMembers, splitName } from './match.js';
import { pluralUnit } from './format.js';
import { $, h, announce, setHidden, plural, shortDate, clockTime } from './ui.js';

// A full GBM is 167 people. Painting 167 tiles before the officer has looked at
// the first one is slower than it is useful, so the grid opens at this many and
// says how many more there are. "Approve all" always means all of them, shown
// or not, and its label says the real number.
const GRID_PAGE = 24;

const RECORD_SELECT = [
  'id',
  'event_id',
  'member_id',
  'claimed_name',
  'claimed_email',
  'status',
  'source',
  'submitted_value',
  'flags',
  'submitted_at',
  'review_note',
  'members(id,display_name,email)',
  // !inner so the year filter below narrows the records rather than just
  // blanking the embedded event on the ones from another year.
  'events!inner(id,title,occurred_on,academic_year_id,event_categories(credit_mode,categories(name,unit,unit_label)))',
  'attendance_evidence(id,kind,object_path,sha256)',
].join(',');

const REJECT_PRESETS = [
  'Was not at this event',
  'Photo is not from this event',
  'Already has credit for this event',
  'Checked in for somebody else',
];

const SOURCE_NOTE = {
  officer_entry: 'Added by an officer',
  import: 'Imported',
  member_request: 'Member portal',
};

// A card whose flags have all been dealt with, which is what a resolved
// unmatched card becomes without leaving the screen.
const SETTLED_HEADLINE = 'Ready to approve';

/**
 * Members who already hold a live record for the same event.
 *
 * This exists because the ranking will happily suggest one. The mock roster
 * has an "Abby Catto" and an "Abigail Catto", and a check-in typed as "Abby
 * Cato" scores both highly, but if Abby Catto already scanned in properly then
 * linking this one to her is refused: one_live_record_per_member_event allows
 * exactly one. Left alone, the officer presses the best-looking suggestion and
 * gets PDS05 back, which reads as the software being broken rather than as the
 * answer being wrong.
 *
 * So a suggestion that would clash is shown, greyed, with the reason. Shown
 * rather than hidden, because "she is already checked in" is often the fact
 * the officer needed: it means the person in front of them is the OTHER Catto.
 *
 * Only pending records are loaded, so this cannot see an already-approved
 * clash. That case still reaches PDS05, and officer-errors.js has copy for it.
 * This is the cheap half of a two-layer answer, not the whole of it.
 *
 * @param {Array} records the queue as loaded
 * @param {{id: string, event_id: string}} record the unmatched one being resolved
 * @returns {Set<string>} member ids that cannot take this record
 */
export function membersAlreadyOnEvent(records, record) {
  return new Set(
    (records ?? [])
      .filter(
        (other) =>
          other.id !== record.id &&
          other.event_id === record.event_id &&
          other.member_id &&
          other.status !== 'rejected',
      )
      .map((other) => other.member_id),
  );
}

export function createReview(ctx) {
  const el = {
    loading: $('loading-review'),
    empty: $('empty-review'),
    emptyBody: $('empty-review-body'),
    flaggedZone: $('zone-flagged'),
    flaggedList: $('flagged-list'),
    flaggedCount: $('flagged-count'),
    routineZone: $('zone-routine'),
    routineGrid: $('routine-grid'),
    routineCount: $('routine-count'),
    approveAll: $('approve-all'),
    showAll: $('show-all'),
    eventSelect: $('event-select'),
    pendingCount: $('pending-count'),
    refresh: $('refresh'),
    rejectDialog: $('reject-dialog'),
    rejectForm: $('reject-form'),
    rejectTitle: $('reject-title'),
    rejectNote: $('reject-note'),
    rejectError: $('reject-error'),
    rejectPresets: $('reject-presets'),
    newMemberDialog: $('new-member-dialog'),
    newMemberForm: $('new-member-form'),
    newFirst: $('new-first'),
    newLast: $('new-last'),
    newEmail: $('new-email'),
    newMemberError: $('new-member-error'),
    photoDialog: $('photo-dialog'),
    photoBody: $('photo-dialog-body'),
    photoHint: $('photo-dialog-hint'),
  };

  const state = {
    records: [],
    roster: null, // loaded lazily, only when a card actually needs it
    priorRejections: new Map(), // `${event_id}:${member_id}` -> record
    photos: new Map(), // object_path -> signed url
    eventFilter: 'all',
    showAllRoutine: false,
    cursorId: null,
    busy: false,
    loaded: false,
  };

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async function load() {
    setHidden(el.loading, false);
    setHidden(el.empty, true);
    setHidden(el.flaggedZone, true);
    setHidden(el.routineZone, true);

    // Signed photo URLs expire, so a queue left open all evening and then
    // refreshed must not reuse the ones it signed at six o'clock. The roster
    // is deliberately NOT cleared: members do not change between refreshes,
    // and it is the one fetch on this screen worth keeping.
    state.photos.clear();
    state.priorRejections.clear();

    try {
      const records = await select('attendance_records', {
        select: RECORD_SELECT,
        filters: {
          status: 'eq.pending',
          'events.academic_year_id': `eq.${ctx.year.id}`,
        },
        order: 'submitted_at.asc',
      });

      state.records = records;
      state.loaded = true;

      await Promise.all([loadPhotos(records), loadRosterIfNeeded(), loadPriorRejections()]);

      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  async function loadPhotos(records) {
    const paths = records.flatMap((r) => (r.attendance_evidence ?? []).map((e) => e.object_path));
    if (!paths.length) return;
    try {
      const urls = await signPhotoUrls(paths);
      for (const [path, url] of urls) state.photos.set(path, url);
    } catch {
      // A photo that will not sign is a tile that says so. It is not a reason
      // to refuse to show the queue, and an officer who was at the event can
      // still make the call.
    }
  }

  /**
   * The roster is only fetched when a card actually needs it: an unmatched
   * name to rank against, or a "very similar name" flag to explain. On a queue
   * of forty routine check-ins it is never fetched at all.
   */
  async function loadRosterIfNeeded() {
    if (state.roster) return;
    const needed = state.records.some((r) =>
      (r.flags ?? []).some((f) => f === 'unmatched_name' || f === 'possible_duplicate_person'),
    );
    if (!needed) return;

    state.roster = await select('members', {
      select: 'id,display_name,email',
      filters: { archived_at: 'is.null', merged_into_id: 'is.null' },
      order: 'display_name.asc',
    });
  }

  /**
   * "Previously declined" is useless without the reason it was declined, and
   * that reason is on the earlier record. One query for every such card,
   * rather than one per card.
   */
  async function loadPriorRejections() {
    const wanted = state.records.filter(
      (r) => (r.flags ?? []).includes('previously_rejected') && r.member_id,
    );
    if (!wanted.length) return;

    const events = [...new Set(wanted.map((r) => r.event_id))];
    const members = [...new Set(wanted.map((r) => r.member_id))];
    const rows = await select('attendance_records', {
      select: 'id,event_id,member_id,review_note,reviewed_at',
      filters: {
        status: 'eq.rejected',
        event_id: `in.(${events.join(',')})`,
        member_id: `in.(${members.join(',')})`,
      },
      order: 'reviewed_at.desc',
    });
    for (const row of rows) {
      const key = `${row.event_id}:${row.member_id}`;
      if (!state.priorRejections.has(key)) state.priorRejections.set(key, row);
    }
  }

  // -------------------------------------------------------------------------
  // Slicing
  // -------------------------------------------------------------------------

  const inFilter = (record) =>
    state.eventFilter === 'all' || record.event_id === state.eventFilter;

  const visible = () => state.records.filter(inFilter);
  const flagged = () => visible().filter((r) => knownFlags(r.flags).length > 0);
  const routine = () => visible().filter((r) => knownFlags(r.flags).length === 0);

  const nameOf = (record) =>
    record.members?.display_name ?? record.claimed_name ?? 'No name on file';

  function eventLabel(record) {
    const event = record.events ?? {};
    return `${shortDate(event.occurred_on)} ${event.title ?? 'Untitled event'}`.trim();
  }

  /** 'Volunteering: 3.5 hours', built from whatever the event actually reads. */
  function valueLabel(record) {
    if (record.submitted_value === null || record.submitted_value === undefined) return '';
    const link = (record.events?.event_categories ?? []).find(
      (ec) => ec.credit_mode === 'from_submission',
    );
    const category = link?.categories;
    if (!category) return `Entered ${record.submitted_value}`;
    const unit = pluralUnit(category.unit_label ?? category.unit);
    return `${category.name}: ${record.submitted_value} ${unit}`.trim();
  }

  function photoUrl(record) {
    const evidence = (record.attendance_evidence ?? [])[0];
    return evidence ? state.photos.get(evidence.object_path) ?? null : null;
  }

  /**
   * The one line under a heading that carries the identifiers: who, which
   * event, what time. Parts may be nodes, so the name can stay emphasised.
   */
  function metaLine(parts) {
    const kept = parts.filter(Boolean);
    const children = [];
    for (const part of kept) {
      if (children.length) children.push(' · ');
      children.push(part);
    }
    return h('p', { class: 'card-meta' }, children);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    setHidden(el.loading, true);
    renderEventFilter();

    const all = visible();
    const flaggedRows = flagged();
    const routineRows = routine();

    el.pendingCount.textContent = all.length
      ? `${plural(all.length, 'check-in')} waiting`
      : '';
    ctx.setReviewCount(state.records.length);

    if (!all.length) {
      setHidden(el.flaggedZone, true);
      setHidden(el.routineZone, true);
      setHidden(el.empty, false);
      el.emptyBody.textContent =
        state.eventFilter === 'all'
          ? 'Every check-in for this year has been reviewed.'
          : 'Every check-in for that event has been reviewed.';
      return;
    }

    setHidden(el.empty, true);

    setHidden(el.flaggedZone, flaggedRows.length === 0);
    el.flaggedCount.textContent = flaggedRows.length ? `· ${flaggedRows.length}` : '';
    el.flaggedList.replaceChildren(...flaggedRows.map(renderCard));

    setHidden(el.routineZone, routineRows.length === 0);
    el.routineCount.textContent = routineRows.length ? `· ${routineRows.length}` : '';
    // Rebuilt even when the zone is about to be hidden. Leaving the last
    // batch of tiles in the DOM behind a hidden attribute is how a cleared
    // grid comes back from the dead the next time a filter unhides the zone.
    const shown = state.showAllRoutine ? routineRows : routineRows.slice(0, GRID_PAGE);
    el.routineGrid.replaceChildren(...shown.map(renderTile));

    const notShown = routineRows.length - shown.length;
    setHidden(el.showAll, notShown <= 0);
    el.showAll.textContent = notShown > 0 ? `Show all ${routineRows.length}` : '';

    el.approveAll.textContent = `Approve all ${routineRows.length}`;
    el.approveAll.disabled = state.busy || !ctx.canReview || routineRows.length === 0;

    applyCursor();
  }

  function renderEventFilter() {
    const counts = new Map();
    for (const record of state.records) {
      const event = record.events ?? {};
      const entry = counts.get(record.event_id) ?? {
        id: record.event_id,
        title: event.title ?? 'Untitled event',
        occurred_on: event.occurred_on,
        count: 0,
      };
      entry.count += 1;
      counts.set(record.event_id, entry);
    }

    const events = [...counts.values()].sort((a, b) =>
      String(b.occurred_on ?? '').localeCompare(String(a.occurred_on ?? '')),
    );

    if (!events.some((e) => e.id === state.eventFilter)) state.eventFilter = 'all';

    el.eventSelect.replaceChildren(
      h('option', { value: 'all' }, `All events (${state.records.length})`),
      ...events.map((event) =>
        h(
          'option',
          { value: event.id },
          `${shortDate(event.occurred_on)} ${event.title} (${event.count})`,
        ),
      ),
    );
    el.eventSelect.value = state.eventFilter;
  }

  // ---- flagged cards ------------------------------------------------------

  function renderCard(record) {
    const flags = knownFlags(record.flags);
    const lead = primaryFlag(record.flags);
    const copy = lead ? FLAG_COPY[lead] : null;
    const actions = actionsFor(record.flags);

    const card = h('article', {
      class: 'card',
      tabindex: '-1',
      dataset: { id: record.id, severity: copy?.severity ?? 'look' },
    });

    const main = h('div', { class: 'card-main' });

    // The heading names the state. Who they are, which event and what time all
    // sit on the metadata line under it.
    main.append(h('p', { class: 'card-headline' }, copy ? copy.headline : SETTLED_HEADLINE));

    main.append(
      metaLine([
        record.member_id
          ? h('span', { class: 'card-who' }, nameOf(record))
          : h('span', { class: 'card-said' }, `"${record.claimed_name ?? ''}"`),
        eventLabel(record),
        clockTime(record.submitted_at),
        valueLabel(record),
        // The "Requested by member" heading already says where it came from.
        lead === 'member_requested' ? null : SOURCE_NOTE[record.source],
        record.claimed_email || null,
      ]),
    );

    if (copy?.detail) main.append(h('p', { class: 'card-detail' }, copy.detail));

    // Any flag past the first one is still named, otherwise a card headlined
    // "Member not matched" would silently drop "and no photo either". The
    // headline is the whole fact, so the details are not repeated here.
    if (flags.length > 1) {
      const also = flags.slice(1).map((flag) => FLAG_COPY[flag].headline).join(', ');
      main.append(h('p', { class: 'card-detail' }, `Also: ${also}`));
    }

    if (flags.includes('previously_rejected')) {
      const prior = state.priorRejections.get(`${record.event_id}:${record.member_id}`);
      if (prior?.review_note) {
        main.append(
          h(
            'p',
            { class: 'card-quote' },
            h('span', { class: 'card-quote-label' }, 'Previous reason'),
            prior.review_note,
          ),
        );
      }
    }

    if (flags.includes('possible_duplicate_person') && record.members) {
      const similar = rankMembers({ name: record.members.display_name }, state.roster ?? [], {
        limit: 3,
        floor: 0.45,
      }).filter((row) => row.member.id !== record.member_id);
      if (similar.length) {
        main.append(
          h(
            'p',
            { class: 'card-quote' },
            h('span', { class: 'card-quote-label' }, 'Also on the roster'),
            similar.map((row) => row.member.display_name).join(', '),
          ),
        );
      }
    }

    if (record.review_note) {
      main.append(
        h(
          'p',
          { class: 'card-quote' },
          h('span', { class: 'card-quote-label' }, 'Note'),
          record.review_note,
        ),
      );
    }

    card.append(main, h('div', { class: 'card-side' }, thumbFor(record)));

    if (flags.includes('unmatched_name')) card.append(renderSuggestions(record, card));

    card.append(renderActions(record, actions, card));
    return card;
  }

  /** The photo the lightbox is showing, so the arrow keys know where they are. */
  let lightboxId = null;

  function thumbFor(record) {
    const url = photoUrl(record);
    if (!url) {
      return h(
        'p',
        { class: 'thumb-missing' },
        (record.attendance_evidence ?? []).length ? 'Photo unavailable' : 'No photo',
      );
    }
    return h('img', {
      class: 'thumb',
      src: url,
      alt: `Photo submitted by ${nameOf(record)}`,
      loading: 'lazy',
      onClick: () => openPhoto(record),
    });
  }

  /**
   * The ranked roster. One click links the record to that person.
   *
   * "Add as new member" sits at the end of the same row rather than somewhere
   * else, because at the first event of the year it is the common answer, not
   * the exceptional one: the system ships with an empty roster and the first
   * GBM is a recruiting event.
   */
  function renderSuggestions(record, card) {
    const list = h('ul', { class: 'suggestions' });
    const ranked = rankMembers(
      { name: record.claimed_name, email: record.claimed_email },
      state.roster ?? [],
      { limit: 5 },
    );

    if (!ranked.length) {
      list.append(
        h(
          'li',
          { class: 'no-suggestions' },
          state.roster && state.roster.length
            ? 'No close match on the roster.'
            : 'The roster is empty.',
        ),
      );
    }

    const taken = membersAlreadyOnEvent(state.records, record);

    for (const row of ranked) {
      const clashes = taken.has(row.member.id);
      list.append(
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'suggestion',
              dataset: {
                certain: String(row.certain && !clashes),
                memberId: row.member.id,
                clash: String(clashes),
              },
              disabled: !ctx.canReview || clashes,
              'aria-label': clashes
                ? `${row.member.display_name}, already checked in to this event`
                : `Link member ${row.member.display_name}`,
              title: clashes
                ? `${row.member.display_name} already has a check-in for this event`
                : '',
              onClick: () => resolveToMember(record, row.member, card),
            },
            h('span', { class: 'suggestion-name' }, row.member.display_name),
            h(
              'span',
              { class: 'suggestion-why' },
              clashes ? 'Already checked in' : row.reason,
            ),
          ),
        ),
      );
    }

    list.append(
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'button button-small',
            disabled: !ctx.canReview,
            onClick: () => resolveToNewMember(record, card),
          },
          'Add new member',
        ),
      ),
    );

    return list;
  }

  function renderActions(record, actions) {
    const row = h('div', { class: 'card-actions' });

    const button = (label, className, onClick, { readOnly = false } = {}) =>
      h(
        'button',
        {
          type: 'button',
          class: `button ${className}`,
          // Comparing two photos changes nothing, so a viewer keeps it. Every
          // other control here writes, and fn_assert_officer() would refuse it.
          dataset: readOnly ? { readonly: 'true' } : {},
          disabled: state.busy || (!ctx.canReview && !readOnly),
          onClick,
        },
        label,
      );

    for (const action of actions) {
      if (action === 'resolve') continue; // the suggestion row above is the control
      if (action === 'compare') {
        row.append(button('Compare photos', '', () => openComparison(record), { readOnly: true }));
      } else if (action === 'enroll') {
        row.append(
          button('Enroll and approve', 'button-primary', () => enrollAndApprove(record)),
        );
      } else if (action === 'approve') {
        row.append(
          button(approveLabel(record.flags), 'button-primary', () =>
            decide([record.id], 'approve', null),
          ),
        );
      } else if (action === 'reject') {
        row.append(button('Decline', 'button-danger', () => rejectWithReason([record])));
      }
    }

    if (!ctx.canReview) {
      row.append(h('p', { class: 'muted small' }, READ_ONLY));
    }

    return row;
  }

  // ---- routine tiles ------------------------------------------------------

  function renderTile(record) {
    const url = photoUrl(record);
    const tile = h('div', { class: 'tile', tabindex: '-1', dataset: { id: record.id } });

    tile.append(
      url
        ? h('img', {
            class: 'tile-photo',
            src: url,
            alt: `Photo submitted by ${nameOf(record)}`,
            loading: 'lazy',
            onClick: () => openPhoto(record),
          })
        : h('p', { class: 'tile-missing' }, 'No photo'),
      h('p', { class: 'tile-name', title: nameOf(record) }, nameOf(record)),
      h('p', { class: 'tile-value' }, valueLabel(record) || eventLabel(record)),
      h(
        'div',
        { class: 'tile-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'tile-action',
            dataset: { decision: 'approve' },
            title: `Approve ${nameOf(record)}`,
            'aria-label': `Approve ${nameOf(record)}`,
            disabled: state.busy || !ctx.canReview,
            onClick: () => decide([record.id], 'approve', null),
          },
          '✓',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'tile-action',
            dataset: { decision: 'reject' },
            title: `Decline ${nameOf(record)}`,
            'aria-label': `Decline ${nameOf(record)}`,
            disabled: state.busy || !ctx.canReview,
            onClick: () => rejectWithReason([record]),
          },
          '✗',
        ),
      ),
    );

    return tile;
  }

  // -------------------------------------------------------------------------
  // Deciding
  // -------------------------------------------------------------------------

  function setBusy(on) {
    state.busy = on;
    for (const node of document.querySelectorAll('.card-actions button, .tile-action')) {
      const readOnly = node.dataset.readonly === 'true';
      node.disabled = on || (!ctx.canReview && !readOnly);
    }
    el.approveAll.disabled = on || !ctx.canReview || routine().length === 0;
  }

  function drop(ids) {
    const gone = new Set(ids);
    state.records = state.records.filter((r) => !gone.has(r.id));
    if (gone.has(state.cursorId)) state.cursorId = null;
  }

  /**
   * approve or reject, through review_records() and nothing else.
   *
   * PDS06 is caught rather than merely displayed. It means an approve reached a
   * record with nobody attached, which this screen tries hard to make
   * impossible, so if it happens the screen is out of date and reloading it is
   * the honest answer rather than leaving a card that will refuse again.
   */
  async function decide(ids, decision, note) {
    if (!ids.length) return;
    setBusy(true);
    ctx.clearMessage();
    try {
      const count = await callRpc('review_records', {
        p_ids: ids,
        p_decision: decision,
        p_note: note ?? null,
      });

      drop(ids);
      const verb = decision === 'approve' ? 'Approved' : 'Declined';
      const said = `${verb} ${plural(Number(count) || ids.length, 'check-in')}.`;
      ctx.note(said);
      announce(said);
      render();
    } catch (err) {
      if (err instanceof RpcError && err.code === 'PDS06') {
        ctx.fail(err, load);
      } else {
        ctx.fail(err, () => decide(ids, decision, note));
      }
    } finally {
      setBusy(false);
    }
  }

  async function approveAll() {
    const ids = routine().map((r) => r.id);
    if (!ids.length) return;
    await decide(ids, 'approve', null);
  }

  async function rejectWithReason(records) {
    const reason = await askReason(records);
    if (!reason) return;
    await decide(
      records.map((r) => r.id),
      'reject',
      reason,
    );
  }

  /**
   * Linking, then approving, are two decisions and stay two clicks.
   * resolve_unmatched() deliberately does not approve, because working out who
   * somebody is and deciding whether they get credit are different judgements.
   * The screen does the next best thing: it turns the card into an approvable
   * one on the spot and puts the cursor on the Approve button, so the second
   * decision is one keystroke away rather than a page reload away.
   */
  async function resolveToMember(record, member, card) {
    setBusy(true);
    ctx.clearMessage();
    try {
      await callRpc('resolve_unmatched', {
        p_record_id: record.id,
        p_member_id: member.id,
      });
      onResolved(record, member, card, `Linked to ${member.display_name}.`);
    } catch (err) {
      ctx.fail(err, () => resolveToMember(record, member, card));
    } finally {
      setBusy(false);
    }
  }

  async function resolveToNewMember(record, card) {
    const guess = splitName(record.claimed_name);
    const details = await askNewMember(guess, record.claimed_email);
    if (!details) return;

    setBusy(true);
    ctx.clearMessage();
    try {
      const memberId = await callRpc('resolve_unmatched', {
        p_record_id: record.id,
        p_new_member: details,
      });
      const display = `${details.first_name} ${details.last_name}`.trim();
      const member = { id: memberId, display_name: display, email: details.email ?? null };
      if (state.roster) state.roster.push(member);
      onResolved(record, member, card, `${display} added to the roster and linked.`);
    } catch (err) {
      ctx.fail(err, () => resolveToNewMember(record, card));
    } finally {
      setBusy(false);
    }
  }

  function onResolved(record, member, card, said) {
    record.member_id = member.id;
    record.members = { id: member.id, display_name: member.display_name, email: member.email ?? null };
    record.flags = (record.flags ?? []).filter((f) => f !== 'unmatched_name');
    // resolve_unmatched() enrols them in the event's year as part of the same
    // transaction, so a not_enrolled flag left over from submission is stale.
    record.flags = record.flags.filter((f) => f !== 'not_enrolled');

    const settled = `${said} Not approved yet.`;
    ctx.note(settled);
    announce(settled);

    const replacement = renderCard(record);
    replacement.classList.add('is-settled');
    replacement.append(h('p', { class: 'card-outcome' }, settled));
    card.replaceWith(replacement);
    state.cursorId = record.id;
    applyCursor();

    // On the next task, not this one. Closing a <dialog> restores focus to
    // whatever had it beforehand, and the browser does that fixup after the
    // current one, so focusing here directly gets quietly undone and the
    // officer's next keystroke goes nowhere. The Approve button is the whole
    // point of this moment, so it has to win.
    //
    // setTimeout rather than requestAnimationFrame: a frame callback does not
    // run at all while the tab is in the background, and an officer who came
    // back to a tab to find focus lost would have no idea why.
    const approve = replacement.querySelector('.button-primary');
    if (approve) setTimeout(() => approve.focus({ preventScroll: true }), 0);
  }

  /**
   * The wireframe's "Enroll & approve". Two writes rather than one, because
   * there is no RPC that does both: enrolling is an ordinary insert an officer
   * is allowed to make, and approving is review_records(). They are ordered so
   * a failure leaves the safer state: enrolled but still pending is a record
   * an officer can still approve, where approved but not enrolled would be
   * credit against a year they are not on.
   */
  async function enrollAndApprove(record) {
    setBusy(true);
    ctx.clearMessage();
    try {
      await insert('member_enrollments', [
        {
          member_id: record.member_id,
          academic_year_id: record.events?.academic_year_id ?? ctx.year.id,
          status: 'active',
        },
      ]);
      record.flags = (record.flags ?? []).filter((f) => f !== 'not_enrolled');
      setBusy(false);
      await decide([record.id], 'approve', null);
    } catch (err) {
      setBusy(false);
      ctx.fail(err, () => enrollAndApprove(record));
    }
  }

  // -------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------

  /**
   * Rejection always captures a reason (docs/03-admin-ui.md section 2). Six
   * months later "why doesn't Ana have credit for the March GBM" has an answer,
   * and the member sees it on their own records screen without emailing
   * anybody.
   *
   * The presets exist because a reason nobody can face typing forty times
   * becomes a reason nobody records.
   */
  function askReason(records) {
    return new Promise((resolve) => {
      el.rejectTitle.textContent =
        records.length === 1
          ? `Decline ${nameOf(records[0])}`
          : `Decline ${plural(records.length, 'check-in')}`;
      el.rejectNote.value = '';
      setHidden(el.rejectError, true);

      el.rejectPresets.replaceChildren(
        ...REJECT_PRESETS.map((preset) =>
          h(
            'button',
            {
              type: 'button',
              class: 'chip',
              onClick: () => {
                el.rejectNote.value = preset;
                setHidden(el.rejectError, true);
                el.rejectNote.focus();
              },
            },
            preset,
          ),
        ),
      );

      // The guard matters. close() fires its `close` event as a queued task,
      // so the cancel path can still run after the submit path has already
      // decided, and without this the rejection would be quietly thrown away
      // by its own dialog closing. Relying on that ordering is not worth it.
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        el.rejectForm.removeEventListener('submit', onSubmit);
        el.rejectDialog.removeEventListener('close', onClose);
        resolve(value);
      };

      const onSubmit = (event) => {
        const note = el.rejectNote.value.trim();
        if (!note) {
          event.preventDefault();
          setHidden(el.rejectError, false);
          el.rejectNote.focus();
          return;
        }
        el.rejectDialog.close();
        finish(note);
      };

      const onClose = () => finish(null);

      el.rejectForm.addEventListener('submit', onSubmit);
      el.rejectDialog.addEventListener('close', onClose, { once: true });
      el.rejectDialog.showModal();
      el.rejectNote.focus();
    });
  }

  function askNewMember(guess, email) {
    return new Promise((resolve) => {
      el.newFirst.value = guess.first_name ?? '';
      el.newLast.value = guess.last_name ?? '';
      el.newEmail.value = email ?? '';
      setHidden(el.newMemberError, true);

      // Same guard as askReason, for the same reason.
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        el.newMemberForm.removeEventListener('submit', onSubmit);
        el.newMemberDialog.removeEventListener('close', onClose);
        resolve(value);
      };

      const onSubmit = (event) => {
        const first = el.newFirst.value.trim();
        const last = el.newLast.value.trim();
        if (!first || !last) {
          event.preventDefault();
          setHidden(el.newMemberError, false);
          el.newFirst.focus();
          return;
        }
        el.newMemberDialog.close();
        finish({ first_name: first, last_name: last, email: el.newEmail.value.trim() || null });
      };

      const onClose = () => finish(null);

      el.newMemberForm.addEventListener('submit', onSubmit);
      el.newMemberDialog.addEventListener('close', onClose, { once: true });
      el.newMemberDialog.showModal();
      el.newFirst.focus();
    });
  }

  function openPhoto(record) {
    const url = photoUrl(record);
    if (!url) return;
    lightboxId = record.id;
    el.photoBody.replaceChildren(
      h(
        'figure',
        {},
        h('img', { src: url, alt: `Photo submitted by ${nameOf(record)}` }),
        h(
          'figcaption',
          {},
          h('strong', {}, nameOf(record)),
          `${eventLabel(record)} · ${clockTime(record.submitted_at)}`,
        ),
      ),
    );
    el.photoHint.textContent = 'Arrow keys move between photos.';
    if (!el.photoDialog.open) el.photoDialog.showModal();
  }

  /**
   * Stepping through the wall of photos without closing the lightbox between
   * each one. Judging forty shirt photos is the task this screen exists for,
   * and doing it at full size should not cost forty round trips through Escape.
   *
   * Records with no photo are skipped rather than shown as a gap, because the
   * only reason to be in here is to look at a photograph.
   */
  function stepLightbox(delta) {
    // Null while the dialog is showing a comparison rather than one record's
    // photo. Stepping out of a comparison with an arrow key would replace the
    // thing the officer opened it to look at.
    if (!lightboxId) return;
    const withPhotos = orderedIds()
      .map((id) => state.records.find((r) => r.id === id))
      .filter((record) => record && photoUrl(record));
    if (withPhotos.length < 2) return;

    const at = withPhotos.findIndex((record) => record.id === lightboxId);
    const next = at < 0 ? 0 : (at + delta + withPhotos.length) % withPhotos.length;
    const record = withPhotos[next];
    // Moving the lightbox moves the cursor with it, so closing it leaves the
    // keyboard where the officer's eyes are rather than where they were.
    state.cursorId = record.id;
    applyCursor();
    openPhoto(record);
  }

  /**
   * The duplicate-photo case, which the wireframe calls "both photos side by
   * side". The other record is found by the hash the database already stores,
   * so this is a lookup and not a guess.
   */
  async function openComparison(record) {
    const evidence = (record.attendance_evidence ?? [])[0];
    el.photoBody.replaceChildren(h('p', { class: 'muted' }, 'Loading the other photo…'));
    el.photoHint.textContent = '';
    lightboxId = null; // a comparison is not a place the arrow keys can step from
    if (!el.photoDialog.open) el.photoDialog.showModal();

    if (!evidence?.sha256) {
      el.photoBody.replaceChildren(
        h('p', { class: 'muted' }, 'The other photo is no longer available.'),
      );
      return;
    }

    try {
      const rows = await select('attendance_evidence', {
        select:
          'id,object_path,sha256,attendance_records(id,event_id,status,members(display_name),events(title,occurred_on))',
        filters: { sha256: `eq.${evidence.sha256}` },
      });

      const others = rows.filter((row) => row.attendance_records?.id !== record.id);
      const urls = await signPhotoUrls([evidence.object_path, ...others.map((o) => o.object_path)]);
      for (const [path, url] of urls) state.photos.set(path, url);

      const figure = (path, title, caption) =>
        h(
          'figure',
          {},
          state.photos.get(path)
            ? h('img', { src: state.photos.get(path), alt: title })
            : h('p', { class: 'tile-missing' }, 'Photo unavailable'),
          h('figcaption', {}, h('strong', {}, title), caption),
        );

      el.photoBody.replaceChildren(
        figure(
          evidence.object_path,
          'This check-in',
          `${nameOf(record)} · ${eventLabel(record)}`,
        ),
        ...others.map((other) => {
          const rec = other.attendance_records ?? {};
          const who = rec.members?.display_name ?? 'No name on file';
          const where = `${shortDate(rec.events?.occurred_on)} ${rec.events?.title ?? ''}`.trim();
          return figure(other.object_path, 'Earlier check-in', `${who} · ${where} · ${rec.status}`);
        }),
      );
      el.photoHint.textContent = others.length
        ? 'Same image on both records.'
        : 'The other record no longer exists.';
    } catch (err) {
      const copy = describeOfficer(err);
      el.photoBody.replaceChildren(h('p', { class: 'muted' }, `${copy.title}. ${copy.body}`));
    }
  }

  // -------------------------------------------------------------------------
  // The cursor, and the keyboard
  // -------------------------------------------------------------------------

  const orderedIds = () => [
    ...flagged().map((r) => r.id),
    ...(state.showAllRoutine ? routine() : routine().slice(0, GRID_PAGE)).map((r) => r.id),
  ];

  function nodeFor(id) {
    return (
      el.flaggedList.querySelector(`[data-id="${CSS.escape(id)}"]`) ??
      el.routineGrid.querySelector(`[data-id="${CSS.escape(id)}"]`)
    );
  }

  function applyCursor() {
    for (const node of document.querySelectorAll('.is-cursor')) node.classList.remove('is-cursor');
    if (!state.cursorId) return;
    nodeFor(state.cursorId)?.classList.add('is-cursor');
  }

  function moveCursor(delta) {
    const ids = orderedIds();
    if (!ids.length) return;
    const at = ids.indexOf(state.cursorId);
    const next = at < 0 ? (delta > 0 ? 0 : ids.length - 1) : (at + delta + ids.length) % ids.length;
    state.cursorId = ids[next];
    applyCursor();

    const node = nodeFor(state.cursorId);
    node?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: 'nearest' });

    const record = state.records.find((r) => r.id === state.cursorId);
    if (record) announce(`${nameOf(record)}. ${eventLabel(record)}.`);
  }

  function currentRecord() {
    return state.records.find((r) => r.id === state.cursorId) ?? null;
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const key = event.key.toLowerCase();

    if (key === 'j' || key === 'arrowdown') {
      event.preventDefault();
      moveCursor(1);
      return;
    }
    if (key === 'k' || key === 'arrowup') {
      event.preventDefault();
      moveCursor(-1);
      return;
    }

    const record = currentRecord();
    if (!record) return;

    if (key === 'enter' || key === ' ') {
      if (photoUrl(record)) {
        event.preventDefault();
        openPhoto(record);
      }
      return;
    }

    if (!ctx.canReview) return;

    if (key === 'a') {
      event.preventDefault();
      // An unmatched record cannot be approved, so the shortcut says why
      // rather than sending a call that is certain to come back PDS06.
      if (!record.member_id) {
        const said = 'Link this check-in to a member first.';
        ctx.note(said, 'warn');
        announce(said);
        return;
      }
      decide([record.id], 'approve', null, nodeFor(record.id));
      return;
    }

    if (key === 'r') {
      event.preventDefault();
      rejectWithReason([record], nodeFor(record.id));
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function wire() {
    el.eventSelect.addEventListener('change', () => {
      state.eventFilter = el.eventSelect.value;
      state.showAllRoutine = false;
      state.cursorId = null;
      render();
    });

    el.refresh.addEventListener('click', () => {
      ctx.clearMessage();
      load();
    });

    el.approveAll.addEventListener('click', approveAll);

    el.showAll.addEventListener('click', () => {
      state.showAllRoutine = true;
      render();
    });

    for (const dialog of [el.rejectDialog, el.newMemberDialog, el.photoDialog]) {
      dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    }

    el.photoDialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepLightbox(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepLightbox(-1);
      }
    });
    el.photoDialog.addEventListener('close', () => {
      lightboxId = null;
    });

    document.addEventListener('keydown', onKeyDown);
  }

  return {
    mount() {
      wire();
      return load();
    },
    reload: load,
    hasLoaded: () => state.loaded,
  };
}
