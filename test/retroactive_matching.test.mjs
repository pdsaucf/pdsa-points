// Retroactive matching: when somebody who checked in before they paid finally
// joins the roster, do their earlier check-ins get offered back to them
// without ever being silently handed to the wrong person.
//
// The failure this file exists to catch is not "the match misses a record".
// It is "the match hands one person's attendance to somebody else", which is
// exactly what a blind name lookup (the old spreadsheet's approach) cannot
// avoid: two people can share a name, and a lookup keyed on the string alone
// cannot tell them apart. fn_retroactive_match_candidates() only ever
// suggests; link_retroactive_matches() only ever writes the exact ids an
// officer confirmed. The test named for two Priya Sharmas at the bottom of
// the first section is the one that would fail first if that guarantee
// slipped.
//
// The second assertion this file leans on hardest is invariant 6: linking is
// not approving. A linked record must still be 'pending' and still have to
// pass through review_records(), the same as every other record in the queue.
//
// Two further failure modes get their own sections, both found in review
// rather than in the original brief:
//
//   A CONFIRMATION IS PER RECORD. link_retroactive_matches() returns one
//   outcome per requested id (linked, already_linked, not_pending,
//   wrong_year, not_found, conflict), not an aggregate count. "9 of the 10
//   you confirmed worked" is not an answer an officer can act on without
//   knowing which one failed.
//
//   THE PREVIEW CAN GO STALE. The candidate list is a snapshot; nothing stops
//   another officer reviewing (and rejecting) one of the records it shows
//   before the first officer presses Confirm. The write has to recheck
//   'pending' at the moment it writes, not trust what the screen said.
//
// And a third: an archived or merged member is a real state a target id can
// be in, and this branch has already settled how the schema treats both
// (review_member_claim(), migration 18) in ways that differ by case.

import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers/db.mjs';
import { loadFixture, EVENTS, MEMBERS, USERS, YEAR_2026 } from './helpers/fixture.mjs';
import { snapshotTables, restoreTables } from './helpers/settings.mjs';

let db;
let settings;

const R = (n) => `44444444-0000-4000-a000-0000000000${n}`;

// Two different people who happen to share a name, the exact shape a blind
// name lookup cannot tell apart. Both enrolled for 2026-2027 only, so the
// wrong-year exclusion has a genuine enrollment to check against.
const RETRO = {
  priyaA: R('01'), // has her own email on file
  priyaB: R('02'), // a different person, same display name
  archived: R('03'), // P1c: archived is a refusal, not a suggestion
  mergeSurvivor: R('04'),
  mergeLoser: R('05'), // tombstoned into mergeSurvivor below
  raceMember: R('06'), // P1b: the stale-preview race
  conflictMember: R('07'), // the conflict outcome, within one batch
};

// Attendance records filed through the free-text path, before anybody was on
// the roster. Inserted directly (not through submit_checkin()) so the
// fixture can place them precisely, but flagged 'unmatched_name' the way
// submit_checkin() would have left them.
const RECORD = {
  // Claims Priya A's exact email. An identity, not a resemblance.
  priyaAEmail: R('11'),
  // Claims the shared name with an email that matches neither Priya. Only a
  // resemblance, and it resembles BOTH of them equally, since they share a
  // normalised name.
  sharedName: R('12'),
  // Claims Priya A's exact email, but the event is in 2025-2026, a year
  // neither Priya is enrolled in.
  wrongYear: R('13'),
  // Claims the shared name, but already linked to Dorian (who has no other
  // attendance in the fixture, so linking here cannot collide with the
  // one-live-record-per-event index).
  alreadyLinked: R('14'),
  // Claims the shared name, but was already reviewed and rejected. Not
  // "unresolved" by the definition this feature uses.
  rejectedUnmatched: R('15'),
  // Priya B's own earlier check-in: her exact email, nobody else's.
  priyaBEmail: R('16'),
  // Claims the merge survivor's email, filed under the loser's old id.
  mergeCandidate: R('17'),
  // A candidate that looks fine at preview time, then gets rejected by
  // another officer before Confirm is pressed.
  raceReject: R('18'),
  // Two candidates for the same member and the same event: only one can
  // ever hold a live record there.
  conflictA: R('19'),
  conflictB: R('1a'),
};

