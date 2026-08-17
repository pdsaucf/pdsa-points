// Fixtures for the officer half of the mock: a small database in the shape the
// migrations actually produce, not the shape the design docs describe.
//
// Sized from docs/00-spreadsheet-findings.md rather than from convenience. The
// routine zone holds 43 records because that is the number in the wireframe and
// because a grid that is comfortable with four tiles and unusable with forty is
// a grid that passes review and fails at a GBM. Every triage flag in the check
// constraint on attendance_records has at least one record carrying it, so no
// branch of the card renderer is unexercised.
//
// Ids are readable rather than realistic, in the same style as fixtures.mjs.
// Nothing in the client parses them.

const YEAR_CURRENT = 'a0000000-0000-4000-a000-000000000002';
const YEAR_PAST = 'a0000000-0000-4000-a000-000000000001';

const USERS = {
  officer: 'u0000000-0000-4000-a000-00000000001f',
  admin: 'u0000000-0000-4000-a000-00000000002f',
  viewer: 'u0000000-0000-4000-a000-00000000003f',
  member: 'u0000000-0000-4000-a000-00000000004f',
  claimant: 'u0000000-0000-4000-a000-00000000005f',
  claimant2: 'u0000000-0000-4000-a000-00000000006f',
};

// This is the mock's auth.users as much as it is its sign-in form. The address
// each account signed in WITH is the thing list_pending_claims() exists to
// return, and it is not the address on anybody's roster row: the two claimants
// below are exactly the case the claim flow is for, somebody whose sign-in
// address the club has never seen. An account with no entry here is one whose
// email the queue shows as missing, which is a real state and is why the card
// has copy for it.
export const ACCOUNTS = {
  'sara@pdsaucf.com': { user_id: USERS.officer, role: 'officer', full_name: 'Sara Whitfield' },
  'ben@pdsaucf.com': { user_id: USERS.admin, role: 'admin', full_name: 'Ben Le' },
  'advisor@ucf.edu': { user_id: USERS.viewer, role: 'viewer', full_name: 'Dr Okafor' },
  'priya@knights.ucf.edu': { user_id: USERS.member, role: 'member', full_name: 'Priya Raman' },
  'a.catto.2027@knights.ucf.edu': { user_id: USERS.claimant, role: 'member', full_name: 'Abigail Catto' },
  'ewallace99@gmail.com': { user_id: USERS.claimant2, role: 'member', full_name: null },
};

// Somebody with no account at all, for the "no profile row" branch of the guard.
export const UNKNOWN_EMAIL = 'stranger@example.com';

// Slugs and ids match supabase/migrations/20260811101300_seed_2026_2027.sql, so
// a rule copied off this mock is the same rule the seed describes. Volunteering
// is the one that does not count toward the point total, which is the verified
// behaviour of the old Total column (docs/00-spreadsheet-findings.md).
const CATEGORIES = [
  { id: 'c0000000-0000-4000-a000-000000000001', slug: 'gbms', name: 'GBMs', unit: 'event_count', unit_label: null, sort_order: 10, counts_toward_point_total: true },
  { id: 'c0000000-0000-4000-a000-000000000002', slug: 'volunteering', name: 'Volunteering', unit: 'hours', unit_label: 'hour', sort_order: 20, counts_toward_point_total: false },
  { id: 'c0000000-0000-4000-a000-000000000005', slug: 'socials', name: 'Socials', unit: 'event_count', unit_label: null, sort_order: 30, counts_toward_point_total: true },
  { id: 'c0000000-0000-4000-a000-000000000009', slug: 'tabling', name: 'Tabling', unit: 'event_count', unit_label: null, sort_order: 40, counts_toward_point_total: true },
  { id: 'c0000000-0000-4000-a000-00000000000a', slug: 'journal-club', name: 'Journal Club', unit: 'event_count', unit_label: null, sort_order: 50, counts_toward_point_total: true },
  { id: 'c0000000-0000-4000-a000-00000000000c', slug: 'media-speaking', name: 'Media Speaking', unit: 'event_count', unit_label: null, sort_order: 60, counts_toward_point_total: true },
  { id: 'c0000000-0000-4000-a000-00000000000b', slug: 'pdsa-post', name: 'PDSA Post', unit: 'event_count', unit_label: null, sort_order: 70, counts_toward_point_total: true },
  { id: 'c0000000-0000-4000-a000-00000000000d', slug: 'media-writing', name: 'Media Writing', unit: 'event_count', unit_label: null, sort_order: 80, counts_toward_point_total: true },
  // Already retired. It is what the dead "President Workshops" tab in the old
  // spreadsheet became: nothing measures it, and nothing may delete it either.
  { id: 'c0000000-0000-4000-a000-0000000000ff', slug: 'president-workshops', name: 'President Workshops', unit: 'event_count', unit_label: null, sort_order: 90, counts_toward_point_total: true, archived_at: '2026-06-01T00:00:00.000Z' },
];

const EVENTS = [
  {
    id: 'e0000000-0000-4000-a000-000000000001',
    academic_year_id: YEAR_CURRENT,
    title: 'Spring GBM 5',
    occurred_on: '2026-08-11',
    location: 'HPA-1 205',
    is_published: true,
  },
  {
    id: 'e0000000-0000-4000-a000-000000000003',
    academic_year_id: YEAR_CURRENT,
    title: 'Soap Carving',
    occurred_on: '2026-08-10',
    location: 'HPA-2 118',
    is_published: true,
  },
  {
    id: 'e0000000-0000-4000-a000-000000000002',
    academic_year_id: YEAR_CURRENT,
    title: 'Give Kids A Smile',
    occurred_on: '2026-08-09',
    location: 'UCF College of Medicine',
    is_published: true,
  },
  {
    // Last year. Nothing from this event may appear in the queue while the
    // current year is selected, which is what the year filter is for.
    id: 'e0000000-0000-4000-a000-00000000000f',
    academic_year_id: YEAR_PAST,
    title: 'Fall GBM 1',
    occurred_on: '2025-09-04',
    location: 'Student Union 316',
    is_published: true,
  },
  {
    /*
      THE ONE EVENT THAT COUNTS FOR TWO CATEGORIES.

      docs/04-member-ui.md calls this out as mattering more than it looks: an
      event that earns credit twice has to show both categories in a member's
      record list, or counting twice reads as a bug. Nothing else in these
      fixtures had two, so a portal that drew only the first category would
      have looked correct on every screen there is.

      It carries no attendance records on purpose, so every number on the
      board, in the preview and in the queue is exactly what it was before this
      event existed. The only screens that can see it are the ones that list
      events to pick from.

      One of its two categories reads a number off the submission, which is the
      second thing the portal needs: a missing-credit request for this event
      has to ask for hours, and the label for that field has to come from the
      category rather than from anything in the client.

      Last in the array, because EVENTS[3] is read by name below and by
      IDS.EVENT_LAST_YEAR.
    */
    id: 'e0000000-0000-4000-a000-000000000004',
    academic_year_id: YEAR_CURRENT,
    title: 'Health Fair',
    occurred_on: '2026-08-08',
    location: 'Memory Mall',
    is_published: true,
  },
];

const EVENT_CATEGORIES = [
  { event_id: EVENTS[0].id, category_id: CATEGORIES[0].id, credit_mode: 'fixed', fixed_credit: 1 },
  { event_id: EVENTS[1].id, category_id: CATEGORIES[2].id, credit_mode: 'fixed', fixed_credit: 1 },
  { event_id: EVENTS[2].id, category_id: CATEGORIES[1].id, credit_mode: 'from_submission', fixed_credit: 1 },
  { event_id: EVENTS[3].id, category_id: CATEGORIES[0].id, credit_mode: 'fixed', fixed_credit: 1 },
  // Health Fair: Tabling, and Volunteering hours off the submission.
  { event_id: EVENTS[4].id, category_id: CATEGORIES[3].id, credit_mode: 'fixed', fixed_credit: 1 },
  { event_id: EVENTS[4].id, category_id: CATEGORIES[1].id, credit_mode: 'from_submission', fixed_credit: 1 },
];

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------
// The first four are the ones the flagged cards need. "Abigail Catto" and
// "Abby Catto" exist as two rows on purpose: that pair is what the duplicate
// person flag is about, and it is what makes ranking a typed-in "Abby Cato"
// genuinely ambiguous rather than a trick question.

