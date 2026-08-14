// What "Joined" means, decided once.
//
// Three surfaces put that word next to a date about the same person:
//
//   the roster row            this file
//   the duplicate banner      joined_a and joined_b from
//                             v_possible_duplicate_members, which is
//                             min(member_enrollments.joined_on) falling back
//                             to members.created_at
//   the member detail screen  this file
//
// The banner and the roster row sit a few pixels apart, and the detail screen
// is one click from both. They are read together exactly when an officer is
// deciding which of two rows survives a merge, and "who has been here longer"
// is the fact that decides it. A returning member reading Aug 2025 in one
// place and Aug 2026 in another is not a cosmetic difference: it is two
// answers to the question the merge turns on.
//
// So the rule is here rather than in each screen, and it is the SQL's rule:
// the EARLIEST enrollment across every year, and for somebody with no
// enrollment row at all, when the member row was created.
//
// Note what it is NOT. It is not the selected year's joined_on. That date is
// "enrolled for 2026-2027", it is the same month for nearly everybody, and it
// answers a different question.

/**
 * One member's join date.
 *
 * Rows carrying a member_id for somebody else are ignored, so a caller may
 * pass the whole enrollment table or just this member's rows.
 *
 * @param {Array<{member_id?: string, joined_on?: string|null}>} rows
 * @param {{id?: string, created_at?: string|null}} member
 * @returns {string|null}
 */
export function firstJoinedOn(rows, member) {
  let earliest;
  for (const row of rows ?? []) {
    if (!row?.joined_on) continue;
    if (member?.id && row.member_id && row.member_id !== member.id) continue;
    const value = String(row.joined_on);
    if (earliest === undefined || value < earliest) earliest = value;
  }
  return earliest ?? member?.created_at ?? null;
}

/**
 * The same answer for a list of members, from one read of the enrollments.
 *
 * @returns {Map<string, string|null>} member id -> join date
 */
export function firstJoinedIndex(rows, members) {
  const earliest = new Map();
  for (const row of rows ?? []) {
    if (!row?.joined_on || !row.member_id) continue;
    const held = earliest.get(row.member_id);
    const value = String(row.joined_on);
    if (held === undefined || value < held) earliest.set(row.member_id, value);
  }

  return new Map(
    (members ?? []).map((member) => [
      member.id,
      earliest.get(member.id) ?? member.created_at ?? null,
    ]),
  );
}
