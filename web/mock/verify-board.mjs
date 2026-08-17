// Checks for the progress board, the member screen, the roster and the merge.
//
// Same rule as the other three suites: assert what fails SILENTLY. A board that
// draws is easy to see. What is not:
//
//   1. THAT THE NUMBERS COME FROM THE SERVER. Invariant 2 says honorary status
//      is computed in Postgres and never in client JS, and the point total is
//      the same kind of answer: it sums only the categories flagged as counting
//      toward it, which is what excludes Volunteering hours. A board that added
//      up its own columns would look completely normal and be wrong for every
//      member with volunteering. So the falsifiable check is here: the visible
//      cells deliberately do NOT sum to the visible point total, and a client
//      doing its own arithmetic could not produce both.
//   2. That a threshold met shows as met, and that the target under each
//      column is the published rule's own number rather than a constant. Change
//      the rule, the board moves.
//   3. That the export carries what is on screen. An export that quietly
//      ignored the filter answers a different question from the one just asked.
//   4. That an import cannot create a second Abigail Catto. The preview has to
//      catch the fuzzy match, and the button has to stay unpressable while a
//      row is unanswered.
//   5. That a pair renders once rather than twice, that merging moves the
//      records, and that dismissing is remembered whichever way round the pair
//      is passed.
//   6. That none of it is reachable by a member account.
//
// HOW THE SCREENS ARE DRIVEN. mock/dom.mjs parses the real admin/index.html and
// admin.js's own start() runs against it, so what is asserted below is the
// rendered DOM of the shipped page, not a module's return value. An id that
// stopped matching between the markup and the module fails here.
//
// WHERE THE NUMBERS COME FROM, AND WHY THAT IS NOT CIRCULAR. The mock computes
// v_member_status, v_member_category_totals and fn_member_requirement_status
// from the same attendance rows the real views read (see admin-server.mjs). It
// shares no code with the page: nothing under src/ can compute a point total or
// an honorary flag, which is check 1 above and is also asserted against the
// sources.
//
// Run: node web/mock/verify-board.mjs   (npm run verify:board, from web/)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';
import { failRpcOnce, refuseImportRowOnce, dropImportResultOnce } from './admin-server.mjs';
import { IDS } from './admin-fixtures.mjs';
import { installDom } from './dom.mjs';

const PORT = 8796;
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

globalThis.__PDSA_CONFIG__ = {
  SUPABASE_URL: `http://localhost:${PORT}`,
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

// The page, as it ships.
const adminHtml = await readFile(`${WEB_ROOT}admin/index.html`, 'utf8');
const adminCss = await readFile(`${WEB_ROOT}assets/css/admin.css`, 'utf8');
const dom = installDom(adminHtml);

globalThis.window = {
  location: {
    origin: `http://localhost:${PORT}`,
    pathname: '/admin/',
    href: `http://localhost:${PORT}/admin/`,
    replace() {},
  },
  history: { replaceState() {} },
};

// Export writes a blob and clicks a link. Both are caught here, so the bytes
// the officer would have downloaded are the bytes this suite reads.
const downloads = [];
globalThis.Blob = class {
  constructor(parts) {
    this.text = parts.join('');
  }
};
// Added to the real URL rather than replacing it: fetch() needs the
// constructor, and a stand-in object here would take the whole suite offline.
URL.createObjectURL = (blob) => {
  downloads.push(blob.text);
  return 'blob:mock';
};
URL.revokeObjectURL = () => {};

const auth = await import('../src/auth.js');
const { select, patch, callRpc } = await import('../src/rest.js');
const csv = await import('../src/csv.js');
const { matchRoster, parsePastedNames } = await import('../src/roster.js');
const { RpcError } = await import('../src/errors.js');
const { start } = await import('../src/admin.js');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

const api = (path) => fetch(`http://localhost:${PORT}${path}`).then((r) => r.json());
const adminAudit = () => api('/__mock/audit').then((body) => body.admin);

async function signInAs(email) {
  auth.forgetSession();
  await auth.sendMagicLink(email, `http://localhost:${PORT}/admin/`);
  const { url } = await api(`/__mock/magic-link?email=${encodeURIComponent(email)}`);
  const parsed = auth.parseAuthRedirect(url);
  assert.ok(parsed?.session, `no session in the sign-in link for ${email}`);
  auth.adoptSession(parsed.session);
  return parsed.session;
}

/** Waits for the screen to settle, rather than for a fixed number of turns. */
async function until(predicate, message, timeout = 4000) {
  const stop = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > stop) throw new Error(`timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const server = await startMock(PORT);
await api('/__mock/reset');

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const sources = {
  'src/progress.js': await readFile(`${WEB_ROOT}src/progress.js`, 'utf8'),
  'src/roster.js': await readFile(`${WEB_ROOT}src/roster.js`, 'utf8'),
  'src/member.js': await readFile(`${WEB_ROOT}src/member.js`, 'utf8'),
  'src/joined.js': await readFile(`${WEB_ROOT}src/joined.js`, 'utf8'),
  'src/csv.js': await readFile(`${WEB_ROOT}src/csv.js`, 'utf8'),
  'src/retro.js': await readFile(`${WEB_ROOT}src/retro.js`, 'utf8'),
};

await check('no em dash in anything these screens are made of', async () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    ...sources,
    'src/admin.js': await readFile(`${WEB_ROOT}src/admin.js`, 'utf8'),
    'admin/index.html': adminHtml,
    'assets/css/admin.css': adminCss,
    'mock/dom.mjs': await readFile(`${WEB_ROOT}mock/dom.mjs`, 'utf8'),
    'mock/admin-server.mjs': await readFile(`${WEB_ROOT}mock/admin-server.mjs`, 'utf8'),
    'mock/verify-board.mjs': await readFile(new URL(import.meta.url), 'utf8'),
  };
  for (const [label, source] of Object.entries(files)) {
    assert.ok(!source.includes(emDash), `${label} contains an em dash`);
  }
});

/** Every string literal that is plainly copy rather than an identifier. */
function uiStrings(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const found = [];
  for (const pattern of [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g, /`((?:[^`\\]|\\.)*)`/g]) {
    for (const match of withoutComments.matchAll(pattern)) {
      const text = match[1];
      if (!text) continue;
      if (!/\s/.test(text) && !/[A-Z]/.test(text)) continue;
      found.push(text);
    }
  }
  return found;
}

await check('the database vocabulary never reaches these screens', () => {
  const banned = ['node', 'nodes', 'threshold', 'schema', 'RLS', 'PostgREST', 'uuid', 'jsonb', 'foreign key'];
  const copy = [
    ...Object.entries(sources).flatMap(([label, source]) =>
      uiStrings(source).map((text) => [label, text]),
    ),
    ['admin/index.html', adminHtml.replace(/<!--[\s\S]*?-->/g, ' ')],
  ];
  for (const [label, text] of copy) {
    for (const word of banned) {
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i'),
        `${label} shows the word "${word}": ${JSON.stringify(text.slice(0, 90))}`,
      );
    }
  }
});

await check('every column of digits is tabular', () => {
  // The whole product is a spreadsheet replacement, and a proportional 1 in a
  // column of 9s is the difference between scanning and reading.
  for (const selector of ['.board', '.member-points', '.check-figures', '.progress-value', '.record-date']) {
    const block = new RegExp(`\\${selector}\\s*\\{[^}]*font-variant-numeric:\\s*tabular-nums`);
    assert.match(adminCss, block, `${selector} does not line its digits up`);
  }
});

await check('the sticky heading and the sticky targets under it cannot drift apart', () => {
  // The board scrolls under two stacked sticky rows. The second one's offset IS
  // the first one's height, and nothing in CSS enforces that: change the
  // heading's padding alone and the targets strip either covers the headings or
  // leaves a stripe of rows showing through between them, on scroll only, which
  // is exactly the kind of thing nobody sees until an officer scrolls.
  const header = /\.board thead th\s*\{([^}]*)\}/.exec(adminCss);
  const targets = /\.board-targets td\s*\{([^}]*)\}/.exec(adminCss);
  assert.ok(header && targets, 'the two sticky rules are not both there');

  const height = /height:\s*([\d.]+)rem/.exec(header[1]);
  const top = /top:\s*([\d.]+)rem/.exec(targets[1]);
  assert.ok(height, 'the heading row has no fixed height, so the offset below cannot be right');
  assert.ok(top, 'the targets strip has no offset, so it will cover the headings');
  assert.equal(top[1], height[1], `the targets sit at ${top[1]}rem under a ${height[1]}rem heading`);
});

await check('the honorary star is gold as a fill, never as ink', () => {
  // #e6c845 is 1.57:1 on the page, so a gold glyph is unreadable. The star is
  // dark ink on a gold pill instead. goldMisuse() in verify-admin.mjs holds the
  // general line; this holds the two places on these screens.
  for (const name of ['.board-star', '.member-badge']) {
    const rule = new RegExp(`\\${name}\\s*\\{([^}]*)\\}`).exec(adminCss);
    assert.ok(rule, `no ${name} rule`);
    assert.match(rule[1], /background:\s*var\(--gold\)/, `${name} does not fill with the gold`);
    assert.match(rule[1], /color:\s*var\(--gold-ink\)/, `${name} does not draw its glyph in the gold ink`);
  }
});

await check('nothing under src computes a point total or an honorary flag', () => {
  // The one check that stands between this product and invariant 2. Both
  // numbers are read from v_member_status and rendered; there is no summation
  // over categories anywhere in the client, and no comparison that decides
  // whether somebody is honorary.
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      source,
      /is_honorary\s*=[^=]/,
      `${label} assigns is_honorary rather than reading it`,
    );
    assert.doesNotMatch(
      source,
      /point_total\s*[+-]?=[^=]/,
      `${label} computes a point total`,
    );
    assert.doesNotMatch(
      source,
      /counts_toward_point_total\s*\)?\s*(\?|&&|\|\||===)/,
      `${label} branches on which categories count, which is the database's job`,
    );
  }
  assert.match(sources['src/progress.js'], /select\('v_member_status'/);
  assert.match(sources['src/member.js'], /callRpc\('fn_member_requirement_status'/);
});

