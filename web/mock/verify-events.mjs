// Checks for the events screen and its QR encoder.
//
// Same rule as verify-admin.mjs: assert the things that fail SILENTLY.
//
//   1. Creating an event is one transactional RPC. The lower-level table
//      fixture still proves that an event row gets its database-generated
//      checkin_token, because without one the QR code has nothing to encode.
//   2. checkin_opens_at is never written, because check-in has to work the
//      moment an event exists. This is a client discipline, not a database
//      one (the column is nullable either way), so the only way to catch a
//      regression is to insert exactly what events.js inserts and read the
//      column back.
//   3. review_policy defaults to manual_review on every created event:
//      invariant 6 (no auto-approval) depends on nobody ever flipping this
//      from the officer screen.
//   4. The UI refuses a second "member types the number" category before any
//      request goes out, because the database's own refusal
//      (one_submitted_value_per_event) is a 409 an officer would otherwise
//      see after already pressing Save.
//   5. A PATCH the mock's policy refuses comes back 200 with an empty array,
//      not an error, exactly as it does for categories and requirements: a
//      caller that does not check the length reports a write that never
//      happened.
//   6. The QR encoder, which is the part that fails silently and expensively:
//      a code that renders but does not scan looks identical to one that
//      does, right up until it is printed and taped to a wall. Two
//      independent checks, neither of which touches the other's internals:
//      a round trip through the module placement and masking, and the
//      Reed-Solomon syndromes of the interleaved codeword stream computed
//      with this file's own GF(256) arithmetic, not qr.js's.
//
// Run: node web/mock/verify-events.mjs   (or npm run verify:events, from web/)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';
import { signInAs as signInAsAccount } from './sign-in.mjs';
import { IDS } from './admin-fixtures.mjs';
import {
  dropRpcResponseOnce,
  failRpcOnce,
  failStorageDeleteOnce,
} from './admin-server.mjs';
import { installDom } from './dom.mjs';

const PORT = 8799;
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

// The page, as it ships. Parsed before anything under src/ is imported, so
// createEvents() and createEventDetail() look their ids up against the real
// markup: an id that stops matching between the two fails here rather than in
// front of an officer.
const adminHtml = await readFile(`${WEB_ROOT}admin/index.html`, 'utf8');
const adminCss = await readFile(`${WEB_ROOT}assets/css/admin.css`, 'utf8');
const dom = installDom(adminHtml);

// The production browser owns activeElement. The intentionally small DOM
// harness does not model focus, so give its shared element prototype the one
// behavior this accessibility regression needs to observe.
let activeElement = null;
Object.defineProperty(globalThis.document, 'activeElement', {
  configurable: true,
  get: () => activeElement,
});
Object.getPrototypeOf(dom.$('event-detail-back')).focus = function focus() {
  activeElement = this;
};

// What the screen opens for the officer, caught rather than opened. Preview
// has to send them to the same URL the QR code encodes, and the only way to
// prove that is to hold on to what it asked for.
const opened = [];
globalThis.window = {
  location: {
    origin: `http://localhost:${PORT}`,
    pathname: '/admin/',
    href: `http://localhost:${PORT}/admin/`,
    replace() {},
  },
  history: { replaceState() {} },
  open: (url, target, features) => {
    opened.push({ url, target, features });
    return null;
  },
};

// The attendee export writes a blob and clicks a link. Both are caught, so
// the bytes an officer would have downloaded are the bytes this file reads.
const downloads = [];
globalThis.Blob = class {
  constructor(parts) {
    this.text = parts.join('');
  }
};
URL.createObjectURL = (blob) => {
  downloads.push(blob.text);
  return 'blob:mock';
};
URL.revokeObjectURL = () => {};

const auth = await import('../src/auth.js');
const { select, insert, patch, remove, callRpc } = await import('../src/rest.js');
const { RpcError } = await import('../src/errors.js');
const { eventsStartupQuery } = await import('../src/events-contract.js');
const {
  validateCategoryRows,
  diffCategoryRows,
  diffEvidenceRow,
  defaultCloseTime,
  toNewYorkDatetimeLocalValue,
  fromNewYorkDatetimeLocalValue,
  eventStatus,
  buildCheckinUrl,
  sortEvents,
  todayDividerIndex,
  todayInNewYork,
} = await import('../src/events-model.js');
const { encodeQR, formatBits, ECC_TABLE_M } = await import('../src/qr.js');
const {
  buildAttendancePastePreview,
  reconstructAttendanceBatchOutcomes,
} = await import('../src/event-detail.js');

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
const reset = async () => {
  await api('/__mock/reset');
  auth.forgetSession();
};
const signInAs = (email) => signInAsAccount(email, PORT);

const server = await startMock(PORT);

const EVENT_SELECT = [
  'id,title,occurred_on,starts_at,ends_at,term_id,checkin_token,checkin_opens_at,checkin_closes_at,config_version,',
  'review_policy,is_published,',
  'event_categories(category_id,credit_mode,fixed_credit),',
  'event_evidence_requirements(id,kind,is_required,prompt)',
].join('');

// ---------------------------------------------------------------------------
process.stdout.write('\ncreating an event\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('officers@pdsaucf.com');

await check('creating an event writes all three tables, and the event comes back with a checkin_token', async () => {
  const [event] = await insert('events', [
    {
      academic_year_id: IDS.YEAR_CURRENT,
      title: 'Verify Event Create',
      occurred_on: '2026-09-01',
      starts_at: '2026-09-01T22:00:00.000Z',
      ends_at: '2026-09-02T00:00:00.000Z',
      checkin_closes_at: '2026-09-01T23:59:00.000Z',
    },
  ]);
  assert.ok(event?.id, 'the insert did not come back with an id');
  assert.ok(event.checkin_token, 'the event has no checkin_token');

  await insert('event_categories', [
    { event_id: event.id, category_id: IDS.CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 1 },
  ]);
  await insert('event_evidence_requirements', [
    { event_id: event.id, kind: 'shirt_photo', is_required: true, prompt: null },
  ]);

  const [reread] = await select('events', {
    select: EVENT_SELECT,
    filters: { id: `eq.${event.id}` },
  });
  assert.equal(reread.event_categories.length, 1, 'event_categories was not written');
  assert.equal(reread.event_categories[0].category_id, IDS.CATEGORY_GBMS);
  assert.equal(reread.event_evidence_requirements.length, 1, 'event_evidence_requirements was not written');
  assert.equal(reread.event_evidence_requirements[0].kind, 'shirt_photo');
});

await check('checkin_opens_at is never written', async () => {
  const [event] = await insert('events', [
    {
      academic_year_id: IDS.YEAR_CURRENT,
      title: 'Verify Opens Null',
      occurred_on: '2026-09-02',
    },
  ]);
  const [reread] = await select('events', {
    select: 'id,checkin_opens_at',
    filters: { id: `eq.${event.id}` },
  });
  assert.equal(reread.checkin_opens_at, null, 'checkin_opens_at was written on create');
});

await check("review_policy on a created event is 'manual_review'", async () => {
  const [event] = await insert('events', [
    {
      academic_year_id: IDS.YEAR_CURRENT,
      title: 'Verify Review Policy',
      occurred_on: '2026-09-03',
    },
  ]);
  const [reread] = await select('events', {
    select: 'id,review_policy,is_published',
    filters: { id: `eq.${event.id}` },
  });
  assert.equal(reread.review_policy, 'manual_review');
  // Migration 29 flips the column default: a newly created event is queued
  // until an officer publishes it or the Monday drop reaches it.
  assert.equal(reread.is_published, false);
});

await check('a second "member types the number" category is refused by the database', async () => {
  const [event] = await insert('events', [
    { academic_year_id: IDS.YEAR_CURRENT, title: 'Verify Double Submission', occurred_on: '2026-09-04' },
  ]);
  await insert('event_categories', [
    { event_id: event.id, category_id: IDS.CATEGORY_GBMS, credit_mode: 'from_submission', fixed_credit: 1 },
  ]);
  await assert.rejects(
    () =>
      insert('event_categories', [
        { event_id: event.id, category_id: IDS.CATEGORY_SOCIALS, credit_mode: 'from_submission', fixed_credit: 1 },
      ]),
    (err) => err instanceof RpcError,
    'a second from_submission link on one event was accepted',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe UI refuses before any request goes out\n');
// ---------------------------------------------------------------------------

await check('validateCategoryRows refuses a second "member types the number" row, with no request involved', () => {
  const rows = [
    { category_id: IDS.CATEGORY_GBMS, credit_mode: 'from_submission', fixed_credit: 1 },
    { category_id: IDS.CATEGORY_SOCIALS, credit_mode: 'from_submission', fixed_credit: 1 },
  ];
  const error = validateCategoryRows(rows);
  assert.ok(error, 'two from_submission rows were accepted');
  assert.match(error, /one category/i);
});

await check('validateCategoryRows accepts one from_submission row among several fixed ones', () => {
  const rows = [
    { category_id: IDS.CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 1 },
    { category_id: IDS.CATEGORY_SOCIALS, credit_mode: 'from_submission', fixed_credit: 1 },
  ];
  assert.equal(validateCategoryRows(rows), null);
});

await check('validateCategoryRows refuses the same category twice on one event', () => {
  const rows = [
    { category_id: IDS.CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 1 },
    { category_id: IDS.CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 2 },
  ];
  assert.ok(validateCategoryRows(rows), 'the same category twice was accepted');
});

await check('diffCategoryRows finds an insert, an update and a removal in one pass', () => {
  const existing = [
    { category_id: IDS.CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 1 },
    { category_id: IDS.CATEGORY_SOCIALS, credit_mode: 'fixed', fixed_credit: 1 },
  ];
  const desired = [
    { category_id: IDS.CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 2 }, // credit changed
    { category_id: IDS.CATEGORY_JOURNAL_CLUB, credit_mode: 'fixed', fixed_credit: 1 }, // new
    // Socials dropped entirely.
  ];
  const { toInsert, toUpdate, toRemove } = diffCategoryRows(existing, desired);
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].category_id, IDS.CATEGORY_JOURNAL_CLUB);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].category_id, IDS.CATEGORY_GBMS);
  assert.equal(toRemove.length, 1);
  assert.equal(toRemove[0].category_id, IDS.CATEGORY_SOCIALS);
});

await check('diffEvidenceRow tells insert, patch, remove and none apart', () => {
  assert.equal(diffEvidenceRow(null, null).action, 'none');
  assert.equal(diffEvidenceRow(null, { kind: 'shirt_photo', prompt: null }).action, 'insert');
  assert.equal(diffEvidenceRow({ id: 'x', kind: 'shirt_photo', prompt: null }, null).action, 'remove');
  assert.equal(
    diffEvidenceRow({ id: 'x', kind: 'shirt_photo', prompt: null }, { kind: 'receipt_photo', prompt: null }).action,
    'patch',
  );
  assert.equal(
    diffEvidenceRow({ id: 'x', kind: 'shirt_photo', prompt: null }, { kind: 'shirt_photo', prompt: null }).action,
    'none',
  );
});

await check('eventStatus reads Open with no close time, and Closed once it passes', () => {
  assert.equal(eventStatus(null), 'Open');
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(eventStatus(past), 'Closed');
  assert.equal(eventStatus(future), 'Open');
});

await check('defaultCloseTime lands on 11:59 PM local time for the given date', () => {
  const iso = defaultCloseTime('2026-03-05');
  const date = new Date(iso);
  assert.equal(date.getHours(), 23);
  assert.equal(date.getMinutes(), 59);
  assert.equal(date.getDate(), 5);
});

await check('actual event times round trip as America/New_York instants', () => {
  const summer = '2026-08-11T22:00:00.000Z';
  const winter = '2027-01-11T23:00:00.000Z';
  assert.equal(toNewYorkDatetimeLocalValue(summer), '2026-08-11T18:00');
  assert.equal(toNewYorkDatetimeLocalValue(winter), '2027-01-11T18:00');
  assert.equal(fromNewYorkDatetimeLocalValue('2026-08-11T18:00'), summer);
  assert.equal(fromNewYorkDatetimeLocalValue('2027-01-11T18:00'), winter);
  assert.equal(fromNewYorkDatetimeLocalValue('2026-03-08T02:30'), null);
  assert.equal(fromNewYorkDatetimeLocalValue('2026-11-01T01:30', '2026-11-01T06:30:00.000Z'), '2026-11-01T06:30:00.000Z');
});

await check('today uses the America/New_York calendar date across UTC rollover', () => {
  assert.equal(todayInNewYork(new Date('2026-08-11T03:59:59.000Z')), '2026-08-10');
  assert.equal(todayInNewYork(new Date('2026-08-11T04:00:00.000Z')), '2026-08-11');
});

await check('ascending events place today at the first current event', () => {
  const events = [
    { title: 'Tomorrow', occurred_on: '2026-08-11' },
    { title: 'Yesterday', occurred_on: '2026-08-09' },
    { title: 'Today', occurred_on: '2026-08-10' },
  ];
  const sorted = sortEvents(events);
  assert.deepEqual(
    sorted.map((event) => event.title),
    ['Yesterday', 'Today', 'Tomorrow'],
    'the model default is not oldest first',
  );
  assert.equal(todayDividerIndex(sorted, 'date_asc', '2026-08-10'), 1);
  assert.equal(sorted[1].occurred_on, '2026-08-10', 'an event on today is above the boundary');
});

await check('today divider hides for one-sided and non-ascending lists', () => {
  const past = [{ occurred_on: '2026-08-08' }, { occurred_on: '2026-08-09' }];
  const current = [{ occurred_on: '2026-08-10' }, { occurred_on: '2026-08-11' }];
  const both = [...past, ...current];
  assert.equal(todayDividerIndex(past, 'date_asc', '2026-08-10'), -1);
  assert.equal(todayDividerIndex(current, 'date_asc', '2026-08-10'), -1);
  assert.equal(todayDividerIndex([...both].reverse(), 'date_desc', '2026-08-10'), -1);
  assert.equal(todayDividerIndex(both, 'title', '2026-08-10'), -1);
  assert.equal(todayDividerIndex(both, 'attendance', '2026-08-10'), -1);
});

await check('buildCheckinUrl resolves against the admin page location and carries the token', () => {
  const url = buildCheckinUrl('https://points.pdsaucf.com/admin/index.html', '7fK2pQ');
  assert.equal(url, 'https://points.pdsaucf.com/c/?e=7fK2pQ');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe event surface stays private\n');
// ---------------------------------------------------------------------------

await check('an anon-key request for events is refused', async () => {
  const res = await fetch(`http://localhost:${PORT}/rest/v1/events?select=id`, {
    headers: { apikey: 'mock-anon-key', Authorization: 'Bearer mock-anon-key' },
  });
  assert.equal(res.status, 401);
});

await signInAs('officers@pdsaucf.com');

// ---------------------------------------------------------------------------
process.stdout.write('\nQR correctness\n');
// ---------------------------------------------------------------------------
// Two independent checks per the brief: a round trip through placement and
// masking, and the Reed-Solomon syndromes of the interleaved stream computed
// with this file's OWN GF(256) tables, never qr.js's. If qr.js's Galois
// tables were wrong, syndromes computed with the same wrong tables would
// still read zero; this would not.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildIndependentGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);
/** Evaluate a polynomial (highest-degree-first coefficients) at x. */
const evalPoly = (coeffs, x) => coeffs.reduce((y, c) => gfMul(y, x) ^ c, 0);

/** Every syndrome of every Reed-Solomon block in the interleaved stream. */
function rsSyndromesAllZero(codewords, version) {
  const [, eccPerBlock, g1c, g1l, g2c, g2l] = ECC_TABLE_M[version];
  const blockLens = [...Array(g1c).fill(g1l), ...Array(g2c).fill(g2l)];
  const blocks = blockLens.map((len) => new Array(len));
  const eccBlocks = Array.from({ length: blockLens.length }, () => new Array(eccPerBlock));
  let idx = 0;
  const maxLen = Math.max(g1l, g2l || 0);
  for (let i = 0; i < maxLen; i += 1) {
    for (let b = 0; b < blockLens.length; b += 1) if (i < blockLens[b]) blocks[b][i] = codewords[idx++];
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (let b = 0; b < blockLens.length; b += 1) eccBlocks[b][i] = codewords[idx++];
  }
  for (let b = 0; b < blockLens.length; b += 1) {
    const full = [...blocks[b], ...eccBlocks[b]];
    for (let s = 0; s < eccPerBlock; s += 1) {
      if (evalPoly(full, GF_EXP[s]) !== 0) return false;
    }
  }
  return true;
}

const MASK_FUNCTIONS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function readDataBitsBack(qr) {
  const { size, modules, isFunction, mask } = qr;
  const maskFn = MASK_FUNCTIONS[mask];
  const bits = [];
  let row = size - 1;
  let rowStep = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        const cc = col - c;
        if (!isFunction[row][cc]) bits.push(modules[row][cc] !== maskFn(row, cc) ? 1 : 0);
      }
      row += rowStep;
      if (row < 0 || row >= size) {
        row -= rowStep;
        rowStep = -rowStep;
        break;
      }
    }
  }
  return bits;
}