const NAMED = [
  ['m0000000-0000-4000-a000-000000000001', 'Abigail', 'Catto', 'abigail.catto@knights.ucf.edu'],
  ['m0000000-0000-4000-a000-000000000002', 'Abby', 'Catto', null],
  ['m0000000-0000-4000-a000-000000000003', 'Catherine', 'Diaz', 'cdiaz@knights.ucf.edu'],
  ['m0000000-0000-4000-a000-000000000004', 'Aaron', 'Ozan', null],
  ['m0000000-0000-4000-a000-000000000005', 'Priya', 'Raman', 'priya@knights.ucf.edu'],
  ['m0000000-0000-4000-a000-000000000006', 'Marcus', 'Bell', 'mbell@knights.ucf.edu'],
  ['m0000000-0000-4000-a000-000000000007', 'Sofia', 'Marchetti', null],
  ['m0000000-0000-4000-a000-000000000008', 'Jonathan', 'Pak', null],
  ['m0000000-0000-4000-a000-000000000009', 'Leah', 'Ortiz', null],
  ['m0000000-0000-4000-a000-00000000000a', 'Daniel', 'Nguyen', null],
  ['m0000000-0000-4000-a000-00000000000b', 'Grace', 'Okonkwo', null],
  ['m0000000-0000-4000-a000-00000000000c', 'Ethan', 'Wallace', null],
];

const FIRST_NAMES = [
  'Ana', 'Devin', 'Priyanka', 'Luis', 'Mei', 'Tobi', 'Hannah', 'Omar', 'Ruby', 'Sean',
  'Ines', 'Kwame', 'Talia', 'Victor', 'Nadia', 'Elliot', 'Rosa', 'Amir', 'Freya', 'Noah',
  'Ivy', 'Diego', 'Simone', 'Rahul', 'Clara', 'Malik', 'Yara', 'Peter', 'Anika', 'Jonas',
  'Lena', 'Caleb', 'Sana', 'Theo', 'Maya', 'Felix', 'Zoe', 'Idris', 'Nora', 'Emeka',
  'Camila', 'Hugo', 'Aisha',
];

const LAST_NAMES = [
  'Silva', 'Mehta', 'Brown', 'Okafor', 'Lindqvist', 'Barros', 'Cheng', 'Haddad', 'Novak', 'Fisher',
  'Duarte', 'Mensah', 'Kaplan', 'Romero', 'Osei', 'Whitfield', 'Iqbal', 'Petrov', 'Sandoval', 'Kim',
  'Adeyemi', 'Moreau', 'Castellanos', 'Bianchi', 'Nakamura', 'Ferreira', 'Hassan', 'Larsen', 'Volkov', 'Ibarra',
  'Rashid', 'Guerrero', 'Bergstrom', 'Tran', 'Almeida', 'Kowalski', 'Ndiaye', 'Salazar', 'Weiss', 'Oyelaran',
  'Pereira', 'Dubois', 'Mbeki',
];

/*
  Members who clear every requirement except GBMs.

  WHY THEY EXIST. Everyone else's credit follows a single strength dial, so the
  GBMs cut, the Socials cut and the Tabling cut all land on exactly the same
  people: nobody is held back by GBMs alone. A preview built on that roster
  reads the same number whatever the GBMs threshold is set to, which makes
  "lowering a threshold lets more members through" unfalsifiable. It cannot go
  red when the preview is broken, because it cannot go green when it works.

  These six sit between the two values the check uses. They fail at 9 and pass
  at 3, and they pass everything else, so the GBMs threshold is the only thing
  between them and Honorary. Names are deliberately nothing like "Abby Cato" or
  "Tobias Renner": those two are ranked against the whole roster in
  verify-admin.mjs, and a near miss here would change what that screen offers.
*/
const NEARLY = [
  ['Wren', 'Vasquez'],
  ['Kojo', 'Boateng'],
  ['Margit', 'Halvorsen'],
  ['Sunil', 'Bhattacharya'],
  ['Ilse', 'Vandenberg'],
  ['Pemba', 'Dorjee'],
];

/*
  Somebody who was here last year and has not been put on this year's list yet.

  WHY THEY EXIST. This is the person an import has to FIND rather than create
  again, and a matcher built from this year's enrollments cannot see them at
  all: they have no row for this year, which is the whole point. With the
  address below, importing them as new collides with the unique index on
  members.email and fails the run; without one it would quietly file a second
  person. Both are silent until somebody notices the roster holds two of them.

  They carry no attendance history, so no count on the board or in the preview
  moves because of them, and the name resembles nobody else's, so they raise no
  duplicate pair.
*/
const RETURNING = [
  'm3000000-0000-4000-a000-000000000001',
  'Rowan',
  'Vance',
  'rowan.vance@knights.ucf.edu',
];

/*
  Retroactive matching. Genuinely earlier, genuinely unmatched
  attendance_records, for fn_retroactive_match_candidates() and
  link_retroactive_matches() to have something real to find. Names are
  deliberately unlike anybody else in this file, so none of them accidentally
  raise a v_possible_duplicate_members pair or a CSV-import fuzzy match that
  some other check depends on.

  RETRO_MEMBER carries one exact_email candidate, one name_match candidate,
  and one candidate with no genuine resemblance at all (below
  RETRO_NAME_FLOOR, never offered), plus a third exact_email candidate held
  back for the "rejected out from under a stale preview" outcome. It is
  enrolled for YEAR_CURRENT only, which is what makes RECORD_RETRO_WRONG_YEAR
  (claiming her email, but an event from YEAR_PAST) a genuine wrong_year case
  rather than a contrived one.

  RETRO_MERGE_LOSER and RETRO_MERGE_SURVIVOR are for the followed_merge path:
  two candidates claim the loser's email, so a merge_members() call mid-test
  can be followed on both the read and the write.

  RETRO_CONFLICT_MEMBER already holds a live record for the one event
  RECORD_RETRO_CONFLICT also claims, so linking it collides with
  one_live_record_per_member_event the moment it is tried, the same
  pre-existing collision merge_members() and review_records() already guard
  against elsewhere in this file.
*/
const RETRO = {
  member: 'm4000000-0000-4000-a000-000000000001',
  mergeLoser: 'm4000000-0000-4000-a000-000000000002',
  mergeSurvivor: 'm4000000-0000-4000-a000-000000000003',
  conflictMember: 'm4000000-0000-4000-a000-000000000004',
};

const RETRO_MEMBERS = [
  [RETRO.member, 'Xiomara', 'Petrenko', 'xiomara.petrenko@knights.ucf.edu'],
  [RETRO.mergeLoser, 'Fionnuala', 'Askew', 'fionnuala.askew@knights.ucf.edu'],
  [RETRO.mergeSurvivor, 'Yevgenia', 'Marchant', 'yevgenia.marchant@knights.ucf.edu'],
  [RETRO.conflictMember, 'Torvald', 'Quillfeather', 'torvald.quillfeather@knights.ucf.edu'],
];

