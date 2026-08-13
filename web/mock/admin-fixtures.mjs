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

export const ACCOUNTS = {
  'sara@pdsaucf.com': { user_id: USERS.officer, role: 'officer', full_name: 'Sara Whitfield' },
  'ben@pdsaucf.com': { user_id: USERS.admin, role: 'admin', full_name: 'Ben Le' },
  'advisor@ucf.edu': { user_id: USERS.viewer, role: 'viewer', full_name: 'Dr Okafor' },
  'priya@knights.ucf.edu': { user_id: USERS.member, role: 'member', full_name: 'Priya Raman' },
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
];

const EVENT_CATEGORIES = [
  { event_id: EVENTS[0].id, category_id: CATEGORIES[0].id, credit_mode: 'fixed', fixed_credit: 1 },
  { event_id: EVENTS[1].id, category_id: CATEGORIES[2].id, credit_mode: 'fixed', fixed_credit: 1 },
  { event_id: EVENTS[2].id, category_id: CATEGORIES[1].id, credit_mode: 'from_submission', fixed_credit: 1 },
  { event_id: EVENTS[3].id, category_id: CATEGORIES[0].id, credit_mode: 'fixed', fixed_credit: 1 },
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
    .filter((m) => m.id !== notEnrolled.id)
    .map((m) => ({
      member_id: m.id,
      academic_year_id: YEAR_CURRENT,
      status: 'active',
      joined_on: '2026-08-01',
    }));

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

  const addEvidence = (recordId, kind, sha256) => {
    evidenceSeq += 1;
    const objectPath = `${YEAR_CURRENT}/${kind}/photo-${String(evidenceSeq).padStart(3, '0')}.jpg`;
    evidence.push({
      id: `v0000000-0000-4000-a000-${String(evidenceSeq).padStart(12, '0')}`,
      attendance_record_id: recordId,
      kind,
      provider: 'supabase',
      object_path: objectPath,
      drive_file_id: null,
      content_type: 'image/jpeg',
      byte_size: 184320,
      sha256: sha256 ?? `sha256-${recordId}`,
      uploaded_at: '2026-08-11T18:02:00.000Z',
      archived_at: null,
      purged_at: null,
    });
    return objectPath;
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
    audit_log: [],
  };
}

export const IDS = {
  YEAR_CURRENT,
  YEAR_PAST,
  USERS,
  EVENT_GBM: EVENTS[0].id,
  EVENT_SOAP: EVENTS[1].id,
  EVENT_LAST_YEAR: EVENTS[3].id,
  MEMBER_ABIGAIL: 'm0000000-0000-4000-a000-000000000001',
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
};