function deinterleaveToDataStream(codewords, version) {
  const [dataCodewordCount, , g1c, g1l, g2c, g2l] = ECC_TABLE_M[version];
  const blockLens = [...Array(g1c).fill(g1l), ...Array(g2c).fill(g2l)];
  const blocks = blockLens.map((len) => new Array(len));
  let idx = 0;
  const maxLen = Math.max(g1l, g2l || 0);
  for (let i = 0; i < maxLen; i += 1) {
    for (let b = 0; b < blockLens.length; b += 1) if (i < blockLens[b]) blocks[b][i] = codewords[idx++];
  }
  return blocks.flat().slice(0, dataCodewordCount);
}

/** Reverses placement and masking, then reads back the byte-mode payload. */
function decodeRoundTrip(qr) {
  const bits = readDataBitsBack(qr);
  const interleaved = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    interleaved.push(byte);
  }
  const dataCodewords = deinterleaveToDataStream(interleaved.slice(0, qr.codewords.length), qr.version);

  const dataBits = [];
  for (const byte of dataCodewords) for (let i = 7; i >= 0; i -= 1) dataBits.push((byte >> i) & 1);
  let at = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | dataBits[at++];
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode 0100, got ${mode.toString(2)}`);
  const len = take(qr.version <= 9 ? 8 : 16);
  let out = '';
  for (let i = 0; i < len; i += 1) out += String.fromCharCode(take(8));
  return out;
}

const qrUrls = [
  buildCheckinUrl('https://points.pdsaucf.com/admin/', 'a1B2c3D4e5'), // the realistic case
  'https://points.pdsaucf.com/c/?e=' + 'x'.repeat(150), // forces a large version
  'https://points.pdsaucf.com/c/?e=z',
];

for (const url of qrUrls) {
  const qr = encodeQR(url);

  await check(`QR round trip recovers the original URL (version ${qr.version})`, () => {
    assert.equal(decodeRoundTrip(qr), url);
  });

  await check(`QR Reed-Solomon syndromes are all zero (version ${qr.version})`, () => {
    assert.ok(rsSyndromesAllZero(qr.codewords, qr.version), 'a nonzero syndrome means a corrupt codeword');
  });

  await check(`QR finder patterns sit at the three corners (version ${qr.version})`, () => {
    const { size, modules } = qr;
    assert.equal(modules[0][0], true, 'top-left finder missing');
    assert.equal(modules[0][size - 1], true, 'top-right finder missing');
    assert.equal(modules[size - 1][0], true, 'bottom-left finder missing');
  });

  await check(`QR timing patterns alternate (version ${qr.version})`, () => {
    const { size, modules } = qr;
    for (let i = 8; i < size - 8; i += 1) {
      assert.equal(modules[6][i], i % 2 === 0, `row timing pattern wrong at column ${i}`);
      assert.equal(modules[i][6], i % 2 === 0, `column timing pattern wrong at row ${i}`);
    }
  });

  await check(`QR format information matches the published constant for level M, mask ${qr.mask} (version ${qr.version})`, () => {
    const expected = formatBits(qr.mask);
    const { modules, size } = qr;
    let bits = 0;
    for (let i = 0; i <= 5; i += 1) bits |= (modules[i][8] ? 1 : 0) << i;
    bits |= (modules[7][8] ? 1 : 0) << 6;
    bits |= (modules[8][8] ? 1 : 0) << 7;
    bits |= (modules[8][7] ? 1 : 0) << 8;
    for (let i = 9; i <= 14; i += 1) bits |= (modules[8][14 - i] ? 1 : 0) << i;
    assert.equal(bits, expected, `copy 1: ${bits.toString(2)} !== ${expected.toString(2)}`);

    let bits2 = 0;
    for (let i = 0; i <= 7; i += 1) bits2 |= (modules[8][size - 1 - i] ? 1 : 0) << i;
    for (let i = 8; i <= 14; i += 1) bits2 |= (modules[size - 15 + i][8] ? 1 : 0) << i;
    assert.equal(bits2, expected, `copy 2: ${bits2.toString(2)} !== ${expected.toString(2)}`);
  });
}

// ---------------------------------------------------------------------------
process.stdout.write('\nthe screen itself\n');
// ---------------------------------------------------------------------------
//
// Everything above drives the modules and the transport. From here the shipped
// page is mounted on mock/dom.mjs and admin.js's own start() runs against it,
// so what is asserted is the rendered DOM: an id that stopped matching between
// admin/index.html and events.js or event-detail.js fails right here.

await reset();

const { start } = await import('../src/admin.js');

/** Waits for the screen to settle, rather than for a fixed number of turns. */
async function until(predicate, message, timeout = 4000) {
  const stop = Date.now() + timeout;
  for (;;) {
    // Awaited, so a predicate that reads the mock's audit log works. An
    // unawaited promise is truthy, and a wait that returns on the first turn
    // is a check that asserts against a screen mid-flight.
    if (await predicate()) return;
    if (Date.now() > stop) throw new Error(`timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const adminAudit = () => api('/__mock/audit').then((body) => body.admin);
const eventRowFor = (title) =>
  dom
    .$('event-list')
    .querySelectorAll('.event-row')
    .find((row) => row.querySelector('.event-title')?.textContent.trim() === title) ?? null;
const rowTitles = () =>
  dom.$('event-list').querySelectorAll('.event-title').map((node) => node.textContent.trim());
const todayDivider = () => dom.$('event-list').querySelector('.event-today-divider');
const tabLabels = () =>
  dom.$('event-category-tabs').querySelectorAll('.filter-tab').map((node) => node.textContent.trim());
const attendeeNames = () =>
  dom.$('attendee-rows').querySelectorAll('tr').map((row) => row.querySelectorAll('td')[0].textContent.trim());
const rowFor = (name) =>
  dom
    .$('attendee-rows')
    .querySelectorAll('tr')
    .find((row) => row.querySelectorAll('td')[0].textContent.includes(name)) ?? null;
const rowForRecord = (recordId) =>
  dom
    .$('attendee-rows')
    .querySelectorAll('tr')
    .find((row) => row.getAttribute('data-record') === recordId) ?? null;

const detailSnapshot = () => {
  const stats = Object.fromEntries(
    dom
      .$('event-detail-stats')
      .querySelectorAll('.event-stat')
      .map((tile) => {
        const label = tile.querySelector('.event-stat-label').textContent.trim();
        const raw = tile.querySelector('.event-stat-value').textContent.trim();
        return [label, /^\d+$/.test(raw) ? Number(raw) : raw];
      }),
  );
  const sources = Object.fromEntries(
    dom
      .$('event-detail-sources')
      .textContent.split(' · ')
      .map((part) => /^(.*) (\d+)$/.exec(part.trim()))
      .filter(Boolean)
      .map((match) => [match[1], Number(match[2])]),
  );
  return {
    records: dom.$('attendee-rows').querySelectorAll('tr').length,
    count: dom.$('attendee-count').textContent.trim(),
    stats,
    sources,
  };
};