const RETRO_RECORD = {
  email: 'r4000000-0000-4000-a000-000000000001',
  name: 'r4000000-0000-4000-a000-000000000002',
  tooFar: 'r4000000-0000-4000-a000-000000000003',
  race: 'r4000000-0000-4000-a000-000000000004',
  wrongYear: 'r4000000-0000-4000-a000-000000000005',
  mergeA: 'r4000000-0000-4000-a000-000000000006',
  mergeB: 'r4000000-0000-4000-a000-000000000007',
  conflict: 'r4000000-0000-4000-a000-000000000008',
  forAdd: 'r4000000-0000-4000-a000-000000000009',
  forImport: 'r4000000-0000-4000-a000-00000000000a',
  // Claims the SURVIVOR's own email, not the loser's: once merge_members()
  // runs, fn_retroactive_match_candidates(loserId) matches against the
  // resolved (survivor) member's identity, not the tombstone's, the same
  // way the real migration's own RECORD.mergeCandidate does (filed under
  // the survivor's address, asked about by the loser's old id). mergeA and
  // mergeB above claim the LOSER's identity instead, on purpose: they are
  // for the WRITE-side race, where a stale preview already captured their
  // ids before the merge and link_retroactive_matches() never re-derives a
  // match, it only re-resolves the member and re-checks the guards.
  mergeReadSide: 'r4000000-0000-4000-a000-00000000000c',

  // Held back for verify-board.mjs's own race and rendering checks, never
  // touched by anything above. alreadyLinked claims her email at SOAP, so it
  // can be linked to somebody ELSE first and prove already_linked does not
  // read as this member's own success. reasonEmail and reasonName both sit
  // at GKAS, an event no other Xiomara-claimed record above uses, so the
  // pair can be told apart from every other candidate on her list by event
  // title alone, and told apart from EACH OTHER by their reason text: one an
  // identity (matching email), one a resemblance (matching name, wrong
  // email). Together they prove that reason text survives a decision.
  alreadyLinked: 'r4000000-0000-4000-a000-00000000000d',
  reasonEmail: 'r4000000-0000-4000-a000-00000000000e',
  reasonName: 'r4000000-0000-4000-a000-00000000000f',
};

// Two people nobody has heard of yet, each with one earlier check-in
// waiting. Used only to prove an import's courtesy retro scan cannot be
// overwritten by a slower, earlier-started import's own scan: see the
// "an import scan" check in verify-board.mjs. Distinctive names on purpose,
// unlike FIRST_NAMES/LAST_NAMES above, so importing them raises no fuzzy
// match and needs no decision before the run.
const IMPORT_RACE = {
  first: { name: 'Perpetua Thistlewood', email: 'perpetua.thistlewood@knights.ucf.edu' },
  second: { name: 'Cornelius Applewhite', email: 'cornelius.applewhite@knights.ucf.edu' },
};

/*
  The storage screen. Written against
  supabase/migrations/20260815100000_storage_ops.sql, whose eligibility rule
  is exactly three things: the record's own status (approved or rejected,
  nothing else), whether the evidence row already carries a purged_at, and
  the event's occurred_on against the retention window (12 months by
  default, the app_settings default below). None of that needs a category or
  a requirement, so the events these ids belong to carry neither.

  eventOldA and eventOldB sit well before the twelve-month cutoff and are
  what the "ready to clear" preview and the confirmation dialog's per-event
  checkboxes exist to show: two events, so unchecking one in the dialog
  really does leave the other behind. eventOldRejected is equally old but
  the one record on it was REJECTED, not approved, which purge_evidence()
  treats as just as eligible. eventOldPending is equally old too, but its
  record is still pending, which must never turn up in a preview however far
  past the window it sits. eventRecent is approved and reviewed but inside
  the window, so a preview that forgot the cutoff entirely would still look
  right without it.

  runClean, runOutstanding and runOrphan are three rows of "Previously
  cleared" history, attributed to two different people so the by-line is
  exercised, and one of them (runOutstanding) left with objects nobody has
  confirmed deleting, which is what the "Finish deleting" path on the screen
  is for.
*/
const STORAGE = {
  eventOldA: 's0000000-0000-4000-a000-000000000001',
  eventOldB: 's0000000-0000-4000-a000-000000000002',
  eventOldRejected: 's0000000-0000-4000-a000-000000000003',
  eventOldPending: 's0000000-0000-4000-a000-000000000004',
  eventRecent: 's0000000-0000-4000-a000-000000000005',
  runClean: 'p8000000-0000-4000-a000-000000000001',
  runOutstanding: 'p8000000-0000-4000-a000-000000000002',
  runOrphan: 'p8000000-0000-4000-a000-000000000003',
};

function buildMembers() {
  const members = NAMED.map(([id, first, last, email]) => ({
    id,
    first_name: first,
    last_name: last,
    preferred_name: null,
    email,
    ucf_nid: null,
    display_name: `${first} ${last}`,
    notes: null,
    merged_into_id: null,
    created_at: '2025-08-20T12:00:00.000Z',
    archived_at: null,
  }));

  for (let i = 0; i < 43; i += 1) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[i % LAST_NAMES.length];
    members.push({
      id: `m1000000-0000-4000-a000-${String(i + 1).padStart(12, '0')}`,
      first_name: first,
      last_name: last,
      preferred_name: null,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@knights.ucf.edu`,
      ucf_nid: null,
      display_name: `${first} ${last}`,
      notes: null,
      merged_into_id: null,
      created_at: '2026-08-01T12:00:00.000Z',
      archived_at: null,
    });
  }

  NEARLY.forEach(([first, last], i) => {
    members.push({
      id: `m2000000-0000-4000-a000-${String(i + 1).padStart(12, '0')}`,
      first_name: first,
      last_name: last,
      preferred_name: null,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@knights.ucf.edu`,
      ucf_nid: null,
      display_name: `${first} ${last}`,
      notes: null,
      merged_into_id: null,
      created_at: '2026-08-01T12:00:00.000Z',
      archived_at: null,
    });
  });

  members.push({
    id: RETURNING[0],
    first_name: RETURNING[1],
    last_name: RETURNING[2],
    preferred_name: null,
    email: RETURNING[3],
    ucf_nid: null,
    display_name: `${RETURNING[1]} ${RETURNING[2]}`,
    notes: null,
    merged_into_id: null,
    created_at: '2025-08-20T12:00:00.000Z',
    archived_at: null,
  });

  RETRO_MEMBERS.forEach(([id, first, last, email]) => {
    members.push({
      id,
      first_name: first,
      last_name: last,
      preferred_name: null,
      email,
      ucf_nid: null,
      display_name: `${first} ${last}`,
      notes: null,
      merged_into_id: null,
      created_at: '2026-08-01T12:00:00.000Z',
      archived_at: null,
    });
  });

  return members;
}

const DUPLICATE_HASH = 'sha256-shared-between-two-events-0000000000000000';

// The rules. Two published sets: this year's, which is what "Edit as draft"
// clones, and last year's, which is what "Copy from" copies.
const SET_CURRENT = 'd0000000-0000-4000-a000-000000000001';
const SET_PAST = 'd0000000-0000-4000-a000-000000000002';

const NODES = {
  root: 'f0000000-0000-4000-a000-000000000000',
  gbms: 'f0000000-0000-4000-a000-000000000001',
  volunteering: 'f0000000-0000-4000-a000-000000000002',
  socials: 'f0000000-0000-4000-a000-000000000003',
  tabling: 'f0000000-0000-4000-a000-000000000004',
  editorial: 'f0000000-0000-4000-a000-000000000005',
  speaking: 'f0000000-0000-4000-a000-000000000006',
  writing: 'f0000000-0000-4000-a000-000000000007',
  pastRoot: 'f1000000-0000-4000-a000-000000000000',
  pastGbms: 'f1000000-0000-4000-a000-000000000001',
  pastSocials: 'f1000000-0000-4000-a000-000000000002',
};

/**
 * Rebuilt from scratch on every /__mock/reset, so one check cannot leave state
 * behind for the next one. Everything below is plain data: the server owns all
 * of the behaviour.
 */