async function candidatesFor(memberId) {
  return db.withRole('authenticated', USERS.officer, () =>
    db.q(`select * from fn_retroactive_match_candidates($1)`, [memberId]),
  );
}

async function link(memberId, recordIds) {
  return db.withRole('authenticated', USERS.officer, () =>
    db.q(`select * from link_retroactive_matches($1, $2::uuid[])`, [memberId, recordIds]),
  );
}

function byId(rows, id) {
  return rows.find((r) => r.record_id === id);
}

function outcomesOf(results) {
  return Object.fromEntries(results.map((r) => [r.record_id, r.outcome]));
}

test.before(async () => {
  db = await freshDb();
  await loadFixture(db);

  await db.exec(`
    insert into members (id, first_name, last_name, email, archived_at) values
      ('${RETRO.priyaA}', 'Priya', 'Sharma', 'priya.sharma.retro@ucf.edu', null),
      ('${RETRO.priyaB}', 'Priya', 'Sharma', 'priya.b.retro@ucf.edu', null),
      ('${RETRO.archived}', 'Ansel', 'Retired', 'ansel.retired@ucf.edu', now()),
      ('${RETRO.mergeSurvivor}', 'Nadia', 'Ferro', 'nadia.ferro.retro@ucf.edu', null),
      ('${RETRO.mergeLoser}', 'Nadia', 'Ferro Duplicate', 'nadia.dup.retro@ucf.edu', null),
      ('${RETRO.raceMember}', 'Rowan', 'Delacroix', 'rowan.delacroix.retro@ucf.edu', null),
      ('${RETRO.conflictMember}', 'Wendell', 'Ashcroft', 'wendell.ashcroft.retro@ucf.edu', null);

    insert into member_enrollments (member_id, academic_year_id) values
      ('${RETRO.priyaA}', '${YEAR_2026}'),
      ('${RETRO.priyaB}', '${YEAR_2026}'),
      ('${RETRO.mergeSurvivor}', '${YEAR_2026}'),
      ('${RETRO.raceMember}', '${YEAR_2026}'),
      ('${RETRO.conflictMember}', '${YEAR_2026}');

    insert into attendance_records
      (id, event_id, member_id, claimed_name, claimed_email, status, source, flags)
    values
      -- Priya A's own check-in, matched on the identity tier. Case-varied and
      -- with an interior dot, so this also proves fn_normalise_email() ran.
      ('${RECORD.priyaAEmail}', '${EVENTS.gbmSingle}', null, 'Priya Sharma',
       'Priya.Sharma.Retro@UCF.EDU', 'pending', 'self_checkin', array['unmatched_name']),

      -- Ambiguous: resembles both Priyas, matches neither's email.
      ('${RECORD.sharedName}', '${EVENTS.socialBlock}', null, 'Priya Sharma',
       'someone.else@example.test', 'pending', 'self_checkin', array['unmatched_name']),

      -- Right person, wrong year: neither Priya is enrolled in 2025-2026.
      ('${RECORD.wrongYear}', '${EVENTS.priorGbm}', null, 'Priya Sharma',
       'Priya.Sharma.Retro@UCF.EDU', 'pending', 'self_checkin', array['unmatched_name']),

      -- Already somebody else's. Must never be offered, whatever it says.
      ('${RECORD.alreadyLinked}', '${EVENTS.gbmSingle}', '${MEMBERS.dorian}', 'Priya Sharma',
       'nobody@example.test', 'pending', 'officer_entry', '{}'),

      -- Reviewed and turned down already. Not "unresolved".
      ('${RECORD.rejectedUnmatched}', '${EVENTS.clinA}', null, 'Priya Sharma',
       'nobody@example.test', 'rejected', 'self_checkin', array['unmatched_name']),

      -- Priya B's own check-in.
      ('${RECORD.priyaBEmail}', '${EVENTS.visits}', null, 'Priya Sharma',
       'priya.b.retro@ucf.edu', 'pending', 'self_checkin', array['unmatched_name']),

      -- Filed under the survivor's email, but the officer will ask about it
      -- by the loser's old id.
      ('${RECORD.mergeCandidate}', '${EVENTS.fund}', null, 'Nadia Ferro',
       'nadia.ferro.retro@ucf.edu', 'pending', 'self_checkin', array['unmatched_name']),

      -- Looks fine at preview time. A second officer rejects it mid-test.
      ('${RECORD.raceReject}', '${EVENTS.tabling}', null, 'Rowan Delacroix',
       'rowan.delacroix.retro@ucf.edu', 'pending', 'self_checkin', array['unmatched_name']),

      -- Two candidates, one event: at most one can end up linked.
      ('${RECORD.conflictA}', '${EVENTS.proceeds}', null, 'Wendell Ashcroft',
       'wendell.ashcroft.retro@ucf.edu', 'pending', 'self_checkin', array['unmatched_name']),
      ('${RECORD.conflictB}', '${EVENTS.proceeds}', null, 'Wendell Ashcroft',
       'wendell.ashcroft.retro@ucf.edu', 'pending', 'self_checkin', array['unmatched_name']);
  `);

  await db.withRole('authenticated', USERS.officer, () =>
    db.q(`select merge_members($1, $2)`, [RETRO.mergeLoser, RETRO.mergeSurvivor]),
  );

  settings = await snapshotTables(db, ['app_settings']);
});