function failRpcAsMissingOnce(name) {
  const originalFetch = globalThis.fetch;
  let pending = true;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (pending && new URL(url).pathname === `/rest/v1/rpc/${name}`) {
      pending = false;
      globalThis.fetch = originalFetch;
      return new Response(
        JSON.stringify({
          code: 'PGRST202',
          message: `Could not find the function public.${name} in the schema cache`,
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function dropRpcBodyOnce(name) {
  const originalFetch = globalThis.fetch;
  let pending = true;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const response = await originalFetch(input, init);
    if (new URL(url).pathname === `/rest/v1/rpc/${name}`) calls += 1;
    if (pending && new URL(url).pathname === `/rest/v1/rpc/${name}`) {
      pending = false;
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text: async () => {
          throw new TypeError('response body terminated');
        },
      };
    }
    return response;
  };
  const restore = () => {
    globalThis.fetch = originalFetch;
  };
  restore.calls = () => calls;
  return restore;
}

function failRestReadOnce(table) {
  const originalFetch = globalThis.fetch;
  let pending = true;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (pending && new URL(url).pathname === `/rest/v1/${table}`) {
      pending = false;
      globalThis.fetch = originalFetch;
      await originalFetch(input, init);
      return new Response(JSON.stringify({ code: 'REST_READ_FAILED', message: 'read failed' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function answerRestReadOnce(table, rows) {
  const originalFetch = globalThis.fetch;
  let seen;
  const captured = new Promise((resolve) => {
    seen = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url).pathname === `/rest/v1/${table}`) {
      globalThis.fetch = originalFetch;
      seen();
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };
  return captured;
}

function holdNextRestResponse(table) {
  const originalFetch = globalThis.fetch;
  let release;
  let captured;
  let pending = true;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const responseCaptured = new Promise((resolve) => {
    captured = resolve;
  });

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (pending && new URL(url).pathname === `/rest/v1/${table}`) {
      pending = false;
      const response = await originalFetch(input, init);
      captured();
      await released;
      return response;
    }
    return originalFetch(input, init);
  };

  return {
    captured: responseCaptured,
    release() {
      globalThis.fetch = originalFetch;
      release();
    },
  };
}

function failInitialEventsStartupOnce() {
  const originalFetch = globalThis.fetch;
  const expectedUrl = `http://localhost:${PORT}/rest/v1/events?${eventsStartupQuery(IDS.YEAR_CURRENT)}`;
  let request = null;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!request && url === expectedUrl && (init.method ?? 'GET') === 'GET') {
      request = { url, init };
      globalThis.fetch = originalFetch;
      // Let the mock record the request, then replace only what the shipped
      // page receives with the production schema-drift response.
      await originalFetch(input, init);
      return new Response(
        JSON.stringify({
          code: '42703',
          details: null,
          hint: null,
          message: 'column events.starts_at does not exist',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  };

  return {
    expectedUrl,
    request: () => request,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function captureRequests() {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    requests.push({ url, init });
    return originalFetch(input, init);
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

const initialStorageLoad = holdNextRestResponse('v_purge_runs_outstanding');
const initialEventsFailure = failInitialEventsStartupOnce();
const SCREEN_NOW = new Date('2026-08-10T16:00:00.000Z');
start({ now: () => new Date(SCREEN_NOW) });
dom.$('signin-passcode').value = 'mock-passcode';
dom.fire(dom.$('signin-form'), 'submit');
await until(() => !dom.$('view-app').hidden, 'the app never opened');
await until(
  () => dom.$('screen-message-title').textContent === 'Events unavailable',
  'the Events startup failure never reached the shared banner',
);
await until(
  () =>
    dom.$('loading-review').hidden &&
    dom.$('loading-progress').hidden &&
    dom.$('loading-roster').hidden &&
    dom.$('loading-requirements').hidden,
  'the other startup panels did not continue after Events failed',
);

await check('an Events query failure does not erase categories from New event', async () => {
  assert.equal(dom.$('event-new').disabled, false, 'New event stayed disabled after categories loaded');
  dom.click(dom.$('event-new'));
  const picker = dom.$('event-categories').querySelector('select');
  const offered = picker
    .querySelectorAll('option')
    .map((option) => option.textContent.trim())
    .filter((label) => !['Choose a category', 'New event category…'].includes(label));
  const expected = (await adminAudit()).categories
    .filter((category) => !category.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((category) => category.name);
  assert.deepEqual(offered, expected, 'New event did not offer every active category');
  assert.ok(!offered.includes('President Workshops'), 'New event offered a retired category');
  dom.click(dom.$('event-cancel'));
});

await check('an Events schema drift banner reloads Events without reloading Review', async () => {
  const failed = initialEventsFailure.request();
  assert.ok(failed, 'the initial Events request was not intercepted');
  assert.equal(failed.url, initialEventsFailure.expectedUrl);
  assert.equal(failed.init.method, 'GET');
  assert.equal(dom.$('tab-events').getAttribute('aria-selected'), 'true');
  assert.equal(dom.$('panel-events').hidden, false);
  assert.equal(dom.$('screen-message').hidden, false);
  assert.equal(dom.$('screen-message-title').textContent, 'Events unavailable');
  assert.equal(dom.$('screen-message-body').textContent, 'Try again.');
  assert.equal(dom.$('screen-message-action').textContent, 'Reload Events');

  const captured = captureRequests();
  try {
    dom.click(dom.$('screen-message-action'));
    await until(() => !dom.$('event-list').hidden, 'Reload Events did not recover the list');
  } finally {
    captured.restore();
  }

  const eventReads = captured.requests.filter(
    ({ url, init }) => url === initialEventsFailure.expectedUrl && init.method === 'GET',
  );
  const reviewReads = captured.requests.filter(({ url, init }) => {
    const parsed = new URL(url);
    return (
      parsed.pathname === '/rest/v1/attendance_records' &&
      parsed.searchParams.get('status') === 'eq.pending' &&
      init.method === 'GET'
    );
  });
  assert.equal(eventReads.length, 1, 'the recovery action did not retry the Events startup GET');
  assert.equal(reviewReads.length, 0, 'the Events recovery action reloaded Review');
});

initialEventsFailure.restore();
await until(() => !dom.$('event-list').hidden, 'the events list never rendered after recovery');

await check('Events opens oldest first with Today between past and current events', async () => {
  const sort = dom.$('events-sort');
  assert.equal(sort.value, 'date_asc');
  assert.equal(
    sort.querySelectorAll('option').find((option) => option.value === sort.value)?.textContent,
    'Oldest first',
  );
  const loadedEvents = await select('events', {
    select: 'title,occurred_on',
    filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
  });
  assert.deepEqual(
    rowTitles(),
    sortEvents(loadedEvents).map((event) => event.title),
    'initial rows are not ascending by calendar date',
  );

  const divider = todayDivider();
  assert.ok(divider, 'Today is missing');
  assert.equal(divider.textContent.trim(), 'Today');
  assert.equal(divider.getAttribute('role'), 'separator');
  assert.equal(divider.getAttribute('aria-label'), 'Today');
  assert.equal(divider.hasAttribute('tabindex'), false, 'Today is focusable');
  assert.ok(divider.querySelector('.event-today-dot'), 'Today has no marker');
  assert.ok(divider.querySelector('.event-today-line'), 'Today has no line');

  const children = dom.$('event-list').children;
  const at = children.indexOf(divider);
  assert.equal(children[at - 1].querySelector('.event-title').textContent, 'Give Kids A Smile');
  assert.equal(children[at + 1].querySelector('.event-title').textContent, 'Soap Carving');
  const rowCount = dom.$('event-list').querySelectorAll('.event-row').length;
  assert.equal(dom.$('events-count').textContent, `${rowCount} events`);
});

await check('search recomputes Today without server reads', async () => {
  const captured = captureRequests();
  const search = dom.$('events-search');
  try {
    search.value = 'Give Kids';
    dom.fire(search, 'input');
    assert.deepEqual(rowTitles(), ['Give Kids A Smile']);
    assert.equal(Boolean(todayDivider()), false, 'a past-only search left Today behind');

    search.value = 'Soap';
    dom.fire(search, 'input');
    assert.deepEqual(rowTitles(), ['Soap Carving']);
    assert.equal(Boolean(todayDivider()), false, 'a current-only search added Today');

    search.value = '';
    dom.fire(search, 'input');
    assert.ok(todayDivider(), 'clearing search did not restore Today');

    const eventReads = captured.requests.filter(({ url }) => new URL(url).pathname === '/rest/v1/events');
    assert.equal(eventReads.length, 0, 'search re-read events from the server');
    const rowCount = dom.$('event-list').querySelectorAll('.event-row').length;
    assert.equal(dom.$('events-count').textContent, `${rowCount} events`);
  } finally {
    captured.restore();
  }
});

await check('category rows filter duplicates and an inline category appears immediately', async () => {
  dom.click(dom.$('event-new'));
  let pickers = dom.$('event-categories').querySelectorAll('select');
  pickers[0].value = IDS.CATEGORY_GBMS;
  dom.fire(pickers[0], 'change');

  dom.click(dom.$('event-category-add'));
  pickers = dom.$('event-categories').querySelectorAll('select');
  assert.equal(pickers.length, 2);
  assert.ok(
    !pickers[1].querySelectorAll('option').some((option) => option.getAttribute('value') === IDS.CATEGORY_GBMS),
    'a selected category was still offered in another row',
  );

  pickers[1].value = 'new';
  dom.fire(pickers[1], 'change');
  dom.$('event-new-category-name').value = 'Immediate Category';
  dom.fire(dom.$('event-new-category-form'), 'submit');
  await until(
    () =>
      dom.$('event-categories').querySelectorAll('select')[1]?.querySelectorAll('option')
        .some((option) => option.textContent.trim() === 'Immediate Category' && option.selected),
    'the inline category did not become the selected option',
  );
  assert.ok(
    (await adminAudit()).categories.some((category) => category.name === 'Immediate Category'),
    'the inline category was not written',
  );
  dom.click(dom.$('event-cancel'));
});

await check('Edit saves a retired link unchanged and reloads after a stale conflict', async () => {
  const [event] = await insert('events', [
    {
      academic_year_id: IDS.YEAR_CURRENT,
      title: 'Retired Category History',
      occurred_on: '2026-08-01',
    },
  ]);
  await insert('event_categories', [
    {
      event_id: event.id,
      category_id: IDS.CATEGORY_RETIRED,
      credit_mode: 'fixed',
      fixed_credit: 1,
    },
  ]);
  const [approved] = await insert('attendance_records', [
    {
      event_id: event.id,
      member_id: IDS.MEMBER_ABIGAIL,
      status: 'approved',
      source: 'officer_entry',
    },
  ]);
  await callRpc('review_records', {
    p_ids: [approved.id],
    p_decision: 'approve',
    p_note: null,
  });
  dom.fire(dom.$('year-select'), 'change');
  await until(() => rowTitles().includes('Retired Category History'), 'the historical event did not load');

  const historicalRow = eventRowFor('Retired Category History');
  dom.click(dom.buttonNamed(historicalRow, 'View event'));
  await until(() => !dom.$('event-detail-body').hidden, 'the historical event did not open');
  dom.click(dom.$('event-detail-edit'));
  let pickers = dom.$('event-categories').querySelectorAll('select');
  assert.ok(
    pickers[0].querySelectorAll('option').some(
      (option) => option.getAttribute('value') === IDS.CATEGORY_RETIRED && option.selected,
    ),
    'Edit did not display the retired category it already references',
  );

  dom.click(dom.$('event-category-add'));
  pickers = dom.$('event-categories').querySelectorAll('select');
  assert.ok(
    !pickers[1].querySelectorAll('option').some(
      (option) => option.getAttribute('value') === IDS.CATEGORY_RETIRED,
    ),
    'a retired category was offered on a new row',
  );

  dom.$('event-title').value = 'Retired Category Saved';
  dom.$('event-starts').value = '2026-08-01T18:00';
  dom.$('event-ends').value = '2026-08-01T19:00';
  dom.fire(dom.$('event-form'), 'submit');
  await until(
    async () => (await adminAudit()).calls.some(
      (call) => call.fn === 'save_event_config' && call.eventId === event.id,
    ),
    'the retired-link form did not call save_event_config',
  );
  await until(() => !dom.$('event-save').disabled, 'the retired-link save never settled');
  assert.ok(dom.$('event-error').hidden, dom.$('event-error').textContent || 'the retired-link save failed');
  const [savedTitle] = await select('events', { select: 'title', filters: { id: `eq.${event.id}` } });
  assert.equal(
    savedTitle?.title,
    'Retired Category Saved',
    `the retired-link edit did not save (${dom.$('screen-message-title').textContent})`,
  );

  let [savedEvent] = await select('events', {
    select: EVENT_SELECT,
    filters: { id: `eq.${event.id}` },
  });
  let savedLink = savedEvent.event_categories.find(
    (row) => row.category_id === IDS.CATEGORY_RETIRED,
  );
  assert.equal(savedLink?.credit_mode, 'fixed', 'the retired link mode changed');
  assert.equal(Number(savedLink?.fixed_credit), 1, 'the retired link credit changed');
  assert.ok(
    (await adminAudit()).attendance.some(
      (row) => row.event_id === event.id && row.member_id === IDS.MEMBER_ABIGAIL && row.status === 'approved',
    ),
    'the approved attendance changed during the edit',
  );

  await until(() => !dom.$('event-detail-body').hidden, 'the saved event did not reopen');
  dom.click(dom.$('event-detail-edit'));
  const [snapshot] = await select('events', {
    select: EVENT_SELECT,
    filters: { id: `eq.${event.id}` },
  });
  await callRpc('save_event_config', {
    p_event_id: event.id,
    p_academic_year_id: IDS.YEAR_CURRENT,
    p_event: {
      title: 'Retired Category Concurrent',
      occurred_on: snapshot.occurred_on,
      starts_at: snapshot.starts_at,
      ends_at: snapshot.ends_at,
      term_id: snapshot.term_id,
      checkin_closes_at: snapshot.checkin_closes_at,
    },
    p_categories: snapshot.event_categories.map((row) => ({
      category_id: row.category_id,
      credit_mode: row.credit_mode,
      fixed_credit: row.fixed_credit,
    })),
    p_evidence: null,
    p_expected_config_version: snapshot.config_version,
    p_create: false,
  });
  dom.$('event-title').value = 'Retired Category Stale';
  dom.fire(dom.$('event-form'), 'submit');
  await until(
    () => dom.$('screen-message-title').textContent === 'Event changed',
    'the stale save did not show the conflict',
  );
  assert.ok(dom.$('event-form-view').hidden, 'the stale form stayed open');
  assert.ok(rowTitles().includes('Retired Category Concurrent'), 'the authoritative event was not reloaded');
  assert.ok(!rowTitles().includes('Retired Category Stale'), 'the stale edit overwrote the event');

  [savedEvent] = await select('events', {
    select: EVENT_SELECT,
    filters: { id: `eq.${event.id}` },
  });
  savedLink = savedEvent.event_categories.find((row) => row.category_id === IDS.CATEGORY_RETIRED);
  assert.equal(Number(savedLink?.fixed_credit), 1, 'the conflict changed retired credit');
  await remove('attendance_records', { id: `eq.${approved.id}` });
  await remove('events', { id: `eq.${event.id}` });
  dom.fire(dom.$('year-select'), 'change');
  await until(() => !rowTitles().includes('Retired Category History'), 'the test event stayed on screen');
});

await check('category loading and failure cannot look like an empty picker', async () => {
  const held = holdNextRestResponse('categories');
  dom.fire(dom.$('year-select'), 'change');
  await held.captured;
  assert.equal(dom.$('event-new').disabled, true);
  assert.equal(dom.$('event-new').title, 'Categories loading');
  held.release();
  await until(() => dom.$('event-new').disabled === false, 'New event did not recover after categories loaded');

  const restore = failRestReadOnce('categories');
  dom.fire(dom.$('year-select'), 'change');
  await until(
    () => dom.$('event-new').title === 'Categories unavailable',
    'a category read failure did not disable New event',
  );
  restore();
  assert.ok(dom.$('event-form-view').hidden, 'a failed category read opened an empty form');

  dom.fire(dom.$('year-select'), 'change');
  await until(() => dom.$('event-new').disabled === false, 'New event did not recover after retry');

  const emptyRead = answerRestReadOnce('categories', []);
  dom.fire(dom.$('year-select'), 'change');
  await emptyRead;
  await until(() => dom.$('event-new').disabled === false, 'an empty category read did not settle');
  dom.click(dom.$('event-new'));
  assert.deepEqual(
    dom.$('event-categories').querySelectorAll('option').map((option) => option.textContent.trim()),
    ['Choose a category', 'New event category…'],
    'the real empty state did not keep inline category creation available',
  );
  dom.click(dom.$('event-cancel'));

  dom.fire(dom.$('year-select'), 'change');
  await until(
    () => dom.$('event-categories').hidden || dom.$('event-new').disabled === false,
    'categories did not recover after the empty-state check',
  );
});

await check('term loading and failure block the form without retaining another year', async () => {
  const held = holdNextRestResponse('terms');
  dom.fire(dom.$('year-select'), 'change');
  await held.captured;
  assert.equal(dom.$('event-new').disabled, true);
  assert.equal(dom.$('event-new').title, 'Terms loading');
  held.release();
  await until(() => dom.$('event-new').disabled === false, 'New event did not recover after terms loaded');

  const past = dom.$('year-select').querySelectorAll('option').find(
    (option) => option.textContent.trim() === '2025-2026',
  );
  const current = dom.$('year-select').querySelectorAll('option').find(
    (option) => option.textContent.trim() === '2026-2027',
  );
  const restore = failRestReadOnce('terms');
  dom.$('year-select').value = past.getAttribute('value');
  dom.fire(dom.$('year-select'), 'change');
  await until(
    () => dom.$('event-new').title === 'Terms unavailable',
    'a term read failure did not disable New event',
  );
  restore();
  assert.equal(dom.$('event-new').disabled, true);
  assert.ok(dom.$('event-form-view').hidden, 'a failed term read opened a form with stale terms');

  dom.$('year-select').value = current.getAttribute('value');
  dom.fire(dom.$('year-select'), 'change');
  await until(() => dom.$('event-new').disabled === false, 'New event did not recover after terms retry');
});

await check('a read-only RPC retries when its response body is lost', async () => {
  const restoreFetch = dropRpcBodyOnce('fn_storage_usage');
  try {
    const rows = await callRpc('fn_storage_usage', undefined, { sleep: async () => {} });
    assert.ok(Array.isArray(rows) && rows.length === 1, 'the read did not recover its result');
  } finally {
    restoreFetch();
  }
  assert.equal(restoreFetch.calls(), 2, 'the read-only RPC did not retry exactly once');
});

await check('attendance batch recovery is a retryable authoritative read', async () => {
  const batchKey = 'mock-recovery-read';
  await callRpc('add_officer_attendance_batch', {
    p_event_id: IDS.EVENT_GKAS,
    p_entries: [{
      line: 1,
      claimed_name: 'One',
      disposition: 'invalid',
      member_id: null,
      batch_key: batchKey,
    }],
    p_submitted_value: 0,
  });
  const restoreFetch = dropRpcBodyOnce('recover_officer_attendance_batch');
  try {
    const outcomes = await callRpc('recover_officer_attendance_batch', {
      p_event_id: IDS.EVENT_GKAS,
      p_batch_key: batchKey,
    }, { sleep: async () => {} });
    assert.deepEqual(outcomes.map((row) => row.outcome), ['invalid']);
  } finally {
    restoreFetch();
  }
  assert.equal(restoreFetch.calls(), 2, 'batch recovery was not retried as a read');
  assert.equal(
    await callRpc('recover_officer_attendance_batch', {
      p_event_id: IDS.EVENT_GKAS,
      p_batch_key: 'missing-key',
    }),
    null,
  );
});

await check('the events list draws the year, and last year stays out of it', () => {
  const titles = rowTitles();
  assert.ok(titles.includes('Spring GBM 5'), `Spring GBM 5 is missing: ${titles.join(', ')}`);
  assert.ok(titles.includes('Health Fair'), 'Health Fair is missing');
  assert.ok(!titles.includes('Fall GBM 1'), 'last year\'s event is on this year\'s list');
});

await check('the editor requires paired, ordered actual times', async () => {
  const before = (await select('events', {
    select: 'id',
    filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
  })).length;
  dom.click(dom.$('event-new'));
  dom.$('event-title').value = 'Verify Time Validation';
  dom.$('event-starts').value = '2026-09-20T18:00';
  dom.fire(dom.$('event-form'), 'submit');
  assert.match(dom.$('event-error').textContent, /both event times/i);

  dom.$('event-ends').value = '2026-09-20T17:00';
  dom.fire(dom.$('event-form'), 'submit');
  assert.match(dom.$('event-error').textContent, /end must be after/i);
  const after = (await select('events', {
    select: 'id',
    filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
  })).length;
  assert.equal(after, before, 'an invalid time pair was submitted');
  dom.click(dom.$('event-cancel'));
});

// Migration 25 dropped location on the stated grounds that the club does not
// use it; migration 29 (docs/05-events-page.md) restores it for the public
// /events page, alongside three new fields. This is what proves the round
// trip: typed in the form, sent by save_event_config(), and read back by the
// next load, the way every other field on this form already is.
await check('Location, Attire, Sign-up and Description save and reload with the event', async () => {
  dom.click(dom.$('event-new'));
  dom.$('event-title').value = 'Verify Public Fields';
  dom.$('event-date').value = '2026-09-25';
  dom.$('event-location').value = '  Student Union 218  ';
  dom.$('event-attire').value = 'Business casual';
  dom.$('event-signup').value = 'https://forms.example.com/verify-public-fields';
  dom.$('event-description').value = 'What a member reads on the public events page.';
  dom.fire(dom.$('event-form'), 'submit');
  // The form hides the instant hideForm() runs, before the reload it kicks
  // off has repainted the list with the new row: waiting on the form alone
  // is a race, so this waits for the row itself.
  await until(() => Boolean(eventRowFor('Verify Public Fields')), 'the new event never appeared in the list');

  const [saved] = await select('events', {
    select: 'id,title,location,attire,signup,description',
    filters: { title: 'eq.Verify Public Fields' },
  });
  assert.ok(saved, 'the new event is missing from the table');
  assert.equal(saved.location, 'Student Union 218');
  assert.equal(saved.attire, 'Business casual');
  assert.equal(saved.signup, 'https://forms.example.com/verify-public-fields');
  assert.equal(saved.description, 'What a member reads on the public events page.');

  const row = eventRowFor('Verify Public Fields');
  dom.click(dom.buttonNamed(row, 'Edit'));
  assert.equal(dom.$('event-location').value, 'Student Union 218');
  assert.equal(dom.$('event-attire').value, 'Business casual');
  assert.equal(dom.$('event-signup').value, 'https://forms.example.com/verify-public-fields');
  assert.equal(dom.$('event-description').value, 'What a member reads on the public events page.');

  // Blanked, the same way every other optional field on this form clears to
  // null rather than to an empty string sitting in the column forever.
  dom.$('event-location').value = '';
  dom.$('event-attire').value = '';
  dom.$('event-signup').value = '';
  dom.$('event-description').value = '';
  dom.fire(dom.$('event-form'), 'submit');
  await until(() => dom.$('event-form-view').hidden, 'the cleared event did not save');

  const [cleared] = await select('events', {
    select: 'location,attire,signup,description',
    filters: { title: 'eq.Verify Public Fields' },
  });
  assert.equal(cleared.location, null);
  assert.equal(cleared.attire, null);
  assert.equal(cleared.signup, null);
  assert.equal(cleared.description, null);
});

// This is the ordinary steady state for most events (hardly any get
// published by hand): is_published stays false forever and is_visible turns
// true on its own from the Monday drop. A card that branched on is_published
// first would call this "queued" with a stale drop date already in the past
// and offer a Publish button for something the whole club can already see.
// Unpublish must not be offered either: set_event_published(id, false) would
// only flip a column here, since fn_event_is_visible() keeps returning true
// from the drop alone once release_at has passed while the toggle is on, so
// a button that cannot take effect must not be drawn as though it can.
await check('an auto-released event reads Published, solid, with no Publish or Unpublish button', async () => {
  const search = dom.$('events-search');
  search.value = 'Test Events Page Auto Released';
  dom.fire(search, 'input');
  await until(
    () => rowTitles().includes('Test Events Page Auto Released'),
    'the auto-released fixture never appeared',
  );

  const row = eventRowFor('Test Events Page Auto Released');
  assert.ok(row, 'Test Events Page Auto Released is missing from the list');
  assert.equal(row.dataset.visible, 'true', 'an auto-released event drew as not visible');
  const status = row.querySelector('.event-publish-status');
  assert.equal(status?.textContent.trim(), 'Published', `status reads "${status?.textContent}"`);
  assert.equal(dom.buttonNamed(row, 'Publish'), null, 'a visible event still offers Publish');
  assert.equal(dom.buttonNamed(row, 'Unpublish'), null, 'Unpublish is offered where it would be a no-op');
  assert.doesNotMatch(
    row.querySelector('.event-actions').textContent,
    /null/,
    'omitting the publish button left a stray "null" in the actions row',
  );

  dom.click(dom.buttonNamed(row, 'View event'));
  await until(() => !dom.$('event-detail-body').hidden, 'the auto-released event detail never opened');
  assert.equal(
    dom.$('event-detail-publish-status').textContent.trim(),
    'Published',
    'the detail screen disagrees with its own card',
  );
  assert.equal(dom.$('event-detail-publish').hidden, true, 'the detail toolbar offers a no-op Unpublish');
  dom.click(dom.$('event-detail-back'));

  search.value = '';
  dom.fire(search, 'input');
});

await check('event cards separate headings, status metadata, counts, and actions', async () => {
  await patch(
    'events',
    { id: `eq.${IDS.EVENT_SOAP}` },
    { checkin_closes_at: new Date(Date.now() - 60_000).toISOString() },
  );
  dom.fire(dom.$('year-select'), 'change');
  await until(
    () =>
      eventRowFor('Soap Carving')
        ?.querySelector('.event-checkin-status')
        ?.textContent.trim() === 'Check-in closed',
    'the closed card never rendered',
  );

  const rows = dom.$('event-list').querySelectorAll('.event-row');
  const statuses = new Set();
  assert.ok(rows.length > 1, 'there are not enough cards to check both statuses');

  for (const row of rows) {
    const title = row.querySelector('.event-title');
    assert.equal(title?.tagName, 'H3', `the title is not a heading: ${row.textContent}`);
    assert.equal(title.querySelector('button, a'), null, 'the title still contains navigation');
    assert.equal(row.querySelector('.event-open'), null, 'the hidden title button still exists');
    assert.ok(row.querySelector('.event-date')?.textContent.trim(), 'the date is missing');
    assert.ok(row.querySelector('.chip-row'), 'the category metadata is missing');

    const view = dom.buttonNamed(row, 'View event');
    assert.ok(view, `View event is missing from ${title.textContent}`);
    assert.match(view.getAttribute('class') ?? '', /button-primary/);

    const qr = dom.buttonNamed(row, 'QR');
    const edit = dom.buttonNamed(row, 'Edit');
    assert.equal(qr?.getAttribute('aria-label'), `QR code for ${title.textContent}`);
    assert.equal(edit?.getAttribute('aria-label'), `Edit ${title.textContent}`);

    const status = row.querySelector('.event-checkin-status');
    assert.equal(status?.tagName, 'SPAN', 'check-in status is not plain metadata');
    assert.equal(status.getAttribute('role'), null, 'check-in status has an interactive role');
    assert.equal(status.querySelector('button, a'), null, 'check-in status contains a control');
    assert.match(status.textContent.trim(), /^Check-in (open|closed)$/);
    assert.equal(status.querySelector('.event-status-dot')?.getAttribute('aria-hidden'), 'true');
    statuses.add(status.textContent.trim());

    const counts = row.querySelector('.event-counts')?.textContent.trim() ?? '';
    assert.match(counts, /^\d+ approved · \d+ waiting$/);
    assert.doesNotMatch(counts, /pending/i);
  }

  assert.deepEqual(statuses, new Set(['Check-in open', 'Check-in closed']));
  assert.ok(
    rows.some((row) => /photo required/.test(row.querySelector('.event-title-cell').textContent)),
    'photo-required metadata disappeared',
  );
});

await check('View event opens the event named on its card', async () => {
  const row = eventRowFor('Field Day');
  assert.ok(row, 'Field Day is not on the list');
  const view = dom.buttonNamed(row, 'View event');
  view.focus();
  assert.equal(document.activeElement, view, 'the originating View event button was not focused');
  dom.click(view);
  assert.equal(
    document.activeElement,
    dom.$('event-detail-back'),
    'detail entry left focus in the hidden list',
  );
  await until(() => !dom.$('event-detail-body').hidden, 'View event did not open the detail');
  assert.equal(dom.$('event-detail-title').textContent, 'Field Day');
  dom.click(dom.$('event-detail-back'));
  await until(() => !dom.$('event-list').hidden, 'Back did not return to the cards');
  const returned = dom.buttonNamed(eventRowFor('Field Day'), 'View event');
  assert.notEqual(returned, view, 'Back did not rebuild the event cards');
  assert.equal(document.activeElement, returned, 'Back did not restore focus to Field Day');
});

await check('ordinary list repainting does not steal focus', () => {
  const search = dom.$('events-search');
  search.focus();
  dom.$('events-sort').value = 'title';
  dom.fire(dom.$('events-sort'), 'change');
  assert.equal(document.activeElement, search);
  dom.$('events-sort').value = 'date_asc';
  dom.fire(dom.$('events-sort'), 'change');
  assert.equal(document.activeElement, search);
});

await check('card QR has a working Back control and Edit keeps its existing flow', async () => {
  let row = eventRowFor('Soap Carving');
  assert.ok(row, 'Soap Carving is not on the list');
  dom.click(dom.buttonNamed(row, 'QR'));
  assert.equal(dom.$('qr-dialog').open, true, 'QR did not open its dialog');
  assert.equal(dom.$('qr-title').textContent, 'Soap Carving');
  const qrBack = dom.buttonNamed(dom.$('qr-dialog'), 'Back');
  assert.ok(qrBack, 'QR dialog has no Back control');
  assert.ok(qrBack.hasAttribute('data-close'), 'Back does not use the dialog close behavior');
  dom.click(qrBack);
  assert.equal(dom.$('qr-dialog').open, false, 'Back did not close the QR dialog');

  row = eventRowFor('Soap Carving');
  dom.click(dom.buttonNamed(row, 'Edit'));
  assert.ok(!dom.$('event-form-view').hidden, 'Edit did not open the event form');
  assert.equal(dom.$('event-form-title').textContent, 'Edit event');
  assert.equal(dom.$('event-title').value, 'Soap Carving');
  dom.click(dom.$('event-cancel'));
  await until(() => !dom.$('event-list').hidden, 'Cancel did not return to the cards');
});

await check('event cards stack actions with full tap targets on narrow screens', () => {
  assert.match(
    adminCss,
    /@media \(max-width: 46rem\)[\s\S]*?\.event-row[\s\S]*?grid-template-areas:[\s\S]*?'actions actions'/,
  );
  assert.match(
    adminCss,
    /@media \(max-width: 46rem\)[\s\S]*?\.event-actions \.button\s*\{[\s\S]*?min-height: var\(--tap\)/,
  );
  assert.match(
    adminCss,
    /@media \(max-width: 34rem\)[\s\S]*?\.event-row\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
  );
  assert.match(adminCss, /\.event-title\s*\{[^}]*overflow-wrap: anywhere/);
  assert.match(
    adminCss,
    /\.event-row > \.chip-row\s*\{[^}]*min-width: 0[^}]*max-width: 100%/,
  );
  assert.match(
    adminCss,
    /\.event-row > \.chip-row \.category-chip\s*\{[^}]*min-width: 0[^}]*max-width: 100%/,
  );
  assert.match(
    adminCss,
    /\.event-row > \.chip-row \.category-chip > span\s*\{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/,
  );
  assert.match(
    adminCss,
    /\.event-today-divider\s*\{[^}]*display: flex;[^}]*width: 100%;[^}]*min-width: 0;[^}]*color: var\(--danger\)/,
  );
  assert.match(
    adminCss,
    /\.event-today-line\s*\{[^}]*min-width: 0;[^}]*flex: 1 1 auto;/,
  );
  assert.match(
    adminCss,
    /@media \(max-width: 46rem\)[\s\S]*?\.event-today-divider\s*\{[^}]*padding-inline:/,
  );
  assert.match(
    adminCss,
    /@media \(max-width: 34rem\)[\s\S]*?\.event-today-divider\s*\{[^}]*gap:/,
  );
});

await check('QR actions center, wrap, and stay within the dialog on narrow screens', () => {
  assert.match(
    adminCss,
    /\.qr-dialog-actions\s*\{[^}]*flex-wrap:\s*wrap;[^}]*justify-content:\s*center;/,
  );
  assert.match(
    adminCss,
    /\.qr-dialog-actions \.button\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;/,
  );
});

await check('the tabs are built from the events, not from the category table', () => {
  const labels = tabLabels();
  // GBMs, Socials, Volunteering and Tabling are all used by this year's
  // events. "Last Year Only" is a real category with a real reference, but
  // nothing this year points at it, so a tab for it would filter to nothing.
  assert.ok(labels.some((text) => text.startsWith('All')), `no All tab: ${labels.join(' | ')}`);
  assert.ok(labels.some((text) => text.startsWith('GBMs')), 'no GBMs tab');
  assert.ok(!labels.some((text) => text.startsWith('Last Year Only')), 'a category with no event this year got a tab');
});

/** Puts every list control back, whatever a check left behind. */
function clearListFilters() {
  dom.$('events-search').value = '';
  dom.fire(dom.$('events-search'), 'input');
  dom.$('events-status').value = 'all';
  dom.fire(dom.$('events-status'), 'change');
  dom.$('events-sort').value = 'date_asc';
  dom.fire(dom.$('events-sort'), 'change');
  dom.click(dom.$('event-category-tabs').querySelectorAll('.filter-tab')[0]);
}

await check('picking a tab narrows the list to that category', () => {
  try {
    const socials = dom
      .$('event-category-tabs')
      .querySelectorAll('.filter-tab')
      .find((node) => node.textContent.startsWith('Socials'));
    assert.ok(socials, 'there is no Socials tab');
    dom.click(socials);

    const titles = rowTitles();
    assert.ok(titles.includes('Soap Carving'), `Socials left out a Socials event: ${titles.join(', ')}`);
    assert.ok(!titles.includes('Spring GBM 5'), 'a GBM is showing under Socials');
    assert.ok(todayDivider(), 'a category spanning the boundary lost Today');
    for (const row of dom.$('event-list').querySelectorAll('.event-row')) {
      assert.match(row.textContent, /Socials/, `a row with no Socials chip is under the Socials tab: ${row.textContent}`);
    }
    // Read off the tabs as they are now: pressing one rebuilds the row, so
    // the node that was clicked is not the node on screen.
    const selected = dom
      .$('event-category-tabs')
      .querySelectorAll('.filter-tab')
      .filter((node) => node.getAttribute('aria-selected') === 'true')
      .map((node) => node.textContent.trim());
    assert.equal(selected.length, 1, `${selected.length} tabs are selected`);
    assert.ok(selected[0].startsWith('Socials'), `the selected tab is ${selected[0]}`);
  } finally {
    clearListFilters();
  }
  assert.ok(rowTitles().includes('Spring GBM 5'), 'All did not put the list back');
});

await check('search narrows on the title only', () => {
  try {
    const search = dom.$('events-search');
    search.value = 'soap';
    dom.fire(search, 'input');
    assert.deepEqual(rowTitles(), ['Soap Carving']);

    search.value = 'hpa-2';
    dom.fire(search, 'input');
    assert.ok(!dom.$('empty-events').hidden, 'a search term matching no title still returned rows');

    search.value = 'zzzz';
    dom.fire(search, 'input');
    assert.ok(!dom.$('empty-events').hidden, 'no empty state for a search that matched nothing');
    assert.match(
      dom.$('empty-events-title').textContent,
      /no events match/i,
      'a filtered-to-nothing list claims the year is empty',
    );
  } finally {
    clearListFilters();
  }
});

await check('Show narrows to what is still open for check-in', () => {
  try {
    const status = dom.$('events-status');
    status.value = 'open';
    dom.fire(status, 'change');
    const open = rowTitles();
    // Field Day is dated in the future, so its check-in has not closed.
    assert.ok(open.includes('Field Day'), `Field Day is not open: ${open.join(', ')}`);
    for (const row of dom.$('event-list').querySelectorAll('.event-row')) {
      assert.equal(
        row.querySelector('.event-checkin-status').textContent.trim(),
        'Check-in open',
        `a closed event is under the Open filter: ${row.textContent}`,
      );
    }

    status.value = 'pending';
    dom.fire(status, 'change');
    const waiting = rowTitles();
    assert.ok(waiting.includes('Spring GBM 5'), `the event with a queue is missing: ${waiting.join(', ')}`);
    assert.ok(!waiting.includes('Field Day'), 'an event with nothing waiting is under the waiting filter');
    assert.ok(todayDivider(), 'the waiting list spanning the boundary lost Today');
  } finally {
    clearListFilters();
  }
});

await check('the order picker reorders the list without re-reading the server', async () => {
  const captured = captureRequests();
  try {
    const sort = dom.$('events-sort');

    sort.value = 'title';
    dom.fire(sort, 'change');
    assert.equal(Boolean(todayDivider()), false, 'Title displayed a misleading Today divider');
    const byTitle = rowTitles();
    assert.deepEqual(byTitle, [...byTitle].sort((a, b) => a.localeCompare(b)), 'Title did not sort by title');

    sort.value = 'attendance';
    dom.fire(sort, 'change');
    assert.equal(Boolean(todayDivider()), false, 'Most check-ins displayed a misleading Today divider');
    // Read off the rows rather than named against a fixture, so this stays
    // true whichever event happens to be the busiest.
    const live = dom
      .$('event-list')
      .querySelectorAll('.event-row')
      .map((row) => {
        // Read off its own cell, never off the row's text: a category chip
        // ending in a credit runs straight into the count beside it, and
        // "Socials · 1" plus "64 approved" reads as 164.
        const [, approved, waiting] =
          /(\d+) approved · (\d+) waiting/.exec(row.querySelector('.event-counts').textContent) ?? [];
        return Number(approved ?? 0) + Number(waiting ?? 0);
      });
    assert.deepEqual(live, [...live].sort((a, b) => b - a), 'Most check-ins is not in order');
    assert.ok(live[0] > live[live.length - 1], 'every event has the same number of check-ins');

    sort.value = 'date_desc';
    dom.fire(sort, 'change');
    assert.equal(Boolean(todayDivider()), false, 'Newest first displayed a misleading Today divider');

    sort.value = 'date_asc';
    dom.fire(sort, 'change');
    assert.ok(todayDivider(), 'Oldest first did not restore Today');

    const eventReads = captured.requests.filter(({ url }) => new URL(url).pathname === '/rest/v1/events');
    assert.equal(eventReads.length, 0, 'sorting sent a request');
  } finally {
    captured.restore();
    clearListFilters();
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\none event, in full\n');
// ---------------------------------------------------------------------------

const openEvent = async (title) => {
  const row = eventRowFor(title);
  assert.ok(row, `${title} is not on the list`);
  dom.click(dom.buttonNamed(row, 'View event'));
  await until(() => !dom.$('event-detail-body').hidden, `${title} never opened`);
};

// Add attendance is on screen for the whole of the detail view and is disabled
// for exactly as long as a write is in flight, so it is what "the screen has
// finished" is read off. Waiting on the row that changed is not enough: the
// list behind this screen is reloaded after it, and a check that returned in
// between would press the next button while the screen was still busy.
const settle = () => until(() => !dom.$('attendee-add').disabled, 'the event screen never settled');

const backToList = async () => {
  dom.click(dom.$('event-detail-back'));
  await until(() => !dom.$('event-list').hidden, 'the list never came back');
};

await openEvent('Spring GBM 5');

await check('the paste attendance action uses the new label', () => {
  assert.equal(dom.$('attendee-add').textContent.trim(), 'Add attendance');
});

await check('the attendee list is every record on the event, waiting ones first', () => {
  const rows = dom.$('attendee-rows').querySelectorAll('tr');
  assert.ok(rows.length > 40, `only ${rows.length} rows on a 48-record event`);

  const statuses = rows.map((row) => row.getAttribute('data-status'));
  const firstApproved = statuses.indexOf('approved');
  const lastPending = statuses.lastIndexOf('pending');
  assert.ok(
    firstApproved === -1 || lastPending < firstApproved,
    'an approved row is sitting above a waiting one',
  );
  assert.equal(statuses.indexOf('rejected'), statuses.lastIndexOf('rejected'), 'declined rows are not together');
});

await check('a record with no member offers Review, never Approve', () => {
  const row = rowFor('Abby Cato');
  assert.ok(row, 'the unmatched check-in is not on the list');
  const labels = row.querySelectorAll('button').map((button) => button.textContent.trim());
  assert.ok(!labels.includes('Approve'), `Approve was offered on an unmatched record: ${labels.join(', ')}`);
  assert.ok(labels.includes('Review'), `Review was not offered: ${labels.join(', ')}`);
  assert.match(row.textContent, /Member not matched/, 'the row does not say why');
});

await check('the numbers are counts of rows, and say where the check-ins came from', () => {
  const tiles = dom
    .$('event-detail-stats')
    .querySelectorAll('.event-stat')
    .map((tile) => tile.textContent.trim());
  const rows = dom.$('attendee-rows').querySelectorAll('tr');
  const waiting = rows.filter((row) => row.getAttribute('data-status') === 'pending').length;

  const waitingTile = tiles.find((text) => text.endsWith('Waiting'));
  assert.ok(waitingTile, `no Waiting tile: ${tiles.join(' | ')}`);
  assert.equal(
    Number(waitingTile.replace('Waiting', '').trim()),
    waiting,
    'the Waiting tile and the rows underneath it disagree',
  );

  const unmatched = tiles.find((text) => text.endsWith('Not matched'));
  assert.ok(unmatched, 'an event with unmatched names does not say so');
  assert.match(dom.$('event-detail-sources').textContent, /Scanned/, 'the sources line is missing');
});

await check('Approve goes through review_records, and never writes status directly', async () => {
  const row = rowFor('Abby Catto');
  assert.ok(row, 'the possible-duplicate record is missing');
  const approve = dom.buttonNamed(row, 'Approve');
  assert.ok(approve, 'Approve is not offered on an approvable record');

  const before = (await adminAudit()).calls.length;
  dom.click(approve);
  await until(
    async () => (await adminAudit()).calls.slice(before).some((call) => call.fn === 'review_records'),
    'review_records was never called',
  );

  const calls = (await adminAudit()).calls.slice(before);
  const reviewed = calls.find((call) => call.fn === 'review_records');
  assert.equal(reviewed.decision, 'approve');
  assert.equal(reviewed.count, 1);
  assert.ok(
    !calls.some((call) => call.fn === 'patch.attendance_records'),
    'the screen patched attendance_records directly',
  );

  await until(
    () => rowFor('Abby Catto')?.getAttribute('data-status') === 'approved',
    'the row never turned approved',
  );
  await settle();
});

await check('Approve reconciles a committed call whose response was lost', async () => {
  const row = dom
    .$('attendee-rows')
    .querySelectorAll('tr[data-status="pending"]')
    .find((candidate) => dom.buttonNamed(candidate, 'Approve'));
  assert.ok(row, 'there is no linked waiting record to approve');
  const recordId = row.getAttribute('data-record');
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter((entry) => entry.action === 'review_records').length;

  dropRpcResponseOnce('review_records');
  dom.click(dom.buttonNamed(row, 'Approve'));
  await settle();

  const after = await adminAudit();
  const mutationCalls = after.calls
    .slice(beforeCalls)
    .filter((call) => call.fn === 'review_records' && call.actor);
  assert.equal(mutationCalls.length, 1, 'Approve retried after its committed response was lost');
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'review_records').length,
    beforeAudits + 1,
    'Approve wrote more than one audit row',
  );
  assert.equal(rowForRecord(recordId)?.getAttribute('data-status'), 'approved');
  assert.equal(dom.$('screen-message-title').textContent, '1 record approved');
  assert.ok(
    after.calls.slice(beforeCalls).some((call) => call.fn === 'rest.v_possible_duplicate_members'),
    'Approve did not refresh member-derived views',
  );
});

await check('Review reconciles a committed call whose response body was lost', async () => {
  const row = dom
    .$('attendee-rows')
    .querySelectorAll('tr[data-status="pending"]')
    .find((candidate) => dom.buttonNamed(candidate, 'Approve'));
  assert.ok(row, 'there is no linked waiting record for the body-loss check');
  const recordId = row.getAttribute('data-record');
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter((entry) => entry.action === 'review_records').length;
  const restoreFetch = dropRpcBodyOnce('review_records');

  try {
    dom.click(dom.buttonNamed(row, 'Approve'));
    await settle();
  } finally {
    restoreFetch();
  }

  const after = await adminAudit();
  assert.equal(
    after.calls
      .slice(beforeCalls)
      .filter((call) => call.fn === 'review_records' && call.actor).length,
    1,
    'Review retried after success headers and a lost body',
  );
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'review_records').length,
    beforeAudits + 1,
    'Review wrote more than one audit row after body loss',
  );
  assert.equal(rowForRecord(recordId)?.getAttribute('data-status'), 'approved');
  assert.equal(dom.$('screen-message-title').textContent, '1 record approved');
});

await check('Decline reconciles a committed call whose response was lost', async () => {
  const row = rowFor('Tobias Renner');
  assert.ok(row, 'the unmatched waiting record is missing');
  const recordId = row.getAttribute('data-record');
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter((entry) => entry.action === 'review_records').length;

  dropRpcResponseOnce('review_records');
  const restoreDerivedRead = failRestReadOnce('v_possible_duplicate_members');
  try {
    dom.click(dom.buttonNamed(row, 'Decline'));
    await settle();
  } finally {
    restoreDerivedRead();
  }

  const after = await adminAudit();
  const mutationCalls = after.calls
    .slice(beforeCalls)
    .filter((call) => call.fn === 'review_records' && call.actor);
  assert.equal(mutationCalls.length, 1, 'Decline retried after its committed response was lost');
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'review_records').length,
    beforeAudits + 1,
    'Decline wrote more than one audit row',
  );
  assert.equal(rowForRecord(recordId)?.getAttribute('data-status'), 'rejected');
  assert.equal(dom.$('screen-message-title').textContent, '1 record declined');
  assert.equal(
    dom.$('screen-message-body').textContent,
    '',
    'a derived reload failure replaced the committed success',
  );
  assert.ok(
    after.calls.slice(beforeCalls).some((call) => call.fn === 'rest.v_possible_duplicate_members'),
    'Decline did not refresh member-derived views',
  );
});

await check('a failed post-commit event reload keeps stale mutation controls locked', async () => {
  const row = dom
    .$('attendee-rows')
    .querySelectorAll('tr[data-status="pending"]')
    .find((candidate) => dom.buttonNamed(candidate, 'Approve'));
  assert.ok(row, 'there is no linked waiting record for the reload-failure check');
  const recordId = row.getAttribute('data-record');
  const approve = dom.buttonNamed(row, 'Approve');
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const restoreRead = failRestReadOnce('events');

  try {
    dom.click(approve);
    await until(async () => {
      const current = await adminAudit();
      return (
        current.attendance.find((record) => record.id === recordId)?.status === 'approved' &&
        dom.$('screen-message-title').textContent === '1 record approved'
      );
    }, 'the mutation did not commit before its reload failed');
  } finally {
    restoreRead();
  }

  assert.equal(dom.$('screen-message-body').textContent, '', 'the success strip became an error');
  assert.equal(dom.$('event-detail-body').hidden, true, 'stale event controls remained visible');
  const lockedApprove = dom.buttonNamed(rowForRecord(recordId), 'Approve');
  assert.equal(lockedApprove.disabled, true, 'the stale Approve button was re-enabled');

  dom.click(lockedApprove);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const afterRepeat = await adminAudit();
  assert.equal(
    afterRepeat.calls
      .slice(beforeCalls)
      .filter((call) => call.fn === 'review_records' && call.actor).length,
    1,
    'the stale button repeated a committed review',
  );

  await backToList();
  await openEvent('Spring GBM 5');
  assert.equal(rowForRecord(recordId)?.getAttribute('data-status'), 'approved');
  assert.equal(dom.$('attendee-add').disabled, false, 'a successful re-read did not release the lock');
});

await check('Approve on every waiting record leaves the unmatched ones alone', async () => {
  const button = dom.$('attendee-approve-all');
  assert.ok(!button.hidden, 'there is nothing waiting to approve');
  const waitingBefore = dom.$('attendee-rows').querySelectorAll('tr[data-status="pending"]').length;

  dom.click(button);
  await until(
    () => dom.$('attendee-rows').querySelectorAll('tr[data-status="pending"]').length < waitingBefore,
    'the waiting records were never approved',
  );
  await settle();

  // What is left waiting is exactly the records the database refuses to
  // approve: the ones with no member linked.
  const stillWaiting = dom
    .$('attendee-rows')
    .querySelectorAll('tr[data-status="pending"]')
    .map((row) => row.querySelectorAll('td')[0].textContent);
  assert.ok(stillWaiting.length, 'the unmatched records were approved, which the database forbids');
  for (const name of stillWaiting) {
    assert.match(name, /Member not matched/, `${name} is still waiting and is not an unmatched name`);
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\nfiling the paper sign-in sheet\n');
// ---------------------------------------------------------------------------

await backToList();
await openEvent('Give Kids A Smile');

await check('the batch mock rejects negative and nonfinite values before writes', async () => {
  const before = (await adminAudit()).attendance.length;
  for (const value of [-1, 'NaN']) {
    await assert.rejects(
      () => callRpc('add_officer_attendance_batch', {
        p_event_id: IDS.EVENT_GKAS,
        p_entries: [{
          line: 1,
          claimed_name: 'Rejected Value',
          disposition: 'unmatched',
          member_id: null,
          batch_key: `rejected-${value}`,
        }],
        p_submitted_value: value,
      }),
      RpcError,
    );
  }
  assert.equal((await adminAudit()).attendance.length, before);
});

await check('event bulk approval excludes member-entered points', async () => {
  const [enteredMember, routineMember] = await insert('members', [
    { first_name: 'Entered', last_name: 'Control' },
    { first_name: 'Routine', last_name: 'Event Control' },
  ]);
  await insert('member_enrollments', [
    { member_id: enteredMember.id, academic_year_id: IDS.YEAR_CURRENT, status: 'active' },
    { member_id: routineMember.id, academic_year_id: IDS.YEAR_CURRENT, status: 'active' },
  ]);
  const [entered, routine] = await insert('attendance_records', [
    {
      event_id: IDS.EVENT_GKAS,
      member_id: enteredMember.id,
      source: 'self_checkin',
      submitted_value: 77,
      flags: [],
    },
    {
      event_id: IDS.EVENT_GKAS,
      member_id: routineMember.id,
      source: 'self_checkin',
      submitted_value: null,
      flags: [],
    },
  ]);

  await backToList();
  await openEvent('Give Kids A Smile');
  const bulk = dom.$('attendee-approve-all');
  assert.equal(bulk.textContent.trim(), 'Approve 1 waiting');
  dom.click(bulk);
  await until(async () => {
    const rows = (await adminAudit()).attendance;
    return rows.find((row) => row.id === routine.id)?.status === 'approved';
  }, 'the event bulk action did not approve the routine control');
  let rows = (await adminAudit()).attendance;
  assert.equal(rows.find((row) => row.id === entered.id)?.status, 'pending');

  await settle();
  const enteredRow = rowForRecord(entered.id);
  dom.click(dom.buttonNamed(enteredRow, 'Approve'));
  await until(async () => {
    const currentRows = (await adminAudit()).attendance;
    return currentRows.find((row) => row.id === entered.id)?.status === 'approved';
  }, 'the individual member-entered approval did not commit');
  rows = (await adminAudit()).attendance;
  assert.equal(rows.find((row) => row.id === entered.id)?.status, 'approved');
});

const attendancePasteRows = () =>
  dom.$('attendee-add-list').querySelectorAll('.attendance-paste-row');

function pasteAttendance(text) {
  const input = dom.$('attendee-add-names');
  input.value = text;
  dom.fire(input, 'input');
}

await check('paste choices are bound to the exact text and normalized name', () => {
  const roster = [
    { id: 'abby', display_name: 'Abby Catto' },
    { id: 'abigail', display_name: 'Abigail Catto' },
    { id: 'marcus', display_name: 'Marcus Bell' },
  ];
  const memberChoice = new Map([[1, {
    kind: 'member',
    member_id: 'abby',
    normalized_name: 'abby cato',
    source_text: 'Abby Cato',
  }]]);
  const inserted = buildAttendancePastePreview('Marcus Bell\nAbby Cato', roster, [], memberChoice);
  assert.equal(inserted[0].member.id, 'marcus', 'an inserted line inherited the old member choice');
  assert.equal(inserted[1].status, 'choice', 'the moved line retained its old member choice');

  const unmatchedChoice = new Map([[1, {
    kind: 'unmatched',
    normalized_name: 'abby cato',
    source_text: 'Abby Cato',
  }]]);
  const newlyExact = buildAttendancePastePreview(
    'Abby Cato',
    [...roster, { id: 'exact', display_name: 'Abby Cato' }],
    [],
    unmatchedChoice,
  );
  assert.equal(newlyExact[0].status, 'member');
  assert.equal(newlyExact[0].member.id, 'exact', 'Not on roster overrode a new exact match');
});

await check('editing, inserting, deleting, or reordering clears paste choices', () => {
  dom.click(dom.$('attendee-add'));
  pasteAttendance('Abby Cato\nTalia Newcomer');
  let rows = attendancePasteRows();
  dom.click(dom.buttonNamed(rows[0], 'Link member'));
  assert.equal(attendancePasteRows()[0].dataset.status, 'member');

  pasteAttendance('Talia Newcomer\nAbby Cato');
  rows = attendancePasteRows();
  assert.equal(rows[1].dataset.status, 'choice', 'reordering retained a member choice');

  dom.click(dom.buttonNamed(rows[1], 'Not on roster'));
  assert.equal(attendancePasteRows()[1].dataset.status, 'unmatched');
  pasteAttendance('Marcus Bell\nTalia Newcomer\nAbby Cato');
  rows = attendancePasteRows();
  assert.equal(rows[0].dataset.status, 'member');
  assert.equal(rows[2].dataset.status, 'choice', 'insertion retained Not on roster');

  pasteAttendance('Abby Cato');
  assert.equal(attendancePasteRows()[0].dataset.status, 'choice', 'deletion retained a stale choice');
  pasteAttendance('Marcus Bell');
  assert.equal(attendancePasteRows()[0].dataset.status, 'member', 'an edit retained a stale choice');
  dom.$('attendee-add-dialog').close();
});

await check('duplicate exact names offer distinct member targets before linking', async () => {
  const [older, newer] = await insert('members', [
    { first_name: 'Same', last_name: 'Person' },
    { first_name: 'Same', last_name: 'Person' },
  ]);
  await insert('member_enrollments', [
    {
      member_id: older.id,
      academic_year_id: IDS.YEAR_CURRENT,
      status: 'active',
      joined_on: '2024-01-05',
    },
    {
      member_id: newer.id,
      academic_year_id: IDS.YEAR_CURRENT,
      status: 'active',
      joined_on: '2025-02-05',
    },
  ]);
  await backToList();
  await openEvent('Give Kids A Smile');

  const openCandidate = async (index, joined) => {
    dom.click(dom.$('attendee-add'));
    pasteAttendance('Same Person');
    const row = attendancePasteRows()[0];
    assert.equal(row.dataset.status, 'choice', 'duplicate exact names were selected blindly');
    const suggestions = row.querySelectorAll('.attendance-paste-suggestion');
    assert.equal(suggestions.length, 2);
    assert.equal(suggestions[index].textContent.includes('Link member'), true);
    dom.click(dom.buttonNamed(suggestions[index], 'Open member'));
    assert.equal(dom.$('attendee-add-dialog').open, false, 'Open member left the paste modal open');
    await until(() => !dom.$('member-body').hidden, 'the selected member did not open');
    assert.match(dom.$('member-meta').textContent, joined);
    dom.click(dom.$('member-back'));
    await until(() => !dom.$('event-detail-body').hidden, 'Back did not return to the event');
  };

  await openCandidate(0, /Joined Jan 2024/);
  await openCandidate(1, /Joined Feb 2025/);
});

await check('every pasted line has a visible outcome, including ambiguity and an existing record', () => {
  dom.click(dom.$('attendee-add'));
  pasteAttendance([
    'Marcus Bell',
    'Talia Newcomer',
    'Talia Newcomer',
    'Bob',
    'Abby Cato',
    'Grace Okonkwo',
  ].join('\n'));

  const rows = attendancePasteRows();
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.dataset.status), [
    'member',
    'unmatched',
    'repeated',
    'invalid',
    'choice',
    'recorded',
  ]);
  assert.match(rows[2].textContent, /Repeated/);
  assert.match(rows[3].textContent, /Needs full name/);
  assert.match(rows[4].textContent, /Choose member/);
  assert.match(rows[5].textContent, /Already recorded/);
  assert.equal(dom.$('attendee-add-submit').disabled, true, 'an ambiguous name could be submitted without a choice');

  dom.click(dom.buttonNamed(rows[4], 'Not on roster'));
  assert.equal(attendancePasteRows()[4].dataset.status, 'unmatched');
  assert.equal(dom.$('attendee-add-submit').disabled, false);
  assert.match(dom.$('attendee-add-count').textContent, /1 member · 2 not on roster · 1 already recorded · 2 needs review/);
});

await check("the number an event collects is labelled by the category, not by the word 'hours'", () => {
  assert.ok(!dom.$('attendee-add-value-field').hidden, 'the number field is not shown on an event that collects one');
  assert.equal(dom.$('attendee-add-value-label').textContent, 'Volunteering');
});

await check('adding goes through one call, not an insert the approval can be lost after', async () => {
  const before = (await adminAudit()).calls.length;

  dom.$('attendee-add-value').value = '2.5';
  dom.fire(dom.$('attendee-add-form'), 'submit');
  await settle();

  const calls = (await adminAudit()).calls.slice(before);
  const filedCall = calls.find((call) => call.fn === 'add_officer_attendance_batch');
  assert.ok(filedCall, `add_officer_attendance_batch was never called: ${calls.map((c) => c.fn).join(', ')}`);
  assert.equal(filedCall.count, 6);
  assert.equal(filedCall.added, 1);
  assert.equal(filedCall.waiting, 2);
  assert.equal(Number(filedCall.submittedValue), 2.5);

  // The two-call shape is what this replaced. A direct insert into
  // attendance_records from this screen would put the gap back: the insert
  // commits, the approval fails, and records nobody was told about sit
  // pending in the queue.
  assert.ok(
    !calls.some((call) => call.fn === 'insert.attendance_records'),
    'the screen inserted attendance_records directly',
  );

  const filed = await select('attendance_records', {
    select: 'status,source,submitted_value,reviewed_by',
    filters: { event_id: `eq.${IDS.EVENT_GKAS}`, source: 'eq.officer_entry' },
  });
  assert.equal(filed.length, 3, `${filed.length} officer entries were written`);
  assert.equal(filed.filter((row) => row.status === 'approved').length, 1);
  assert.equal(filed.filter((row) => row.status === 'pending').length, 2);
  for (const row of filed) {
    assert.equal(Number(row.submitted_value), 2.5, 'the number typed was not written');
  }
  assert.ok(filed.find((row) => row.status === 'approved').reviewed_by, 'the member record carries no reviewer');

  const names = attendeeNames();
  assert.ok(names.some((name) => name.includes('Marcus Bell')), `Marcus Bell is not on the list: ${names.join(', ')}`);
  assert.equal(dom.$('attendee-add-result-list').querySelectorAll('.attendance-paste-result').length, 6);
  assert.equal(dom.$('attendee-add-result-summary').textContent, '1 added · 2 waiting for member links');
  dom.$('attendee-add-result-dialog').close();
});

await check('a preserved unmatched name becomes a Review action after enrollment', async () => {
  dom.click(dom.$('attendee-add'));
  pasteAttendance('Preserved Browser');
  dom.$('attendee-add-value').value = '1';
  dom.fire(dom.$('attendee-add-form'), 'submit');
  await settle();
  dom.$('attendee-add-result-dialog').close();

  const before = await adminAudit();
  const preserved = before.attendance.find(
    (row) => row.event_id === IDS.EVENT_GKAS && row.claimed_name === 'Preserved Browser',
  );
  assert.ok(preserved, 'the unmatched row was not preserved');
  assert.equal(preserved.status, 'pending');
  assert.equal(preserved.member_id, null);

  const [member] = await insert('members', [
    { first_name: 'Preserved', last_name: 'Browser' },
  ]);
  await insert('member_enrollments', [{
    member_id: member.id,
    academic_year_id: IDS.YEAR_CURRENT,
    status: 'active',
  }]);
  const staleOutcomes = await callRpc('add_officer_attendance_batch', {
    p_event_id: IDS.EVENT_GKAS,
    p_entries: [{
      line: 1,
      claimed_name: 'Preserved Browser',
      disposition: 'member',
      member_id: member.id,
      batch_key: 'preserved-browser-stale-client',
    }],
    p_submitted_value: 1,
  });
  assert.equal(staleOutcomes[0].outcome, 'already_recorded');
  assert.equal(staleOutcomes[0].record_id, preserved.id);
  await backToList();
  await openEvent('Give Kids A Smile');

  dom.click(dom.$('attendee-add'));
  pasteAttendance('Preserved Browser');
  const row = attendancePasteRows()[0];
  assert.equal(row.dataset.status, 'recorded');
  assert.match(row.textContent, /Needs review/);
  assert.equal(dom.$('attendee-add-submit').disabled, true, 'the preserved row could be submitted');
  dom.click(dom.buttonNamed(row, 'Review'));
  assert.equal(dom.$('attendee-add-dialog').open, false, 'Review left the paste modal open');
  await until(() => !dom.$('panel-review').hidden, 'Review did not open the event review flow');

  const after = await adminAudit();
  const sameName = after.attendance.filter(
    (candidate) =>
      candidate.event_id === IDS.EVENT_GKAS &&
      String(candidate.claimed_name ?? '').toLowerCase() === 'preserved browser',
  );
  assert.equal(sameName.length, 1, 'same-name paste created a second attendance row');
  assert.equal(sameName[0].status, 'pending', 'same-name paste approved the preserved row');
  dom.click(dom.$('tab-events'));
  await until(() => !dom.$('event-detail-body').hidden, 'Events did not return to the open event');
});

await check('Add reconciles a committed call whose response was lost', async () => {
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter(
    (entry) => entry.action === 'add_officer_attendance_batch',
  ).length;
  const beforeFiled = before.attendance.filter(
    (row) => row.event_id === IDS.EVENT_GKAS && row.source === 'officer_entry',
  ).length;

  dom.click(dom.$('attendee-add'));
  // Grace already holds a self_checkin with 3.5. This batch sends 1.5, so
  // recovery must recognize the before snapshot without requiring the old
  // row to be an officer entry or to carry this calls value.
  pasteAttendance('Grace Okonkwo\nLeah Ortiz\nNora Response');
  dom.$('attendee-add-value').value = '1.5';
  dropRpcResponseOnce('add_officer_attendance_batch');
  dom.fire(dom.$('attendee-add-form'), 'submit');
  await settle();

  const after = await adminAudit();
  const mutationCalls = after.calls
    .slice(beforeCalls)
    .filter((call) => call.fn === 'add_officer_attendance_batch' && call.actor);
  assert.equal(mutationCalls.length, 1, 'Add retried after its committed response was lost');
  assert.ok(
    after.calls.slice(beforeCalls).some((call) => call.fn === 'recover_officer_attendance_batch'),
    'Add did not recover through the authoritative batch RPC',
  );
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'add_officer_attendance_batch').length,
    beforeAudits + 1,
    'Add wrote more than one audit row',
  );
  assert.equal(
    after.attendance.filter(
      (row) => row.event_id === IDS.EVENT_GKAS && row.source === 'officer_entry',
    ).length,
    beforeFiled + 2,
    'Add did not leave exactly two new records',
  );
  assert.equal(dom.$('screen-message-title').textContent, '1 added · 1 waiting for member links');
  const resultOutcomes = dom.$('attendee-add-result-list')
    .querySelectorAll('.attendance-paste-result')
    .map((row) => row.dataset.outcome);
  assert.deepEqual(resultOutcomes, ['already_recorded', 'added', 'waiting_for_member_link']);
  assert.ok(
    after.calls.slice(beforeCalls).some((call) => call.fn === 'rest.v_possible_duplicate_members'),
    'Add did not refresh member-derived views',
  );
  dom.$('attendee-add-result-dialog').close();
});

await check('snapshot recovery repeats a second spelling of a pre-existing member', () => {
  const memberId = 'm-same-member';
  const entries = [
    { line: 1, claimed_name: 'Jonathan Pak', disposition: 'member', member_id: memberId },
    { line: 2, claimed_name: 'Jonathon Pak', disposition: 'member', member_id: memberId },
  ];
  const before = [
    {
      id: 'record-old',
      member_id: memberId,
      status: 'pending',
      source: 'self_checkin',
    },
  ];
  const outcomes = reconstructAttendanceBatchOutcomes(entries, before, before);
  assert.deepEqual(outcomes.map((row) => row.outcome), ['already_recorded', 'repeated']);
});

await check('snapshot recovery never attributes a new matched row to the batch', () => {
  const entries = [
    { line: 1, claimed_name: 'Grace Okonkwo', disposition: 'member', member_id: 'member-old' },
    { line: 2, claimed_name: 'Leah Ortiz', disposition: 'member', member_id: 'member-new' },
  ];
  const before = [
    {
      id: 'record-old',
      member_id: 'member-old',
      status: 'pending',
      source: 'self_checkin',
      submitted_value: 99,
    },
  ];
  const current = [
    ...before,
    {
      id: 'record-new',
      member_id: 'member-new',
      status: 'approved',
      source: 'officer_entry',
      submitted_value: 2,
      reviewed_by: 'officer-id',
    },
  ];
  const outcomes = reconstructAttendanceBatchOutcomes(entries, current, before);
  assert.equal(outcomes, null);
});

await check('lost-response reconstruction does not claim an unrelated concurrent unmatched row', () => {
  const outcomes = reconstructAttendanceBatchOutcomes(
    [{ line: 1, claimed_name: 'Nora Response', disposition: 'unmatched', member_id: null }],
    [{
      id: 'other-row',
      member_id: null,
      claimed_name: 'Nora Response',
      status: 'pending',
      source: 'officer_entry',
      submitted_value: 2,
      flags: ['unmatched_name'],
    }],
    [],
    { submittedValue: 2, userId: 'officer-id' },
  );
  assert.equal(outcomes, null);
});

await check('Add reconciles a committed call whose response body was lost', async () => {
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter(
    (entry) => entry.action === 'add_officer_attendance_batch',
  ).length;
  const beforeIds = new Set(
    before.attendance
      .filter((row) => row.event_id === IDS.EVENT_GKAS && row.source === 'officer_entry')
      .map((row) => row.id),
  );

  dom.click(dom.$('attendee-add'));
  pasteAttendance('Daniel Nguyen');
  dom.$('attendee-add-value').value = '1.25';
  const restoreFetch = dropRpcBodyOnce('add_officer_attendance_batch');
  try {
    dom.fire(dom.$('attendee-add-form'), 'submit');
    await settle();
  } finally {
    restoreFetch();
  }

  const after = await adminAudit();
  assert.equal(
    after.calls
      .slice(beforeCalls)
      .filter((call) => call.fn === 'add_officer_attendance_batch' && call.actor).length,
    1,
    'Add retried after success headers and a lost body',
  );
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'add_officer_attendance_batch').length,
    beforeAudits + 1,
    'Add wrote more than one audit row after body loss',
  );
  const added = after.attendance.filter(
    (row) =>
      row.event_id === IDS.EVENT_GKAS &&
      row.source === 'officer_entry' &&
      !beforeIds.has(row.id),
  );
  assert.equal(added.length, 1, 'Add body loss did not leave exactly one new record');
  assert.equal(Number(added[0].submitted_value), 1.25);
  assert.equal(dom.$('screen-message-title').textContent, '1 added · 0 waiting for member links');
  dom.$('attendee-add-result-dialog').close();
});

await check('an event whose credit mode changed under the screen refuses the add', async () => {
  // THE SILENT ONE. The screen decides whether to ask for a number from the
  // event as it was when it opened. Switch the event to fixed credit
  // underneath it and the old client would have gone on sending 2.5 against
  // an event that collects nothing, or, the other way round, filed a null
  // against a from_submission link, which is approved credit worth zero and
  // nothing anywhere says so. The database is asked instead.
  await patch(
    'event_categories',
    { event_id: `eq.${IDS.EVENT_GKAS}`, category_id: `eq.${IDS.CATEGORY_VOLUNTEERING}` },
    { credit_mode: 'fixed' },
  );

  const beforeRows = (
    await select('attendance_records', { select: 'id', filters: { event_id: `eq.${IDS.EVENT_GKAS}` } })
  ).length;

  dom.click(dom.$('attendee-add'));
  pasteAttendance('Ethan Wallace');
  dom.$('attendee-add-value').value = '4';
  dom.fire(dom.$('attendee-add-form'), 'submit');
  await settle();

  const afterRows = (
    await select('attendance_records', { select: 'id', filters: { event_id: `eq.${IDS.EVENT_GKAS}` } })
  ).length;
  assert.equal(afterRows, beforeRows, 'a record was filed against a credit mode the screen did not know about');
  assert.match(
    dom.$('screen-message-title').textContent,
    /.+/,
    'the refusal was not reported to the officer',
  );

  await patch(
    'event_categories',
    { event_id: `eq.${IDS.EVENT_GKAS}`, category_id: `eq.${IDS.CATEGORY_VOLUNTEERING}` },
    { credit_mode: 'from_submission' },
  );
  dom.$('attendee-add-dialog').close();

  // And the screen picks the restored mode up on its next read, rather than
  // holding the copy it was opened with for as long as it stays open.
  await backToList();
  await openEvent('Give Kids A Smile');
  assert.ok(!dom.$('attendee-value-head').hidden, 'the screen did not re-read the event');
});

await check('the export carries what is on screen, in the order it is on screen', () => {
  dom.click(dom.$('attendee-export'));
  const text = downloads[downloads.length - 1];
  assert.ok(text, 'nothing was exported');

  const lines = text.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Name,Status,Source,Checked in,Value,Note', `header was: ${lines[0]}`);
  assert.equal(lines.length - 1, attendeeNames().length, 'the file and the screen hold different numbers of rows');

  const firstOnScreen = attendeeNames()[0].replace(/Member not matched$/, '').trim();
  assert.ok(lines[1].startsWith(firstOnScreen), `${lines[1]} does not start with ${firstOnScreen}`);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nremoving, previewing, copying, deleting\n');
// ---------------------------------------------------------------------------

const { evidenceObjectExists } = await import('../src/rest.js');

/** A routine record on Spring GBM 5 that carries a photo, and its owner's name. */
async function aRecordWithAPhoto(skip = new Set()) {
  const candidates = (await adminAudit()).attendance.filter(
    (row) => row.event_id === IDS.EVENT_GBM && row.member_id && row.id.startsWith('r1000000') && !skip.has(row.id),
  );
  for (const candidate of candidates) {
    const evidence = await select('attendance_evidence', {
      select: 'object_path',
      filters: { attendance_record_id: `eq.${candidate.id}` },
    });
    const path = evidence[0]?.object_path;
    if (!path) continue;
    const [member] = await select('members', {
      select: 'display_name',
      filters: { id: `eq.${candidate.member_id}` },
    });
    return { record: candidate, path, name: member.display_name };
  }
  throw new Error('no routine record with a photo to remove');
}

function storageOutstandingCount() {
  if (dom.$('storage-outstanding').hidden) return 0;
  const match = /^(\d+)/.exec(dom.$('storage-outstanding-title').textContent.trim());
  return match ? Number(match[1]) : 0;
}

async function finishOutstandingFromStorage(runId) {
  dom.click(dom.$('tab-storage'));
  await until(
    () => !dom.$('storage-body').hidden,
    'Storage did not open with the outstanding run',
  );
  assert.equal(dom.$('storage-outstanding').hidden, false, 'Storage hid the outstanding run');
  dom.click(dom.$('storage-finish'));
  await until(async () => {
    const rows = await select('v_purge_runs_outstanding', {
      select: 'purge_run_id',
      filters: { purge_run_id: `eq.${runId}` },
    });
    return rows.length === 0 && !dom.$('storage-body').hidden;
  }, 'Storage could not finish the outstanding run');
  dom.click(dom.$('tab-events'));
  await until(
    () => !dom.$('event-detail-view').hidden && !dom.$('event-detail-body').hidden,
    'Events did not return to the open event',
  );
}

await check('a missing remove RPC stays on the event with a contextual error', async () => {
  await backToList();
  await openEvent('Spring GBM 5');

  const noPhotoRow = dom
    .$('attendee-rows')
    .querySelectorAll('tr')
    .find((row) => row.getAttribute('data-record') === 'r0000000-0000-4000-a000-000000000007');
  assert.ok(noPhotoRow, 'the no-photo record is not on the event');
  dom.click(dom.buttonNamed(noPhotoRow, 'Remove'));
  assert.equal(dom.$('attendee-remove-note').textContent, 'Decline to keep this record in event history');
  assert.doesNotMatch(dom.$('attendee-remove-note').textContent, /\.$/);
  dom.$('attendee-remove-dialog').close();

  const { record, name } = await aRecordWithAPhoto();
  const before = detailSnapshot();
  const restoreFetch = failRpcAsMissingOnce('remove_attendance_record');

  try {
    const row = rowFor(name);
    dom.click(dom.buttonNamed(row, 'Remove'));
    assert.equal(dom.$('attendee-remove-dialog').querySelector('.dialog-title').textContent, 'Remove record');
    assert.equal(dom.$('attendee-remove-note').textContent, 'The attached photo will also be removed');
    assert.doesNotMatch(dom.$('attendee-remove-note').textContent, /\.$/);
    dom.fire(dom.$('attendee-remove-form'), 'submit');
    await settle();
  } finally {
    restoreFetch();
  }

  assert.ok(!dom.$('event-detail-view').hidden, 'the event detail closed after a failed removal');
  assert.ok(rowFor(name), 'the row disappeared after the delete request was refused');
  assert.deepEqual(detailSnapshot(), before, 'the event figures changed after a failed removal');
  assert.equal(
    (await adminAudit()).attendance.filter((one) => one.id === record.id).length,
    1,
    'the record was deleted after the RPC was reported missing',
  );
  assert.equal(dom.$('screen-message-title').textContent, 'Record not removed');
  assert.equal(dom.$('screen-message-body').textContent, 'An admin needs to finish the site update');
  assert.doesNotMatch(
    `${dom.$('screen-message-title').textContent} ${dom.$('screen-message-body').textContent}`,
    /cannot reach the database|schema cache|p_record_id/i,
  );
});

await check('Remove reconciles a committed call whose response was lost', async () => {
  const { record, path, name } = await aRecordWithAPhoto();
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter(
    (entry) => entry.action === 'remove_attendance_record',
  ).length;

  dropRpcResponseOnce('remove_attendance_record');
  const row = rowFor(name);
  dom.click(dom.buttonNamed(row, 'Remove'));
  dom.fire(dom.$('attendee-remove-form'), 'submit');
  try {
    await initialStorageLoad.captured;
    await until(
      async () =>
        (await adminAudit()).attendance.every((candidate) => candidate.id !== record.id),
      'Remove did not commit while the older Storage load was held',
    );
  } finally {
    initialStorageLoad.release();
  }
  await settle();

  const after = await adminAudit();
  const mutationCalls = after.calls
    .slice(beforeCalls)
    .filter((call) => call.fn === 'remove_attendance_record' && call.actor);
  assert.equal(mutationCalls.length, 1, 'Remove retried after its committed response was lost');
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'remove_attendance_record').length,
    beforeAudits + 1,
    'Remove wrote more than one audit row',
  );
  assert.equal(
    after.attendance.filter((one) => one.id === record.id).length,
    0,
    'Remove reconciliation left the record behind',
  );
  assert.ok(!rowFor(name), 'Remove reconciliation left the row on screen');
  assert.equal(await evidenceObjectExists(path), true, 'response loss unexpectedly deleted the photo');
  assert.equal(
    dom.$('screen-message-title').textContent,
    `${name} removed · Photo waiting on Storage`,
  );
  assert.ok(
    after.calls.slice(beforeCalls).some((call) => call.fn === 'rest.v_possible_duplicate_members'),
    'Remove did not refresh member-derived views',
  );

  const outstanding = await select('v_purge_runs_outstanding', {
    select: 'purge_run_id,kind,outstanding_count',
  });
  const mine = outstanding.filter((one) => one.kind === 'record_removed');
  assert.equal(mine.length, 1, 'response loss did not leave a recoverable purge run');
  assert.equal(Number(mine[0].outstanding_count), 1);
  const totalOutstanding = outstanding.reduce(
    (sum, run) => sum + Number(run.outstanding_count ?? 0),
    0,
  );
  assert.equal(
    storageOutstandingCount(),
    totalOutstanding,
    'an older Storage load overwrote the post-removal recovery reload',
  );

  await finishOutstandingFromStorage(mine[0].purge_run_id);
  assert.equal(await evidenceObjectExists(path), false, 'Storage did not finish the recovered photo');
});

await check('Remove reconciles a committed call whose response body was lost', async () => {
  const { record, path, name } = await aRecordWithAPhoto();
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter(
    (entry) => entry.action === 'remove_attendance_record',
  ).length;
  const beforeOutstanding = storageOutstandingCount();
  const restoreFetch = dropRpcBodyOnce('remove_attendance_record');

  try {
    const row = rowFor(name);
    dom.click(dom.buttonNamed(row, 'Remove'));
    dom.fire(dom.$('attendee-remove-form'), 'submit');
    await settle();
  } finally {
    restoreFetch();
  }

  const after = await adminAudit();
  assert.equal(
    after.calls
      .slice(beforeCalls)
      .filter((call) => call.fn === 'remove_attendance_record' && call.actor).length,
    1,
    'Remove retried after success headers and a lost body',
  );
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'remove_attendance_record').length,
    beforeAudits + 1,
    'Remove wrote more than one audit row after body loss',
  );
  assert.equal(
    after.attendance.filter((candidate) => candidate.id === record.id).length,
    0,
    'Remove body loss left the attendance record behind',
  );
  assert.ok(!rowFor(name), 'Remove body loss left the row on screen');
  assert.equal(await evidenceObjectExists(path), true, 'body loss unexpectedly deleted the photo');
  assert.equal(
    dom.$('screen-message-title').textContent,
    `${name} removed · Photo waiting on Storage`,
  );

  const outstanding = await select('v_purge_runs_outstanding', {
    select: 'purge_run_id,kind,outstanding_count',
  });
  const mine = outstanding.filter((one) => one.kind === 'record_removed');
  assert.equal(mine.length, 1, 'body loss did not leave a recoverable purge run');
  assert.equal(storageOutstandingCount(), beforeOutstanding + 1);
  await finishOutstandingFromStorage(mine[0].purge_run_id);
  assert.equal(await evidenceObjectExists(path), false, 'Storage did not finish the body-loss run');
});

