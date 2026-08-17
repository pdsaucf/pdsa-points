// What a category is, with no DOM in it: the unit vocabulary and the slug rule.
//
// TWO SCREENS CREATE CATEGORIES NOW. The categories screen is where they are
// managed, and the requirements editor makes one inline, because an officer
// writing a rule for something the club has not tracked before should not have
// to abandon a half written rule to go and create it. Both have to agree on
// what a unit is called and on what a slug looks like, so both read it here.

/** The word the unit picker shows. */
export const UNIT_NAME = {
  event_count: 'Events',
  hours: 'Hours',
  points: 'Points',
};

/**
 * The singular word a requirement reads with. 'hours' is the only unit whose
 * sentence needs one; an event count reads "9 events" from the unit itself.
 */
export const UNIT_LABEL = {
  event_count: null,
  hours: 'hour',
  points: 'point',
};

/**
 * The stable key. Never shown, never reused, and unique across retired ones
 * too: a slug that came back for a second category would attach this year's
 * credit to a name last year's rules already measure.
 *
 * @param {string} name what the officer typed
 * @param {Iterable<string>} taken every slug that already exists
 */
export function uniqueSlug(name, taken) {
  const base =
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'category';

  const used = new Set(taken ?? []);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}