test.beforeEach(async () => {
  await db?.asOwner();
});

test.afterEach(async () => {
  await db?.asOwner();
  await restoreTables(db, settings);
});

test.after(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// Finding candidates
// ---------------------------------------------------------------------------

test('an email match and a name match are both found, and labelled differently', async () => {
  const rows = await candidatesFor(RETRO.priyaA);

  const email = byId(rows, RECORD.priyaAEmail);
  assert.ok(email, 'the exact-email record was not offered');
  assert.equal(email.reason, 'exact_email');
  assert.equal(Number(email.score), 1);

  const name = byId(rows, RECORD.sharedName);
  assert.ok(name, 'the name-only record was not offered');
  assert.equal(name.reason, 'name_match');
  assert.notEqual(name.reason, email.reason);
});

test('each candidate carries what an officer decides on without a second query', async () => {
  const rows = await candidatesFor(RETRO.priyaA);
  const email = byId(rows, RECORD.priyaAEmail);

  assert.equal(email.event_id, EVENTS.gbmSingle);
  assert.equal(email.claimed_name, 'Priya Sharma');
  assert.equal(email.claimed_email, 'Priya.Sharma.Retro@UCF.EDU');
  assert.equal(email.occurred_on.toISOString().slice(0, 10), '2027-02-10');
  assert.equal(email.resolved_member_id, RETRO.priyaA);
  assert.equal(email.followed_merge, false);
});

test('a record already linked to somebody else is never offered', async () => {
  const rows = await candidatesFor(RETRO.priyaA);
  assert.equal(byId(rows, RECORD.alreadyLinked), undefined);
});

test('a record from a year the member is not enrolled in is never offered', async () => {
  const rows = await candidatesFor(RETRO.priyaA);
  assert.equal(
    byId(rows, RECORD.wrongYear),
    undefined,
    'matched Priya A on email exactly, but the event is a year she is not enrolled in',
  );
});

test('a rejected, never-resolved record is not "unresolved" and is not offered', async () => {
  const rows = await candidatesFor(RETRO.priyaA);
  assert.equal(byId(rows, RECORD.rejectedUnmatched), undefined);
});

test('a member with no earlier check-ins gets an empty answer, not an error', async () => {
  const rows = await candidatesFor(MEMBERS.dorian);
  assert.deepEqual(rows, []);
});

test('an unknown member id is refused rather than silently answered empty', async () => {
  await db.as('authenticated', USERS.officer);
  const err = await db.expectError(`select fn_retroactive_match_candidates($1)`, [
    '44444444-0000-4000-a000-0000000000ff',
  ]);
  await db.asOwner();
  assert.equal(err.code, 'PDS03');
});

test('the similarity floor is a setting, not a constant', async () => {
  // "Priya Sharma" against itself is a normalised-exact match (1.0), so it
  // survives even a floor raised almost to the top. Confirms the row in
  // app_settings is actually consulted rather than a value baked into the
  // function.
  await db.q(
    `update app_settings set value = '0.99'::jsonb where key = 'retroactive_name_similarity'`,
  );
  const stillThere = await candidatesFor(RETRO.priyaA);
  assert.ok(byId(stillThere, RECORD.sharedName), 'an exact normalised name match should clear any floor below 1.0');

  await db.q(`update app_settings set value = '1.01'::jsonb where key = 'retroactive_name_similarity'`);
  const goneNow = await candidatesFor(RETRO.priyaA);
  assert.equal(byId(goneNow, RECORD.sharedName), undefined, 'a floor above 1.0 admits no name match at all');
});

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

test('linking attaches exactly the records named and no others', async () => {
  const results = await link(RETRO.priyaA, [RECORD.priyaAEmail, RECORD.sharedName]);
  assert.equal(results.length, 2);

  const outcomes = outcomesOf(results);
  assert.equal(outcomes[RECORD.priyaAEmail], 'linked');
  assert.equal(outcomes[RECORD.sharedName], 'linked');
  for (const r of results) {
    assert.equal(r.resolved_member_id, RETRO.priyaA);
    assert.equal(r.followed_merge, false);
  }

  const rows = await db.q(
    `select id, member_id, status, flags from attendance_records where id = any($1::uuid[])`,
    [[RECORD.priyaAEmail, RECORD.sharedName, RECORD.wrongYear, RECORD.alreadyLinked, RECORD.priyaBEmail]],
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  // Exactly the two named records moved.
  assert.equal(by[RECORD.priyaAEmail].member_id, RETRO.priyaA);
  assert.equal(by[RECORD.sharedName].member_id, RETRO.priyaA);

  // Nothing else did, including a record with the identical claimed name.
  assert.equal(by[RECORD.wrongYear].member_id, null, 'the wrong-year record was linked anyway');
  assert.equal(by[RECORD.alreadyLinked].member_id, MEMBERS.dorian, 'somebody elses link was overwritten');
  assert.equal(by[RECORD.priyaBEmail].member_id, null, 'Priya Bs own record was linked to Priya A');

  // Invariant 6: linking is not approving. This is the assertion that
  // matters most in this file.
  assert.equal(by[RECORD.priyaAEmail].status, 'pending');
  assert.equal(by[RECORD.sharedName].status, 'pending');

  // The triage flag that sent these to the unmatched queue is gone.
  assert.equal(by[RECORD.priyaAEmail].flags.includes('unmatched_name'), false);
  assert.equal(by[RECORD.sharedName].flags.includes('unmatched_name'), false);
});

test('linking twice reports already_linked and does not double anything', async () => {
  const results = await link(RETRO.priyaA, [RECORD.priyaAEmail, RECORD.sharedName]);
  // Both records were already linked by the previous test, so a second call
  // over the same ids links nothing further, and says so per id.
  const outcomes = outcomesOf(results);
  assert.equal(outcomes[RECORD.priyaAEmail], 'already_linked');
  assert.equal(outcomes[RECORD.sharedName], 'already_linked');

  const stillOne = await db.val(
    `select count(*)::int from attendance_records where id = $1 and member_id = $2`,
    [RECORD.priyaAEmail, RETRO.priyaA],
  );
  assert.equal(stillOne, 1);

  // Every call is audited, including one that changed nothing: the trail is
  // "an officer confirmed these", not only "these got linked".
  const auditRows = await db.val(
    `select count(*)::int from audit_log where action = 'link_retroactive_matches'`,
  );
  assert.equal(auditRows, 2);
});

test('a duplicate id in one request reports once', async () => {
  const results = await link(RETRO.priyaA, [RECORD.priyaAEmail, RECORD.priyaAEmail]);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'already_linked');
});

test('linking an empty or null list produces no results, not an error', async () => {
  assert.deepEqual(await link(RETRO.priyaB, []), []);
  assert.deepEqual(await link(RETRO.priyaB, null), []);
});

test('every requested id gets its own outcome: not found, wrong year, already linked, and linked, in one call', async () => {
  const bogus = '44444444-0000-4000-a000-0000000000fe';
  const results = await link(RETRO.priyaB, [
    bogus,
    RECORD.wrongYear,
    RECORD.alreadyLinked,
    RECORD.priyaBEmail,
  ]);
  const outcomes = outcomesOf(results);

  assert.equal(outcomes[bogus], 'not_found');
  assert.equal(outcomes[RECORD.wrongYear], 'wrong_year');
  assert.equal(outcomes[RECORD.alreadyLinked], 'already_linked');
  assert.equal(outcomes[RECORD.priyaBEmail], 'linked');

  // The audit row names what actually happened, not the requested array
  // standing in for it: every id's real outcome is recoverable afterward
  // without cross-referencing anything else.
  const audit = await db.one(
    `select detail from audit_log where action = 'link_retroactive_matches' order by id desc limit 1`,
  );
  assert.equal(audit.detail.member_id, RETRO.priyaB);
  const storedOutcomes = Object.fromEntries(
    audit.detail.results.map((r) => [r.record_id, r.outcome]),
  );
  assert.equal(storedOutcomes[bogus], 'not_found');
  assert.equal(storedOutcomes[RECORD.priyaBEmail], 'linked');
});

// ---------------------------------------------------------------------------
// The blind-name-lookup failure, caught directly
// ---------------------------------------------------------------------------
// Two different people, Priya A and Priya B, share a claimed name. Priya A's
// records were already linked above (RECORD.priyaAEmail and
// RECORD.sharedName). If this feature worked by looking up "records claiming
// the name Priya Sharma" instead of by an explicit officer-confirmed list,
// linking Priya A would have swept up Priya B's own check-in
// (RECORD.priyaBEmail) too, since it carries the identical name. It must not.

test('linking one Priyas confirmed records leaves the other Priyas alone', async () => {
  // Priya B's own record was linked by the outcomes test just above. The
  // records already linked to Priya A never appeared for her, even though
  // RECORD.sharedName once resembled her exactly as much as it resembled
  // Priya A.
  const rows = await candidatesFor(RETRO.priyaB);
  assert.equal(byId(rows, RECORD.sharedName), undefined);
  assert.equal(byId(rows, RECORD.priyaAEmail), undefined);
  assert.equal(byId(rows, RECORD.priyaBEmail), undefined, 'already linked to her, so no longer a candidate');

  const after = await db.q(
    `select id, member_id, status from attendance_records where id = any($1::uuid[])`,
    [[RECORD.priyaAEmail, RECORD.sharedName, RECORD.priyaBEmail]],
  );
  const by = Object.fromEntries(after.map((r) => [r.id, r]));

  // Final ownership: nobody's record crossed to the other person.
  assert.equal(by[RECORD.priyaAEmail].member_id, RETRO.priyaA);
  assert.equal(by[RECORD.sharedName].member_id, RETRO.priyaA);
  assert.equal(by[RECORD.priyaBEmail].member_id, RETRO.priyaB);
  assert.equal(by[RECORD.priyaBEmail].status, 'pending');
});

// ---------------------------------------------------------------------------
// The preview can go stale
// ---------------------------------------------------------------------------
// P1b: fn_retroactive_match_candidates() only ever shows pending records, but
// nothing freezes the record between when the screen loads and when the
// officer presses Confirm. Another officer can review_records()-reject the
// same record in that gap. The write has to notice.

test('a candidate rejected after the preview loaded is neither linked nor reported as linked', async () => {
  const before = await candidatesFor(RETRO.raceMember);
  assert.ok(byId(before, RECORD.raceReject), 'the record should be a candidate before anybody rejects it');

  // A second officer reviews the queue and rejects it, independent of the
  // retroactive-match screen entirely.
  await db.withRole('authenticated', USERS.officer, () =>
    db.q(`select review_records($1::uuid[], 'reject', $2)`, [
      [RECORD.raceReject],
      'wrong event',
    ]),
  );

  // The first officer, still holding the stale preview, presses Confirm.
  const results = await link(RETRO.raceMember, [RECORD.raceReject]);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'not_pending');

  const row = await db.one(`select member_id, status from attendance_records where id = $1`, [
    RECORD.raceReject,
  ]);
  assert.equal(row.member_id, null, 'a rejected record was linked anyway');
  assert.equal(row.status, 'rejected', 'linking silently un-rejected a reviewed record');
});