await check('removing updates every event figure and deletes only the intended record', async () => {
  await backToList();
  await openEvent('Spring GBM 5');

  const { record, path, name } = await aRecordWithAPhoto();
  const beforeUi = detailSnapshot();
  const beforeDb = await adminAudit();
  const memberBefore = beforeDb.members.find((member) => member.id === record.member_id);
  const unrelatedBefore = beforeDb.attendance.filter((one) => one.id !== record.id);
  const [eventBefore] = await select('events', {
    select: EVENT_SELECT,
    filters: { id: `eq.${record.event_id}` },
  });
  assert.equal(await evidenceObjectExists(path), true, 'the photo is not in the bucket to begin with');

  const row = rowFor(name);
  assert.ok(row, `${name} is not on the attendee list`);
  dom.click(dom.buttonNamed(row, 'Remove'));
  assert.match(dom.$('attendee-remove-note').textContent, /photo/i, 'the dialog does not mention the photo');
  dom.fire(dom.$('attendee-remove-form'), 'submit');
  await settle();

  assert.equal(
    (await adminAudit()).attendance.filter((one) => one.id === record.id).length,
    0,
    'the record is still there',
  );
  assert.equal(await evidenceObjectExists(path), false, 'the photo is still in the bucket');
  assert.ok(!rowFor(name), 'the row is still on screen');

  const afterDb = await adminAudit();
  assert.deepEqual(
    afterDb.members.find((member) => member.id === record.member_id),
    memberBefore,
    'the member changed with the attendance record',
  );
  assert.deepEqual(
    afterDb.attendance.filter((one) => one.id !== record.id),
    unrelatedBefore,
    'an unrelated attendance record changed',
  );
  const [eventAfter] = await select('events', {
    select: EVENT_SELECT,
    filters: { id: `eq.${record.event_id}` },
  });
  assert.deepEqual(eventAfter, eventBefore, 'the event changed with the attendance record');

  const afterUi = detailSnapshot();
  assert.equal(afterUi.records, beforeUi.records - 1);
  assert.equal(afterUi.count, `${afterUi.records} records`);
  const changedStat =
    record.status === 'approved' ? 'Approved' : record.status === 'pending' ? 'Waiting' : 'Declined';
  for (const label of ['Approved', 'Waiting', 'Declined', 'Not matched']) {
    const decrease = label === changedStat || (label === 'Not matched' && !record.member_id) ? 1 : 0;
    assert.equal(afterUi.stats[label], beforeUi.stats[label] - decrease, `${label} did not refresh`);
  }
  assert.equal(afterUi.sources.Scanned, beforeUi.sources.Scanned - 1, 'the source count did not refresh');

  const enrolled = (
    await select('member_enrollments', {
      select: 'member_id,members(id,archived_at,merged_into_id)',
      filters: {
        academic_year_id: `eq.${IDS.YEAR_CURRENT}`,
        'members.archived_at': 'is.null',
        'members.merged_into_id': 'is.null',
      },
    })
  ).length;
  assert.equal(
    afterUi.stats['Of the roster'],
    `${Math.round((afterUi.stats.Approved / enrolled) * 100)}%`,
    'the roster percentage did not refresh',
  );

  await backToList();
  await openEvent('Spring GBM 5');
  assert.ok(!rowFor(name), 'the removed row came back after reopening the event');
  assert.deepEqual(detailSnapshot(), afterUi, 'the refreshed event disagrees with the saved deletion');
});