export function buildDatabase() {
  const members = buildMembers();
  const byName = (name) => members.find((m) => m.display_name === name);

  const notEnrolled = byName('Sofia Marchetti');

  const enrollments = members
    .filter((m) => m.id !== notEnrolled.id && m.id !== RETURNING[0])
    .map((m) => ({
      member_id: m.id,
      academic_year_id: YEAR_CURRENT,
      status: 'active',
      joined_on: '2026-08-01',
    }));

  // Last year only. See RETURNING above.
  enrollments.push({
    member_id: RETURNING[0],
    academic_year_id: YEAR_PAST,
    status: 'active',
    joined_on: '2025-08-19',
  });

  // A long history on the roster row somebody is claiming, so the claims card
  // has something to say beyond a name.
  enrollments.push({
    member_id: byName('Abigail Catto').id,
    academic_year_id: YEAR_PAST,
    status: 'active',
    joined_on: '2025-08-19',
  });

  const attendance = [];
  const evidence = [];
  let evidenceSeq = 0;

  // byteSize defaults to a plausible compressed shirt photo, and is only ever
  // varied by the storage fixtures below: giving each one a distinct size is
  // what lets fn_storage_usage()'s bytes_held and a purge run's bytes_freed
  // be told apart from a row count that merely looks right.
  //
  // Returns the pushed row itself, not just its path, because the storage
  // fixtures also need to stamp purged_at on one of these after the fact, to
  // prove an already-cleared photo does not reappear just because its event
  // is eligible again.
  const addEvidence = (recordId, kind, sha256, byteSize = 184320) => {
    evidenceSeq += 1;
    const objectPath = `${YEAR_CURRENT}/${kind}/photo-${String(evidenceSeq).padStart(3, '0')}.jpg`;
    const row = {
      id: `v0000000-0000-4000-a000-${String(evidenceSeq).padStart(12, '0')}`,
      attendance_record_id: recordId,
      kind,
      provider: 'supabase',
      object_path: objectPath,
      drive_file_id: null,
      content_type: 'image/jpeg',
      byte_size: byteSize,
      sha256: sha256 ?? `sha256-${recordId}`,
      uploaded_at: '2026-08-11T18:02:00.000Z',
      archived_at: null,
      purged_at: null,
    };
    evidence.push(row);
    return row;
  };

  const add = (record) => {
    const row = {
      claimed_name: null,
      claimed_email: null,
      member_id: null,
      status: 'pending',
      source: 'self_checkin',
      submitted_value: null,
      flags: [],
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      // The member's own words, added by migration 18. Only
      // request_missing_credit() writes it, so every fixture row carries null.
      member_note: null,
      created_at: record.submitted_at,
      ...record,
    };
    attendance.push(row);
    return row;
  };

  const GBM = EVENTS[0].id;
  const SOAP = EVENTS[1].id;
  const GKAS = EVENTS[2].id;
  const LAST_YEAR = EVENTS[3].id;

  // ---- the flagged zone ---------------------------------------------------

  // 1. Typed their name in, and the roster has somebody very close.
  const unmatchedClose = add({
    id: 'r0000000-0000-4000-a000-000000000001',
    event_id: GBM,
    claimed_name: 'Abby Cato',
    claimed_email: 'abby.cato@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:01:00.000Z',
  });
  addEvidence(unmatchedClose.id, 'shirt_photo');

  // 2. Typed their name in, and nobody on the roster is close. This is the
  //    empty-roster case in miniature: the only way through is to create them.
  const unmatchedNew = add({
    id: 'r0000000-0000-4000-a000-000000000002',
    event_id: GBM,
    claimed_name: 'Tobias Renner',
    claimed_email: 'tobias.renner@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:03:00.000Z',
  });
  addEvidence(unmatchedNew.id, 'shirt_photo');

  // 3. The same image as an earlier event.
  const duplicatePhoto = add({
    id: 'r0000000-0000-4000-a000-000000000003',
    event_id: SOAP,
    member_id: byName('Marcus Bell').id,
    flags: ['duplicate_photo'],
    submitted_at: '2026-08-10T19:10:00.000Z',
  });
  addEvidence(duplicatePhoto.id, 'shirt_photo', DUPLICATE_HASH);

  // The earlier record the duplicate matches, already approved, last year.
  const earlier = add({
    id: 'r0000000-0000-4000-a000-000000000004',
    event_id: LAST_YEAR,
    member_id: byName('Marcus Bell').id,
    status: 'approved',
    reviewed_at: '2025-09-05T10:00:00.000Z',
    submitted_at: '2025-09-04T18:30:00.000Z',
  });
  addEvidence(earlier.id, 'shirt_photo', DUPLICATE_HASH);

  // 4. No photo, on the event that requires one.
  add({
    id: 'r0000000-0000-4000-a000-000000000005',
    event_id: SOAP,
    member_id: byName('Leah Ortiz').id,
    flags: ['missing_evidence'],
    submitted_at: '2026-08-10T19:14:00.000Z',
  });

  // 5. On the roster, but not on this year of it.
  const notEnrolledRecord = add({
    id: 'r0000000-0000-4000-a000-000000000006',
    event_id: GBM,
    member_id: notEnrolled.id,
    flags: ['not_enrolled'],
    submitted_at: '2026-08-11T18:05:00.000Z',
  });
  addEvidence(notEnrolledRecord.id, 'shirt_photo');

  // 6. Turned down once already, with the reason still attached to that row.
  add({
    id: 'r0000000-0000-4000-a000-000000000007',
    event_id: GBM,
    member_id: byName('Aaron Ozan').id,
    status: 'rejected',
    review_note: 'Photo was taken in the car park after everyone had left.',
    reviewed_at: '2026-08-11T21:00:00.000Z',
    submitted_at: '2026-08-11T18:06:00.000Z',
  });
  const retry = add({
    id: 'r0000000-0000-4000-a000-000000000008',
    event_id: GBM,
    member_id: byName('Aaron Ozan').id,
    flags: ['previously_rejected'],
    submitted_at: '2026-08-11T18:40:00.000Z',
  });
  addEvidence(retry.id, 'shirt_photo');

  // 7. The roster holds a very similar name, so the wrong one may well have
  //    been tapped.
  const similar = add({
    id: 'r0000000-0000-4000-a000-000000000009',
    event_id: GBM,
    member_id: byName('Abby Catto').id,
    flags: ['possible_duplicate_person'],
    submitted_at: '2026-08-11T18:07:00.000Z',
  });
  addEvidence(similar.id, 'shirt_photo');

  // 8. Volunteering hours, filed after the window closed.
  add({
    id: 'r0000000-0000-4000-a000-00000000000a',
    event_id: GKAS,
    member_id: byName('Grace Okonkwo').id,
    submitted_value: 3.5,
    flags: ['outside_window'],
    submitted_at: '2026-08-09T23:40:00.000Z',
  });

  // ---- retroactive matching -------------------------------------------------
  // Genuinely earlier, genuinely unmatched. See the RETRO comment above for
  // what each one is for.

  const HEALTH_FAIR = EVENTS[4].id;

  add({
    id: RETRO_RECORD.email,
    event_id: GBM,
    claimed_name: 'Xiomara Petrenko',
    // Case-varied and with an interior dot, so this also proves the mock's
    // normaliseEmailForMatch() ran rather than a plain lowercase compare.
    claimed_email: 'Xiomara.Petrenko@Knights.UCF.EDU',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:20:00.000Z',
  });

  // Same name, normalised-exact, but an email that matches nobody: a
  // resemblance, never an identity.
  add({
    id: RETRO_RECORD.name,
    event_id: SOAP,
    claimed_name: 'Xiomara Petrenko',
    claimed_email: 'someone.else@example.test',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-10T19:20:00.000Z',
  });

  // No genuine resemblance at all, below RETRO_NAME_FLOOR and no email match.
  // Never offered as a candidate for anybody.
  add({
    id: RETRO_RECORD.tooFar,
    event_id: GKAS,
    claimed_name: 'Zephyr Quillon',
    claimed_email: 'zephyr.quillon@example.test',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-09T19:20:00.000Z',
  });

  // Looks fine at preview time. Held back for the "rejected out from under a
  // stale preview" outcome: another officer runs review_records() on it
  // between the preview and Confirm.
  add({
    id: RETRO_RECORD.race,
    event_id: HEALTH_FAIR,
    claimed_name: 'Xiomara Petrenko',
    claimed_email: 'Xiomara.Petrenko@Knights.UCF.EDU',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-08T19:20:00.000Z',
  });

  // Her own email, but the event is LAST_YEAR and she is enrolled for
  // YEAR_CURRENT only: never offered as a candidate, and a direct link
  // attempt reports wrong_year rather than writing anything.
  add({
    id: RETRO_RECORD.wrongYear,
    event_id: LAST_YEAR,
    claimed_name: 'Xiomara Petrenko',
    claimed_email: 'Xiomara.Petrenko@Knights.UCF.EDU',
    flags: ['unmatched_name'],
    submitted_at: '2025-09-04T19:20:00.000Z',
  });

  // Two candidates claiming the merge loser's email, for the followed_merge
  // path on both the read and the write.
  add({
    id: RETRO_RECORD.mergeA,
    event_id: GBM,
    claimed_name: 'Fionnuala Askew',
    claimed_email: 'fionnuala.askew@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:22:00.000Z',
  });
  add({
    id: RETRO_RECORD.mergeB,
    event_id: SOAP,
    claimed_name: 'Fionnuala Askew',
    claimed_email: 'fionnuala.askew@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-10T19:22:00.000Z',
  });

  // Claims the survivor's own email. Never a candidate for the loser before
  // any merge, only for the survivor, whether asked about directly or (once
  // merged) by the loser's old id. See the RETRO_RECORD comment above.
  add({
    id: RETRO_RECORD.mergeReadSide,
    event_id: GKAS,
    claimed_name: 'Yevgenia Marchant',
    claimed_email: 'yevgenia.marchant@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-09T19:22:00.000Z',
  });

  // Already holds a live record for GBM (below), so linking this one
  // collides with one_live_record_per_member_event.
  add({
    id: RETRO_RECORD.conflict,
    event_id: GBM,
    claimed_name: 'Torvald Quillfeather',
    claimed_email: 'torvald.quillfeather@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:24:00.000Z',
  });
  add({
    id: 'r4000000-0000-4000-a000-00000000000b',
    event_id: GBM,
    member_id: RETRO.conflictMember,
    status: 'approved',
    reviewed_by: USERS.officer,
    reviewed_at: '2026-08-05T20:00:00.000Z',
    submitted_at: '2026-08-05T18:00:00.000Z',
  });

  // Held back. See the RETRO_RECORD comment above for what each is for.
  add({
    id: RETRO_RECORD.alreadyLinked,
    event_id: SOAP,
    claimed_name: 'Xiomara Petrenko',
    claimed_email: 'Xiomara.Petrenko@Knights.UCF.EDU',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-07T19:20:00.000Z',
  });
  add({
    id: RETRO_RECORD.reasonEmail,
    event_id: GKAS,
    claimed_name: 'Xiomara Petrenko',
    claimed_email: 'Xiomara.Petrenko@Knights.UCF.EDU',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-06T19:20:00.000Z',
  });
  add({
    id: RETRO_RECORD.reasonName,
    event_id: GKAS,
    claimed_name: 'Xiomara Petrenko',
    claimed_email: 'reason-name-only@example.test',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-06T19:21:00.000Z',
  });

  // For the import-race check: two brand-new people, each with one earlier
  // check-in, created by two separate imports in verify-board.mjs rather
  // than by any member fixture here.
  add({
    id: 'r4000000-0000-4000-a000-000000000010',
    event_id: GBM,
    claimed_name: IMPORT_RACE.first.name,
    claimed_email: IMPORT_RACE.first.email,
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:30:00.000Z',
  });
  add({
    id: 'r4000000-0000-4000-a000-000000000011',
    event_id: GBM,
    claimed_name: IMPORT_RACE.second.name,
    claimed_email: IMPORT_RACE.second.email,
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:31:00.000Z',
  });

  // For the roster screen: an officer adding or importing somebody whose
  // typed name matches a check-in already sitting in the queue, filed by
  // nobody the roster has ever heard of. No member fixture behind either:
  // they are created by the Add form and by the import itself.
  add({
    id: RETRO_RECORD.forAdd,
    event_id: GBM,
    claimed_name: 'Beatrix Hallworth',
    claimed_email: 'beatrix.hallworth@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-11T18:26:00.000Z',
  });
  add({
    id: RETRO_RECORD.forImport,
    event_id: SOAP,
    claimed_name: 'Endellion Marrow',
    claimed_email: 'endellion.marrow@knights.ucf.edu',
    flags: ['unmatched_name'],
    submitted_at: '2026-08-10T19:26:00.000Z',
  });

  // ---- the routine zone ---------------------------------------------------
  // 43 roster-matched members, inside the window, photo attached, no flags.

  const routineMembers = members.filter((m) => m.id.startsWith('m1000000'));
  routineMembers.forEach((member, index) => {
    const record = add({
      id: `r1000000-0000-4000-a000-${String(index + 1).padStart(12, '0')}`,
      event_id: GBM,
      member_id: member.id,
      submitted_at: new Date(Date.parse('2026-08-11T18:10:00.000Z') + index * 9000).toISOString(),
    });
    addEvidence(record.id, 'shirt_photo');
  });

  // ---- the storage screen ---------------------------------------------------
  // See the STORAGE comment above for why each event and record exists.

  const storageEvents = [
    { id: STORAGE.eventOldA, academic_year_id: YEAR_PAST, title: 'Career Night', occurred_on: '2025-03-10', location: 'Business Admin 101', is_published: true },
    { id: STORAGE.eventOldB, academic_year_id: YEAR_PAST, title: 'Movie Night', occurred_on: '2025-03-24', location: 'Student Union 316', is_published: true },
    { id: STORAGE.eventOldRejected, academic_year_id: YEAR_PAST, title: 'Blood Drive', occurred_on: '2025-04-07', location: 'Recreation and Wellness Center', is_published: true },
    { id: STORAGE.eventOldPending, academic_year_id: YEAR_PAST, title: 'Beach Cleanup', occurred_on: '2025-04-21', location: 'Cocoa Beach', is_published: true },
    { id: STORAGE.eventRecent, academic_year_id: YEAR_CURRENT, title: 'Trivia Night', occurred_on: '2026-08-10', location: 'HPA-1 205', is_published: true },
  ];

  // Two reviewed, unpurged photos at eventOldA, plus a third that an earlier
  // run already cleared: proof that an already-purged row does not reappear
  // in the preview or the usage bar just because its event is eligible again.
  const storageA1 = add({
    id: 's1000000-0000-4000-a000-000000000001',
    event_id: STORAGE.eventOldA,
    member_id: byName('Daniel Nguyen').id,
    status: 'approved',
    reviewed_by: USERS.officer,
    reviewed_at: '2025-03-11T10:00:00.000Z',
    submitted_at: '2025-03-10T18:00:00.000Z',
  });
  addEvidence(storageA1.id, 'shirt_photo', undefined, 262144);

  const storageA2 = add({
    id: 's1000000-0000-4000-a000-000000000002',
    event_id: STORAGE.eventOldA,
    member_id: byName('Jonathan Pak').id,
    status: 'approved',
    reviewed_by: USERS.officer,
    reviewed_at: '2025-03-11T10:05:00.000Z',
    submitted_at: '2025-03-10T18:05:00.000Z',
  });
  addEvidence(storageA2.id, 'shirt_photo', undefined, 307200);

  const storageAPurged = add({
    id: 's1000000-0000-4000-a000-000000000003',
    event_id: STORAGE.eventOldA,
    member_id: byName('Priya Raman').id,
    status: 'approved',
    reviewed_by: USERS.officer,
    reviewed_at: '2025-03-11T10:10:00.000Z',
    submitted_at: '2025-03-10T18:10:00.000Z',
  });
  const storagePurgedEvidence = addEvidence(storageAPurged.id, 'shirt_photo', undefined, 200000);
  storagePurgedEvidence.purged_at = '2026-06-01T10:00:00.000Z';
  storagePurgedEvidence.purge_run_id = STORAGE.runClean;

  const storageB1 = add({
    id: 's1000000-0000-4000-a000-000000000004',
    event_id: STORAGE.eventOldB,
    member_id: byName('Leah Ortiz').id,
    status: 'approved',
    reviewed_by: USERS.officer,
    reviewed_at: '2025-03-25T09:00:00.000Z',
    submitted_at: '2025-03-24T19:00:00.000Z',
  });
  addEvidence(storageB1.id, 'shirt_photo', undefined, 358400);

  // Rejected, not approved, and just as eligible: purge_evidence() reads
  // status in ('approved', 'rejected'), never just the one.
  const storageRejected = add({
    id: 's1000000-0000-4000-a000-000000000005',
    event_id: STORAGE.eventOldRejected,
    member_id: byName('Catherine Diaz').id,
    status: 'rejected',
    review_note: 'Shirt not visible in the photo.',
    reviewed_by: USERS.officer,
    reviewed_at: '2025-04-08T09:00:00.000Z',
    submitted_at: '2025-04-07T19:00:00.000Z',
  });
  addEvidence(storageRejected.id, 'shirt_photo', undefined, 184320);

  // Equally old, but still pending: never eligible, however far past the
  // window it sits.
  const storagePending = add({
    id: 's1000000-0000-4000-a000-000000000006',
    event_id: STORAGE.eventOldPending,
    member_id: byName('Grace Okonkwo').id,
    submitted_at: '2025-04-21T18:00:00.000Z',
  });
  addEvidence(storagePending.id, 'shirt_photo', undefined, 184320);

  // Reviewed and approved, but inside the retention window: a preview that
  // forgot the cutoff entirely would still look right without this one.
  const storageRecent = add({
    id: 's1000000-0000-4000-a000-000000000007',
    event_id: STORAGE.eventRecent,
    member_id: byName('Ethan Wallace').id,
    status: 'approved',
    reviewed_by: USERS.officer,
    reviewed_at: '2026-08-10T20:00:00.000Z',
    submitted_at: '2026-08-10T18:00:00.000Z',
  });
  addEvidence(storageRecent.id, 'shirt_photo', undefined, 184320);

  // ---- purge history ---------------------------------------------------
  // Three rows for "Previously cleared": one attributed to the officer, one
  // to the admin, and the third the orphaned-uploads kind, whose bytes are
  // always "size unknown" rather than a number the screen has no way to know.
  const purgeRuns = [
    {
      id: STORAGE.runClean,
      performed_by: USERS.officer,
      performed_at: '2026-06-01T10:00:00.000Z',
      kind: 'evidence',
      retention_months: 12,
      evidence_count: 1,
      bytes_freed: 200000,
      event_ids: [STORAGE.eventOldA],
    },
    {
      // Left outstanding on purpose: two of its three objects were never
      // confirmed deleted from Storage, which is exactly the state
      // "Finish deleting" exists for.
      id: STORAGE.runOutstanding,
      performed_by: USERS.admin,
      performed_at: '2026-07-15T09:30:00.000Z',
      kind: 'evidence',
      retention_months: 12,
      evidence_count: 3,
      bytes_freed: 552960,
      event_ids: [STORAGE.eventOldRejected],
    },
    {
      id: STORAGE.runOrphan,
      performed_by: USERS.officer,
      performed_at: '2026-05-01T14:00:00.000Z',
      kind: 'orphaned_uploads',
      retention_months: null,
      evidence_count: 2,
      bytes_freed: 0,
      event_ids: [],
    },
  ];

  const purgeRunObjects = [
    {
      id: 'q8000000-0000-4000-a000-000000000001',
      purge_run_id: STORAGE.runClean,
      bucket: 'evidence',
      object_path: storagePurgedEvidence.object_path,
      deleted_at: '2026-06-01T10:05:00.000Z',
    },
    {
      id: 'q8000000-0000-4000-a000-000000000002',
      purge_run_id: STORAGE.runOutstanding,
      bucket: 'evidence',
      object_path: `${YEAR_PAST}/shirt_photo/outstanding-1.jpg`,
      deleted_at: '2026-07-15T09:35:00.000Z',
    },
    {
      id: 'q8000000-0000-4000-a000-000000000003',
      purge_run_id: STORAGE.runOutstanding,
      bucket: 'evidence',
      object_path: `${YEAR_PAST}/shirt_photo/outstanding-2.jpg`,
      deleted_at: null,
    },
    {
      id: 'q8000000-0000-4000-a000-000000000004',
      purge_run_id: STORAGE.runOutstanding,
      bucket: 'evidence',
      object_path: `${YEAR_PAST}/shirt_photo/outstanding-3.jpg`,
      deleted_at: null,
    },
    {
      id: 'q8000000-0000-4000-a000-000000000005',
      purge_run_id: STORAGE.runOrphan,
      bucket: 'evidence',
      object_path: `${YEAR_CURRENT}/orphan/reclaimed-1.jpg`,
      deleted_at: '2026-05-01T14:05:00.000Z',
    },
    {
      id: 'q8000000-0000-4000-a000-000000000006',
      purge_run_id: STORAGE.runOrphan,
      bucket: 'evidence',
      object_path: `${YEAR_CURRENT}/orphan/reclaimed-2.jpg`,
      deleted_at: '2026-05-01T14:05:00.000Z',
    },
  ];

  // ---- orphaned uploads ---------------------------------------------------
  // One truly abandoned grant (expired, unconsumed, nothing wrote a
  // byte_size for it, so its bytes stay out of bytes_held) and one still
  // within its window, which must never count as orphaned just because it
  // is unconsumed.
  const uploadGrants = [
    {
      id: 'w0000000-0000-4000-a000-000000000001',
      token: 'storage-fixture-orphan-1',
      event_id: GBM,
      member_id: null,
      client_nonce: null,
      kind: 'shirt_photo',
      bucket_id: 'evidence',
      object_path: `${YEAR_CURRENT}/orphan/never-uploaded-1.jpg`,
      created_at: '2026-08-01T10:00:00.000Z',
      expires_at: '2026-08-01T10:30:00.000Z',
      consumed_at: null,
      reclaimed_at: null,
      purge_run_id: null,
    },
    {
      id: 'w0000000-0000-4000-a000-000000000002',
      token: 'storage-fixture-active-1',
      event_id: GBM,
      member_id: null,
      client_nonce: null,
      kind: 'shirt_photo',
      bucket_id: 'evidence',
      object_path: `${YEAR_CURRENT}/orphan/still-active.jpg`,
      created_at: '2026-08-16T10:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      consumed_at: null,
      reclaimed_at: null,
      purge_run_id: null,
    },
  ];

  // ---- credit already earned, so the preview has something to count --------
  //
  // The requirements screen is worth nothing without real numbers behind it:
  // "45 of 355 would qualify" is the safety rail, and a mock with no approved
  // history would show 0 of 55 whatever anybody typed, which would let a broken
  // preview pass unnoticed.
  //
  // Most members get a strength from their position on the roster, and their
  // credit follows it, because a member who comes to everything comes to
  // everything.
  //
  // One dial is not enough on its own. It makes every threshold cut the roster
  // in the same place, so no single threshold is ever the one holding anybody
  // back, and moving one alone cannot move the count. The NEARLY cohort breaks
  // that: strong everywhere, short on GBMs, and nowhere near the dial.

  const historyEvents = [];
  const addHistory = (title, categoryId, index, mode = 'fixed') => {
    const id = `h0000000-0000-4000-a000-${String(historyEvents.length + 1).padStart(12, '0')}`;
    historyEvents.push({
      id,
      academic_year_id: YEAR_CURRENT,
      title: `${title} ${index}`,
      occurred_on: '2026-08-05',
      location: null,
      is_published: true,
      category_id: categoryId,
      credit_mode: mode,
    });
    return id;
  };

  const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c.id]));

  const gbmEvents = Array.from({ length: 12 }, (_, i) => addHistory('GBM', CAT.gbms, i + 1));
  const socialEvents = Array.from({ length: 9 }, (_, i) => addHistory('Social', CAT.socials, i + 1));
  const tablingEvents = Array.from({ length: 3 }, (_, i) => addHistory('Tabling', CAT.tabling, i + 1));
  const volunteeringEvent = addHistory('Volunteering', CAT.volunteering, 1, 'from_submission');
  const journalEvent = addHistory('Journal Club', CAT['journal-club'], 1);
  const speakingEvent = addHistory('Media Speaking', CAT['media-speaking'], 1);
  const postEvent = addHistory('PDSA Post', CAT['pdsa-post'], 1);
  const writingEvent = addHistory('Media Writing', CAT['media-writing'], 1);

  let historySeq = 0;
  const approve = (memberId, eventId, value = null) => {
    historySeq += 1;
    attendance.push({
      id: `r2000000-0000-4000-a000-${String(historySeq).padStart(12, '0')}`,
      event_id: eventId,
      member_id: memberId,
      claimed_name: null,
      claimed_email: null,
      status: 'approved',
      source: 'self_checkin',
      submitted_value: value,
      flags: [],
      submitted_at: '2026-08-05T18:00:00.000Z',
      created_at: '2026-08-05T18:00:00.000Z',
      reviewed_by: USERS.officer,
      reviewed_at: '2026-08-05T20:00:00.000Z',
      review_note: null,
    });
  };

  members.forEach((member, index) => {
    if (member.id === notEnrolled.id) return;
    if (member.id.startsWith('m2000000')) return; // the NEARLY cohort, below
    if (member.id === RETURNING[0]) return; // not on this year at all
    const strength = index % 10;

    for (let n = 0; n < strength + 3; n += 1) approve(member.id, gbmEvents[n]);
    for (let n = 0; n < strength; n += 1) approve(member.id, socialEvents[n]);
    for (let n = 0; n < Math.floor(strength / 3); n += 1) approve(member.id, tablingEvents[n]);
    if (strength > 0) approve(member.id, volunteeringEvent, strength * 5);
    if (strength >= 4) approve(member.id, journalEvent);
    if (strength === 3) approve(member.id, speakingEvent);
    if (strength >= 7) approve(member.id, postEvent);
    if (strength >= 5 && strength < 7) approve(member.id, writingEvent);
  });

  /*
    The NEARLY cohort. Every number here is chosen against a threshold in the
    published set below, so changing one without the other makes them pointless
    rather than merely different:

      GBMs          5   under the 9 the rule asks for, over the 3 it is lowered
                        to. This is the straddle, and the only one.
      Socials       6   exactly the 6 the rule asks for.
      Tabling       2   exactly the 2 the rule asks for.
      Volunteering 30   over the 25 the rule asks for.
      Journal Club  1   carries Speaking, which asks for 1.
      PDSA Post     1   carries Writing, which asks for 1.
  */
  for (const member of members.filter((m) => m.id.startsWith('m2000000'))) {
    for (let n = 0; n < 5; n += 1) approve(member.id, gbmEvents[n]);
    for (let n = 0; n < 6; n += 1) approve(member.id, socialEvents[n]);
    for (let n = 0; n < 2; n += 1) approve(member.id, tablingEvents[n]);
    approve(member.id, volunteeringEvent, 30);
    approve(member.id, journalEvent);
    approve(member.id, postEvent);
  }

  // ---- the rules themselves -----------------------------------------------

  const sets = [
    {
      id: SET_CURRENT,
      academic_year_id: YEAR_CURRENT,
      name: 'Honorary Member',
      version: 1,
      status: 'published',
      root_node_id: NODES.root,
      published_at: '2026-08-01T12:00:00.000Z',
      created_at: '2026-08-01T12:00:00.000Z',
    },
    {
      id: SET_PAST,
      academic_year_id: YEAR_PAST,
      name: 'Honorary Member',
      version: 1,
      status: 'published',
      root_node_id: NODES.pastRoot,
      published_at: '2025-08-01T12:00:00.000Z',
      created_at: '2025-08-01T12:00:00.000Z',
    },
  ];

  const nodes = [];
  const nodeCategories = [];
  const addNode = (id, setId, parentId, type, label, order, extra = {}) => {
    nodes.push({
      id,
      requirement_set_id: setId,
      parent_id: parentId,
      type,
      label,
      sort_order: order,
      min_children_passing: null,
      min_value: null,
      term_id: null,
      ...extra,
    });
    return id;
  };
  const measures = (nodeId, ...categoryIds) => {
    for (const categoryId of categoryIds) nodeCategories.push({ node_id: nodeId, category_id: categoryId });
  };

  addNode(NODES.root, SET_CURRENT, null, 'group', 'Honorary Member', 0);
  addNode(NODES.gbms, SET_CURRENT, NODES.root, 'threshold', 'GBMs', 10, { min_value: 9 });
  measures(NODES.gbms, CAT.gbms);
  addNode(NODES.volunteering, SET_CURRENT, NODES.root, 'threshold', 'Volunteering', 20, { min_value: 25 });
  measures(NODES.volunteering, CAT.volunteering);
  addNode(NODES.socials, SET_CURRENT, NODES.root, 'threshold', 'Socials', 30, { min_value: 6 });
  measures(NODES.socials, CAT.socials);
  addNode(NODES.tabling, SET_CURRENT, NODES.root, 'threshold', 'Tabling', 40, { min_value: 2 });
  measures(NODES.tabling, CAT.tabling);
  addNode(NODES.editorial, SET_CURRENT, NODES.root, 'group', 'Editorial Points', 50);
  // The compound editorial rule: two categories under one requirement.
  addNode(NODES.speaking, SET_CURRENT, NODES.editorial, 'threshold', 'Speaking', 10, { min_value: 1 });
  measures(NODES.speaking, CAT['journal-club'], CAT['media-speaking']);
  addNode(NODES.writing, SET_CURRENT, NODES.editorial, 'threshold', 'Writing', 20, { min_value: 1 });
  measures(NODES.writing, CAT['pdsa-post'], CAT['media-writing']);

  // Last year, deliberately shorter, so a copy of it is visibly a copy.
  addNode(NODES.pastRoot, SET_PAST, null, 'group', 'Honorary Member', 0);
  addNode(NODES.pastGbms, SET_PAST, NODES.pastRoot, 'threshold', 'GBMs', 10, { min_value: 8 });
  measures(NODES.pastGbms, CAT.gbms);
  addNode(NODES.pastSocials, SET_PAST, NODES.pastRoot, 'threshold', 'Socials', 20, { min_value: 5 });
  measures(NODES.pastSocials, CAT.socials);

  // ---- accounts and claims ------------------------------------------------

  const profiles = [
    { user_id: USERS.officer, member_id: null, full_name: 'Sara Whitfield', role: 'officer', created_at: '2026-07-01T00:00:00.000Z' },
    { user_id: USERS.admin, member_id: null, full_name: 'Ben Le', role: 'admin', created_at: '2026-07-01T00:00:00.000Z' },
    { user_id: USERS.viewer, member_id: null, full_name: 'Dr Okafor', role: 'viewer', created_at: '2026-07-01T00:00:00.000Z' },
    // A member account that has not been linked to a roster row yet, which is
    // the state every claim starts from.
    { user_id: USERS.member, member_id: null, full_name: 'Priya Raman', role: 'member', created_at: '2026-08-02T00:00:00.000Z' },
    { user_id: USERS.claimant, member_id: null, full_name: 'Abigail Catto', role: 'member', created_at: '2026-08-05T00:00:00.000Z' },
    { user_id: USERS.claimant2, member_id: null, full_name: null, role: 'member', created_at: '2026-08-06T00:00:00.000Z' },
  ];

  const claims = [
    {
      id: 'k0000000-0000-4000-a000-000000000001',
      user_id: USERS.claimant,
      member_id: byName('Abigail Catto').id,
      status: 'pending',
      note: 'I am on the roster from last year, my knights address is new.',
      requested_at: '2026-08-11T09:00:00.000Z',
      reviewed_by: null,
      reviewed_at: null,
      // The officer's column, added by migration 18. member_claims.note above
      // is the member's own words and is shown back to them, so a decline
      // reason cannot go there.
      review_note: null,
    },
    {
      // No name on the profile: the officer has only the roster row to go on,
      // which is exactly the case the copy has to handle honestly.
      id: 'k0000000-0000-4000-a000-000000000002',
      user_id: USERS.claimant2,
      member_id: byName('Ethan Wallace').id,
      status: 'pending',
      note: null,
      requested_at: '2026-08-11T10:30:00.000Z',
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
    },
  ];

  return {
    academic_years: [
      { id: YEAR_CURRENT, label: '2026-2027', starts_on: '2026-08-01', ends_on: '2027-05-31', is_current: true },
      { id: YEAR_PAST, label: '2025-2026', starts_on: '2025-08-01', ends_on: '2026-05-31', is_current: false },
    ],
    terms: [],
    categories: CATEGORIES.map((c) => ({ archived_at: null, ...c })),
    events: [
      ...EVENTS.map((e) => ({ ...e })),
      ...historyEvents.map(({ category_id, credit_mode, ...event }) => event),
      ...storageEvents,
    ],
    event_categories: [
      ...EVENT_CATEGORIES.map((ec) => ({ ...ec })),
      ...historyEvents.map((event) => ({
        event_id: event.id,
        category_id: event.category_id,
        credit_mode: event.credit_mode,
        fixed_credit: 1,
      })),
    ],
    requirement_sets: sets,
    requirement_nodes: nodes,
    requirement_node_categories: nodeCategories,
    members,
    member_enrollments: enrollments,
    profiles,
    member_claims: claims,
    attendance_records: attendance,
    attendance_evidence: evidence,
    // Written by merge_members(), read by nothing on screen yet. It is the
    // record that a merge happened and who did it, and the mock keeps it for
    // the same reason the schema does.
    member_merges: [],
    // "Not a duplicate", remembered. Without this the same pair asks again on
    // the next load, which is the behaviour the officer just said no to.
    duplicate_dismissals: [],
    audit_log: [],
    // The storage screen. Defaults match
    // supabase/migrations/20260811100800_ops_tables.sql exactly, so a
    // retention change made here is the same edit an admin would make there.
    app_settings: [
      { key: 'evidence_retention_months', value: 12, updated_by: null, updated_at: '2026-08-01T00:00:00.000Z' },
      { key: 'storage_warn_percent', value: 75, updated_by: null, updated_at: '2026-08-01T00:00:00.000Z' },
      { key: 'storage_quota_bytes', value: 1073741824, updated_by: null, updated_at: '2026-08-01T00:00:00.000Z' },
    ],
    purge_runs: purgeRuns,
    purge_run_objects: purgeRunObjects,
    evidence_upload_grants: uploadGrants,
  };
}

