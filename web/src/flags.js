// The triage vocabulary, in the words an officer would use.
//
// The flag names are the database's (see the check constraint on
// attendance_records in supabase/migrations/20260811100600_attendance.sql).
// None of them appears on screen: docs/03-admin-ui.md asks for
// spreadsheet-simple with no jargon, and "possible_duplicate_person" is not
// something a student secretary should have to decode at 11pm.
//
// Each entry carries what went wrong, and what one click should do about it.
// The wireframe's table in section 2 is exactly this, made into data so the
// card renderer has no branching in it.
//
//   headline  names the STATE, not the person. Names, events and times belong
//             on the card's metadata line, so nothing here interpolates them
//   detail    one sentence, only when the heading and metadata do not already
//             say it. Empty is the normal case
//   actions   which controls the card offers, in order
//   severity  'stop' for something that cannot be approved as it stands,
//             'look' for something that can, once a person has looked
//   override  approving this overrides a rule the card has just stated, so the
//             Approve button says "anyway" and means it
//
// ORDER MATTERS. A record can carry several flags, and the card headlines
// itself with the first one in FLAG_ORDER that it has, because an unmatched
// name outranks a missing photo: there is no point discussing the photo of
// somebody nobody can identify.

export const FLAG_ORDER = [
  'unmatched_name',
  'previously_rejected',
  'possible_duplicate_person',
  'duplicate_photo',
  'not_enrolled',
  'missing_evidence',
  'outside_window',
  'member_requested',
];

export const FLAG_COPY = {
  unmatched_name: {
    headline: 'Member not matched',
    detail: 'Link this check-in to a member or add them as a new member before awarding points.',
    actions: ['resolve'],
    severity: 'stop',
  },

  previously_rejected: {
    headline: 'Previously declined',
    // The reason it was declined is on the card, read off the earlier record.
    detail: '',
    actions: ['approve', 'reject'],
    severity: 'look',
  },

  possible_duplicate_person: {
    headline: 'Similar name on the roster',
    detail: 'Confirm this is the right person before approving.',
    actions: ['approve', 'reject'],
    severity: 'look',
  },

  duplicate_photo: {
    headline: 'Duplicate photo',
    detail: 'The same image was submitted for another event.',
    actions: ['compare', 'approve', 'reject'],
    severity: 'look',
  },

  not_enrolled: {
    headline: 'Not on this year of the roster',
    detail: 'Usually a returning member who has not signed up this year.',
    actions: ['enroll', 'reject'],
    severity: 'look',
  },

  missing_evidence: {
    headline: 'Photo missing',
    detail: 'This event requires a photo.',
    actions: ['approve', 'reject'],
    severity: 'look',
    override: true,
  },

  outside_window: {
    headline: 'Late check-in',
    // The check-in time is on the metadata line.
    detail: '',
    actions: ['approve', 'reject'],
    severity: 'look',
    override: true,
  },

  member_requested: {
    headline: 'Requested by member',
    detail: '',
    actions: ['approve', 'reject'],
    severity: 'look',
  },
};

/** The flag a card leads with, or null when the record is routine. */
export function primaryFlag(flags) {
  const held = new Set(Array.isArray(flags) ? flags : []);
  return FLAG_ORDER.find((flag) => held.has(flag)) ?? null;
}

/**
 * Every flag on a record, in the same order, with any the client does not
 * recognise dropped rather than rendered raw. A flag added to the database
 * later would otherwise reach an officer as a bare identifier.
 */
export function knownFlags(flags) {
  const held = new Set(Array.isArray(flags) ? flags : []);
  return FLAG_ORDER.filter((flag) => held.has(flag));
}

/**
 * The union of what every flag on this record offers, in a fixed order so the
 * buttons do not move around between cards.
 *
 * 'resolve' swallows the rest: a record with no member attached cannot be
 * approved at all (the check constraint on attendance_records says so, and
 * review_records raises PDS06 if you try), so offering Approve beside it would
 * be offering a button whose only outcome is a refusal.
 */
const ACTION_ORDER = ['resolve', 'compare', 'enroll', 'approve', 'reject'];

export function actionsFor(flags) {
  const held = knownFlags(flags);
  if (held.includes('unmatched_name')) return ['resolve', 'reject'];

  const offered = new Set();
  for (const flag of held) for (const action of FLAG_COPY[flag].actions) offered.add(action);
  if (!offered.size) {
    offered.add('approve');
    offered.add('reject');
  }
  // Enrolling already approves, so a card that offers it does not also need a
  // bare Approve sitting next to it doing nine tenths of the same thing.
  if (offered.has('enroll')) offered.delete('approve');
  return ACTION_ORDER.filter((action) => offered.has(action));
}

/**
 * 'Approve', or 'Approve anyway' where the card has just stated a rule that
 * approving overrides: a photo this event requires, or a closed check-in
 * window. Everything else is a judgement call rather than an override, and a
 * button that says "anyway" on every card stops carrying information.
 */
export function approveLabel(flags) {
  return knownFlags(flags).some((flag) => FLAG_COPY[flag].override)
    ? 'Approve anyway'
    : 'Approve';
}

/** 'Late check-in' */
export function headlineFor(flags) {
  const flag = primaryFlag(flags);
  return flag ? FLAG_COPY[flag].headline : '';
}
