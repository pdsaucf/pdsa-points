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

const CATEGORIES = [
  { id: 'c0000000-0000-4000-a000-000000000001', slug: 'gbms', name: 'GBMs', unit: 'event_count', unit_label: null, sort_order: 1 },
  { id: 'c0000000-0000-4000-a000-000000000002', slug: 'volunteering', name: 'Volunteering', unit: 'hours', unit_label: 'hour', sort_order: 2 },
  { id: 'c0000000-0000-4000-a000-000000000005', slug: 'socials', name: 'Socials', unit: 'event_count', unit_label: null, sort_order: 3 },
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

  return members;
}

const DUPLICATE_HASH = 'sha256-shared-between-two-events-0000000000000000';

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
    categories: CATEGORIES.map((c) => ({ ...c, counts_toward_point_total: true, archived_at: null })),
    events: EVENTS.map((e) => ({ ...e })),
    event_categories: EVENT_CATEGORIES.map((ec) => ({ ...ec })),
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
};