export const IDS = {
  YEAR_CURRENT,
  YEAR_PAST,
  USERS,
  EVENT_GBM: EVENTS[0].id,
  EVENT_SOAP: EVENTS[1].id,
  EVENT_GKAS: EVENTS[2].id,
  EVENT_LAST_YEAR: EVENTS[3].id,
  EVENT_TWO_CATEGORIES: EVENTS[4].id,
  MEMBER_ABIGAIL: 'm0000000-0000-4000-a000-000000000001',
  MEMBER_ABBY: 'm0000000-0000-4000-a000-000000000002',
  MEMBER_PRIYA: 'm0000000-0000-4000-a000-000000000005',
  MEMBER_AARON: 'm0000000-0000-4000-a000-000000000004',
  MEMBER_ETHAN: 'm0000000-0000-4000-a000-00000000000c',
  MEMBER_RETURNING: RETURNING[0],
  RETRO_MEMBER: RETRO.member,
  RETRO_MERGE_LOSER: RETRO.mergeLoser,
  RETRO_MERGE_SURVIVOR: RETRO.mergeSurvivor,
  RETRO_CONFLICT_MEMBER: RETRO.conflictMember,
  RETRO_RECORD,
  IMPORT_RACE,
  RECORD_UNMATCHED_CLOSE: 'r0000000-0000-4000-a000-000000000001',
  RECORD_UNMATCHED_NEW: 'r0000000-0000-4000-a000-000000000002',
  RECORD_DUPLICATE_PHOTO: 'r0000000-0000-4000-a000-000000000003',
  RECORD_MISSING_EVIDENCE: 'r0000000-0000-4000-a000-000000000005',
  RECORD_NOT_ENROLLED: 'r0000000-0000-4000-a000-000000000006',
  RECORD_PREVIOUSLY_REJECTED: 'r0000000-0000-4000-a000-000000000008',
  CLAIM_WITH_NAME: 'k0000000-0000-4000-a000-000000000001',
  CLAIM_WITHOUT_NAME: 'k0000000-0000-4000-a000-000000000002',

  SET_CURRENT,
  SET_PAST,
  NODES,
  CATEGORY_GBMS: 'c0000000-0000-4000-a000-000000000001',
  CATEGORY_VOLUNTEERING: 'c0000000-0000-4000-a000-000000000002',
  CATEGORY_SOCIALS: 'c0000000-0000-4000-a000-000000000005',
  CATEGORY_JOURNAL_CLUB: 'c0000000-0000-4000-a000-00000000000a',
  CATEGORY_MEDIA_SPEAKING: 'c0000000-0000-4000-a000-00000000000c',
  CATEGORY_RETIRED: 'c0000000-0000-4000-a000-0000000000ff',

  STORAGE: {
    ...STORAGE,
    MEMBER_DANIEL: 'm0000000-0000-4000-a000-00000000000a',
    MEMBER_JONATHAN: 'm0000000-0000-4000-a000-000000000008',
    MEMBER_LEAH: 'm0000000-0000-4000-a000-000000000009',
    MEMBER_CATHERINE: 'm0000000-0000-4000-a000-000000000003',
    MEMBER_GRACE: 'm0000000-0000-4000-a000-00000000000b',
    RECORD_OLD_A_1: 's1000000-0000-4000-a000-000000000001',
    RECORD_OLD_A_2: 's1000000-0000-4000-a000-000000000002',
    RECORD_OLD_A_PURGED: 's1000000-0000-4000-a000-000000000003',
    RECORD_OLD_B: 's1000000-0000-4000-a000-000000000004',
    RECORD_REJECTED: 's1000000-0000-4000-a000-000000000005',
    RECORD_PENDING: 's1000000-0000-4000-a000-000000000006',
    RECORD_RECENT: 's1000000-0000-4000-a000-000000000007',
    UPLOAD_GRANT_ORPHAN: 'w0000000-0000-4000-a000-000000000001',
    UPLOAD_GRANT_ACTIVE: 'w0000000-0000-4000-a000-000000000002',
  },
};
