// Fixtures for the local mock. The shapes here are copied from the return
// values in supabase/migrations/20260811101000_rpcs.sql, not from the design
// docs, because the docs predate the client_nonce argument.

export const ACADEMIC_YEAR_ID = 'a0000000-0000-4000-a000-000000000001';

// A category is an id and a name. get_checkin_context() carried a unit until
// migration 22, which dropped the column: there is one unit, and the field a
// member types a number into is labelled from the category itself.
const CATEGORY = {
  gbms: { id: 'c0000000-0000-4000-a000-000000000001', name: 'GBMs' },
  volunteering: { id: 'c0000000-0000-4000-a000-000000000002', name: 'Volunteering' },
  socials: { id: 'c0000000-0000-4000-a000-000000000005', name: 'Socials' },
  partial: { id: 'c0000000-0000-4000-a000-000000000008', name: 'Partial Proceeds' },
};

const today = () => new Date().toISOString().slice(0, 10);
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

/**
 * Each token is a scenario. `behaviour` is what the mock does that a real
 * server would do only under load or on bad wifi.
 */
export const EVENTS = {
  // Plain GBM: pick your name, check in. Also the unmatched-name path.
  gbm: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000001',
      title: 'Spring GBM 5',
      occurred_on: today(),
      location: 'HPA-1 205',
      closes_at: inHours(3),
    },
    categories: [CATEGORY.gbms],
    collect_value: null,
    evidence_requirements: [],
  },

  // An event that collects a number, labelled from the category.
  vol: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000002',
      title: 'Give Kids A Smile',
      occurred_on: today(),
      location: 'UCF College of Medicine',
      closes_at: inHours(6),
    },
    categories: [CATEGORY.volunteering],
    collect_value: {
      category_id: CATEGORY.volunteering.id,
      category: 'Volunteering',
    },
    evidence_requirements: [],
  },

  // Shirt photo required.
  shirt: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000003',
      title: 'Soap Carving',
      occurred_on: today(),
      location: 'HPA-2 118',
      closes_at: inHours(4),
    },
    categories: [CATEGORY.socials],
    collect_value: null,
    evidence_requirements: [
      { kind: 'shirt_photo', is_required: true, prompt: 'Photo of you in your PDSA shirt' },
    ],
  },

  // Receipt photo required, and the submit drops the connection once after the
  // upload has already succeeded. Retrying must not ask for a new photo.
  drop: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000004',
      title: "Nothing Bundt Cakes",
      occurred_on: today(),
      location: 'Waterford Lakes',
      closes_at: inHours(2),
    },
    categories: [CATEGORY.partial],
    collect_value: null,
    evidence_requirements: [
      { kind: 'receipt_photo', is_required: true, prompt: 'Photo of your receipt' },
    ],
    behaviour: { dropSubmits: 1 },
  },

  // Rate limited: the first two submits answer PDS09.
  busy: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000005',
      title: 'Fall GBM 2',
      occurred_on: today(),
      location: 'Student Union 218',
      closes_at: inHours(3),
    },
    categories: [CATEGORY.gbms],
    collect_value: null,
    evidence_requirements: [],
    behaviour: { rateLimitSubmits: 2 },
  },

  // Refuses five submits in a row, which is the whole rate-limit ladder. Used
  // with an injected clock, so the suite walks all five rungs without sitting
  // through the seventy seconds they add up to.
  busy5: {
    event: {
      id: 'e0000000-0000-4000-a000-00000000000b',
      title: 'Fall GBM 3',
      occurred_on: today(),
      location: 'Student Union 218',
      closes_at: inHours(3),
    },
    categories: [CATEGORY.gbms],
    collect_value: null,
    evidence_requirements: [],
    behaviour: { rateLimitSubmits: 5 },
  },

  // Already checked in: every submit answers PDS05.
  dupe: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000006',
      title: 'Zumba Night',
      occurred_on: today(),
      location: 'RWC',
      closes_at: inHours(3),
    },
    categories: [CATEGORY.socials],
    collect_value: null,
    evidence_requirements: [],
    behaviour: { alwaysDuplicate: true },
  },

  // Check-in has closed.
  closed: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000007',
      title: 'Tabling',
      occurred_on: today(),
      location: 'Memory Mall',
      closes_at: inHours(-1),
    },
    categories: [CATEGORY.gbms],
    collect_value: null,
    evidence_requirements: [],
    behaviour: { window: 'closed' },
  },

  // Check-in has not opened yet.
  early: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000008',
      title: 'Spring GBM 6',
      occurred_on: today(),
      location: 'HPA-1 106',
      closes_at: inHours(30),
    },
    categories: [CATEGORY.gbms],
    collect_value: null,
    evidence_requirements: [],
    behaviour: { window: 'early' },
  },

  // Open when the page loaded, closed past the grace period by the time the
  // member pressed the button. The only way PDS10 reaches somebody who is
  // already filling in the form.
  latesubmit: {
    event: {
      id: 'e0000000-0000-4000-a000-00000000000a',
      title: 'Spring GBM 4',
      occurred_on: today(),
      location: 'HPA-1 106',
      closes_at: inHours(-2),
    },
    categories: [CATEGORY.gbms],
    collect_value: null,
    evidence_requirements: [],
    behaviour: { window: 'closed_past_grace' },
  },

  // An event whose roster is empty, which is the shipping state of the system.
  empty: {
    event: {
      id: 'e0000000-0000-4000-a000-000000000009',
      title: 'Fall GBM 1',
      occurred_on: today(),
      location: 'Student Union 316',
      closes_at: inHours(3),
    },
    categories: [CATEGORY.gbms],
    collect_value: null,
    evidence_requirements: [],
    behaviour: { emptyRoster: true },
  },
};

// Deliberately includes two names close enough to be worth disambiguating, and
// one that only matches on a nickname, which is what the escape hatch is for.
export const MEMBERS = [
  { id: 'm0000000-0000-4000-a000-000000000001', display_name: 'Abigail Catto' },
  { id: 'm0000000-0000-4000-a000-000000000002', display_name: 'Abby Catto' },
  { id: 'm0000000-0000-4000-a000-000000000003', display_name: 'Catherine Diaz' },
  { id: 'm0000000-0000-4000-a000-000000000004', display_name: 'Aaron Ozan' },
  { id: 'm0000000-0000-4000-a000-000000000005', display_name: 'Priya Raman' },
  { id: 'm0000000-0000-4000-a000-000000000006', display_name: 'Marcus Bell' },
  { id: 'm0000000-0000-4000-a000-000000000007', display_name: 'Sofia Marchetti' },
  { id: 'm0000000-0000-4000-a000-000000000008', display_name: 'Jonathan Pak' },
  { id: 'm0000000-0000-4000-a000-000000000009', display_name: 'Leah Ortiz' },
  { id: 'm0000000-0000-4000-a000-00000000000a', display_name: 'Daniel Nguyen' },
  { id: 'm0000000-0000-4000-a000-00000000000b', display_name: 'Grace Okonkwo' },
  { id: 'm0000000-0000-4000-a000-00000000000c', display_name: 'Ethan Wallace' },
];
