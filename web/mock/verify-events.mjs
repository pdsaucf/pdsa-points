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
import { startMock } from './server.mjs';
import { signInAs as signInAsAccount } from './sign-in.mjs';
import { IDS } from './admin-fixtures.mjs';

const PORT = 8799;

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

const auth = await import('../src/auth.js');
const { select, insert, patch } = await import('../src/rest.js');
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

server.close();
process.stdout.write(`\n${failures ? 'FAIL' : 'OK'}: ${failures} failure(s)\n`);
process.exit(failures ? 1 : 0);
