// Names pasted from a message, spreadsheet, or sign-in sheet.
//
// Both roster enrollment and event attendance accept the same shapes. Keeping
// the parser here means line numbers, list-marker cleanup, surname handling,
// and duplicate detection cannot drift between the two screens.

/**
 * @param {string} text
 * @returns {{people: Array<object>, repeated: Array<object>, unusable: Array<object>, entries: Array<object>}}
 */
export function parsePastedNames(text) {
  const people = [];
  const repeated = [];
  const unusable = [];
  const entries = [];
  const seen = new Map();

  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const row = index + 1;
      const cleaned = line
        .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '')
        .replace(/[,;]\s*$/, '')
        .trim()
        .replace(/\s+/g, ' ');
      if (!cleaned) return;

      const [first, last] = splitPastedName(cleaned);
      if (!first || !last || !/[\p{L}\p{N}]/u.test(first) || !/[\p{L}\p{N}]/u.test(last)) {
        const entry = {
          kind: 'invalid',
          raw: cleaned,
          row,
          why: 'Needs a first and last name',
        };
        unusable.push(entry);
        entries.push(entry);
        return;
      }

      const name = `${first} ${last}`;
      const key = name.toLowerCase();
      if (seen.has(key)) {
        const entry = { kind: 'repeated', name, row, first_row: seen.get(key) };
        repeated.push(entry);
        entries.push(entry);
        return;
      }

      seen.set(key, row);
      const person = { first_name: first, last_name: last, row };
      people.push(person);
      entries.push({ kind: 'person', name, ...person });
    });

  return { people, repeated, unusable, entries };
}

/** `Marcus Bell` and `Bell, Marcus` produce the same two columns. */
export function splitPastedName(cleaned) {
  const comma = cleaned.indexOf(',');
  if (comma > 0) {
    const last = cleaned.slice(0, comma).trim();
    const first = cleaned.slice(comma + 1).trim();
    return [first, last];
  }
  const parts = cleaned.split(' ');
  if (parts.length < 2) return [cleaned, ''];
  return [parts[0], parts.slice(1).join(' ')];
}
