// Checks for the events screen and its QR encoder.
//
// Same rule as verify-admin.mjs: assert the things that fail SILENTLY.
//
//   1. Creating an event is three requests with no transaction across them,
//      so what has to be proven is that all three actually landed, and that
//      the row that comes back carries a checkin_token: without one the QR
//      code has nothing to encode.
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
const {
  validateCategoryRows,
  diffCategoryRows,
  diffEvidenceRow,
  defaultCloseTime,
  eventStatus,
  buildCheckinUrl,
} = await import('../src/events-model.js');
const { encodeQR, formatBits, ECC_TABLE_M } = await import('../src/qr.js');

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
  'id,title,occurred_on,location,term_id,checkin_token,checkin_opens_at,checkin_closes_at,',
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
      location: 'HPA-1 100',
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
  assert.equal(reread.is_published, true);
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

const initialStorageLoad = holdNextRestResponse('v_purge_runs_outstanding');
start();
dom.$('signin-passcode').value = 'mock-passcode';
dom.fire(dom.$('signin-form'), 'submit');
await until(() => !dom.$('view-app').hidden, 'the app never opened');
await until(() => !dom.$('event-list').hidden, 'the events list never rendered');

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

await check('the events list draws the year, and last year stays out of it', () => {
  const titles = rowTitles();
  assert.ok(titles.includes('Spring GBM 5'), `Spring GBM 5 is missing: ${titles.join(', ')}`);
  assert.ok(titles.includes('Health Fair'), 'Health Fair is missing');
  assert.ok(!titles.includes('Fall GBM 1'), 'last year\'s event is on this year\'s list');
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
  dom.$('events-sort').value = 'title_asc';
  dom.fire(dom.$('events-sort'), 'change');
  assert.equal(document.activeElement, search);
  dom.$('events-sort').value = 'date_desc';
  dom.fire(dom.$('events-sort'), 'change');
  assert.equal(document.activeElement, search);
});

