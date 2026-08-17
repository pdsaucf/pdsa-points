// What a category is, with no DOM in it: the slug rule.
//
// TWO SCREENS CREATE CATEGORIES. The categories screen is where they are
// managed, and the requirements editor makes one inline, because an officer
// writing a rule for something the club has not tracked before should not have
// to abandon a half written rule to go and create it. Both have to agree on what
// a slug looks like, so both read it here.
//
// A CATEGORY IS A NAME AND AN ORDER. It used to carry a unit (events, hours or
// points) and a flag for whether its credit counted toward the point total.
// Migration 22 dropped both: the unit never changed any arithmetic, the club
// does not track hours, and the flag existed only to keep Volunteering hours out
// of a total they could not honestly be added to. There is one unit and it is
// points.

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
