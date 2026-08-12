// Synthetic test fixture.
//
// Ten fictional members and eighteen events, hand-built to exercise every
// shape the requirements engine supports rather than just the easy path.
// There is no real student data anywhere in this repository, and none of the
// numbers below came from a spreadsheet: every expected value in EXPECTED was
// worked out by hand from the tables in this file, so the tests fail if the
// evaluator drifts.
//
// Shapes covered:
//   - fixed credit links, including fixed_credit values other than 1
//   - a from_submission link, where the member supplies the number (hours)
//   - one event linked to two categories, both fixed        (soap)
//   - one event linked to two categories with DIFFERENT credit modes,
//     from_submission for hours and fixed for socials        (vol_social)
//   - multi-category thresholds, the Speaking and Writing shape
//   - a nested group, Editorial Points inside Honorary Member
//   - a member who passes everything                         (Ada)
//   - a member who fails exactly one requirement             (Barnaby)
//   - a member sitting exactly on every threshold boundary   (Cressida)
//   - a member with no records at all                        (Dorian)
//   - hours arriving as decimals across two events           (Edda)
//   - rejected and pending records, which must not count     (Hamish)
//   - credit in a different academic year, which must not
//     leak into this year's totals                           (Imogen)
//
// The requirement tree itself is NOT defined here. It is the real published
// 2026-2027 set from migration 13, so these tests exercise the configuration
// that actually ships.

export const YEAR_2026 = 'a0000000-0000-4000-a000-000000000001'; // seeded, is_current
export const YEAR_2025 = 'a0000000-0000-4000-a000-000000000002'; // fixture only
export const TERM_FALL = 'b0000000-0000-4000-a000-000000000001';
export const TERM_SPRING = 'b0000000-0000-4000-a000-000000000002';
export const REQ_SET = 'd0000000-0000-4000-a000-000000000001';
export const ROOT_NODE = 'e0000000-0000-4000-a000-000000000000';

const M = (n) => `11111111-0000-4000-a000-0000000000${n}`;
const E = (n) => `22222222-0000-4000-a000-0000000000${n}`;
const U = (n) => `99999999-0000-4000-a000-0000000000${n}`;

export const MEMBERS = {
  ada: M('01'),       // passes everything
  barnaby: M('02'),   // fails exactly one requirement (Clinical Workshops)
  cressida: M('03'),  // exactly on every threshold
  dorian: M('04'),    // enrolled, no records
  edda: M('05'),      // hours split across two events, landing exactly on 25
  fergus: M('06'),    // scattered partial credit
  greta: M('07'),     // only the two multi-category events
  hamish: M('08'),    // only rejected and pending records
  imogen: M('09'),    // credit in the previous year only
  jasper: M('10'),    // editorial only, via the second category of each pair
};

export const EVENTS = {
  gbmBlock: E('01'),
  gbmSingle: E('02'),
  volDay: E('03'),
  volSocial: E('04'),
  clinA: E('05'),
  clinB: E('06'),
  soap: E('07'),
  nonClin: E('08'),
  socialBlock: E('09'),
  visits: E('10'),
  fund: E('11'),
  proceeds: E('12'),
  tabling: E('13'),
  journalClub: E('14'),
  mediaSpeak: E('15'),
  pdsaPost: E('16'),
  mediaWrite: E('17'),
  priorGbm: E('18'),
};

export const USERS = {
  admin: U('01'),
  officer: U('02'),
  viewer: U('03'),
  adaAccount: U('04'),   // a member, claimed and linked to Ada
  unclaimed: U('05'),    // a member whose claim has not been approved
};

// ---------------------------------------------------------------------------
// Expected results, derived by hand from the attendance table further down.
//
// point_total sums every category flagged counts_toward_point_total, which is
// all thirteen except Volunteering. Volunteering hours are required for
// Honorary but are never a point, which is the distinction the old Total tab
// made and the reason the flag is per category rather than per unit.
// ---------------------------------------------------------------------------

