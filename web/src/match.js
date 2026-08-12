// Ranking roster names against a name somebody typed in on their phone.
//
// WHY THIS IS IN THE BROWSER, WHEN THE DATABASE HAS pg_trgm
//
// The obvious home for this is Postgres: `similarity()` is right there, the
// index for it exists (members_name_trgm), and search_members() already uses
// it. It is not used here because search_members() takes a check-in token, is
// granted to anon, and returns ten rows with no scores. An officer-side "rank
// the roster against this string, with the numbers" call would be a new
// SECURITY DEFINER function, and supabase/ belongs to another agent this phase.
//
// So the ranking runs here, over a roster an officer is already allowed to read
// in full (members_read_staff). At 355 rows that is one 30 KB fetch and a few
// milliseconds of scoring, once per session.
//
// This does not break invariant 2. What is computed in Postgres and never in
// client JS is Honorary status, which is a verdict about a member. This is the
// order of some suggestions under a card. Every one of them is a button an
// officer has to press, the link itself is made by resolve_unmatched(), and
// getting the order slightly wrong costs a glance down a list of five.
//
// The scoring below deliberately mirrors pg_trgm rather than inventing its own
// measure, so the percentage shown to an officer means roughly what the same
// percentage means in a query somebody runs later, and so this can move into
// SQL unchanged if the officer-side RPC is ever added.

/**
 * Lowercase, strip punctuation, collapse whitespace.
 * Mirrors fn_normalise_name() in supabase/migrations/20260811100300_people.sql.
 */
export function normaliseName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The trigram set pg_trgm would produce: each word padded with two leading
 * spaces and one trailing space, then every three-character window.
 * show_trgm('abby') is {"  a"," ab","abb","bby","by "}, which is what this
 * returns.
 */
export function trigrams(value) {
  const set = new Set();
  for (const word of normaliseName(value).split(' ')) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/**
 * pg_trgm's similarity(): shared trigrams over the size of the union, not the
 * Dice coefficient. Same numbers Postgres would give, give or take the word
 * splitting.
 */
export function similarity(a, b) {
  const left = trigrams(a);
  const right = trigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

const tokens = (value) => normaliseName(value).split(' ').filter(Boolean);

/**
 * Why a tie-break at all: "Abby Catto" against "Abigail Catto" and "Abby
 * Catterson" can score within a couple of points of each other, and which one
 * an officer sees first is the whole value of the feature. Sharing a surname
 * is the strongest cheap signal that two spellings are one person, and a
 * matching first initial is the next.
 *
 * These order the list. They never change the score shown, because a
 * percentage that has been quietly massaged is worse than no percentage.
 */
function tieBreak(query, candidate) {
  const q = tokens(query);
  const c = tokens(candidate);
  if (!q.length || !c.length) return 0;

  let score = 0;
  const qLast = q[q.length - 1];
  const cLast = c[c.length - 1];
  if (qLast === cLast) score += 2;
  if (q[0] === c[0]) score += 2;
  // "Abby" against "Abigail": one is how the other is shortened.
  if (c[0].startsWith(q[0]) || q[0].startsWith(c[0])) score += 1;
  if (q[0][0] === c[0][0]) score += 1;
  return score;
}

/**
 * @typedef {{ id: string, display_name: string, email?: string|null }} RosterRow
 * @typedef {{
 *   member: RosterRow,
 *   score: number,          // 0..1, the pg_trgm-shaped similarity
 *   percent: number,        // score as a whole number, for display
 *   certain: boolean,       // the email is an exact match, so this is not a guess
 *   reason: string          // why it is on the list, in plain English
 * }} Suggestion
 */

/**
 * Ranked roster suggestions for a name typed at check-in.
 *
 * An exact email match is treated as certainty rather than as a good score,
 * and pinned to the top with its own wording, because the check-in page asks
 * for an email on precisely this path and "same email address" is not a fuzzy
 * judgement. A name can be spelled six ways; an address either matches or does
 * not.
 *
 * @param {{name?: string|null, email?: string|null}} claimed
 * @param {RosterRow[]} roster
 * @param {{limit?: number, floor?: number}} [options]
 * @returns {Suggestion[]}
 */
export function rankMembers(claimed, roster, { limit = 5, floor = 0.2 } = {}) {
  const name = String(claimed?.name ?? '').trim();
  const email = String(claimed?.email ?? '').trim().toLowerCase();
  const rows = Array.isArray(roster) ? roster : [];

  const scored = rows.map((member) => {
    const score = name ? similarity(name, member.display_name) : 0;
    const sameEmail = Boolean(email) && String(member.email ?? '').toLowerCase() === email;
    return {
      member,
      score,
      percent: Math.round(score * 100),
      certain: sameEmail,
      reason: sameEmail
        ? 'Same email address'
        : `${Math.round(score * 100)}% name match`,
      tie: tieBreak(name, member.display_name),
    };
  });

  return scored
    .filter((row) => row.certain || row.score >= floor)
    .sort(
      (a, b) =>
        Number(b.certain) - Number(a.certain) ||
        b.score - a.score ||
        b.tie - a.tie ||
        a.member.display_name.localeCompare(b.member.display_name),
    )
    .slice(0, limit)
    .map(({ tie, ...row }) => row);
}

/**
 * Splits a typed-in name into the first_name / last_name that
 * resolve_unmatched() wants for a new member. Both columns are NOT NULL with a
 * non-empty check, so a single word gets a placeholder surname rather than a
 * failed insert the officer cannot interpret. They can fix it on the Members
 * screen; losing the check-in is not an option.
 *
 * "Catto, Abigail" is handled because some rosters are typed that way.
 */
export function splitName(fullName) {
  const raw = String(fullName ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return { first_name: '', last_name: '' };

  if (raw.includes(',')) {
    const [last, rest] = raw.split(',');
    const first = (rest ?? '').trim();
    if (last.trim() && first) return { first_name: first, last_name: last.trim() };
  }

  const parts = raw.split(' ');
  if (parts.length === 1) return { first_name: parts[0], last_name: '(no surname given)' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] };
}