await check('a bucket that refuses leaves an outstanding purge run, not bytes nobody can name', async () => {
  // THE RECOVERY PATH IS THE FINDING. Storage and Postgres are two systems
  // with no transaction across them, so the client cannot make this safe by
  // picking an order: object first destroys a photo irreversibly when the row
  // delete then fails, and row first strands bytes that no operator tool can
  // reach (purge_orphaned_uploads() only sees grants nobody consumed, and
  // submit_checkin() consumes them). So the intent is written down first, and
  // what proves it is a purge run still outstanding after the bucket refused.
  const { record, path, name } = await aRecordWithAPhoto();
  const beforeOutstanding = storageOutstandingCount();
  failStorageDeleteOnce([path]);

  const row = rowFor(name);
  dom.click(dom.buttonNamed(row, 'Remove'));
  dom.fire(dom.$('attendee-remove-form'), 'submit');
  await settle();

  assert.equal(
    (await adminAudit()).attendance.filter((one) => one.id === record.id).length,
    0,
    'the record survived a bucket failure',
  );
  assert.equal(await evidenceObjectExists(path), true, 'the injected bucket failure did not happen');

  const outstanding = await select('v_purge_runs_outstanding', {
    select: 'purge_run_id,kind,outstanding_count',
  });
  const mine = outstanding.filter((one) => one.kind === 'record_removed');
  assert.equal(mine.length, 1, 'the stranded photo is not on any outstanding run');
  assert.equal(Number(mine[0].outstanding_count), 1);
  assert.equal(
    storageOutstandingCount(),
    beforeOutstanding + 1,
    'the mounted Storage panel missed the run after the bucket failure',
  );

  assert.match(
    dom.$('screen-message-title').textContent,
    /waiting on Storage/i,
    `nothing said the photo was left behind: ${JSON.stringify(dom.$('screen-message-title').textContent)}`,
  );

  await finishOutstandingFromStorage(mine[0].purge_run_id);
  assert.equal(await evidenceObjectExists(path), false, 'Storage did not finish the refused photo');
});