// ---------------------------------------------------------------------------
// A conflict within one batch
// ---------------------------------------------------------------------------
// Two different unmatched records, same member, same event: at most one can
// ever hold a live row there (one_live_record_per_member_event). The other
// must report a refusal rather than aborting the whole call.

test('two candidates for the same event: one links, the other reports conflict, in the same call', async () => {
  const results = await link(RETRO.conflictMember, [RECORD.conflictA, RECORD.conflictB]);
  const outcomes = outcomesOf(results);
  const values = Object.values(outcomes);

  assert.equal(values.filter((o) => o === 'linked').length, 1);
  assert.equal(values.filter((o) => o === 'conflict').length, 1);

  const rows = await db.q(
    `select id, member_id from attendance_records where id = any($1::uuid[])`,
    [[RECORD.conflictA, RECORD.conflictB]],
  );
  const linkedCount = rows.filter((r) => r.member_id === RETRO.conflictMember).length;
  assert.equal(linkedCount, 1, 'only one of the two records should have ended up linked');
});

// ---------------------------------------------------------------------------
// Archived and merged targets
// ---------------------------------------------------------------------------
// P1c: both functions treat member existence as sufficient unless taught
// otherwise. This branch already settled how the schema treats both cases,
// in review_member_claim() (migration 18, 18.6), and the answers differ.

