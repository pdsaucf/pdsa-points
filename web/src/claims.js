// Account claims: the small second tab.
//
// A member signs in to the portal with an address that is not on their roster
// row, picks themselves out of the roster, and an officer confirms it. Most
// members never generate one: if the address they sign in with matches their
// roster email they are linked automatically. Claims exist for the 355
// imported members who arrived with no email on file.
//
// BOTH HALVES OF THE CARD ARE RPCs, AND EACH ONE OWNS A WRITE OR A READ THIS
// SCREEN IS NOT ALLOWED TO MAKE ITSELF.
//
// 1. The card leads with the address the person signed in with, because that
//    is the thing the officer is actually deciding about. It lives in
//    auth.users.email, which PostgREST does not serve, so the queue comes from
//    list_pending_claims() rather than from member_claims.
// 2. Confirm links the account. Writing profiles.member_id is an admin write
//    under profiles_write_admin, and review_member_claim() owns it: an officer
//    calling it records the decision, makes the link, and writes the audit row
//    in one transaction. It is the only column of profiles that function
//    writes, and an officer still cannot change anybody's role.
//
// THE ROSTER MOVES WHILE A CLAIM WAITS, which is why Confirm can come back
// saying something the officer did not press. review_member_claim() revalidates
// the member at approval: an archived one is refused, and a merged one is
// followed to the survivor, because merge_members() took every attendance
// record with it and linking to the tombstone would hand somebody an empty
// portal. The claim keeps naming the row the member picked, so when the walk
// moved the answer, the status line has to say so.
//
// Declining takes a reason, and the member reads it. Same split as a declined
// check-in: member_claims.note is theirs, review_note is the officer's.

import { select, callRpc } from './rest.js';
import { CLAIM } from './officer-errors.js';
import { $, h, announce, setHidden, plural, monthYear } from './ui.js';

/** Shown to a staff account that is not an officer, in place of the queue. */
const OFFICER_ONLY = 'Read only: account claims are decided by officers.';