await check('a finish failure reloads Storage with a run it can finish', async () => {
  const beforeOutstanding = storageOutstandingCount();
  const { record, path, name } = await aRecordWithAPhoto();
  failRpcOnce('finish_purge_run');

  const row = rowFor(name);
  dom.click(dom.buttonNamed(row, 'Remove'));
  dom.fire(dom.$('attendee-remove-form'), 'submit');
  await settle();

  assert.equal(
    (await adminAudit()).attendance.filter((one) => one.id === record.id).length,
    0,
    'the record survived a finish failure',
  );
  assert.equal(await evidenceObjectExists(path), false, 'the bucket delete did not happen');
  const outstanding = await select('v_purge_runs_outstanding', {
    select: 'purge_run_id,kind,outstanding_count',
  });
  const mine = outstanding.filter((one) => one.kind === 'record_removed');
  assert.equal(mine.length, 1, 'the bookkeeping failure did not stay outstanding');
  assert.equal(Number(mine[0].outstanding_count), 1);
  assert.equal(
    storageOutstandingCount(),
    beforeOutstanding + 1,
    'the mounted Storage panel missed the run after the finish failure',
  );
  assert.match(dom.$('screen-message-title').textContent, /waiting on Storage/i);

  await finishOutstandingFromStorage(mine[0].purge_run_id);
});