test('an archived member refuses both functions, offering nothing', async () => {
  const find = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select fn_retroactive_match_candidates($1)`, [RETRO.archived]),
  );
  assert.equal(find.code, 'PDS03');

  const linkErr = await db.withRole('authenticated', USERS.officer, () =>
    db.expectError(`select link_retroactive_matches($1, $2::uuid[])`, [RETRO.archived, []]),
  );
  assert.equal(linkErr.code, 'PDS03');
});

test('a merged member is followed to the survivor, and the survivor is told so', async () => {
  const rows = await candidatesFor(RETRO.mergeLoser);
  const candidate = byId(rows, RECORD.mergeCandidate);
  assert.ok(candidate, "the survivor's matching record should surface when asked about the loser's old id");
  assert.equal(candidate.resolved_member_id, RETRO.mergeSurvivor);
  assert.equal(candidate.followed_merge, true);

  const results = await link(RETRO.mergeLoser, [RECORD.mergeCandidate]);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'linked');
  assert.equal(results[0].resolved_member_id, RETRO.mergeSurvivor);
  assert.equal(results[0].followed_merge, true);

  const row = await db.one(`select member_id, status from attendance_records where id = $1`, [
    RECORD.mergeCandidate,
  ]);
  // Landed on the survivor, never on the tombstone: merge_members() already
  // moved the rest of this person's history there.
  assert.equal(row.member_id, RETRO.mergeSurvivor);
  assert.equal(row.status, 'pending');
});

// ---------------------------------------------------------------------------
// Privileges
// ---------------------------------------------------------------------------

test('anon cannot find or link candidates', async () => {
  await db.as('anon');
  const find = await db.expectError(`select fn_retroactive_match_candidates($1)`, [RETRO.priyaA]);
  const linkErr = await db.expectError(`select link_retroactive_matches($1, $2::uuid[])`, [
    RETRO.priyaA,
    [],
  ]);
  await db.asOwner();

  assert.equal(find.code, '42501');
  assert.equal(linkErr.code, '42501');
});