await check('card QR and Edit keep their existing flows', async () => {
  let row = eventRowFor('Soap Carving');
  assert.ok(row, 'Soap Carving is not on the list');
  dom.click(dom.buttonNamed(row, 'QR'));
  assert.equal(dom.$('qr-dialog').open, true, 'QR did not open its dialog');
  assert.equal(dom.$('qr-title').textContent, 'Soap Carving');
  dom.$('qr-dialog').close();

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
  dom.$('events-sort').value = 'date_desc';
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

await check('search narrows on the title and on the place', () => {
  try {
    const search = dom.$('events-search');
    search.value = 'soap';
    dom.fire(search, 'input');
    assert.deepEqual(rowTitles(), ['Soap Carving']);

    // HPA-2 118 is Soap Carving's room, and appears in no event's title.
    search.value = 'hpa-2';
    dom.fire(search, 'input');
    assert.deepEqual(rowTitles(), ['Soap Carving'], 'the place is not searched');

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
  } finally {
    clearListFilters();
  }
});

await check('the order picker reorders the list without re-reading the server', async () => {
  const before = (await adminAudit()).calls.filter((call) => call.fn === 'rest.events').length;
  try {
    const sort = dom.$('events-sort');

    sort.value = 'title';
    dom.fire(sort, 'change');
    const byTitle = rowTitles();
    assert.deepEqual(byTitle, [...byTitle].sort((a, b) => a.localeCompare(b)), 'Title did not sort by title');

    sort.value = 'attendance';
    dom.fire(sort, 'change');
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

    const after = (await adminAudit()).calls.filter((call) => call.fn === 'rest.events').length;
    assert.equal(after, before, 'sorting sent a request');
  } finally {
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

// Add members is on screen for the whole of the detail view and is disabled
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

const pickerNames = () =>
  dom.$('attendee-add-list').querySelectorAll('.attendee-pick').map((row) => row.textContent.trim());

await check('the add dialog leaves out anybody who already has a live record', () => {
  dom.click(dom.$('attendee-add'));
  const offered = pickerNames();
  assert.ok(offered.length > 5, `only ${offered.length} members offered`);
  // Grace Okonkwo holds a pending record on this event, and the database
  // allows exactly one that is not declined.
  assert.ok(
    !offered.some((name) => name.includes('Grace Okonkwo')),
    'somebody who already has a record for this event was offered again',
  );
});

await check("the number an event collects is labelled by the category, not by the word 'hours'", () => {
  assert.ok(!dom.$('attendee-add-value-field').hidden, 'the number field is not shown on an event that collects one');
  assert.equal(dom.$('attendee-add-value-label').textContent, 'Volunteering');
});

await check('the picker searches, and a tick survives the search that hid it', () => {
  const search = dom.$('attendee-add-search');
  search.value = 'marcus';
  dom.fire(search, 'input');
  const narrowed = pickerNames();
  assert.ok(narrowed.length >= 1 && narrowed.every((name) => /marcus/i.test(name)), `search showed: ${narrowed.join(', ')}`);

  dom.$('attendee-add-list').querySelectorAll('input')[0].checked = true;
  dom.fire(dom.$('attendee-add-list').querySelectorAll('input')[0], 'change');
  assert.match(dom.$('attendee-add-count').textContent, /1 member/);

  search.value = 'leah';
  dom.fire(search, 'input');
  assert.match(dom.$('attendee-add-count').textContent, /1 member/, 'searching lost the tick');

  dom.$('attendee-add-list').querySelectorAll('input')[0].checked = true;
  dom.fire(dom.$('attendee-add-list').querySelectorAll('input')[0], 'change');
  assert.match(dom.$('attendee-add-count').textContent, /2 members/);
});

await check('adding goes through one call, not an insert the approval can be lost after', async () => {
  const before = (await adminAudit()).calls.length;

  dom.$('attendee-add-value').value = '2.5';
  dom.fire(dom.$('attendee-add-form'), 'submit');
  await settle();

  const calls = (await adminAudit()).calls.slice(before);
  const filedCall = calls.find((call) => call.fn === 'add_officer_attendance');
  assert.ok(filedCall, `add_officer_attendance was never called: ${calls.map((c) => c.fn).join(', ')}`);
  assert.equal(filedCall.count, 2);
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
  assert.equal(filed.length, 2, `${filed.length} officer entries were written`);
  for (const row of filed) {
    assert.equal(row.status, 'approved', 'an officer entry did not end up approved');
    assert.equal(Number(row.submitted_value), 2.5, 'the number typed was not written');
    assert.ok(row.reviewed_by, 'the record carries no reviewer');
  }

  const names = attendeeNames();
  assert.ok(names.some((name) => name.includes('Marcus Bell')), `Marcus Bell is not on the list: ${names.join(', ')}`);
});

await check('Add reconciles a committed call whose response was lost', async () => {
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter(
    (entry) => entry.action === 'add_officer_attendance',
  ).length;
  const beforeFiled = before.attendance.filter(
    (row) => row.event_id === IDS.EVENT_GKAS && row.source === 'officer_entry',
  ).length;

  dom.click(dom.$('attendee-add'));
  const picked = dom.$('attendee-add-list').querySelectorAll('input')[0];
  assert.ok(picked, 'there is nobody left to add');
  picked.checked = true;
  dom.fire(picked, 'change');
  dom.$('attendee-add-value').value = '1.5';
  dropRpcResponseOnce('add_officer_attendance');
  dom.fire(dom.$('attendee-add-form'), 'submit');
  await settle();

  const after = await adminAudit();
  const mutationCalls = after.calls
    .slice(beforeCalls)
    .filter((call) => call.fn === 'add_officer_attendance' && call.actor);
  assert.equal(mutationCalls.length, 1, 'Add retried after its committed response was lost');
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'add_officer_attendance').length,
    beforeAudits + 1,
    'Add wrote more than one audit row',
  );
  assert.equal(
    after.attendance.filter(
      (row) => row.event_id === IDS.EVENT_GKAS && row.source === 'officer_entry',
    ).length,
    beforeFiled + 1,
    'Add did not leave exactly one new record',
  );
  assert.equal(dom.$('screen-message-title').textContent, '1 member added');
  assert.ok(
    after.calls.slice(beforeCalls).some((call) => call.fn === 'rest.v_possible_duplicate_members'),
    'Add did not refresh member-derived views',
  );
});

await check('Add reconciles a committed call whose response body was lost', async () => {
  const before = await adminAudit();
  const beforeCalls = before.calls.length;
  const beforeAudits = before.auditLog.filter(
    (entry) => entry.action === 'add_officer_attendance',
  ).length;
  const beforeIds = new Set(
    before.attendance
      .filter((row) => row.event_id === IDS.EVENT_GKAS && row.source === 'officer_entry')
      .map((row) => row.id),
  );

  dom.click(dom.$('attendee-add'));
  const picked = dom.$('attendee-add-list').querySelectorAll('input')[0];
  assert.ok(picked, 'there is nobody left for the Add body-loss check');
  picked.checked = true;
  dom.fire(picked, 'change');
  dom.$('attendee-add-value').value = '1.25';
  const restoreFetch = dropRpcBodyOnce('add_officer_attendance');
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
      .filter((call) => call.fn === 'add_officer_attendance' && call.actor).length,
    1,
    'Add retried after success headers and a lost body',
  );
  assert.equal(
    after.auditLog.filter((entry) => entry.action === 'add_officer_attendance').length,
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
  assert.equal(dom.$('screen-message-title').textContent, '1 member added');
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
  const first = dom.$('attendee-add-list').querySelectorAll('input')[0];
  first.checked = true;
  dom.fire(first, 'change');
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

  dom.$('event-location').value = 'HPA-1 210';
  dom.fire(dom.$('event-form'), 'submit');
  await until(() => !dom.$('event-detail-view').hidden, 'Save did not go back to the event');
  await settle();

  assert.ok(dom.$('event-list').hidden, 'Save dropped the officer back on the list');
  assert.equal(dom.$('event-detail-title').textContent, 'Spring GBM 5');
  assert.match(
    dom.$('event-detail-meta').textContent,
    /HPA-1 210/,
    'the event screen is still showing what it showed before the save',
  );
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

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const eventSources = {
  'src/events.js': await readFile(`${WEB_ROOT}src/events.js`, 'utf8'),
  'src/event-detail.js': await readFile(`${WEB_ROOT}src/event-detail.js`, 'utf8'),
  'src/events-model.js': await readFile(`${WEB_ROOT}src/events-model.js`, 'utf8'),
};

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