await check('a removal whose bucket call works leaves no outstanding run behind', async () => {
  const before = (
    await select('v_purge_runs_outstanding', { select: 'purge_run_id,kind' })
  ).filter((one) => one.kind === 'record_removed').length;

  const { record, path, name } = await aRecordWithAPhoto();
  const row = rowFor(name);
  dom.click(dom.buttonNamed(row, 'Remove'));
  dom.fire(dom.$('attendee-remove-form'), 'submit');
  await settle();

  assert.equal(await evidenceObjectExists(path), false, 'the photo is still in the bucket');
  assert.equal(
    (await adminAudit()).attendance.filter((one) => one.id === record.id).length,
    0,
    'the record is still there',
  );
  const after = (
    await select('v_purge_runs_outstanding', { select: 'purge_run_id,kind' })
  ).filter((one) => one.kind === 'record_removed').length;
  assert.equal(after, before, 'a clean removal left bookkeeping outstanding');
  assert.ok(!rowFor(name), 'the row is still on screen');
});

await check('Preview opens exactly what the QR code encodes', async () => {
  const before = opened.length;
  dom.click(dom.$('event-detail-preview'));
  assert.equal(opened.length, before + 1, 'Preview opened nothing');

  const [event] = await select('events', {
    select: 'checkin_token',
    filters: { id: `eq.${IDS.EVENT_GBM}` },
  });
  assert.equal(
    opened[opened.length - 1].url,
    buildCheckinUrl(`http://localhost:${PORT}/admin/`, event.checkin_token),
    'Preview and the QR code point at different pages',
  );
  assert.equal(opened[opened.length - 1].target, '_blank');
});

await check('an event with check-ins cannot be deleted, and the screen says so rather than asking', async () => {
  assert.equal(dom.$('event-detail-delete').disabled, true, 'Delete was offered on an event with check-ins');

  // And the database is the backstop: attendance_records.event_id is
  // `on delete restrict`, so this is refused even without the screen.
  await assert.rejects(
    () => remove('events', { id: `eq.${IDS.EVENT_GBM}` }),
    (err) => err instanceof RpcError,
    'the database allowed an event with check-ins to be deleted',
  );
});