export const EXPECTED = {
  // member          point_total  is_honorary   how the total is made up
  ada: {
    pointTotal: 46, // 10 gbm + 6 clin + 5 nonclin + 6 social + 5 visits
    isHonorary: true, //  + 5 fund + 5 proceeds + 2 tabling + 1 jc + 1 write
  },
  barnaby: {
    pointTotal: 43, // 9 + 4 + 5 + 6 + 5 + 5 + 5 + 2 + 1 jc + 1 post
    isHonorary: false, // fails Clinical Workshops (4 of 5) and nothing else
  },
  cressida: {
    pointTotal: 44, // 9 + 5 + 5 + 6 + 5 + 5 + 5 + 2 + 1 jc + 1 write
    isHonorary: true, // every single threshold met exactly, none exceeded
  },
  dorian: { pointTotal: 0, isHonorary: false },
  edda: {
    pointTotal: 1, // one social from vol_social; the 25 hours are not points
    isHonorary: false,
  },
  fergus: {
    pointTotal: 5, // 1 gbm + 1 clin + 1 social + 2 tabling
    isHonorary: false,
  },
  greta: {
    pointTotal: 3, // 1 clin + 2 social; the 3 hours are not points
    isHonorary: false,
  },
  hamish: { pointTotal: 0, isHonorary: false }, // rejected and pending only
  imogen: { pointTotal: 0, isHonorary: false }, // 9 gbm, but in 2025-2026
  jasper: {
    pointTotal: 2, // 1 media speaking + 1 media writing
    isHonorary: false, // Editorial Points passes, the other nine do not
  },
};

// Honorary under the seeded rule: all ten children of the root must pass.
export const EXPECTED_HONORARY_COUNT = 2; // Ada and Cressida

// How many of the root's ten children each member passes. Used by the
// engine-flexibility test: dropping the root to "any 8 of 10" should let
// Barnaby through, and nobody else.
export const EXPECTED_CHILDREN_PASSING = {
  ada: 10,
  barnaby: 9, // everything except Clinical Workshops
  cressida: 10,
  dorian: 0,
  edda: 1, // Volunteering
  fergus: 1, // Tabling
  greta: 0,
  hamish: 0,
  imogen: 0,
  jasper: 1, // Editorial Points
};

export const EXPECTED_HONORARY_COUNT_AT_8 = 3; // Ada, Barnaby, Cressida

// Category totals for one member, as a spot check that the sums that feed the
// thresholds are themselves right and not merely consistent with each other.
export const EXPECTED_ADA_CATEGORY_TOTALS = {
  gbms: 10,
  volunteering: 30,
  'clinical-workshops': 6,
  'non-clinical-workshops': 5,
  socials: 6,
  'dental-school-visits': 5,
  fundraising: 5,
  'partial-proceeds': 5,
  tabling: 2,
  'journal-club': 1,
  'media-writing': 1,
};

// Cressida sits on every boundary, so value must equal target on all eleven
// thresholds. Anything that rounded, floored or compared with > instead of >=
// would show up here first.
export const EXPECTED_CRESSIDA_THRESHOLDS = {
  GBMs: 9,
  Volunteering: 25,
  'Clinical Workshops': 5,
  'Non-Clinical Workshops': 5,
  Socials: 6,
  'Dental School Visits': 5,
  Fundraising: 5,
  'Partial Proceeds': 5,
  Tabling: 2,
  Speaking: 1,
  Writing: 1,
};

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

const CAT = {
  gbms: 'c0000000-0000-4000-a000-000000000001',
  volunteering: 'c0000000-0000-4000-a000-000000000002',
  clinical: 'c0000000-0000-4000-a000-000000000003',
  nonClinical: 'c0000000-0000-4000-a000-000000000004',
  socials: 'c0000000-0000-4000-a000-000000000005',
  visits: 'c0000000-0000-4000-a000-000000000006',
  fundraising: 'c0000000-0000-4000-a000-000000000007',
  proceeds: 'c0000000-0000-4000-a000-000000000008',
  tabling: 'c0000000-0000-4000-a000-000000000009',
  journalClub: 'c0000000-0000-4000-a000-00000000000a',
  pdsaPost: 'c0000000-0000-4000-a000-00000000000b',
  mediaSpeaking: 'c0000000-0000-4000-a000-00000000000c',
  mediaWriting: 'c0000000-0000-4000-a000-00000000000d',
};