export function createClaims(ctx) {
  const el = {
    loading: $('loading-claims'),
    empty: $('empty-claims'),
    list: $('claims-list'),
    declineDialog: $('claim-decline-dialog'),
    declineForm: $('claim-decline-form'),
    declineWho: $('claim-decline-who'),
    declineNote: $('claim-decline-note'),
    declineError: $('claim-decline-error'),
  };

  const state = {
    claims: [],
    rosterEmails: new Map(), // member_id -> the address on the roster row
    recordCounts: new Map(), // member_id -> approved records
    joined: new Map(), // member_id -> earliest joined_on
    busy: false,
    loaded: false,
    declining: null,
  };

  async function load() {
    setHidden(el.loading, false);
    setHidden(el.empty, true);
    el.list.replaceChildren();

    // list_pending_claims() is officer only, where the table it replaced was
    // readable by any staff account. So a viewer's load would be one request
    // whose only possible answer is a refusal, and the screen says what it is
    // instead of showing them an error on every page load.
    if (!ctx.canReview) {
      state.claims = [];
      state.loaded = true;
      ctx.setClaimCount(0);
      setHidden(el.loading, true);
      el.list.replaceChildren(h('p', { class: 'muted small' }, OFFICER_ONLY));
      return;
    }

    try {
      const claims = await callRpc('list_pending_claims');

      state.claims = Array.isArray(claims) ? claims : [];
      state.loaded = true;
      ctx.setClaimCount(state.claims.length);

      if (state.claims.length) await loadContext(state.claims);
      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  /**
   * What an officer needs in order to believe a claim: the address already on
   * the roster row, how much history is attached to it, and how long it has
   * been there. A row with 45 approved records and a join date from last August
   * is somebody real; a row with none may be a duplicate that should be merged
   * instead.
   *
   * list_pending_claims() returns names and ids, deliberately: it is the one
   * thing PostgREST cannot answer, and everything else here is an ordinary read
   * under the officer's own policies.
   */
  async function loadContext(claims) {
    const memberIds = [...new Set(claims.map((c) => c.member_id))];

    const [members, records, enrollments] = await Promise.all([
      select('members', {
        select: 'id,email',
        filters: { id: `in.(${memberIds.join(',')})` },
      }),
      select('attendance_records', {
        select: 'id,member_id',
        filters: { member_id: `in.(${memberIds.join(',')})`, status: 'eq.approved' },
      }),
      select('member_enrollments', {
        select: 'member_id,joined_on',
        filters: { member_id: `in.(${memberIds.join(',')})` },
        order: 'joined_on.asc',
      }),
    ]);

    state.rosterEmails = new Map(members.map((row) => [row.id, row.email]));

    state.recordCounts = new Map();
    for (const row of records) {
      state.recordCounts.set(row.member_id, (state.recordCounts.get(row.member_id) ?? 0) + 1);
    }

    state.joined = new Map();
    for (const row of enrollments) {
      if (!state.joined.has(row.member_id)) state.joined.set(row.member_id, row.joined_on);
    }
  }

  function render() {
    setHidden(el.loading, true);
    ctx.setClaimCount(state.claims.length);

    if (!state.claims.length) {
      setHidden(el.empty, false);
      el.list.replaceChildren();
      return;
    }

    setHidden(el.empty, true);
    el.list.replaceChildren(...state.claims.map(renderClaim));
  }

  function renderClaim(claim) {
    const count = state.recordCounts.get(claim.member_id) ?? 0;
    const joinedOn = state.joined.get(claim.member_id);
    const rosterEmail = state.rosterEmails.get(claim.member_id);

    const card = h('article', {
      class: 'card',
      dataset: { id: claim.claim_id, severity: 'look' },
    });

    const main = h('div', { class: 'card-main' });

    // The heading names the state. The address they signed in with, and which
    // roster row they say is theirs, are the metadata line under it.
    main.append(h('p', { class: 'card-headline' }, 'Account claim'));

    main.append(
      h(
        'p',
        { class: 'card-meta' },
        h('span', { class: 'card-who' }, claim.account_email || 'No address on file'),
        h('span', { class: 'claim-says' }, ' claims to be '),
        h('span', { class: 'card-who' }, claim.member_name ?? 'somebody on the roster'),
      ),
    );

    main.append(
      h(
        'ul',
        { class: 'claim-facts' },
        claim.account_name ? h('li', {}, `Account name: ${claim.account_name}`) : null,
        h('li', {}, rosterEmail ? `Roster email: ${rosterEmail}` : 'Roster email: none on file'),
        h('li', {}, `${plural(count, 'approved record')}`),
        h('li', {}, joinedOn ? `Joined ${monthYear(joinedOn)}` : 'Not on any year of the roster'),
      ),
    );

    if (claim.note) {
      main.append(
        h(
          'p',
          { class: 'card-quote' },
          h('span', { class: 'card-quote-label' }, 'Note'),
          claim.note,
        ),
      );
    }

    main.append(
      h(
        'p',
        { class: 'card-detail' },
        "Confirming lets this account see that member's points and records.",
      ),
    );

    card.append(main, h('div', { class: 'card-side' }));

    // No read-only branch here: load() answers that case before a card is ever
    // built, because the queue itself is officer only now.
    card.append(
      h(
        'div',
        { class: 'card-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'button button-primary',
            disabled: state.busy,
            onClick: () => confirmClaim(claim),
          },
          'Confirm',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'button button-danger',
            disabled: state.busy,
            onClick: () => openDecline(claim),
          },
          'Decline',
        ),
      ),
    );

    return card;
  }

  function setBusy(on) {
    state.busy = on;
    for (const node of el.list.querySelectorAll('button')) node.disabled = on;
  }

  const drop = (claim) => {
    state.claims = state.claims.filter((row) => row.claim_id !== claim.claim_id);
  };

  /**
   * The name of the row the link actually landed on.
   *
   * review_member_claim() reports the resolved id rather than rewriting the
   * claim, so after a followed merge the only name this screen holds is the one
   * the member picked, which is now a tombstone. One read turns that id into
   * the name the officer has to be shown.
   */
  async function survivorName(memberId) {
    try {
      const rows = await select('members', {
        select: 'id,display_name',
        filters: { id: `eq.${memberId}` },
        limit: 1,
      });
      return rows[0]?.display_name ?? null;
    } catch {
      return null;
    }
  }

  async function confirmClaim(claim) {
    setBusy(true);
    ctx.clearMessage();
    try {
      const result = await callRpc('review_member_claim', {
        p_claim_id: claim.claim_id,
        p_decision: 'approve',
        p_note: null,
      });

      const picked = claim.member_name ?? 'that member';
      let said = `Linked to ${picked}. They can see their points now.`;
      let tone = 'ok';

      if (result?.followed_merge) {
        // Confirm was pressed on one row and another was linked. Saying only
        // "linked" here would leave the officer reading a name they did not
        // press the next time this member comes up.
        const survivor = await survivorName(result.member_id);
        said = survivor
          ? `Linked to ${survivor}. ${picked} was merged into that record.`
          : `Linked. ${picked} was merged into another record.`;
        tone = 'warn';
      }

      drop(claim);
      ctx.note(said, tone);
      announce(said);
      render();
    } catch (err) {
      ctx.fail(err, () => confirmClaim(claim), CLAIM);
    } finally {
      setBusy(false);
    }
  }

  function openDecline(claim) {
    state.declining = claim;
    el.declineNote.value = '';
    setHidden(el.declineError, true);
    el.declineWho.textContent = `${claim.account_email || 'This account'} · ${claim.member_name ?? ''}`;
    el.declineDialog.showModal();
  }

  async function submitDecline(event) {
    event.preventDefault();
    const claim = state.declining;
    if (!claim) return;

    const note = el.declineNote.value.trim();
    if (!note) {
      setHidden(el.declineError, false);
      el.declineNote.focus();
      return;
    }
    setHidden(el.declineError, true);
    el.declineDialog.close();

    setBusy(true);
    ctx.clearMessage();
    try {
      await callRpc('review_member_claim', {
        p_claim_id: claim.claim_id,
        p_decision: 'reject',
        p_note: note,
      });

      const name = claim.member_name ?? 'that member';
      const said = `Declined. Nobody is linked to ${name}, and they can ask again.`;
      drop(claim);
      ctx.note(said, 'ok');
      announce(said);
      render();
    } catch (err) {
      ctx.fail(err, null, CLAIM);
    } finally {
      state.declining = null;
      setBusy(false);
    }
  }

  function wire() {
    el.declineForm.addEventListener('submit', submitDecline);
    el.declineDialog
      .querySelector('[data-close]')
      ?.addEventListener('click', () => el.declineDialog.close());
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