await check('no module on these screens writes a record status directly', () => {
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      source,
      /patch\(\s*['"]attendance_records['"]/,
      `${label} writes attendance_records directly instead of going through review_records()`,
    );
    assert.doesNotMatch(
      source,
      /status:\s*['"]approved['"]/,
      `${label} writes an approved status of its own`,
    );
  }
  // A record filed by hand is filed pending and approved through the RPC, so
  // the reviewer and the audit row are stamped exactly as a scanned one.
  assert.match(sources['src/member.js'], /callRpc\(\s*'review_records'/);
  assert.match(sources['src/member.js'], /source:\s*'officer_entry'/);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nreading a CSV\n');
// ---------------------------------------------------------------------------

await check('a quoted field survives a comma, a quote and a newline', () => {
  const rows = csv.parseCsv('a,"b,c","say ""hi""","two\nlines"\r\nd,e,f,g\r\n');
  assert.deepEqual(rows[0], ['a', 'b,c', 'say "hi"', 'two\nlines']);
  assert.deepEqual(rows[1], ['d', 'e', 'f', 'g']);
  assert.equal(rows.length, 2, 'a trailing newline made an empty row');
});

await check('a header written any of the ways a person writes it is accepted', () => {
  const { people, problem } = csv.readRoster('First Name,Last-Name\nAbby,Catto\n');
  assert.equal(problem, null);
  assert.deepEqual(people, [{ first_name: 'Abby', last_name: 'Catto', row: 2 }]);
});

await check('a column this product no longer has is ignored, not refused', () => {
  // Last year's export still carries an address, and a file that will not load
  // because of a column nothing reads would be a refusal for its own sake.
  const { people, problem } = csv.readRoster(
    'first_name,last_name,email\nAbby,Catto,407-555-0100\n',
  );
  assert.equal(problem, null, 'a file with an email column was refused');
  assert.deepEqual(people, [{ first_name: 'Abby', last_name: 'Catto', row: 2 }]);
});

await check('a file without the columns it needs says which ones', () => {
  const { problem } = csv.readRoster('name,email\nAbby Catto,a@b.com\n');
  assert.ok(problem);
  assert.match(problem.title, /column/i);
  assert.match(problem.body, /first_name/);
  assert.match(problem.body, /last_name/);
});

await check('a row with half a name stops the file and names the row', () => {
  // Same line scripts/import_roster.py holds: a roster that is half loaded is
  // worse than one that is not loaded.
  const { people, problem } = csv.readRoster('first_name,last_name\nAbby,Catto\nAaron,\n');
  assert.deepEqual(people, []);
  assert.match(problem.title, /Row 3/);
});

await check('the same name twice in one file is one person', () => {
  const { people, skipped } = csv.readRoster(
    ['first_name,last_name', 'Abby,Catto', 'Abigail,Catto', 'Aaron,Ozan', 'Aaron,Ozan'].join('\n'),
  );
  assert.deepEqual(
    people.map((row) => `${row.first_name} ${row.last_name}`),
    ['Abby Catto', 'Abigail Catto', 'Aaron Ozan'],
    'two different names were folded together, or one name was let through twice',
  );
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /name/i);
});

await check('an exported cell cannot become a spreadsheet formula', () => {
  // A surname somebody typed with a leading hyphen is a name, not an
  // instruction to Excel.
  const text = csv.toCsv([['name'], ['=1+1'], ['-Ortiz'], ['Plain, Name']]);
  assert.match(text, /'=1\+1/);
  assert.match(text, /'-Ortiz/);
  assert.match(text, /"Plain, Name"/);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nmatching an import against the roster\n');
// ---------------------------------------------------------------------------

const ROSTER = [
  { id: 'a', display_name: 'Abigail Catto' },
  { id: 'c', display_name: 'Catherine Diaz' },
  { id: 'd', display_name: 'Aaron Ozan' },
];

await check('the same name is the same person', () => {
  const [row] = matchRoster([{ first_name: 'Aaron', last_name: 'Ozan', row: 2 }], ROSTER);
  assert.equal(row.verdict, 'exact');
  assert.equal(row.match.id, 'd');
});

await check('a close spelling is a question, never an answer', () => {
  const [row] = matchRoster([{ first_name: 'Abby', last_name: 'Cato', row: 2 }], ROSTER);
  assert.equal(row.verdict, 'fuzzy', 'a near miss was decided rather than asked about');
  assert.equal(row.match.display_name, 'Abigail Catto');
  assert.match(row.why, /%/);
});

await check('nobody close is a new member', () => {
  const [row] = matchRoster([{ first_name: 'Tobias', last_name: 'Renner', row: 2 }], ROSTER);
  assert.equal(row.verdict, 'new');
  assert.equal(row.match, null);
});

// ---------------------------------------------------------------------------
process.stdout.write('\na pasted list of names\n');
// ---------------------------------------------------------------------------
// The paste box is how a roster will actually be built, so every way a block of
// names arrives wrong is a way to write the wrong person to the database.

await check('bullets, numbering and a trailing comma are read, not refused', () => {
  const { people, unusable } = parsePastedNames(
    ['- Marcus Bell', '1. Grace Okonkwo', '* Aisha Rahman,', '', '   '].join('\n'),
  );
  assert.deepEqual(
    people.map((row) => `${row.first_name} ${row.last_name}`),
    ['Marcus Bell', 'Grace Okonkwo', 'Aisha Rahman'],
  );
  assert.deepEqual(unusable, [], 'a line a person would call a name was rejected');
});

await check('a spreadsheet wrote it surname first, and it is the same person', () => {
  const { people, repeated } = parsePastedNames(['Marcus Bell', 'Bell, Marcus'].join('\n'));
  assert.deepEqual(people, [{ first_name: 'Marcus', last_name: 'Bell', row: 1 }]);
  assert.equal(repeated.length, 1, 'the same person came through twice');
});

await check('a surname of several words survives', () => {
  const { people } = parsePastedNames('Maria de la Cruz');
  assert.deepEqual(people, [{ first_name: 'Maria', last_name: 'de la Cruz', row: 1 }]);
});

await check('one word is not a name, and it is reported rather than dropped', () => {
  const { people, unusable } = parsePastedNames('Bob');
  assert.deepEqual(people, []);
  assert.equal(unusable.length, 1);
  assert.equal(unusable[0].raw, 'Bob');
  assert.match(unusable[0].why, /first and last/i);
});

await check('every pasted line is accounted for exactly once', () => {
  // The report adds up to the number in its own heading, which is the only
  // reason an officer can trust it.
  const lines = ['Marcus Bell', 'Bell, Marcus', 'Bob', 'Grace Okonkwo'];
  const { people, repeated, unusable } = parsePastedNames(lines.join('\n'));
  assert.equal(people.length + repeated.length + unusable.length, lines.length);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe board an officer opens\n');
// ---------------------------------------------------------------------------

await signInAs('sara@pdsaucf.com');
start();

await until(() => !dom.$('view-app').hidden, 'the shell never signed in');
dom.click(dom.$('tab-progress'));
await until(() => dom.$('progress-table').querySelectorAll('tr').length > 2, 'the board never drew');

const board = dom.$('progress-table');
const headings = () =>
  board.querySelectorAll('thead tr')[0].querySelectorAll('th').map((cell) => cell.textContent.trim());
const bodyRows = () => board.querySelectorAll('tbody tr');
const rowFor = (name) =>
  bodyRows().find((row) => row.querySelectorAll('th')[0].textContent.trim() === name) ?? null;
const cellsOf = (row) => row.querySelectorAll('td');

const serverStatus = new Map(
  (
    await select('v_member_status', {
      select: 'member_id,point_total,is_honorary',
      filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
    })
  ).map((row) => [row.member_id, row]),
);

await check('the board is a row per member and a column per category', async () => {
  const names = headings();
  assert.equal(names[0], 'Member');
  assert.equal(names[1], 'Points');
  assert.equal(names[names.length - 1], 'Honorary');

  const categories = await select('categories', { select: 'id,name,archived_at', order: 'sort_order.asc' });
  const drawn = names.slice(2, -1);
  assert.ok(drawn.length >= 8, `only ${drawn.length} category columns`);
  for (const name of drawn) {
    assert.ok(
      categories.some((row) => row.name === name),
      `the board drew a column called "${name}" that is not a category`,
    );
  }
  assert.equal(bodyRows().length, serverStatus.size, 'the board and the roster disagree on who is on it');
});

await check('every point total on screen is the one the server sent', () => {
  const seen = new Map();
  for (const row of bodyRows()) {
    const name = row.querySelectorAll('th')[0].textContent.trim();
    seen.set(name, Number(cellsOf(row)[0].textContent.trim()));
  }
  assert.ok(seen.size > 40, `only ${seen.size} rows to compare`);

  // Matched by name through the roster, because the board renders names and
  // the view returns ids.
  const byId = new Map([...serverStatus].map(([id, row]) => [id, row]));
  for (const rowNode of bodyRows()) {
    const id = rowNode.dataset.member;
    const expected = Number(byId.get(id).point_total);
    const drawn = Number(cellsOf(rowNode)[0].textContent.trim());
    assert.equal(drawn, expected, `${rowNode.querySelectorAll('th')[0].textContent} shows ${drawn}, the server says ${expected}`);
  }
});

await check('the star is on exactly the members the server calls honorary', () => {
  const drawn = new Set();
  for (const row of bodyRows()) {
    const last = cellsOf(row)[cellsOf(row).length - 1];
    if (last.textContent.includes('★')) drawn.add(row.dataset.member);
  }
  const expected = new Set(
    [...serverStatus].filter(([, row]) => row.is_honorary).map(([id]) => id),
  );
  assert.ok(expected.size > 0, 'the fixture has nobody honorary, so this proves nothing');
  assert.deepEqual([...drawn].sort(), [...expected].sort());
});

await check('every point total on the board is the one Postgres holds', async () => {
  // WHAT THIS CHECK USED TO BE, AND WHY IT CHANGED. It asserted that the visible
  // columns deliberately DID NOT add up to the visible total, for more than
  // twenty members. That disagreement was Volunteering: its hours were shown in
  // a column and excluded from the total, because adding 29.5 hours to a count
  // of events is not a number (docs/00-spreadsheet-findings.md, finding 4). A
  // board that summed its own columns therefore could not agree with the club's
  // real Total column, and the disagreement was the proof.
  //
  // Migration 22 removed both the unit and the flag: there is one unit, every
  // category's credit is points, and the columns now add up to the total by
  // construction. So that proof is gone, and this is what replaces it: the total
  // on every row is compared against v_member_status, member by member. A board
  // that summed its own columns would pass this on today's data and fail the
  // moment any credit exists that the visible columns cannot see, which is what
  // retiring a category mid-year does. The source scan above is the other half.
  const held = new Map(
    (
      await select('v_member_status', {
        select: 'member_id,point_total',
        filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
      })
    ).map((row) => [row.member_id, Number(row.point_total)]),
  );

  let compared = 0;
  for (const row of bodyRows()) {
    const drawn = Number(cellsOf(row)[0].textContent.trim());
    const server = held.get(row.dataset.member);
    assert.equal(
      drawn,
      server,
      `${row.querySelectorAll('th')[0].textContent.trim()} is drawn ${drawn} and the server says ${server}`,
    );
    compared += 1;
  }
  assert.ok(compared > 20, `only ${compared} rows were compared, so the board is not drawn`);
});

await check('a category threshold met shows as met, and one short of it does not', async () => {
  const totals = await select('v_member_category_totals', {
    select: 'member_id,category_id,total',
    filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
  });
  const nodes = await select('requirement_nodes', {
    select: 'min_value,type,requirement_node_categories(category_id)',
    filters: { requirement_set_id: `eq.${IDS.SET_CURRENT}`, type: 'eq.threshold' },
  });
  const target = new Map();
  for (const node of nodes) {
    const links = node.requirement_node_categories ?? [];
    if (links.length === 1) target.set(links[0].category_id, Number(node.min_value));
  }

  const categories = await select('categories', { select: 'id,name', order: 'sort_order.asc' });
  const columnOf = new Map();
  headings().forEach((name, index) => columnOf.set(name, index - 1)); // td index

  let met = 0;
  let short = 0;
  for (const row of totals) {
    const category = categories.find((c) => c.id === row.category_id);
    const column = columnOf.get(category?.name);
    const wanted = target.get(row.category_id);
    if (column === undefined || wanted === undefined) continue;

    const node = bodyRows().find((candidate) => candidate.dataset.member === row.member_id);
    if (!node) continue;
    const cell = cellsOf(node)[column];
    const shouldBeMet = Number(row.total) >= wanted;
    assert.equal(
      cell.dataset.met,
      String(shouldBeMet),
      `${category.name} is ${row.total} against ${wanted} and the cell says met=${cell.dataset.met}`,
    );
    assert.equal(
      cell.textContent.includes('✓'),
      shouldBeMet,
      `${category.name} at ${row.total} of ${wanted} has the wrong tick`,
    );
    if (shouldBeMet) met += 1;
    else short += 1;
  }
  assert.ok(met > 10 && short > 10, `only ${met} met and ${short} short, so this proves little`);
});

await check('the target under a column is the published rule, not a constant', () => {
  const targets = board
    .querySelectorAll('.board-targets td')
    .map((cell) => cell.textContent.trim());
  const names = headings();

  const gbms = names.indexOf('GBMs');
  assert.equal(targets[gbms], 'of 9', 'the GBMs column does not carry the published number');
  assert.equal(targets[names.indexOf('Volunteering')], 'of 25');
  assert.equal(targets[names.indexOf('Tabling')], 'of 2');

  // Journal Club is measured only together with Media Speaking, so it has no
  // threshold of its own. Inventing one would tell an officer something the
  // rules do not say.
  assert.equal(
    targets[names.indexOf('Journal Club')],
    '',
    'a category with no rule of its own was given a target anyway',
  );
});

await check('changing the rule moves the board, with no deploy', async () => {
  const names = headings();
  const column = names.indexOf('GBMs');
  const before = bodyRows().filter((row) => cellsOf(row)[column - 1].dataset.met === 'true').length;
  assert.ok(before > 0 && before < bodyRows().length, `the baseline cannot move: ${before}`);

  // Only an admin may edit a published set, which is the whole draft lifecycle.
  await signInAs('ben@pdsaucf.com');
  const edited = await patch(
    'requirement_nodes',
    { id: `eq.${IDS.NODES.gbms}` },
    { min_value: 3 },
  );
  assert.equal(edited.length, 1, 'the rule could not be changed');

  await reloadBoard();
  const after = bodyRows().filter((row) => cellsOf(row)[column - 1].dataset.met === 'true').length;
  const targets = board.querySelectorAll('.board-targets td').map((cell) => cell.textContent.trim());
  assert.equal(targets[column], 'of 3', 'the column heading kept the old number');
  assert.ok(after > before, `the board did not move: ${before} then ${after}`);

  await patch('requirement_nodes', { id: `eq.${IDS.NODES.gbms}` }, { min_value: 9 });
  await signInAs('sara@pdsaucf.com');
  await reloadBoard();
  assert.equal(
    bodyRows().filter((row) => cellsOf(row)[column - 1].dataset.met === 'true').length,
    before,
    'putting the rule back did not put the board back',
  );
});

/** What the year selector does, which is the only control that reloads it. */
async function reloadBoard() {
  const drawnBefore = board.querySelectorAll('tbody tr').length;
  const select = dom.$('year-select');
  select.value = IDS.YEAR_PAST;
  dom.fire(select, 'change');
  await until(() => board.querySelectorAll('tbody tr').length !== drawnBefore || !dom.$('empty-progress').hidden, 'the board never changed year');
  select.value = IDS.YEAR_CURRENT;
  dom.fire(select, 'change');
  await until(() => board.querySelectorAll('tbody tr').length === drawnBefore, 'the board never came back');
}

await check('the honorary filter narrows the board to the members with a star', async () => {
  const filter = dom.$('progress-filter');
  const all = bodyRows().length;
  filter.value = 'honorary';
  dom.fire(filter, 'change');

  const shown = bodyRows();
  const expected = [...serverStatus].filter(([, row]) => row.is_honorary).length;
  assert.equal(shown.length, expected, `the filter shows ${shown.length} of an expected ${expected}`);
  assert.ok(shown.length < all, 'the filter changed nothing');
  for (const row of shown) {
    assert.ok(cellsOf(row)[cellsOf(row).length - 1].textContent.includes('★'));
  }

  filter.value = 'all';
  dom.fire(filter, 'change');
  assert.equal(bodyRows().length, all);
});

await check('search narrows the board by name', () => {
  const search = dom.$('progress-search');
  const all = bodyRows().length;
  search.value = 'catto';
  dom.fire(search, 'input');
  const shown = bodyRows().map((row) => row.querySelectorAll('th')[0].textContent.trim());
  assert.ok(shown.length && shown.length < all);
  for (const name of shown) assert.match(name, /Catto/i);

  search.value = '';
  dom.fire(search, 'input');
  assert.equal(bodyRows().length, all);
});

await check('Export CSV carries exactly what is on screen, in the order it is on screen', () => {
  downloads.length = 0;
  dom.click(dom.$('progress-export'));
  assert.equal(downloads.length, 1, 'nothing was exported');

  const parsed = csv.parseCsv(downloads[0]);
  const header = parsed[0];
  assert.deepEqual(header.slice(0, 2), ['Member', 'Points']);
  assert.deepEqual(header.slice(2, -1), headings().slice(2, -1), 'the columns differ from the board');

  const rows = parsed.slice(1);
  assert.equal(rows.length, bodyRows().length, 'the export has a different number of members');

  bodyRows().forEach((node, index) => {
    const line = rows[index];
    const cells = cellsOf(node);
    assert.equal(line[0], node.querySelectorAll('th')[0].textContent.trim(), 'the order differs');
    assert.equal(line[1], cells[0].textContent.trim(), `${line[0]} exported a different point total`);
    for (let i = 1; i < cells.length - 1; i += 1) {
      assert.equal(
        line[1 + i],
        cells[i].querySelector('.board-value').textContent.trim(),
        `${line[0]} exported a different figure in column ${i}`,
      );
    }
    const starred = cells[cells.length - 1].textContent.includes('★');
    assert.equal(line[line.length - 1], starred ? 'yes' : 'no');
  });
});

await check('a filtered board exports the filtered rows and nothing else', () => {
  const filter = dom.$('progress-filter');
  filter.value = 'honorary';
  dom.fire(filter, 'change');

  downloads.length = 0;
  dom.click(dom.$('progress-export'));
  const rows = csv.parseCsv(downloads[0]).slice(1);
  assert.equal(rows.length, bodyRows().length);
  for (const row of rows) assert.equal(row[row.length - 1], 'yes');

  filter.value = 'all';
  dom.fire(filter, 'change');
});

// ---------------------------------------------------------------------------
process.stdout.write('\none member, in full\n');
// ---------------------------------------------------------------------------

const AARON = 'm0000000-0000-4000-a000-000000000004';

await check('clicking a name opens that member', async () => {
  const row = bodyRows().find((candidate) => candidate.dataset.member === AARON);
  assert.ok(row, 'Aaron Ozan is not on the board');
  dom.click(row.querySelector('.board-name'));

  await until(() => !dom.$('member-body').hidden, 'the member screen never drew');
  assert.equal(dom.$('member-name').textContent.trim(), 'Aaron Ozan');
  assert.ok(dom.$('panel-progress').hidden, 'the board stayed on screen underneath');
});

await check('the points and the star agree with the board', () => {
  const expected = serverStatus.get(AARON);
  assert.equal(Number(dom.$('member-points').textContent.trim()), Number(expected.point_total));
  assert.equal(dom.$('member-honorary').hidden, !expected.is_honorary);
});

await check('the checklist is the requirement engine, not a second opinion', async () => {
  const status = (
    await select('v_member_status', {
      select: 'member_id,is_honorary,requirement_set_id',
      filters: { member_id: `eq.${AARON}`, academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
    })
  )[0];
  const rows = await callRpc('fn_member_requirement_status', {
    p_member_id: AARON,
    p_requirement_set_id: status.requirement_set_id,
  });
  assert.ok(rows.length > 3, 'the rule has too few requirements to check');

  const drawn = dom.$('member-checklist').querySelectorAll('.check-row');
  // The root is the whole rule and is already said by the star, so the list is
  // everything under it.
  assert.equal(drawn.length, rows.length - 1, 'the checklist and the engine disagree on how many requirements there are');

  for (const node of drawn) {
    const label = node.querySelector('.check-label').textContent.trim();
    const row = rows.find((candidate) => candidate.label === label);
    assert.ok(row, `the checklist shows "${label}", which the engine never returned`);
    assert.equal(
      node.dataset.passed,
      String(row.passed),
      `${label} is drawn as ${node.dataset.passed} and the engine says ${row.passed}`,
    );
    assert.equal(
      node.querySelector('.check-figures').textContent.trim(),
      `${Number(row.value)} of ${Number(row.target)}`,
    );
  }

  // And the verdict on the whole rule is the star the board drew.
  const root = rows.find((row) => row.parent_id === null);
  assert.equal(root.passed, Boolean(status.is_honorary));
});

await check('the record log says what it was for, where it came from and who decided it', () => {
  const rows = dom.$('member-records').querySelectorAll('tr');
  assert.ok(rows.length > 2, `only ${rows.length} records`);

  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    assert.equal(cells.length, 6);
    assert.ok(cells[0].textContent.trim(), 'a record with no event on it');
    assert.ok(cells[1].textContent.trim(), 'a record with no date on it');
    assert.match(cells[3].textContent.trim(), /Scanned|Added by an officer|Imported|Member portal/);
  }

  // The declined one carries the reason. Six months later "why doesn't Aaron
  // have credit for the March GBM" has an answer on this screen.
  const declined = rows.find((row) => row.dataset.status === 'rejected');
  assert.ok(declined, 'the fixture no longer has a declined record for this member');
  assert.match(declined.textContent, /Declined/);
  assert.match(declined.textContent, /car park/);
});

await check('an officer adds a record by hand, and it goes through the same approval', async () => {
  const before = Number(dom.$('member-points').textContent.trim());
  const callsBefore = (await adminAudit()).calls.length;

  dom.click(dom.$('member-add-record'));
  await until(() => dom.$('record-event').children.length > 0, 'the event list never filled');

  const option = dom
    .$('record-event')
    .children.find((node) => node.textContent.includes('Soap Carving'));
  assert.ok(option, 'Soap Carving is not offered');
  dom.$('record-event').value = option.value;
  dom.fire(dom.$('record-event'), 'change');
  dom.fire(dom.$('record-form'), 'submit');

  await until(
    () => Number(dom.$('member-points').textContent.trim()) !== before,
    'the point total never moved',
  );

  const after = Number(dom.$('member-points').textContent.trim());
  assert.equal(after, before + 1, `points went from ${before} to ${after}`);

  const calls = (await adminAudit()).calls.slice(callsBefore);
  const inserted = calls.find((call) => call.fn === 'insert.attendance_records');
  const reviewed = calls.find((call) => call.fn === 'review_records');
  assert.ok(inserted, 'no record was filed');
  assert.ok(reviewed, 'the record was never put through review_records()');
  assert.equal(reviewed.decision, 'approve');
  assert.equal(
    calls.some((call) => call.fn === 'patch.attendance_records'),
    false,
    'the screen wrote a status straight onto the record',
  );

  const filed = (await adminAudit()).attendance.find(
    (row) => row.member_id === AARON && row.event_id === IDS.EVENT_SOAP,
  );
  assert.equal(filed.status, 'approved');
  assert.equal(filed.reviewed_by, IDS.USERS.officer, 'nobody is on the hook for the record');

  // It is on the log as an officer's entry, not as a scan.
  const row = dom
    .$('member-records')
    .querySelectorAll('tr')
    .find((node) => node.textContent.includes('Soap Carving'));
  assert.ok(row);
  assert.match(row.textContent, /Added by an officer/);
});

await check('Back returns to the board it was opened from', async () => {
  dom.click(dom.$('member-back'));
  assert.ok(dom.$('panel-member').hidden);
  assert.ok(!dom.$('panel-progress').hidden);
  await until(() => bodyRows().length > 0, 'the board did not come back');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe roster\n');
// ---------------------------------------------------------------------------

dom.click(dom.$('tab-roster'));
await until(() => dom.$('roster-rows').querySelectorAll('tr').length > 0, 'the roster never drew');

const rosterRows = () => dom.$('roster-rows').querySelectorAll('tr');

await check('the roster is this year, searchable', () => {
  const all = rosterRows().length;
  assert.ok(all > 40, `only ${all} on the roster`);

  const search = dom.$('roster-search');
  search.value = 'catto';
  dom.fire(search, 'input');
  const shown = rosterRows();
  assert.ok(shown.length && shown.length < all);
  for (const row of shown) assert.match(row.textContent, /Catto/i);

  search.value = '';
  dom.fire(search, 'input');
  assert.equal(rosterRows().length, all);
});

await check('the same member shows one join date on the roster and on their own screen', async () => {
  // THE SAME LABEL ABOUT THE SAME PERSON, ONE CLICK APART. "Joined" is the
  // earliest enrollment across every year, falling back to when the row was
  // created, which is what v_possible_duplicate_members.joined_a carries and
  // what the roster column shows. A detail screen showing the date somebody
  // was enrolled for THIS year is a second answer to "who has been here
  // longer", which is the question a merge turns on.
  //
  // Read off the rendered cells rather than off the two queries, because it is
  // the contradiction on screen that does the damage.
  const enrollments = await select('member_enrollments', {
    select: 'member_id,academic_year_id,joined_on',
    filters: { member_id: `eq.${IDS.MEMBER_ABIGAIL}` },
  });
  assert.ok(
    enrollments.length > 1,
    'Abigail Catto is no longer on more than one year, so this proves nothing',
  );
  const thisYear = enrollments.find((row) => row.academic_year_id === IDS.YEAR_CURRENT);
  const earliest = enrollments.map((row) => row.joined_on).sort()[0];
  assert.notEqual(
    thisYear.joined_on,
    earliest,
    'both her enrollments are on the same date, so this proves nothing',
  );

  const row = rosterRows().find((node) => node.textContent.includes('Abigail Catto'));
  assert.ok(row, 'Abigail Catto is not on the roster');
  const onRoster = row.querySelectorAll('td')[3].textContent.trim();
  assert.ok(onRoster, 'the roster row carries no join date');

  dom.click(row.querySelector('.board-name'));
  await until(
    () => !dom.$('member-body').hidden && dom.$('member-name').textContent.trim() === 'Abigail Catto',
    'her own screen never drew',
  );

  const part = dom
    .$('member-meta')
    .textContent.split(' · ')
    .find((piece) => piece.startsWith('Joined '));
  assert.ok(part, 'her own screen carries no join date at all');
  const onDetail = part.slice('Joined '.length).trim();
  assert.equal(
    onDetail,
    onRoster,
    `Joined ${onDetail} on her own screen and ${onRoster} on the roster`,
  );

  dom.click(dom.$('member-back'));
  await until(() => !dom.$('panel-roster').hidden, 'Back did not return to the roster');
});

await check('Export CSV writes the two columns the import reads back', () => {
  downloads.length = 0;
  dom.click(dom.$('roster-export'));
  const { people, problem } = csv.readRoster(downloads[0]);
  assert.equal(problem, null, `the roster this screen exported cannot be imported: ${problem?.title}`);
  assert.equal(people.length, rosterRows().length, 'the export lost or gained somebody');

  const drawn = rosterRows().map((row) => row.querySelectorAll('td')[0].textContent.trim());
  const written = people.map((row) => `${row.first_name} ${row.last_name}`);
  assert.deepEqual(written, drawn, 'the export is not the roster on screen');
});

const IMPORT_CSV = [
  'first_name,last_name,email',
  'Abby,Cato,', // looks like Abigail Catto and like Abby Catto
  'Abigail,Catto,abigail.catto@knights.ucf.edu', // already here, by address
  'Tobias,Renner,tobias.renner@knights.ucf.edu', // genuinely new
  'Tobias,Renner,tobias.renner@knights.ucf.edu', // and the same row twice
].join('\n');

const chooseFile = async (text) => {
  const input = dom.$('import-file');
  input.files = [{ text: async () => text }];
  dom.fire(input, 'change');
  await until(() => !dom.$('import-table').hidden || !dom.$('import-problem').hidden, 'the preview never appeared');
};

await check('the preview catches the fuzzy match before anything is written', async () => {
  const membersBefore = (await adminAudit()).members.length;
  dom.click(dom.$('roster-import'));
  await chooseFile(IMPORT_CSV);

  const rows = dom.$('import-rows').querySelectorAll('tr');
  assert.equal(rows.length, 3, 'the within-file duplicate was not dropped before the preview');

  const fuzzy = rows.find((row) => row.dataset.verdict === 'fuzzy');
  assert.ok(fuzzy, 'Abby Cato was not flagged as looking like somebody already here');
  assert.match(fuzzy.textContent, /Catto/, 'the preview does not say who it looks like');
  assert.match(fuzzy.textContent, /Needs a decision/);

  assert.equal(
    rows.find((row) => row.textContent.includes('Abigail'))?.dataset.verdict,
    'exact',
    'somebody already on the roster was going to be created again',
  );
  assert.equal(rows.find((row) => row.textContent.includes('Tobias'))?.dataset.verdict, 'new');

  // AND NOTHING HAS BEEN WRITTEN.
  assert.equal((await adminAudit()).members.length, membersBefore, 'the preview wrote to the roster');
});

await check('the import cannot be run while a row is unanswered', () => {
  assert.equal(dom.$('import-run').disabled, true, 'an undecided row could be imported');
  assert.match(dom.$('import-summary').textContent, /1 to decide/);
});

await check('answering the question is what unlocks it', async () => {
  const fuzzy = dom
    .$('import-rows')
    .querySelectorAll('tr')
    .find((row) => row.dataset.verdict === 'fuzzy');
  const link = dom.buttonNamed(fuzzy, 'Link member');
  assert.ok(link, 'the preview offers no way to say it is the same person');
  assert.ok(dom.buttonNamed(fuzzy, 'Add as new'), 'the preview offers no way to say it is somebody new');

  dom.click(link);
  assert.equal(dom.$('import-run').disabled, false, 'the import stayed locked after the row was answered');
});

await check('running it creates only the people nobody had', async () => {
  const before = (await adminAudit()).members;
  const rosterBefore = rosterRows().length;

  dom.fire(dom.$('import-form'), 'submit');
  await until(() => rosterRows().length !== rosterBefore, 'the roster never grew');

  const after = (await adminAudit()).members;
  const created = after.filter((row) => !before.some((old) => old.id === row.id));
  assert.deepEqual(
    created.map((row) => row.display_name),
    ['Tobias Renner'],
    'the import created somebody it should not have',
  );

  // Abby Cato was answered as Abigail Catto, who was already enrolled, so the
  // roster grew by exactly the one new person.
  assert.equal(rosterRows().length, rosterBefore + 1);
});

await check('a member from a previous year is enrolled, never written down twice', async () => {
  // THE ONE A YEAR-FILTERED MATCHER CANNOT SEE. Rowan Vance is on the roster
  // from last year and has no row for this one, so a matcher built from this
  // year's enrollments finds nobody and the import treats them as new. Their
  // address is taken, so that either fails the whole run on the unique index
  // or, for a row with no address, quietly files a second person.
  const before = (await adminAudit()).members;
  const rosterBefore = rosterRows().length;

  assert.equal(
    before.filter((row) => row.display_name === 'Rowan Vance').length,
    1,
    'the fixture no longer holds exactly one returning member',
  );
  assert.equal(
    rosterRows().some((row) => row.textContent.includes('Rowan Vance')),
    false,
    'the returning member is already on this years roster, so this proves nothing',
  );

  dom.click(dom.$('roster-import'));
  await chooseFile('first_name,last_name,email\nRowan,Vance,rowan.vance@knights.ucf.edu\n');

  const [row] = dom.$('import-rows').querySelectorAll('tr');
  assert.equal(row.dataset.verdict, 'exact', 'somebody here since last year was going to be created');
  assert.match(row.textContent, /Returning member/, 'the preview does not say what will happen');
  assert.match(dom.$('import-summary').textContent, /1 returning/);

  dom.fire(dom.$('import-form'), 'submit');
  await until(
    () => rosterRows().length === rosterBefore + 1,
    'the returning member never reached this years roster',
  );

  const after = (await adminAudit()).members;
  assert.equal(after.length, before.length, 'the import created a second row for somebody it had');
  assert.equal(after.filter((node) => node.display_name === 'Rowan Vance').length, 1);

  // On both years now, which is the point: last year's history is still theirs.
  const years = (await adminAudit()).enrollments
    .filter((entry) => entry.member_id === IDS.MEMBER_RETURNING)
    .map((entry) => entry.academic_year_id)
    .sort();
  assert.deepEqual(years, [IDS.YEAR_PAST, IDS.YEAR_CURRENT].sort());
});

await check('the whole file goes in one call, not one call per row', async () => {
  // THE REASON THIS CHANGED. The real file is 355 rows, and the loop this
  // replaced made 355 sequential round trips. A check that only counted rows
  // on the roster would pass either way, so what is asserted is the number of
  // calls the screen actually made.
  const file = [
    'first_name,last_name,email',
    'Ottoline,Fairbairn,ottoline.fairbairn@knights.ucf.edu',
    'Rafferty,Delacroix,rafferty.delacroix@knights.ucf.edu',
    'Sunniva,Haugland,sunniva.haugland@knights.ucf.edu',
  ].join('\n');

  const callsBefore = (await adminAudit()).calls.filter(
    (entry) => entry.fn === 'upsert_members_and_enroll' && entry.rows !== undefined,
  ).length;
  const rosterBefore = rosterRows().length;

  dom.click(dom.$('roster-import'));
  await chooseFile(file);
  dom.fire(dom.$('import-form'), 'submit');
  await until(() => rosterRows().length === rosterBefore + 3, 'the roster never grew by three');

  const batches = (await adminAudit()).calls.filter(
    (entry) => entry.fn === 'upsert_members_and_enroll' && entry.rows !== undefined,
  );
  assert.equal(batches.length, callsBefore + 1, 'three rows took more than one call');
  assert.equal(batches.at(-1).rows, 3);
  assert.equal(batches.at(-1).created, 3);
  assert.equal(batches.at(-1).refused, 0);
});

await check('a refused row is listed by line, and its neighbours are still written', async () => {
  // The property the batch buys back. One bad row used to be the end of the
  // run; it is now a line the officer can go and fix, with the reason on it,
  // while everything else in the file lands.
  const before = (await adminAudit()).members.length;
  const rosterBefore = rosterRows().length;
  const file = [
    'first_name,last_name,email',
    'Anouk,Brightwater,anouk.brightwater@knights.ucf.edu',
    'Casimir,Odenkirk,casimir.odenkirk@knights.ucf.edu',
    'Delphine,Quintanar,delphine.quintanar@knights.ucf.edu',
  ].join('\n');

  // Line 3 of the file, which is Casimir Odenkirk.
  refuseImportRowOnce(3);

  dom.click(dom.$('roster-import'));
  await chooseFile(file);
  assert.equal(dom.$('import-run').disabled, false, 'a row in this file needs a decision');
  dom.fire(dom.$('import-form'), 'submit');
  await until(() => rosterRows().length === rosterBefore + 2, 'the run did not write the good rows');

  // The run is reported rather than thrown away: what landed on the strip,
  // what did not underneath it.
  assert.match(dom.$('screen-message-title').textContent, /2 members added/);
  assert.equal(dom.$('screen-message').dataset.tone, 'warn');

  assert.equal(dom.$('import-refused').hidden, false, 'the refused row was not shown anywhere');
  assert.match(dom.$('import-refused-title').textContent, /1 row refused/);
  const listed = dom.$('import-refused-list').querySelectorAll('li');
  assert.equal(listed.length, 1);
  assert.match(listed[0].textContent, /Row 3/, 'the refusal does not say which line of the file');
  assert.match(listed[0].textContent, /Casimir Odenkirk/);
  assert.match(listed[0].textContent, /archived/i, 'the refusal does not say what went wrong');

  const after = await adminAudit();
  assert.equal(after.members.length, before + 2, 'the refused row was written anyway');
  assert.equal(
    after.members.some((row) => row.display_name === 'Casimir Odenkirk'),
    false,
  );

  // Every member row written has an enrollment for the year. This is the state
  // two separate requests could leave behind and nothing repaired: a member
  // the roster cannot show, holding an address nobody else can be given.
  for (const name of ['Anouk Brightwater', 'Delphine Quintanar']) {
    const row = after.members.find((one) => one.display_name === name);
    assert.ok(
      after.enrollments.some(
        (entry) => entry.member_id === row.id && entry.academic_year_id === IDS.YEAR_CURRENT,
      ),
      `${name} was written with no enrollment for the year`,
    );
  }
});

await check('an import that dies converges on one row when it is run again', async () => {
  // A chunk is one call and one transaction, so a call that never lands writes
  // nothing at all rather than half of itself. What still has to hold is the
  // half after that: running the same file again finishes it without writing
  // anybody down twice.
  const before = (await adminAudit()).members.length;
  const rosterBefore = rosterRows().length;
  const file = [
    'first_name,last_name,email',
    'Bartek,Wozniak,bartek.wozniak@knights.ucf.edu',
    'Thandiwe,Mkhize,thandiwe.mkhize@knights.ucf.edu',
  ].join('\n');

  failRpcOnce('upsert_members_and_enroll');

  dom.click(dom.$('roster-import'));
  await chooseFile(file);
  assert.equal(dom.$('import-run').disabled, false, 'a row in this file needs a decision');
  dom.fire(dom.$('import-form'), 'submit');

  // The copy officer-errors.js gives a PDS03, so this waits for the failure
  // rather than for the message strip the previous check left on screen.
  await until(
    () => dom.$('screen-message-title').textContent === 'That was not accepted',
    'the failed run said nothing at all',
  );

  const half = await adminAudit();
  assert.equal(half.members.length, before, 'a call that failed still wrote somebody');
  assert.equal(rosterRows().length, rosterBefore, 'the roster grew on a call that failed');

  // Now run the same file again.
  dom.click(dom.$('roster-import'));
  await chooseFile(file);
  const rows = dom.$('import-rows').querySelectorAll('tr');
  assert.equal(
    rows.find((node) => node.textContent.includes('Bartek')).dataset.verdict,
    'new',
    'the failed run left Bartek Wozniak behind on the roster',
  );

  dom.fire(dom.$('import-form'), 'submit');
  await until(
    () => rosterRows().length === rosterBefore + 2,
    'the retry never finished the file',
  );

  const after = (await adminAudit()).members;
  assert.equal(
    after.length,
    before + 2,
    `${after.length - before} rows exist for the two people in that file`,
  );
  for (const name of ['Bartek Wozniak', 'Thandiwe Mkhize']) {
    assert.equal(after.filter((row) => row.display_name === name).length, 1, `two rows for ${name}`);
  }

  // And the refused list from the run before is gone, because this run had
  // nothing to refuse.
  assert.equal(dom.$('import-refused').hidden, true, 'a stale refusal is still on screen');
});

await check('a chunk that does not report every row is not reported as a success', async () => {
  // A short response is the shape a truncated body or a skipped row arrives
  // in. The rows may well have landed, and the client cannot tell, so the one
  // thing it must not do is count them as written and say the run is done. An
  // officer who cannot tell what landed is the failure this screen exists to
  // prevent.
  const before = (await adminAudit()).members.length;
  const file = [
    'first_name,last_name,email',
    'Yusra,Benhamou,yusra.benhamou@knights.ucf.edu',
    'Torfinn,Aasheim,torfinn.aasheim@knights.ucf.edu',
  ].join('\n');

  dropImportResultOnce();

  dom.click(dom.$('roster-import'));
  await chooseFile(file);
  assert.equal(dom.$('import-run').disabled, false, 'a row in this file needs a decision');
  dom.fire(dom.$('import-form'), 'submit');
  await until(
    () => /unknown/.test(dom.$('screen-message-title').textContent),
    'a short response was reported as a finished run',
  );

  // BOTH rows of the chunk are unknown, not just the missing one. A response
  // that does not line up row for row cannot be trusted to line up by index
  // either, so nothing in the chunk is claimed as written.
  const said = dom.$('screen-message-title').textContent;
  assert.match(said, /0 members added, 0 on the roster/, 'a short chunk was counted as written');
  assert.match(said, /2 rows unknown/, 'the officer is not told how many rows are unaccounted for');
  assert.match(said, /Import the file again/, 'the officer is not told what to do about it');
  assert.equal(dom.$('screen-message').dataset.tone, 'warn');

  // The unaccounted row is not filed as a refusal either: nothing is known
  // about it, and a line in the refused list would say the opposite.
  assert.equal(dom.$('import-refused').hidden, true, 'a row nobody heard about was listed as refused');

  // And doing what it says converges, because the import is idempotent.
  dom.click(dom.$('roster-import'));
  await chooseFile(file);
  dom.fire(dom.$('import-form'), 'submit');
  await until(
    () => /2 on the roster/.test(dom.$('screen-message-title').textContent),
    'the re-run never finished the file',
  );

  const after = (await adminAudit()).members;
  assert.equal(after.length, before + 2, 'the re-run wrote somebody a second time');
  for (const name of ['Yusra Benhamou', 'Torfinn Aasheim']) {
    assert.equal(after.filter((row) => row.display_name === name).length, 1, `two rows for ${name}`);
  }
});

await check('a fresh import does not open underneath the last one refusals', async () => {
  // QA walked this. An officer fixes the file, opens Import again, and the
  // previous run's line numbers are still on screen next to a preview of a
  // different file, which invites them to go and fix line 3 of the wrong one.
  const rosterBefore = rosterRows().length;
  refuseImportRowOnce(3);

  dom.click(dom.$('roster-import'));
  await chooseFile(
    [
      'first_name,last_name,email',
      'Eilidh,Kavanagh,eilidh.kavanagh@knights.ucf.edu',
      'Ruaridh,Blackwood,ruaridh.blackwood@knights.ucf.edu',
    ].join('\n'),
  );
  assert.equal(dom.$('import-run').disabled, false, 'a row in this file needs a decision');
  dom.fire(dom.$('import-form'), 'submit');
  await until(() => rosterRows().length === rosterBefore + 1, 'the good row never landed');
  assert.equal(dom.$('import-refused').hidden, false, 'nothing was refused, so this proves nothing');

  dom.click(dom.$('roster-import'));
  assert.equal(dom.$('import-refused').hidden, true, 'the last run refusals are still on screen');
  assert.equal(dom.$('import-refused-list').querySelectorAll('li').length, 0);
  dom.$('import-dialog').close();
});

await check('leaving the roster and coming back does not resurrect the refusals', async () => {
  // The other path QA walked. The panels are hidden and shown rather than
  // rebuilt, so a list left in the markup is still there on the way back.
  const rosterBefore = rosterRows().length;
  refuseImportRowOnce(3);

  dom.click(dom.$('roster-import'));
  await chooseFile(
    [
      'first_name,last_name,email',
      'Saoirse,Lindgren,saoirse.lindgren@knights.ucf.edu',
      'Piia,Vuorinen,piia.vuorinen@knights.ucf.edu',
    ].join('\n'),
  );
  assert.equal(dom.$('import-run').disabled, false, 'a row in this file needs a decision');
  dom.fire(dom.$('import-form'), 'submit');
  await until(() => rosterRows().length === rosterBefore + 1, 'the good row never landed');
  assert.equal(dom.$('import-refused').hidden, false, 'nothing was refused, so this proves nothing');

  dom.click(dom.$('tab-progress'));
  dom.click(dom.$('tab-roster'));

  assert.equal(dom.$('import-refused').hidden, true, 'a run the officer left behind is still on screen');
  assert.equal(dom.$('import-refused-list').querySelectorAll('li').length, 0);
});

await check('a file that cannot be read writes nothing and says which row', async () => {
  const before = (await adminAudit()).members.length;
  dom.click(dom.$('roster-import'));
  await chooseFile('first_name,last_name\nAbby,Catto\nAaron,\n');

  assert.equal(dom.$('import-problem').hidden, false);
  assert.match(dom.$('import-problem-title').textContent, /Row 3/);
  assert.equal(dom.$('import-run').disabled, true);
  assert.equal(dom.$('import-rows').querySelectorAll('tr').length, 0, 'a broken file still previewed rows');
  assert.equal((await adminAudit()).members.length, before);
  dom.$('import-dialog').close();
});

// ---------------------------------------------------------------------------
process.stdout.write('\nduplicate people\n');
// ---------------------------------------------------------------------------

const ABIGAIL = IDS.MEMBER_ABIGAIL;
const ABBY = 'm0000000-0000-4000-a000-000000000002';

const pairCards = () => dom.$('duplicates-list').querySelectorAll('.dupe-card');

await check('a pair is on screen once, not once each way round', async () => {
  await until(() => !dom.$('duplicates-zone').hidden, 'the duplicates banner never appeared');
  const cards = pairCards();
  assert.ok(cards.length >= 1, 'the fixture has no duplicate pair in it');

  const seen = new Set();
  for (const card of cards) {
    const [a, b] = card.dataset.pair.split(':');
    const key = [a, b].sort().join(':');
    assert.equal(seen.has(key), false, 'the same pair is on screen twice');
    seen.add(key);
  }

  const cattos = cards.find(
    (card) => card.dataset.pair.includes(ABIGAIL) && card.dataset.pair.includes(ABBY),
  );
  assert.ok(cattos, 'the two Cattos are not offered as a possible duplicate');
  assert.match(cattos.textContent, /Similar name/);
});

await check('every reason the server can give has copy written for it', async () => {
  // reason is a stable code and the screen branches on it. A code the screen
  // has never heard of falls back to "Possible duplicate", which is honest but
  // is also what a silently drifted contract looks like, so the codes are
  // compared rather than assumed.
  const known = ['exact_email', 'exact_nid', 'exact_name', 'close_name'];
  for (const word of known) {
    assert.match(
      sources['src/roster.js'],
      new RegExp(`\\b${word}\\b`),
      `the screen has no copy for the reason "${word}"`,
    );
  }
  const rows = await select('v_possible_duplicate_members', { select: 'member_a,member_b,reason' });
  for (const row of rows) {
    assert.ok(known.includes(row.reason), `the server sent a reason nobody wrote copy for: ${row.reason}`);
  }
  for (const card of pairCards()) {
    assert.notEqual(
      card.querySelector('.dupe-reason').textContent.trim(),
      'Possible duplicate',
      'a card fell back to the unknown-reason wording',
    );
  }
});

await check('the card carries what decides which row lives', () => {
  const card = pairCards().find(
    (candidate) => candidate.dataset.pair.includes(ABIGAIL) && candidate.dataset.pair.includes(ABBY),
  );
  const sides = card.querySelectorAll('.dupe-side');
  assert.equal(sides.length, 2);
  for (const side of sides) {
    assert.match(side.textContent, /record/, 'a side with no record count on it');
    assert.match(side.textContent, /joined/, 'a side with no join date on it');
  }
  assert.equal(
    card.querySelectorAll('input[type="radio"]:checked').length,
    1,
    'no survivor is offered, or both are',
  );
});

await check('a member on the banner and on the roster shows one join date, not two', () => {
  // THE SAME LABEL ABOUT THE SAME PERSON, ON ONE SCREEN. The banner reads
  // joined_a from v_possible_duplicate_members, which is the earliest
  // enrollment falling back to when the row was created. The roster row under
  // it has to mean the same thing, or an officer choosing which row survives a
  // merge is reading two different numbers called "Joined" a few pixels apart.
  //
  // Asserted on the rendered cells rather than on the two queries, because it
  // is the contradiction on screen that does the damage, and a screen can
  // render two agreeing sources into two different strings.
  const rosterJoined = new Map(
    rosterRows().map((row) => [row.dataset.member, row.querySelectorAll('td')[3].textContent.trim()]),
  );

  let compared = 0;
  for (const card of pairCards()) {
    for (const sideNode of card.querySelectorAll('.dupe-side')) {
      const id = sideNode.querySelector('input[type="radio"]').value;
      if (!rosterJoined.has(id)) continue;

      const name = sideNode.querySelector('.dupe-name').textContent.trim();
      const part = sideNode
        .querySelector('.dupe-meta')
        .textContent.split(' · ')
        .find((piece) => piece.startsWith('joined '));
      assert.ok(part, `${name} is on the banner with no join date to compare`);

      const banner = part.slice('joined '.length).trim();
      assert.equal(
        banner,
        rosterJoined.get(id),
        `${name} joined ${banner} on the banner and ${rosterJoined.get(id)} on the roster`,
      );
      compared += 1;
    }
  }
  assert.ok(compared > 0, 'nobody is on both the banner and the roster, so this proves nothing');
});

await check('merging moves the records onto the survivor and tombstones the other', async () => {
  const card = pairCards().find(
    (candidate) => candidate.dataset.pair.includes(ABIGAIL) && candidate.dataset.pair.includes(ABBY),
  );

  const records = (await adminAudit()).attendance;
  const countFor = (id) => records.filter((row) => row.member_id === id && row.status !== 'rejected').length;
  const abigailBefore = countFor(ABIGAIL);
  const abbyBefore = countFor(ABBY);
  assert.ok(abbyBefore > 0, 'the row being merged away has no records, so nothing would move');

  // Keep Abigail, who is the older row with the longer history.
  const keep = card
    .querySelectorAll('input[type="radio"]')
    .find((input) => input.value === ABIGAIL);
  keep.checked = true;
  const cards = pairCards().length;

  dom.click(dom.buttonNamed(card, 'Merge'));
  await until(() => pairCards().length !== cards, 'the banner never changed');

  const after = (await adminAudit()).attendance;
  const abigailAfter = after.filter((row) => row.member_id === ABIGAIL && row.status !== 'rejected').length;
  assert.ok(abigailAfter > abigailBefore, 'no record moved to the survivor');
  assert.equal(
    after.filter((row) => row.member_id === ABBY).length,
    0,
    'the merged row still holds records',
  );

  const [loser] = await select('members', {
    select: 'id,merged_into_id,archived_at',
    filters: { id: `eq.${ABBY}` },
  });
  assert.equal(loser.merged_into_id, ABIGAIL, 'the merged row is not a pointer at the survivor');
  assert.ok(loser.archived_at, 'the merged row is still live on the roster');

  const merges = (await adminAudit()).merges;
  assert.equal(merges.length, 1, 'the merge is not on the record');
  assert.equal(merges[0].performed_by, IDS.USERS.officer, 'nobody is on the hook for the merge');
  assert.ok(merges[0].dropped_records > 0, 'the fixture no longer exercises a collision');
});

await check('the merged pair is gone from the banner', () => {
  const still = pairCards().find(
    (card) => card.dataset.pair.includes(ABBY) && card.dataset.pair.includes(ABIGAIL),
  );
  assert.equal(still, undefined, 'a merged pair is still being offered');
});

let dismissed = null;

await check('adding somebody whose name resembles a member is allowed, and raises a pair', async () => {
  // Two sisters exist, and an officer who cannot add the second one has no way
  // through. So Add refuses only an exact match and lets a resemblance land,
  // which the banner then offers as a question rather than a block.
  const before = rosterRows().length;
  dom.click(dom.$('roster-add'));
  dom.$('roster-add-first').value = 'Aron';
  dom.$('roster-add-last').value = 'Ozan';
  dom.fire(dom.$('roster-add-form'), 'submit');

  await until(() => rosterRows().length === before + 1, `Add was refused: ${dom.$('roster-add-error').textContent}`);
  await until(() => pairCards().length > 0, 'the new near-duplicate raised no pair');

  const raised = pairCards()[0];
  assert.match(raised.textContent, /Aron Ozan/);
  assert.match(raised.textContent, /Aaron Ozan/);
});

await check('Dismiss makes a pair stay gone', async () => {
  const card = pairCards()[0];
  const [a, b] = card.dataset.pair.split(':');
  dismissed = { a, b };
  const before = pairCards().length;

  dom.click(dom.buttonNamed(card, 'Dismiss'));
  await until(() => pairCards().length === before - 1, 'the pair did not leave the screen');

  // And it is remembered, rather than merely hidden until the next load.
  const rows = await select('v_possible_duplicate_members', { select: 'member_a,member_b' });
  assert.equal(
    rows.some((row) => row.member_a === a && row.member_b === b),
    false,
    'the pair came straight back from the server',
  );
});

await check('dismissing is the same dismissal whichever way round the pair is passed', async () => {
  // The view spells a pair one way. A caller holding the other spelling must
  // not be able to file a second dismissal, and must not see the pair again.
  await callRpc('dismiss_duplicate_pair', {
    p_member_a: dismissed.b,
    p_member_b: dismissed.a,
  });
  const held = (await adminAudit()).dismissals.filter(
    (row) =>
      [row.member_a, row.member_b].sort().join(':') === [dismissed.a, dismissed.b].sort().join(':'),
  );
  assert.equal(held.length, 1, `the same pair is dismissed ${held.length} times`);

  const rows = await select('v_possible_duplicate_members', { select: 'member_a,member_b' });
  assert.equal(
    rows.some(
      (row) =>
        [row.member_a, row.member_b].sort().join(':') ===
        [dismissed.a, dismissed.b].sort().join(':'),
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\nearlier check-ins\n');
// ---------------------------------------------------------------------------
// fn_retroactive_match_candidates() and link_retroactive_matches()
// (supabase/migrations/20260814140000_retroactive_matching.sql), offered on
// the member screen and after Add/Import on the roster. Fixtures for this
// are the RETRO block in admin-fixtures.mjs.

dom.click(dom.$('tab-roster'));
await until(() => rosterRows().length > 0, 'the roster never drew');

function openMemberByName(name) {
  const row = rosterRows().find((candidate) => candidate.textContent.includes(name));
  assert.ok(row, `${name} is not on the roster`);
  dom.click(row.querySelector('.board-name'));
}

async function openMemberAndWaitForRetro(name) {
  openMemberByName(name);
  await until(
    () => !dom.$('member-body').hidden && dom.$('member-name').textContent.trim() === name,
    `${name}'s own screen never drew`,
  );
  await until(() => !dom.$('member-retro').hidden, `no earlier check-ins offered for ${name}`);
}

const retroRows = () => dom.$('member-retro-body').querySelectorAll('.retro-list li');
// Read off the outcome pill specifically, not the row's whole textContent:
// a resolved row also carries the reason text ("Same email address", "NN%
// name match") right beside the pill, and a plain substring search could
// match that instead of the pill's own word.
const retroOutcomeTexts = () =>
  dom.$('member-retro-body').querySelectorAll('.retro-outcome').map((node) => node.textContent.trim());

await check(
  "an earlier, slower member load cannot repaint a later member's screen, or submit under the wrong id",
  async () => {
    const NAME_A = 'Abigail Catto';
    const NAME_B = 'Torvald Quillfeather';
    const ID_A = IDS.MEMBER_ABIGAIL;
    const ID_B = IDS.RETRO_CONFLICT_MEMBER;

    const rowA = rosterRows().find((row) => row.textContent.includes(NAME_A));
    const rowB = rosterRows().find((row) => row.textContent.includes(NAME_B));
    assert.ok(rowA, `${NAME_A} is not on the roster`);
    assert.ok(rowB, `${NAME_B} is not on the roster`);

    // Holds every request that carries A's id, wherever it appears (a
    // select's filter, an RPC's body), until released below. This is what
    // makes "A's own Promise.all resolves after B is already on screen"
    // reproducible on demand, instead of hoping real localhost timing lands
    // that way once in a while.
    let holding = true;
    let started = 0;
    let finished = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const carriesA = String(url).includes(ID_A) || String(init?.body ?? '').includes(ID_A);
      if (carriesA) {
        started += 1;
        while (holding) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      try {
        return await realFetch(url, init);
      } finally {
        if (carriesA) finished += 1;
      }
    };

    try {
      dom.click(rowA.querySelector('.board-name')); // starts loading A; every A request now stalls
      await until(() => started > 0, "member A's own requests never went out");

      dom.click(rowB.querySelector('.board-name')); // starts loading B, unblocked
      await until(
        () => !dom.$('member-body').hidden && dom.$('member-name').textContent.trim() === NAME_B,
        "member B's own screen never drew",
      );

      // Only now let A's held requests resolve, well after B is already
      // showing, and give the promise chain a moment to run to the end.
      holding = false;
      for (let i = 0; i < 10; i += 1) {
        const before = finished;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (started === finished && finished === before) break;
      }
    } finally {
      globalThis.fetch = realFetch;
      holding = false;
    }

    assert.equal(
      dom.$('member-name').textContent.trim(),
      NAME_B,
      "a slower, earlier-started load for member A repainted the screen with A's data after B was already on it",
    );

    // And the write side: B's own earlier check-in, still on screen, has to
    // submit under B's id, not whatever load() last saw at the top of its
    // own function.
    assert.equal(dom.$('member-retro').hidden, false, "member B's own earlier check-in never offered");
    dom.click(dom.buttonNamed(dom.$('member-retro-body'), 'Link selected'));
    await until(
      () => dom.$('member-retro-body').querySelectorAll('.retro-outcome').length > 0,
      'linking never reported an outcome',
    );

    const calls = (await adminAudit()).calls.filter((call) => call.fn === 'link_retroactive_matches');
    const last = calls[calls.length - 1];
    assert.ok(last, 'the link never reached the server');
    assert.equal(last.memberId, ID_B, 'the write went out under the wrong member id');

    dom.click(dom.$('member-back'));
  },
);

await openMemberAndWaitForRetro('Xiomara Petrenko');

await check('already_linked does not render or read as a success', async () => {
  const rows = retroRows();
  const row = rows.find(
    (candidate) =>
      candidate.textContent.includes('Soap Carving') && candidate.textContent.includes('Same email address'),
  );
  assert.ok(row, 'the held-back candidate for this check is not offered');
  const box = row.querySelector('input[type="checkbox"]');
  assert.equal(box.checked, true, 'an exact email match does not default to checked');

  // Every other exact-email candidate on her list defaults to checked too.
  // Unchecked here (not submitted, not consumed) so this check proves
  // something about THIS one record rather than about whatever else was
  // also checked.
  for (const candidate of rows) {
    if (candidate === row) continue;
    const other = candidate.querySelector('input[type="checkbox"]');
    if (other?.checked) {
      other.checked = false;
      dom.fire(other, 'change');
    }
  }

  // Another officer links this exact record to somebody else first, between
  // this preview loading and this officer pressing the button. Ethan
  // Wallace, not Abby Catto: the duplicate-people checks above merge Abby
  // into Abigail, and a merged member would follow that chain here too,
  // which would prove nothing about a genuinely different person.
  await callRpc('link_retroactive_matches', {
    p_member_id: IDS.MEMBER_ETHAN,
    p_record_ids: [IDS.RETRO_RECORD.alreadyLinked],
  });

  dom.click(dom.buttonNamed(dom.$('member-retro-body'), 'Link selected'));
  await until(
    () => dom.$('member-retro-body').textContent.includes('Already linked to somebody'),
    'the already_linked outcome never rendered',
  );

  const after = retroRows().find(
    (candidate) =>
      candidate.textContent.includes('Soap Carving') && candidate.textContent.includes('Already linked to somebody'),
  );
  assert.ok(after, 'the already_linked row is not on screen');
  const pill = after.querySelector('.card-outcome');
  assert.equal(pill.dataset.kind, 'error', 'already_linked was styled as a success');
  assert.doesNotMatch(pill.textContent, /^Already linked$/, 'the wording still reads as this members own success');

  const record = (await adminAudit()).attendance.find((row) => row.id === IDS.RETRO_RECORD.alreadyLinked);
  assert.equal(record.member_id, IDS.MEMBER_ETHAN, "the other officer's link was overwritten");
});

await openMemberAndWaitForRetro('Xiomara Petrenko');

await check('the certain/uncertain reason stays visible after a decision is made', async () => {
  const rows = retroRows();
  const emailRow = rows.find(
    (row) => row.textContent.includes('Give Kids A Smile') && row.textContent.includes('Same email address'),
  );
  const nameRow = rows.find(
    (row) => row.textContent.includes('Give Kids A Smile') && /% name match/.test(row.textContent),
  );
  assert.ok(emailRow, 'the held-back exact-email candidate is not offered');
  assert.ok(nameRow, 'the held-back name-match candidate is not offered');

  // Every other exact-email candidate on her list defaults to checked too.
  // Unchecked here so this batch is exactly the pair this check is about.
  for (const candidate of rows) {
    if (candidate === emailRow || candidate === nameRow) continue;
    const other = candidate.querySelector('input[type="checkbox"]');
    if (other?.checked) {
      other.checked = false;
      dom.fire(other, 'change');
    }
  }

  const emailBox = emailRow.querySelector('input[type="checkbox"]');
  const nameBox = nameRow.querySelector('input[type="checkbox"]');
  assert.equal(emailBox.checked, true, 'an exact email match does not default to checked');
  nameBox.checked = true;
  dom.fire(nameBox, 'change');

  dom.click(dom.buttonNamed(dom.$('member-retro-body'), 'Link selected'));
  await until(() => {
    const after = retroRows();
    const e = after.find(
      (row) => row.textContent.includes('Give Kids A Smile') && row.querySelector('.retro-outcome'),
    );
    const n = after.find(
      (row) =>
        row !== e && row.textContent.includes('Give Kids A Smile') && row.querySelector('.retro-outcome'),
    );
    return Boolean(e && n);
  }, 'both outcomes never rendered');

  const after = retroRows();
  const resolvedEmailRow = after.find(
    (row) => row.textContent.includes('Give Kids A Smile') && row.textContent.includes('Same email address'),
  );
  const resolvedNameRow = after.find(
    (row) => row.textContent.includes('Give Kids A Smile') && /% name match/.test(row.textContent),
  );
  assert.ok(resolvedEmailRow, 'the identity reason ("Same email address") disappeared once a decision was made');
  assert.ok(resolvedNameRow, 'the resemblance reason ("NN% name match") disappeared once a decision was made');
});

dom.click(dom.$('member-back'));
await openMemberAndWaitForRetro('Xiomara Petrenko');

await check('an identity and a resemblance read differently, not just say differently', () => {
  const rows = retroRows();
  assert.ok(rows.length >= 2, `only ${rows.length} candidates offered`);

  const emailRow = rows.find((row) => row.textContent.includes('Same email address'));
  assert.ok(emailRow, 'the exact-email candidate is not offered');
  const emailControl = emailRow.querySelector('.suggestion');
  assert.equal(emailControl.dataset.certain, 'true', 'an identity match is not marked certain');
  assert.equal(
    emailControl.querySelector('input[type="checkbox"]').checked,
    true,
    'an exact email match does not default to checked',
  );

  const nameRow = rows.find((row) => /% name match/.test(row.textContent));
  assert.ok(nameRow, 'the name-resemblance candidate is not offered');
  const nameControl = nameRow.querySelector('.suggestion');
  assert.equal(nameControl.dataset.certain, 'false', 'a resemblance is marked certain');
  assert.equal(
    nameControl.querySelector('input[type="checkbox"]').checked,
    false,
    'a name match defaults to checked',
  );
});

await check('the "does not approve" line is always shown beside the link action', () => {
  assert.match(
    dom.$('member-retro-body').textContent,
    /Not approved yet\./,
    'no line tells the officer that linking is not approving',
  );
});

await check('only the checked record gets linked, whichever one that is', async () => {
  const rows = retroRows();
  const emailRow = rows.find((row) => row.textContent.includes('Spring GBM 5'));
  const nameRow = rows.find((row) => row.textContent.includes('Soap Carving'));
  const raceRow = rows.find((row) => row.textContent.includes('Health Fair'));
  const emailBox = emailRow.querySelector('input[type="checkbox"]');
  const nameBox = nameRow.querySelector('input[type="checkbox"]');
  const raceBox = raceRow.querySelector('input[type="checkbox"]');

  // Flipped from the defaults on purpose: a check that only pressed Link on
  // the untouched defaults could not tell "selection respected" from
  // "selection ignored, exact_email always wins". The third candidate (also
  // exact_email, also checked by default) is unchecked too, so exactly one
  // id is submitted and this check proves something about a deliberate
  // choice rather than about whatever the defaults happened to be.
  emailBox.checked = false;
  dom.fire(emailBox, 'change');
  nameBox.checked = true;
  dom.fire(nameBox, 'change');
  raceBox.checked = false;
  dom.fire(raceBox, 'change');

  dom.click(dom.buttonNamed(dom.$('member-retro-body'), 'Link selected'));
  await until(
    () => retroOutcomeTexts().includes('Linked'),
    'the outcome for the checked record never rendered',
  );

  const attendance = (await adminAudit()).attendance;
  const linked = attendance.find((row) => row.id === IDS.RETRO_RECORD.name);
  const untouched = attendance.find((row) => row.id === IDS.RETRO_RECORD.email);
  const alsoUntouched = attendance.find((row) => row.id === IDS.RETRO_RECORD.race);
  assert.equal(linked.member_id, IDS.RETRO_MEMBER, 'the checked record was not linked');
  assert.equal(untouched.member_id, null, 'an unchecked record was linked anyway');
  assert.equal(alsoUntouched.member_id, null, 'an unchecked record was linked anyway');
});

await check('a record decided elsewhere while linking was in progress reports its own outcome', async () => {
  // The stale-preview race: another officer works the review queue on the
  // exact record this screen is about to submit.
  await callRpc('review_records', {
    p_ids: [IDS.RETRO_RECORD.race],
    p_decision: 'reject',
    p_note: 'wrong event',
  });

  const raceRow = retroRows().find((row) => row.textContent.includes('Health Fair'));
  assert.ok(raceRow, 'the race candidate is not offered');
  const raceBox = raceRow.querySelector('input[type="checkbox"]');
  assert.ok(raceBox, 'the race candidate is not a checkbox to begin with');
  // Checked explicitly rather than asserted as a default: the previous check
  // deliberately left it unchecked to keep that check's own submission to
  // exactly one id (see the comment there).
  raceBox.checked = true;
  dom.fire(raceBox, 'change');

  dom.click(dom.buttonNamed(dom.$('member-retro-body'), 'Link selected'));
  await until(
    () => dom.$('member-retro-body').textContent.includes('Somebody already decided this one'),
    'the outcome for the rejected record never rendered',
  );

  const after = retroRows().find((row) => row.textContent.includes('Health Fair'));
  assert.match(after.textContent, /Somebody already decided this one/, 'not a generic total');

  const record = (await adminAudit()).attendance.find((row) => row.id === IDS.RETRO_RECORD.race);
  assert.equal(record.member_id, null, 'a rejected record was linked anyway');
  assert.equal(record.status, 'rejected', 'linking silently un-rejected a reviewed record');
});

dom.click(dom.$('member-back'));

await check('a merge mid-flow is followed, on both the read and the write', async () => {
  dom.click(dom.$('tab-roster'));
  await openMemberAndWaitForRetro('Fionnuala Askew');

  assert.equal(
    dom.$('member-retro-body').textContent.includes('This member was merged'),
    false,
    'the merge line showed before any merge happened',
  );

  // Held back unchecked, so one candidate survives the coming write and can
  // prove the READ side separately from the WRITE side below.
  const held = retroRows().find((row) => row.textContent.includes('Soap Carving'));
  assert.ok(held, 'the second merge-loser candidate is not offered');
  const heldBox = held.querySelector('input[type="checkbox"]');
  heldBox.checked = false;
  dom.fire(heldBox, 'change');

  // Another officer merges her away mid-flow. The first officer, still
  // holding the stale preview, presses Link selected anyway.
  await callRpc('merge_members', { p_from_id: IDS.RETRO_MERGE_LOSER, p_into_id: IDS.RETRO_MERGE_SURVIVOR });

  dom.click(dom.buttonNamed(dom.$('member-retro-body'), 'Link selected'));
  await until(
    () => retroOutcomeTexts().includes('Linked'),
    'the write-side outcome never rendered',
  );
  assert.match(
    dom.$('member-retro-body').textContent,
    /This member was merged/,
    'the write did not report the merge',
  );

  const written = (await adminAudit()).attendance.find((row) => row.id === IDS.RETRO_RECORD.mergeA);
  assert.equal(
    written.member_id,
    IDS.RETRO_MERGE_SURVIVOR,
    'linking a merged member did not land on the survivor',
  );

  // READ side: reopening the same loser id shows the merge line straight off
  // the candidate list, before anything is linked. A fresh candidate for
  // this, not mergeB: once merged, candidates are matched against the
  // SURVIVOR's own identity, so a record claiming the loser's identity (like
  // the held-back mergeB) does not resurface here, the way
  // RECORD_RETRO_MERGE_READ_SIDE, claiming the survivor's email, does.
  dom.click(dom.$('member-back'));
  dom.click(dom.$('tab-roster'));
  await openMemberAndWaitForRetro('Fionnuala Askew');
  assert.match(
    dom.$('member-retro-body').textContent,
    /This member was merged/,
    'the read never reported the merge',
  );
  assert.match(
    dom.$('member-retro-body').textContent,
    /Give Kids A Smile/,
    'the survivor-matching candidate did not surface when asked about the loser',
  );

  // And there is a way to reach the survivor from here.
  dom.click(dom.buttonNamed(dom.$('member-retro-body'), 'Open the current record'));
  await until(
    () => !dom.$('member-body').hidden && dom.$('member-name').textContent.trim() === 'Yevgenia Marchant',
    'the merge line did not lead to the survivor',
  );
});

dom.click(dom.$('member-back'));

await check(
  'adding somebody opens Earlier check-ins when there is one, and stays closed when there is not',
  async () => {
    dom.click(dom.$('tab-roster'));
    await until(() => rosterRows().length > 0, 'the roster never drew');
    assert.equal(dom.$('roster-retro-dialog').open, false, 'the dialog is already open');

    // Not a roster-row-count wait: the merge two checks ago (a direct RPC
    // call, not the roster's own Merge button) left this screen's roster
    // list stale by one row (the tombstoned loser) until the next reload,
    // and this Add is what triggers it. That reload removes one row and
    // adds Beatrix, which nets to no visible change in the row COUNT even
    // though the roster genuinely changed. The dialog opening is a signal
    // that does not depend on that arithmetic.
    dom.click(dom.$('roster-add'));
    dom.$('roster-add-first').value = 'Beatrix';
    dom.$('roster-add-last').value = 'Hallworth';
    dom.fire(dom.$('roster-add-form'), 'submit');

    await until(
      () => dom.$('roster-retro-dialog').open === true,
      'the dialog never opened for somebody with an earlier check-in',
    );
    assert.match(dom.$('roster-retro-who').textContent, /Beatrix Hallworth/);
    assert.ok(
      rosterRows().some((row) => row.textContent.includes('Beatrix Hallworth')),
      'Beatrix Hallworth was never actually added to the roster',
    );

    const rows = dom.$('roster-retro-body').querySelectorAll('.retro-list li');
    assert.equal(rows.length, 1, `expected exactly one candidate, got ${rows.length}`);
    // By name. Her check-in was typed at an event, and nothing on either side
    // of the match carries an address to be certain about any more.
    assert.match(rows[0].textContent, /name match/);

    dom.$('roster-retro-dialog').close();

    // And adding somebody with nothing waiting does not open it at all.
    const before2 = rosterRows().length;
    dom.click(dom.$('roster-add'));
    dom.$('roster-add-first').value = 'Nobody';
    dom.$('roster-add-last').value = 'Special';
    dom.fire(dom.$('roster-add-form'), 'submit');

    // The dialog's own showModal() runs before setBusy(false), so waiting for
    // Add to finish (the button re-enabling) is the reliable signal that the
    // offer, whichever way it went, has already been decided one way or the
    // other by the time this reads the dialog.
    await until(() => rosterRows().length === before2 + 1, 'Nobody Special was never added');
    await until(() => dom.$('roster-add').disabled === false, 'Add never finished');
    assert.equal(dom.$('roster-retro-dialog').open, false, 'the dialog opened with nothing to offer');
  },
);

await check('a CSV import surfaces earlier check-ins as a quiet, separate zone', async () => {
  dom.click(dom.$('tab-roster'));
  await until(() => rosterRows().length > 0, 'the roster never drew');
  assert.equal(dom.$('import-retro').hidden, true, 'a stale retro zone is already showing');

  dom.click(dom.$('roster-import'));
  await chooseFile('first_name,last_name,email\nEndellion,Marrow,endellion.marrow@knights.ucf.edu\n');
  assert.equal(dom.$('import-run').disabled, false, 'the row needs no decision, so this proves nothing');

  const rosterBefore = rosterRows().length;
  dom.fire(dom.$('import-form'), 'submit');
  await until(() => rosterRows().length === rosterBefore + 1, 'the new member never landed');

  await until(() => !dom.$('import-retro').hidden, 'the retro zone never appeared after the import');
  assert.match(dom.$('import-retro-title').textContent, /1 member/);
  assert.match(dom.$('import-retro-list').textContent, /Endellion Marrow/);
  assert.match(dom.$('import-retro-list').textContent, /1 earlier check-in/);

  // Visually secondary to import-refused, the way import-refused itself
  // reads as informational next to duplicates-zone's warn treatment: it does
  // not carry the class duplicates-title uses to signal a problem.
  assert.doesNotMatch(dom.$('import-retro-title').className, /zone-title-warn/);

  const openButton = dom.buttonNamed(dom.$('import-retro-list'), 'Open member');
  assert.ok(openButton, 'no way to reach the member with the earlier check-in');
  dom.click(openButton);
  await until(
    () => !dom.$('member-body').hidden && dom.$('member-name').textContent.trim() === 'Endellion Marrow',
    'the Open member button did not reach the member',
  );
  // Reaching the member is itself a navigation, and clearMessage() (which
  // openMember() calls) is what clears this zone: the same path
  // renderRefused()'s report is cleared through, applied to both reports at
  // once inside clearReport(). Confirmed here rather than with a second,
  // separate check: navigating away a second time to observe it would only
  // prove the same call happened twice.
  assert.equal(dom.$('import-retro').hidden, true, 'the zone survived the navigation that clears it');
});

await check(
  "an import's own courtesy scan cannot be overwritten by an earlier, slower import's stale one",
  async () => {
    dom.click(dom.$('tab-roster'));
    await until(() => rosterRows().length > 0, 'the roster never drew');
    assert.equal(dom.$('import-retro').hidden, true, 'a stale retro zone is already showing');

    // The roster write for each import is fast and real. What is held back
    // is each import's own COURTESY SCAN (fn_retroactive_match_candidates,
    // fired unawaited once the write is done), captured here in the order
    // the two imports start it so this check can release them in whichever
    // order it wants rather than hope real localhost timing cooperates.
    //
    // responseRead[] mirrors held[] one-for-one (both are pushed to, in
    // order, inside the same interceptor invocation): responseRead[i]
    // resolves once held request i's Response has had its real .text()
    // actually return, the exact call rest.js's send() makes and the last
    // real I/O either request does. See the deterministic-wait comment
    // below, and the check right after this one, for why that is the
    // signal to wait for rather than a fixed sleep.
    const held = [];
    const responseRead = [];
    let capturing = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const isScan = String(url).includes('fn_retroactive_match_candidates');
      const isHeld = isScan && capturing;
      let settleRead;
      if (isHeld) {
        responseRead.push(
          new Promise((resolve) => {
            settleRead = resolve;
          }),
        );
        await new Promise((resolve) => held.push(resolve));
      }
      const res = await realFetch(url, init);
      if (isHeld) {
        const originalText = res.text.bind(res);
        res.text = async (...args) => {
          const body = await originalText(...args);
          settleRead();
          return body;
        };
      }
      return res;
    };

    try {
      const before = rosterRows().length;

      dom.click(dom.$('roster-import'));
      await chooseFile(
        `first_name,last_name,email\n${IDS.IMPORT_RACE.first.name.replace(' ', ',')},${IDS.IMPORT_RACE.first.email}\n`,
      );
      dom.fire(dom.$('import-form'), 'submit');
      await until(() => rosterRows().length === before + 1, "the first import's member never landed");

      dom.click(dom.$('roster-import'));
      await chooseFile(
        `first_name,last_name,email\n${IDS.IMPORT_RACE.second.name.replace(' ', ',')},${IDS.IMPORT_RACE.second.email}\n`,
      );
      dom.fire(dom.$('import-form'), 'submit');
      await until(() => rosterRows().length === before + 2, "the second import's member never landed");

      await until(() => held.length === 2, "both imports' scan calls never went out");

      // The SECOND import's scan, though started second, is let through
      // first: the exact interleaving the bug depends on real network
      // timing to ever hit, made deterministic here.
      held[1]();
      await until(() => !dom.$('import-retro').hidden, "the second import's retro zone never appeared");
      assert.match(dom.$('import-retro-list').textContent, /Cornelius Applewhite/, "the second import's own report never showed");
      assert.doesNotMatch(
        dom.$('import-retro-list').textContent,
        /Perpetua Thistlewood/,
        'this proves nothing if the first import already leaked in',
      );

      // Now let the FIRST import's held scan through, well after the
      // second's has already rendered.
      capturing = false;
      held[0]();

      // Deterministic wait for the first import's own held request to
      // settle: once its response body has actually been read there is no
      // further real I/O in scanImportRetro()'s path for it (JSON.parse,
      // the token guard, the conditional write are all pure promise
      // chaining), so a single macrotask boundary after that is guaranteed
      // by the event loop's own microtask-before-macrotask ordering to land
      // only after that whole continuation has finished, whatever the
      // machine's speed. See the check right after this one for the same
      // reasoning spelled out in full.
      await responseRead[0];
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.match(
      dom.$('import-retro-list').textContent,
      /Cornelius Applewhite/,
      "the second import's report was overwritten",
    );
    assert.doesNotMatch(
      dom.$('import-retro-list').textContent,
      /Perpetua Thistlewood/,
      "the first, slower import's scan repainted the zone with its own stale report",
    );
  },
);

await check(
  'starting an import invalidates an earlier held scan even when the new import links nobody',
  async () => {
    dom.click(dom.$('tab-roster'));
    await until(() => rosterRows().length > 0, 'the roster never drew');

    // Same interception approach as the check above: hold every courtesy
    // scan (fn_retroactive_match_candidates) so this check controls the
    // order they resolve in, rather than hoping real timing cooperates.
    const held = [];
    let capturing = true;
    const realFetch = globalThis.fetch;

    // Deterministic completion signal for A's held request specifically:
    // resolved once its Response's real .text() (the exact call rest.js's
    // send() makes, and the last real I/O scanImportRetro() does for this
    // request) has actually returned a value.
    let settleARead;
    const aResponseRead = new Promise((resolve) => {
      settleARead = resolve;
    });

    globalThis.fetch = async (url, init) => {
      const isScan = String(url).includes('fn_retroactive_match_candidates');
      const isHeld = isScan && capturing;
      if (isHeld) {
        await new Promise((resolve) => held.push(resolve));
      }
      const res = await realFetch(url, init);
      if (isHeld) {
        const originalText = res.text.bind(res);
        res.text = async (...args) => {
          const body = await originalText(...args);
          settleARead();
          return body;
        };
      }
      return res;
    };

    try {
      // Import A links somebody real, with an earlier check-in waiting, so
      // its held scan has something to publish if it is ever let through.
      dom.click(dom.$('roster-import'));
      await chooseFile(
        `first_name,last_name,email\n${IDS.IMPORT_RACE.first.name.replace(' ', ',')},${IDS.IMPORT_RACE.first.email}\n`,
      );
      dom.fire(dom.$('import-form'), 'submit');
      await until(() => held.length === 1, "import A's own scan never went out");

      // While A's scan is still held, the officer reopens the dialog (which
      // clears the zone on screen, but not the token this bug is about) and
      // runs a second import whose only row is refused: import B links
      // nobody at all.
      // Row 2: the header is row 1 to whoever is looking at the file in a
      // spreadsheet (see readRoster() in csv.js), so the one data row here
      // is row 2.
      refuseImportRowOnce(2);
      dom.click(dom.$('roster-import'));
      await chooseFile(
        'first_name,last_name,email\nWilhelmina,Fitzgerald,wilhelmina.fitzgerald@knights.ucf.edu\n',
      );
      dom.fire(dom.$('import-form'), 'submit');
      await until(() => !dom.$('import-refused').hidden, "import B's refusal never showed");
      assert.match(dom.$('import-refused-list').textContent, /Wilhelmina Fitzgerald/);

      // B linked nobody, so it never called scanImportRetro and never
      // queued a second held request.
      assert.equal(held.length, 1, "import B's own scan went out despite linking nobody");
      assert.equal(
        dom.$('import-retro').hidden,
        true,
        "the zone shows something before A's stale scan has even landed",
      );

      // Now let A's held scan through, well after B has already finished.
      capturing = false;
      held[0]();

      // Wait for A's own response body to actually be read (its last real
      // I/O for this request), then yield once via a macrotask. Node drains
      // every currently-queued microtask, including any new microtasks that
      // draining itself queues (i.e. an arbitrarily deep chain of further
      // awaits), before running the next macrotask (setTimeout). Once the
      // body is read there is no further I/O left in this path (JSON.parse,
      // the token guard, loadCandidates()'s worker loop, Promise.all, and
      // the conditional write are all pure promise-chaining), so this
      // setTimeout(resolve, 0) is guaranteed by the event loop's own
      // ordering to fire only after that entire continuation has finished,
      // no matter how slow or fast the machine is. This is not a delay
      // hoping timing cooperates; it is a boundary the language enforces.
      await aResponseRead;
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(
      dom.$('import-retro').hidden,
      true,
      "import A's stale scan repainted the zone even though import B linked nobody",
    );
    assert.doesNotMatch(
      dom.$('import-retro-list').textContent,
      /Perpetua Thistlewood/,
      "import A's stale report leaked in even though B linked nobody",
    );
  },
);

// ---------------------------------------------------------------------------
process.stdout.write('\na member account reaches none of it\n');
// ---------------------------------------------------------------------------

await check('a member sees their own numbers and nobody elses', async () => {
  await signInAs('priya@knights.ucf.edu');

  const status = await select('v_member_status', {
    select: 'member_id,point_total,is_honorary',
    filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
  });
  assert.ok(status.length <= 1, `a member read ${status.length} rows of the board`);

  const totals = await select('v_member_category_totals', { select: 'member_id,total' });
  assert.ok(totals.length === 0, 'a member read other peoples category totals');
});

await check('a member is offered no duplicates and can merge nobody', async () => {
  const pairs = await select('v_possible_duplicate_members', { select: 'member_a,member_b' });
  assert.deepEqual(pairs, [], 'a member could read the whole roster through the duplicate list');

  await assert.rejects(
    () => callRpc('merge_members', { p_from_id: ABBY, p_into_id: ABIGAIL }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );
  await assert.rejects(
    () => callRpc('dismiss_duplicate_pair', { p_member_a: ABBY, p_member_b: ABIGAIL }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
    'a member could dismiss a duplicate an officer needs to see',
  );
});

await check('a member cannot ask about anybody elses progress', async () => {
  await assert.rejects(
    () =>
      callRpc(
        'fn_member_requirement_status',
        { p_member_id: ABIGAIL, p_requirement_set_id: IDS.SET_CURRENT },
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );
});

await check('a member cannot add a record or a person', async () => {
  const { insert } = await import('../src/rest.js');
  await assert.rejects(
    () =>
      insert(
        'attendance_records',
        [{ event_id: IDS.EVENT_SOAP, member_id: ABIGAIL, source: 'officer_entry' }],
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.status === 403,
  );
  await assert.rejects(
    () => insert('members', [{ first_name: 'Snuck', last_name: 'In' }], { attempts: 1 }),
    (err) => err instanceof RpcError && err.status === 403,
  );
});

// ---------------------------------------------------------------------------

server.close();
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exit(failures ? 1 : 0);