export const SQL = `
-- ---- a second academic year, so year scoping can be tested ---------------
insert into academic_years (id, label, starts_on, ends_on, is_current) values
  ('${YEAR_2025}', '2025-2026', date '2025-08-18', date '2026-05-08', false);

-- ---- members --------------------------------------------------------------
insert into members (id, first_name, last_name) values
  ('${MEMBERS.ada}',      'Ada',      'Testwood'),
  ('${MEMBERS.barnaby}',  'Barnaby',  'Fixture'),
  ('${MEMBERS.cressida}', 'Cressida', 'Boundary'),
  ('${MEMBERS.dorian}',   'Dorian',   'Nullstone'),
  ('${MEMBERS.edda}',     'Edda',     'Hoursworth'),
  ('${MEMBERS.fergus}',   'Fergus',   'Halfpoint'),
  ('${MEMBERS.greta}',    'Greta',    'Twoway'),
  ('${MEMBERS.hamish}',   'Hamish',   'Pendleton'),
  ('${MEMBERS.imogen}',   'Imogen',   'Lastyear'),
  ('${MEMBERS.jasper}',   'Jasper',   'Speakwrite');

insert into member_enrollments (member_id, academic_year_id)
select id, '${YEAR_2026}' from members;

insert into member_enrollments (member_id, academic_year_id)
values ('${MEMBERS.imogen}', '${YEAR_2025}');

-- ---- accounts -------------------------------------------------------------
insert into auth.users (id, email) values
  ('${USERS.admin}',      'admin@example.test'),
  ('${USERS.officer}',    'officer@example.test'),
  ('${USERS.viewer}',     'viewer@example.test'),
  ('${USERS.adaAccount}', 'ada@example.test'),
  ('${USERS.unclaimed}',  'nobody@example.test');

insert into profiles (user_id, member_id, full_name, role) values
  ('${USERS.admin}',      null,              'Admin Example',   'admin'),
  ('${USERS.officer}',    null,              'Officer Example', 'officer'),
  ('${USERS.viewer}',     null,              'Viewer Example',  'viewer'),
  ('${USERS.adaAccount}', '${MEMBERS.ada}',  'Ada Testwood',    'member'),
  ('${USERS.unclaimed}',  null,              'Unclaimed User',  'member');

-- ---- events ---------------------------------------------------------------
-- Fall 2026 runs 2026-08-17 to 2026-12-11, Spring 2027 from 2027-01-11.
insert into events (id, academic_year_id, term_id, title, occurred_on, checkin_token) values
  ('${EVENTS.gbmBlock}',    '${YEAR_2026}', '${TERM_FALL}',   'Test GBM Block',              date '2026-09-10', 'tok-gbm-block'),
  ('${EVENTS.gbmSingle}',   '${YEAR_2026}', '${TERM_SPRING}', 'Test GBM Single',             date '2027-02-10', 'tok-gbm-single'),
  ('${EVENTS.volDay}',      '${YEAR_2026}', '${TERM_FALL}',   'Test Volunteering Day',       date '2026-09-20', 'tok-vol-day'),
  ('${EVENTS.volSocial}',   '${YEAR_2026}', '${TERM_FALL}',   'Test Volunteer Social',       date '2026-10-05', 'tok-vol-social'),
  ('${EVENTS.clinA}',       '${YEAR_2026}', '${TERM_FALL}',   'Test Clinical Block A',       date '2026-09-25', 'tok-clin-a'),
  ('${EVENTS.clinB}',       '${YEAR_2026}', '${TERM_FALL}',   'Test Clinical Block B',       date '2026-10-15', 'tok-clin-b'),
  ('${EVENTS.soap}',        '${YEAR_2026}', '${TERM_FALL}',   'Test Soap Carving Twofer',    date '2026-10-20', 'tok-soap'),
  ('${EVENTS.nonClin}',     '${YEAR_2026}', '${TERM_FALL}',   'Test Non-Clinical Block',     date '2026-10-25', 'tok-nonclin'),
  ('${EVENTS.socialBlock}', '${YEAR_2026}', '${TERM_FALL}',   'Test Socials Block',          date '2026-11-01', 'tok-social-block'),
  ('${EVENTS.visits}',      '${YEAR_2026}', '${TERM_FALL}',   'Test Visits Block',           date '2026-11-05', 'tok-visits'),
  ('${EVENTS.fund}',        '${YEAR_2026}', '${TERM_FALL}',   'Test Fundraising Block',      date '2026-11-10', 'tok-fund'),
  ('${EVENTS.proceeds}',    '${YEAR_2026}', '${TERM_FALL}',   'Test Partial Proceeds Block', date '2026-11-15', 'tok-proceeds'),
  ('${EVENTS.tabling}',     '${YEAR_2026}', '${TERM_FALL}',   'Test Tabling Block',          date '2026-11-20', 'tok-tabling'),
  ('${EVENTS.journalClub}', '${YEAR_2026}', '${TERM_FALL}',   'Test Journal Club Session',   date '2026-11-25', 'tok-jc'),
  ('${EVENTS.mediaSpeak}',  '${YEAR_2026}', '${TERM_FALL}',   'Test Media Speaking Spot',    date '2026-12-01', 'tok-media-speak'),
  ('${EVENTS.pdsaPost}',    '${YEAR_2026}', '${TERM_SPRING}', 'Test PDSA Post Feature',      date '2027-02-15', 'tok-post'),
  ('${EVENTS.mediaWrite}',  '${YEAR_2026}', '${TERM_SPRING}', 'Test Media Writing Piece',    date '2027-02-20', 'tok-media-write'),
  ('${EVENTS.priorGbm}',    '${YEAR_2025}', null,             'Test Prior Year GBM Block',   date '2026-03-01', 'tok-prior-gbm');

-- ---- what each event counts for -------------------------------------------
-- Note fixed_credit values other than 1: one "block" event stands in for a
-- run of real events, which is also how a genuine double-credit GBM is
-- recorded. The evaluator sums credit and never counts rows.
insert into event_categories (event_id, category_id, credit_mode, fixed_credit) values
  ('${EVENTS.gbmBlock}',    '${CAT.gbms}',          'fixed', 9),
  ('${EVENTS.gbmSingle}',   '${CAT.gbms}',          'fixed', 1),
  ('${EVENTS.clinA}',       '${CAT.clinical}',      'fixed', 3),
  ('${EVENTS.clinB}',       '${CAT.clinical}',      'fixed', 2),
  ('${EVENTS.nonClin}',     '${CAT.nonClinical}',   'fixed', 5),
  ('${EVENTS.socialBlock}', '${CAT.socials}',       'fixed', 5),
  ('${EVENTS.visits}',      '${CAT.visits}',        'fixed', 5),
  ('${EVENTS.fund}',        '${CAT.fundraising}',   'fixed', 5),
  ('${EVENTS.proceeds}',    '${CAT.proceeds}',      'fixed', 5),
  ('${EVENTS.tabling}',     '${CAT.tabling}',       'fixed', 2),
  ('${EVENTS.journalClub}', '${CAT.journalClub}',   'fixed', 1),
  ('${EVENTS.mediaSpeak}',  '${CAT.mediaSpeaking}', 'fixed', 1),
  ('${EVENTS.pdsaPost}',    '${CAT.pdsaPost}',      'fixed', 1),
  ('${EVENTS.mediaWrite}',  '${CAT.mediaWriting}',  'fixed', 1),
  ('${EVENTS.priorGbm}',    '${CAT.gbms}',          'fixed', 9),

  -- one event, two categories, both fixed: the Soap Carving shape
  ('${EVENTS.soap}',        '${CAT.clinical}',      'fixed', 1),
  ('${EVENTS.soap}',        '${CAT.socials}',       'fixed', 1),

  -- one event, two categories, DIFFERENT credit modes: the member types their
  -- hours, and the same attendance also earns one social. Different units,
  -- same event, no special-casing anywhere in the evaluator.
  ('${EVENTS.volDay}',      '${CAT.volunteering}',  'from_submission', 0),
  ('${EVENTS.volSocial}',   '${CAT.volunteering}',  'from_submission', 0),
  ('${EVENTS.volSocial}',   '${CAT.socials}',       'fixed', 1);

-- ---- attendance -----------------------------------------------------------
insert into attendance_records (event_id, member_id, status, source, submitted_value) values
  -- Ada: passes everything, with room to spare
  ('${EVENTS.gbmBlock}',    '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.gbmSingle}',   '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.volDay}',      '${MEMBERS.ada}', 'approved', 'officer_entry', 30),
  ('${EVENTS.clinA}',       '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.clinB}',       '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.soap}',        '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.nonClin}',     '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.socialBlock}', '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.visits}',      '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.fund}',        '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.proceeds}',    '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.tabling}',     '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.journalClub}', '${MEMBERS.ada}', 'approved', 'officer_entry', null),
  ('${EVENTS.mediaWrite}',  '${MEMBERS.ada}', 'approved', 'officer_entry', null),

  -- Barnaby: identical to Ada except Clinical Workshops lands on 4, not 5
  ('${EVENTS.gbmBlock}',    '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.volDay}',      '${MEMBERS.barnaby}', 'approved', 'officer_entry', 40),
  ('${EVENTS.clinA}',       '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.soap}',        '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.nonClin}',     '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.socialBlock}', '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.visits}',      '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.fund}',        '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.proceeds}',    '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.tabling}',     '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.journalClub}', '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),
  ('${EVENTS.pdsaPost}',    '${MEMBERS.barnaby}', 'approved', 'officer_entry', null),

  -- Cressida: every threshold met exactly, never exceeded
  ('${EVENTS.gbmBlock}',    '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.volSocial}',   '${MEMBERS.cressida}', 'approved', 'officer_entry', 25),
  ('${EVENTS.clinA}',       '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.clinB}',       '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.nonClin}',     '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.socialBlock}', '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.visits}',      '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.fund}',        '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.proceeds}',    '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.tabling}',     '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.journalClub}', '${MEMBERS.cressida}', 'approved', 'officer_entry', null),
  ('${EVENTS.mediaWrite}',  '${MEMBERS.cressida}', 'approved', 'officer_entry', null),

  -- Dorian: nothing at all

  -- Edda: 12.5 + 12.5 hours across two events, landing exactly on 25
  ('${EVENTS.volDay}',    '${MEMBERS.edda}', 'approved', 'officer_entry', 12.5),
  ('${EVENTS.volSocial}', '${MEMBERS.edda}', 'approved', 'officer_entry', 12.5),

  -- Fergus: scattered
  ('${EVENTS.gbmSingle}', '${MEMBERS.fergus}', 'approved', 'officer_entry', null),
  ('${EVENTS.soap}',      '${MEMBERS.fergus}', 'approved', 'officer_entry', null),
  ('${EVENTS.tabling}',   '${MEMBERS.fergus}', 'approved', 'officer_entry', null),

  -- Greta: only the two multi-category events
  ('${EVENTS.soap}',      '${MEMBERS.greta}', 'approved', 'officer_entry', null),
  ('${EVENTS.volSocial}', '${MEMBERS.greta}', 'approved', 'officer_entry', 3),

  -- Hamish: one rejected, two pending. None of it counts.
  ('${EVENTS.gbmBlock}',  '${MEMBERS.hamish}', 'rejected', 'self_checkin', null),
  ('${EVENTS.gbmSingle}', '${MEMBERS.hamish}', 'pending',  'self_checkin', null),
  ('${EVENTS.clinA}',     '${MEMBERS.hamish}', 'pending',  'self_checkin', null),

  -- Imogen: nine GBMs, but in 2025-2026
  ('${EVENTS.priorGbm}',  '${MEMBERS.imogen}', 'approved', 'import', null),

  -- Jasper: editorial only, reaching Speaking and Writing through the SECOND
  -- category of each pair, which Ada and Cressida do not
  ('${EVENTS.mediaSpeak}', '${MEMBERS.jasper}', 'approved', 'officer_entry', null),
  ('${EVENTS.mediaWrite}', '${MEMBERS.jasper}', 'approved', 'officer_entry', null);
`;

export async function loadFixture(db) {
  await db.asOwner();
  await db.exec(SQL);
}
