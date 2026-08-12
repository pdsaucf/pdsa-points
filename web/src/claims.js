// Account claims: the small second tab.
//
// A member signs in to the portal with an address that is not on their roster
// row, picks themselves out of the roster, and an officer confirms it. Most
// members never generate one: if the address they sign in with matches their
// roster email they are linked automatically. Claims exist for the 355
// imported members who arrived with no email on file.
//
// TWO THINGS THE DESIGN DOC ASKS FOR THAT THE DATABASE CANNOT YET GIVE. Both
// are called out in the report for this phase rather than papered over here.
//
// 1. The wireframe leads each card with the address the person signed in
//    with. That lives in auth.users.email, which PostgREST does not expose
//    (it serves the `public` schema) and which no view or RPC in P0 surfaces.
//    So the card leads with profiles.full_name, which an officer can read,
//    and says plainly when even that is missing.
//
// 2. Confirming a claim should link the account: set profiles.member_id. The
//    policy that governs writes to profiles is profiles_write_admin, so an
//    OFFICER cannot make that write. There is no approve_claim() RPC to do it
//    for them. An officer's Confirm therefore records the decision, and an
//    admin's Confirm also completes the link. The screen says which of those
//    just happened instead of claiming the second one either way.
//
// A PATCH that RLS refuses is not an error. It is a 200 with an empty array,
// which is exactly why every write here asks for return=representation and
// counts the rows that came back.

import { select, patch } from './rest.js';
import { READ_ONLY } from './officer-errors.js';
import { $, h, announce, setHidden, plural, monthYear } from './ui.js';

// Both writes below can come back refused as a 200 with an empty array, and
// the officer's next step is the same either way.
const NOT_CHANGED = 'That claim was not changed. Reload the page and try again.';

export function createClaims(ctx) {
  const el = {
    loading: $('loading-claims'),
    empty: $('empty-claims'),
    list: $('claims-list'),
  };

  const state = {
    claims: [],
    profiles: new Map(), // user_id -> profile
    recordCounts: new Map(), // member_id -> approved records
    joined: new Map(), // member_id -> earliest joined_on
    busy: false,
    loaded: false,
  };

  async function load() {
    setHidden(el.loading, false);
    setHidden(el.empty, true);
    el.list.replaceChildren();

    try {
      const claims = await select('member_claims', {
        select: 'id,user_id,member_id,status,note,requested_at,members(id,display_name,email)',
        filters: { status: 'eq.pending' },
        order: 'requested_at.asc',
      });

      state.claims = claims;
      state.loaded = true;
      ctx.setClaimCount(claims.length);

      if (claims.length) await loadContext(claims);
      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  /**
   * What an officer needs in order to believe a claim: how much history is
   * attached to the roster row, and how long it has been there. A row with 45
   * approved records and a join date from last August is somebody real; a row
   * with none may be a duplicate that should be merged instead.
   *
   * member_claims has no foreign key to profiles (both point at auth.users
   * separately), so the names cannot be fetched as an embedded select and come
   * back in their own query.
   */
  async function loadContext(claims) {
    const userIds = [...new Set(claims.map((c) => c.user_id))];
    const memberIds = [...new Set(claims.map((c) => c.member_id))];

    const [profiles, records, enrollments] = await Promise.all([
      select('profiles', {
        select: 'user_id,full_name,role,member_id',
        filters: { user_id: `in.(${userIds.join(',')})` },
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

    state.profiles = new Map(profiles.map((p) => [p.user_id, p]));

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
    const profile = state.profiles.get(claim.user_id);
    const member = claim.members ?? {};
    const who = profile?.full_name?.trim();
    const count = state.recordCounts.get(claim.member_id) ?? 0;
    const joinedOn = state.joined.get(claim.member_id);

    const card = h('article', {
      class: 'card',
      dataset: { id: claim.id, severity: 'look' },
    });

    const main = h('div', { class: 'card-main' });

    // The heading names the state. Who is asking, and which roster row they
    // say is theirs, are the metadata line under it.
    main.append(h('p', { class: 'card-headline' }, 'Account claim'));

    main.append(
      h(
        'p',
        { class: 'card-meta' },
        h('span', { class: 'card-who' }, who || 'No name on file'),
        h('span', { class: 'claim-says' }, ' claims to be '),
        h('span', { class: 'card-who' }, member.display_name ?? 'somebody on the roster'),
      ),
    );

    main.append(
      h(
        'ul',
        { class: 'claim-facts' },
        h('li', {}, member.email ? `Roster email: ${member.email}` : 'Roster email: none on file'),
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

    const actions = h('div', { class: 'card-actions' });
    if (ctx.canReview) {
      actions.append(
        h(
          'button',
          {
            type: 'button',
            class: 'button button-primary',
            disabled: state.busy,
            onClick: () => confirmClaim(claim, card),
          },
          'Confirm',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'button button-danger',
            disabled: state.busy,
            onClick: () => rejectClaim(claim, card),
          },
          'Decline',
        ),
      );
    } else {
      actions.append(h('p', { class: 'muted small' }, READ_ONLY));
    }
    card.append(actions);

    return card;
  }

  function setBusy(on) {
    state.busy = on;
    for (const node of el.list.querySelectorAll('button')) node.disabled = on;
  }

  async function decide(claim, status) {
    return patch(
      'member_claims',
      { id: `eq.${claim.id}` },
      {
        status,
        reviewed_by: ctx.userId,
        reviewed_at: new Date().toISOString(),
      },
    );
  }

  async function confirmClaim(claim, card) {
    setBusy(true);
    ctx.clearMessage();
    try {
      const updated = await decide(claim, 'approved');
      if (!Array.isArray(updated) || !updated.length) {
        // The policy refused it and said so by returning nothing.
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }

      // The link itself, which only an admin is allowed to write.
      let linked = [];
      try {
        linked = await patch(
          'profiles',
          { user_id: `eq.${claim.user_id}` },
          { member_id: claim.member_id },
        );
      } catch (err) {
        ctx.fail(err, null);
        return;
      }

      const name = claim.members?.display_name ?? 'That member';
      const said = linked.length
        ? `Linked to ${name}. They can see their points now.`
        : `Confirmed as ${name}. An admin still has to finish linking the account.`;

      state.claims = state.claims.filter((c) => c.id !== claim.id);
      ctx.note(said, linked.length ? 'ok' : 'warn');
      announce(said);
      render();
    } catch (err) {
      ctx.fail(err, () => confirmClaim(claim, card));
    } finally {
      setBusy(false);
    }
  }

  async function rejectClaim(claim) {
    setBusy(true);
    ctx.clearMessage();
    try {
      const updated = await decide(claim, 'rejected');
      if (!Array.isArray(updated) || !updated.length) {
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      const name = claim.members?.display_name ?? 'that member';
      const said = `Declined. Nobody is linked to ${name}, and they can ask again.`;
      state.claims = state.claims.filter((c) => c.id !== claim.id);
      ctx.note(said, 'ok');
      announce(said);
      render();
    } catch (err) {
      ctx.fail(err, () => rejectClaim(claim));
    } finally {
      setBusy(false);
    }
  }

  return {
    mount: load,
    reload: load,
    hasLoaded: () => state.loaded,
  };
}