await check('Duplicate opens a new event filled in, and writes nothing', async () => {
  const before = (await select('events', { select: 'id', filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` } })).length;

  dom.click(dom.$('event-detail-duplicate'));
  assert.ok(!dom.$('event-form-view').hidden, 'the form did not open');
  assert.equal(dom.$('event-form-title').textContent, 'New event', 'Duplicate opened the editor instead of a new event');
  assert.equal(dom.$('event-title').value, 'Spring GBM 5', 'the title was not copied');
  assert.notEqual(dom.$('event-date').value, '2026-08-11', 'the copy kept the original date');
  assert.equal(
    dom.$('event-categories').querySelectorAll('.event-category-row').length,
    1,
    'the categories were not copied',
  );

  const after = (await select('events', { select: 'id', filters: { academic_year_id: `eq.${IDS.YEAR_CURRENT}` } })).length;
  assert.equal(after, before, 'Duplicate wrote an event before Save was pressed');

  // The whole detail view, not the body inside it: the body keeps its own
  // hidden flag through a trip to the form, so asserting on it would pass
  // against a blank screen.
  dom.click(dom.$('event-cancel'));
  await until(() => !dom.$('event-detail-view').hidden, 'Cancel did not go back to the event');
  assert.ok(dom.$('event-list').hidden, 'the list is showing behind the event');
  assert.equal(dom.$('event-detail-title').textContent, 'Spring GBM 5');
});

await check('Edit pressed on an event puts the officer back on it, showing what they saved', async () => {
  dom.click(dom.$('event-detail-edit'));
  assert.equal(dom.$('event-form-title').textContent, 'Edit event', 'Edit did not open the editor');

  dom.$('event-starts').value = '2026-08-11T18:00';
  dom.$('event-ends').value = '2026-08-11T20:00';
  dom.fire(dom.$('event-form'), 'submit');
  await until(() => !dom.$('event-detail-view').hidden, 'Save did not go back to the event');
  await settle();

  assert.ok(dom.$('event-list').hidden, 'Save dropped the officer back on the list');
  assert.equal(dom.$('event-detail-title').textContent, 'Spring GBM 5');
  const [saved] = await select('events', {
    select: 'starts_at,ends_at',
    filters: { title: 'eq.Spring GBM 5' },
  });
  assert.equal(saved.starts_at, '2026-08-11T22:00:00.000Z');
  assert.equal(saved.ends_at, '2026-08-12T00:00:00.000Z');
  assert.ok(!dom.$('event-detail-meta').textContent.includes('HPA'));
});

await check('an event nobody checked in to can be deleted, and takes its categories with it', async () => {
  await backToList();

  dom.click(dom.$('event-new'));
  dom.$('event-title').value = 'Verify Deletable Event';
  dom.$('event-date').value = '2026-09-20';
  dom.$('event-categories').querySelectorAll('select')[0].value = IDS.CATEGORY_GBMS;
  dom.fire(dom.$('event-categories').querySelectorAll('select')[0], 'change');
  dom.fire(dom.$('event-form'), 'submit');
  await until(() => rowTitles().includes('Verify Deletable Event'), 'the event was never created');

  const [made] = await select('events', {
    select: 'id',
    filters: { title: 'eq.Verify Deletable Event' },
  });
  assert.ok(made, 'the event is not in the database');
  const links = await select('event_categories', { select: 'event_id', filters: { event_id: `eq.${made.id}` } });
  assert.equal(links.length, 1, 'the category was not written');

  await openEvent('Verify Deletable Event');
  assert.equal(dom.$('event-detail-delete').disabled, false, 'Delete is not offered on an event with no check-ins');
  dom.click(dom.$('event-detail-delete'));
  dom.fire(dom.$('event-delete-form'), 'submit');
  await until(() => !dom.$('event-list').hidden, 'the screen never went back to the list');
  await until(() => !rowTitles().includes('Verify Deletable Event'), 'the event is still on the list');

  const gone = await select('events', { select: 'id', filters: { id: `eq.${made.id}` } });
  assert.equal(gone.length, 0, 'the event is still in the database');
  const orphans = await select('event_categories', { select: 'event_id', filters: { event_id: `eq.${made.id}` } });
  assert.equal(orphans.length, 0, 'the category link outlived the event');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe year selector is global\n');
// ---------------------------------------------------------------------------
//
// The one thing on this screen that fails silently and expensively. An open
// event, or a half-filled form, belongs to the year it was opened in. The
// screen used to close both because load() ended in showList() unconditionally;
// once the detail screen needed a load that did NOT close it, that became a
// decision this screen has to make on purpose, and getting it wrong is
// invisible: the year in the top bar reads 2025-2026 while the screen shows a
// 2026-2027 event, and pressing Save on the form writes the event into the year
// the officer is no longer looking at.

const yearSelect = () => dom.$('year-select');
const switchYear = async (label) => {
  const option = yearSelect()
    .querySelectorAll('option')
    .find((one) => one.textContent.trim() === label);
  assert.ok(option, `there is no ${label} to switch to`);
  yearSelect().value = option.getAttribute('value');
  dom.fire(yearSelect(), 'change');
  await until(() => !dom.$('event-list').hidden, `the list never came back on ${label}`);
};

await check('changing the year closes the event that was open, and lands on the list', async () => {
  await clearListFilters();
  await openEvent('Spring GBM 5');
  assert.ok(!dom.$('event-detail-view').hidden, 'the event did not open');

  await switchYear('2025-2026');
  assert.ok(dom.$('event-detail-view').hidden, "last year's screen is still showing this year's event");
  assert.ok(!dom.$('events-toolbar').hidden, 'the toolbar did not come back');
  assert.ok(
    !rowTitles().includes('Spring GBM 5'),
    'an event from the other year is on the list',
  );
  assert.ok(rowTitles().includes('Fall GBM 1'), `the other year's events are missing: ${rowTitles().join(', ')}`);

  await switchYear('2026-2027');
});

await check('the year change takes the screen down before the reload, not after it', async () => {
  // THE GAP THIS CLOSES. Dismissing only once the reload lands leaves the old
  // event, or a filled-in form, on screen and pressable under a selector that
  // already names the new year. A Save in that gap writes the event into the
  // new year with the old year's fields, because academic_year_id is read at
  // Save. So the assertion is deliberately made with NO await in between: the
  // screen must already be down on the turn the selector fires.
  await clearListFilters();
  await openEvent('Spring GBM 5');

  const option = yearSelect()
    .querySelectorAll('option')
    .find((one) => one.textContent.trim() === '2025-2026');
  yearSelect().value = option.getAttribute('value');
  dom.fire(yearSelect(), 'change');

  assert.ok(dom.$('event-detail-view').hidden, 'the event was still up after the selector fired');
  assert.ok(dom.$('event-list').hidden, "the list was showing the old year's rows mid-flight");

  await until(() => !dom.$('event-list').hidden, 'the list never came back');
  await switchYear('2026-2027');
});

await check('changing the year abandons a half-filled form rather than writing it into the new year', async () => {
  const countIn = async (yearId) =>
    (await select('events', { select: 'id', filters: { academic_year_id: `eq.${yearId}` } })).length;
  const beforeCurrent = await countIn(IDS.YEAR_CURRENT);
  const beforePast = await countIn(IDS.YEAR_PAST);

  dom.click(dom.$('event-new'));
  dom.$('event-title').value = 'Verify Year Switch';
  dom.$('event-date').value = '2026-09-25';
  assert.ok(!dom.$('event-form-view').hidden, 'the form did not open');

  await switchYear('2025-2026');
  assert.ok(dom.$('event-form-view').hidden, 'the form survived the year change');
  // Losing typed work is the one thing here the screen cannot show on its own.
  assert.match(dom.$('screen-message-title').textContent, /not saved/i, `nothing said the form was dropped; the banner read ${JSON.stringify(dom.$('screen-message-title').textContent)}`);

  assert.equal(await countIn(IDS.YEAR_CURRENT), beforeCurrent, 'an event was written to the year left behind');
  assert.equal(await countIn(IDS.YEAR_PAST), beforePast, 'an event was written to the year switched to');

  await switchYear('2026-2027');
  dom.click(dom.$('event-new'));
  assert.equal(dom.$('event-title').value, '', 'the abandoned title came back on the next New event');
  dom.click(dom.$('event-cancel'));
});

await check('unmatched visitors stay out of Needs review and can open their event', async () => {
  dom.click(dom.$('tab-review'));
  dom.click(dom.$('refresh'));
  await until(
    () => !dom.$('zone-unmatched').hidden && !dom.$('zone-flagged').hidden,
    'the review groups did not open',
  );

  const unmatchedId = IDS.RECORD_UNMATCHED_CLOSE;
  assert.equal(
    dom.$('flagged-list').querySelector(`[data-id="${unmatchedId}"]`),
    null,
    'an ordinary unmatched visitor still appeared in Needs review',
  );
  assert.equal(dom.$('unmatched-list').children.length, 0, 'collapsed visitors were still rendered');
  dom.$('zone-unmatched').open = true;
  dom.fire(dom.$('zone-unmatched'), 'toggle');
  const card = dom.$('unmatched-list').querySelector(`[data-id="${unmatchedId}"]`);
  assert.ok(card, 'the unmatched visitor was no longer available for optional linking');
  assert.equal(card.querySelector('.card-headline').textContent.trim(), 'Not on roster');
  assert.doesNotMatch(card.textContent, /before awarding points/i);

  const suggestion = card.querySelector(`[data-member-id="${IDS.MEMBER_ABIGAIL}"]`);
  assert.ok(suggestion, 'the optional group no longer offered a roster link');
  dom.click(suggestion);
  await until(
    () => dom.$('flagged-list').querySelector(`[data-id="${unmatchedId}"]`),
    'linking did not move the record into actionable review',
  );
  const linked = dom.$('flagged-list').querySelector(`[data-id="${unmatchedId}"]`);
  assert.equal(linked.querySelector('.card-headline').textContent.trim(), 'Ready to approve');
  assert.ok(dom.buttonNamed(linked, 'Approve'), 'the linked record offered no approval action');

  const offending = dom.$('flagged-list').querySelector(
    `[data-id="${IDS.RECORD_MISSING_EVIDENCE}"]`,
  );
  dom.click(dom.buttonNamed(offending, 'View event'));
  await until(
    () => !dom.$('panel-events').hidden && !dom.$('event-detail-body').hidden,
    'View event did not open the event detail',
  );
  assert.equal(dom.$('event-detail-title').textContent, 'Soap Carving');

  dom.click(dom.$('event-detail-back'));
  await until(
    () => !dom.$('panel-review').hidden && dom.$('event-select').value === IDS.EVENT_SOAP,
    'Back did not return to the filtered review queue',
  );
  dom.$('event-select').value = 'all';
  dom.fire(dom.$('event-select'), 'change');
});

await check('Approve all excludes 99 member-entered points until an individual approval', async () => {
  const [member] = await insert('members', [
    { first_name: 'Routine', last_name: 'Control' },
  ]);
  await insert('member_enrollments', [
    { member_id: member.id, academic_year_id: IDS.YEAR_CURRENT, status: 'active' },
  ]);
  const [routineControl] = await insert('attendance_records', [
    {
      event_id: IDS.EVENT_GBM,
      member_id: member.id,
      source: 'self_checkin',
      submitted_value: null,
      flags: [],
    },
  ]);

  dom.click(dom.$('tab-review'));
  dom.click(dom.$('refresh'));
  await until(
    () => !dom.$('zone-flagged').hidden && !dom.$('zone-routine').hidden,
    'the review queue did not open',
  );

  const enteredId = IDS.RECORD_MEMBER_ENTERED_99;
  const card = dom.$('flagged-list').querySelector(`[data-id="${enteredId}"]`);
  assert.ok(card, '99 member-entered points were shown as Routine');
  assert.equal(card.querySelector('.card-headline').textContent.trim(), 'Member-entered points');
  assert.match(card.textContent, /Volunteering:\s*99/);
  assert.equal(
    dom.$('routine-grid').querySelector(`[data-id="${enteredId}"]`),
    null,
    'the member-entered value was included in the Routine grid',
  );

  dom.click(dom.$('approve-all'));
  await until(async () => {
    const rows = (await adminAudit()).attendance;
    return rows.find((record) => record.id === routineControl.id)?.status === 'approved';
  }, 'Approve all did not approve the routine control');
  const afterBatch = (await adminAudit()).attendance;
  assert.equal(
    afterBatch.find((record) => record.id === enteredId)?.status,
    'pending',
    'Approve all changed the member-entered record',
  );

  dom.click(dom.buttonNamed(card, 'Approve'));
  await until(
    async () =>
      (await adminAudit()).attendance.find((record) => record.id === enteredId)?.status === 'approved',
    'the explicit individual approval did not commit',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const eventSources = {
  'src/events.js': await readFile(`${WEB_ROOT}src/events.js`, 'utf8'),
  'src/event-detail.js': await readFile(`${WEB_ROOT}src/event-detail.js`, 'utf8'),
  'src/events-model.js': await readFile(`${WEB_ROOT}src/events-model.js`, 'utf8'),
};

await check('event configuration saves through one transactional RPC', () => {
  const source = eventSources['src/events.js'];
  assert.match(source, /callRpc\(\s*'save_event_config'/);
  for (const [label, moduleSource] of Object.entries(eventSources)) {
    assert.doesNotMatch(moduleSource, /insert\(\s*'events'/, `${label} inserts events directly`);
    assert.doesNotMatch(moduleSource, /patch\(\s*'events'/, `${label} updates events directly`);
    for (const child of ['event_categories', 'event_evidence_requirements']) {
      assert.doesNotMatch(
        moduleSource,
        new RegExp(`(?:insert|patch|remove)\\(\\s*'${child}'`),
        `${label} mutates ${child} directly`,
      );
    }
    if (label !== 'src/event-detail.js') {
      assert.doesNotMatch(moduleSource, /remove\(\s*'events'/, `${label} deletes events directly`);
    }
  }
  assert.match(
    eventSources['src/event-detail.js'],
    /remove\(\s*'events'/,
    'the retained direct DELETE grant has no product caller',
  );
});

await check('nothing on these screens writes attendance_records.status', () => {
  // RLS would allow it: attendance_write_officer is FOR ALL. Approve and
  // Decline go through review_records() anyway, because that is what stamps
  // the reviewer, writes the audit row, and refuses the approvals that have
  // to be refused. Nothing else would notice this coming back.
  for (const [label, source] of Object.entries(eventSources)) {
    assert.doesNotMatch(source, /status:\s*'(approved|rejected|pending)'/, `${label} sets a status directly`);
    assert.doesNotMatch(
      source,
      /patch\(\s*'attendance_records'/,
      `${label} patches attendance_records rather than calling review_records()`,
    );
  }
});

await check('no em dash in anything the events screen is made of', () => {
  const emDash = String.fromCharCode(0x2014);
  const files = { ...eventSources, 'admin/index.html': adminHtml, 'assets/css/admin.css': adminCss };
  for (const [label, source] of Object.entries(files)) {
    assert.ok(!source.includes(emDash), `${label} contains an em dash`);
  }
});

await check('the database vocabulary never reaches the events screen', () => {
  const banned = ['node', 'threshold', 'schema', 'RLS', 'PostgREST', 'uuid', 'jsonb', 'foreign key', 'cascade'];
  const withoutComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const copy = [];
  for (const [label, source] of Object.entries(eventSources)) {
    for (const pattern of [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g, /`((?:[^`\\]|\\.)*)`/g]) {
      for (const match of withoutComments(source).matchAll(pattern)) {
        const text = match[1];
        if (!text || (!/\s/.test(text) && !/[A-Z]/.test(text))) continue;
        copy.push([label, text]);
      }
    }
  }
  copy.push(['admin/index.html', adminHtml.replace(/<!--[\s\S]*?-->/g, ' ')]);

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

// ---------------------------------------------------------------------------

server.close();
process.stdout.write(`\n${failures ? 'FAIL' : 'OK'}: ${failures} failure(s)\n`);
process.exit(failures ? 1 : 0);
