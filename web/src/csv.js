// CSV, in both directions.
//
// READING is the half that matters. scripts/import_roster.py is the reference
// implementation and its behaviour is deliberately reproduced here rather than
// improved on, because the two paths load the same rosters into the same table
// and a disagreement between them is a second Abigail Catto:
//
//   * column names are matched case-insensitively, and a space or a hyphen is
//     as good as an underscore, so "First Name" and "first-name" both work
//   * first_name and last_name are required, email is optional, everything else
//     is ignored
//   * a row missing a name, or carrying something that is not an email address,
//     stops the whole file and names the offending row. A roster that is half
//     loaded is worse than one that is not loaded
//   * duplicates WITHIN the file are dropped, by email when there is one and by
//     normalised name otherwise
//
// What this file deliberately does NOT do is decide anything about the existing
// roster. Matching an incoming person against the members already in the
// database is roster.js's job, because it needs the roster, and because that is
// the decision an officer has to see before anything is written.
//
// WRITING is the export. Every officer who wants a spreadsheet gets one, and a
// tool that refuses is a tool that gets worked around.

import { normaliseName } from './match.js';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * RFC 4180 as far as anything that comes out of Excel or Sheets goes: quoted
 * fields, doubled quotes inside them, CRLF or LF, and a UTF-8 BOM on the front
 * because Excel puts one there.
 *
 * Returns rows of strings. A trailing newline does not produce an empty last
 * row, and a blank line in the middle produces a row of one empty string,
 * which readRoster() then skips rather than failing on.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Swallowed. The \n that follows is what ends the row.
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** "First Name" and "first-name" both become first_name. */
export function normaliseHeader(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

// Deliberately loose, exactly as the script is: the job is to catch a column of
// phone numbers or a stray header row, not to adjudicate RFC 5322.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const REQUIRED = ['first_name', 'last_name'];

/**
 * A file the officer chose, turned into people, or into one problem naming the
 * row that caused it.
 *
 * @param {string} text
 * @returns {{
 *   people: Array<{first_name: string, last_name: string, email: string|null, row: number}>,
 *   skipped: Array<{row: number, reason: string}>,
 *   problem: {title: string, body: string} | null
 * }}
 */
export function readRoster(text) {
  const fail = (title, body) => ({ people: [], skipped: [], problem: { title, body } });

  // NOT filtered before numbering. A blank line in the middle of the file is
  // not an error, but it still occupies a line, and a message naming row 12
  // has to mean the row the officer sees at 12 in their spreadsheet. Filtering
  // first would silently shift every number after the blank.
  const rows = parseCsv(text);
  const hasContent = (row) => row.some((cell) => String(cell ?? '').trim());
  if (!rows.some(hasContent)) return fail('Empty file', 'There is nothing in it to read.');

  const header = rows[0].map(normaliseHeader);
  const missing = REQUIRED.filter((column) => !header.includes(column));
  if (missing.length) {
    const found = header.filter(Boolean).join(', ') || 'nothing';
    return fail(
      'Missing a column',
      `The first row has to name ${missing.join(' and ')}. It names ${found}.`,
    );
  }

  const at = {};
  header.forEach((name, index) => {
    if (name && !(name in at)) at[name] = index;
  });

  const people = [];

  // The header is row 1 to whoever is looking at the file in a spreadsheet, so
  // the numbers reported here are the numbers on the left of their screen.
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const number = i + 1;
    if (!hasContent(row)) continue;
    const cell = (column) => String(row[at[column]] ?? '').trim();

    const first = cell('first_name');
    const last = cell('last_name');
    const email = cell('email') || null;

    if (!first || !last) {
      return fail(
        `Row ${number} has no name`,
        'Every row needs a first name and a last name. Fix the file and choose it again.',
      );
    }
    if (email && !EMAIL.test(email)) {
      return fail(
        `Row ${number} has a bad email`,
        `"${email}" is not an email address. Correct it, or leave the cell empty.`,
      );
    }

    people.push({ first_name: first, last_name: last, email, row: number });
  }

  if (!people.length) return fail('No people in the file', 'It has a header row and nothing else.');

  return { ...dedupe(people), problem: null };
}

/**
 * Drops the duplicates inside the file itself, before anything looks at the
 * roster. Same rule as the script: by email when the row has one, by
 * normalised full name when it does not.
 */
export function dedupe(people) {
  const kept = [];
  const skipped = [];
  const byEmail = new Map();
  const byName = new Map();

  for (const person of people) {
    const emailKey = person.email ? person.email.toLowerCase() : null;
    const nameKey = normaliseName(`${person.first_name} ${person.last_name}`);

    if (emailKey && byEmail.has(emailKey)) {
      skipped.push({ row: person.row, reason: `Same email as row ${byEmail.get(emailKey)}` });
      continue;
    }
    if (!emailKey && byName.has(nameKey)) {
      skipped.push({ row: person.row, reason: `Same name as row ${byName.get(nameKey)}` });
      continue;
    }

    if (emailKey) byEmail.set(emailKey, person.row);
    if (!byName.has(nameKey)) byName.set(nameKey, person.row);
    kept.push(person);
  }

  return { people: kept, skipped };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * One cell. Quoted when it has to be, left alone when it does not, so a file
 * of plain names opens as plain names.
 *
 * A leading =, +, - or @ is prefixed with an apostrophe. Excel reads those as
 * the start of a formula, and a member whose surname somebody typed with a
 * leading hyphen should not become a spreadsheet error, or worse.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Rows of values to one CSV string, with a BOM so Excel opens it as UTF-8
 * rather than mangling every name with an accent in it.
 *
 * @param {Array<Array<string|number|null>>} rows the header row included
 */
export function toCsv(rows) {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * Hands the file to the browser. Nothing is uploaded anywhere: this is the
 * bytes already on screen, written to a blob URL and clicked.
 */
export function downloadCsv(filename, rows) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next turn of the loop rather than immediately: Safari has
  // not finished with the URL when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 'progress-2026-2027-2026-08-13.csv'. Sorts by year, then by when it was taken. */
export function csvFilename(prefix, yearLabel) {
  const today = new Date();
  const stamp = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  const year = String(yearLabel ?? '').replace(/[^0-9a-z-]+/gi, '-');
  return [prefix, year, stamp].filter(Boolean).join('-') + '.csv';
}
