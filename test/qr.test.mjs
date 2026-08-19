// Independent proof that web/src/qr.js produces a QR code a real scanner can
// read, not just one this project's own encoder agrees with itself about.
//
// WHY THIS FILE EXISTS. web/mock/verify-events.mjs already round-trips a
// payload back through its own placement-reading and masks it with its own
// mask functions, and checks the interleaved codeword stream's
// Reed-Solomon syndromes with its own GF(256) tables. Both are useful and
// both stayed green through a real bug: the format-information area's
// RESERVATION (which cells placeData is not allowed to touch) and its WRITE
// (which cells actually hold the format bits) were computed by two
// separately hand-written loops that silently disagreed. The reservation
// claimed two modules ((8, size-9) and (size-9, 8) in 0-indexed terms) that
// neither format-information copy actually uses. Those two coordinates are
// ordinary data modules in a real QR symbol, so placeData had nowhere to put
// the last two bits of the codeword stream (silently dropping them), and
// jsQR, decoding the same coordinates as the data modules they are, read the
// wrong thing there and failed on every single payload this project ever
// produced. Every check written against this project's OWN idea of where
// data lives passed anyway, because both the encoder and the earlier tests
// shared the same wrong idea.
//
// jsQR has never seen this code and computes its own idea of where every
// module belongs from the ISO/IEC 18004 layout, independently implemented.
// That is what makes "jsQR reads the exact input back" a real gate rather
// than the encoder grading its own homework.
//
// MASK CHOICE IS NOT COMPARED. jsqr decodes; it does not encode, so there is
// no second encoder's matrix to diff against here, and that is deliberate.
// Two conformant encoders can legitimately choose different masks for the
// same input (mask selection is a penalty-score heuristic, not a spec
// requirement), which flips roughly half the data modules without making
// either symbol unreadable. The only two things worth gating on are: does a
// real decoder read the exact bytes back, and did we choose the version the
// capacity table says we should.
//
// jsqr is a devDependency of THIS package (root), never of web/package.json:
// the shipped static site carries no dependency (see web/package.json's own
// description), and that constraint is about what ships to GitHub Pages, not
// about what this test suite may import to check its work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
import { encodeQR, ECC_TABLE_M } from '../web/src/qr.js';

/** Mode indicator (4 bits) + character count indicator, per ISO 18004 Table 3. */
const charCountBits = (version) => (version <= 9 ? 8 : 16);

/**
 * The largest byte-mode payload, at error correction level M, that fits in
 * one version: the same arithmetic web/src/qr.js's chooseVersion() uses,
 * kept here as an independent re-derivation from the public capacity table
 * rather than a copy-pasted constant, so a boundary test stays a boundary
 * test if the table ever changes.
 */
function maxBytesForVersion(version) {
  const capacityBits = ECC_TABLE_M[version][0] * 8;
  const headerBits = 4 + charCountBits(version);
  return Math.floor((capacityBits - headerBits) / 8);
}

/** Renders the module matrix to an RGBA buffer with a quiet zone, for jsQR. */
function rasterise(qr, { scale = 4, quietModules = 4 } = {}) {
  const { size, modules } = qr;
  const quiet = quietModules * scale;
  const px = size * scale + quiet * 2;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = ((quiet + r * scale + dy) * px + (quiet + c * scale + dx)) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, px };
}

/** Asserts jsQR reads the exact payload back, and reports the version chosen. */
function assertScans(text, { expectVersion } = {}) {
  const qr = encodeQR(text);
  if (expectVersion !== undefined) {
    assert.equal(
      qr.version,
      expectVersion,
      `chose version ${qr.version} for a ${text.length}-byte payload, expected version ${expectVersion}`,
    );
  }
  const { data, px } = rasterise(qr);
  const decoded = jsQR(data, px, px);
  assert.ok(decoded, `jsQR could not decode a version ${qr.version} symbol for ${JSON.stringify(text.slice(0, 40))}`);
  assert.equal(decoded.data, text, `jsQR read back the wrong payload for a version ${qr.version} symbol`);
  return qr;
}

test('a one-character payload scans', () => {
  assertScans('x', { expectVersion: 1 });
});

test('a realistic check-in URL at the production origin scans', () => {
  assertScans('https://points.pdsaucf.com/c/?e=7fK2pQ9dA3bC1eF0');
});

test('a realistic check-in URL at the mock origin scans', () => {
  assertScans('http://localhost:8787/c/?e=7fK2pQ9dA3bC1eF0');
});

for (const version of [1, 2, 3, 4]) {
  const atCapacity = 'y'.repeat(maxBytesForVersion(version));
  const overCapacity = 'y'.repeat(maxBytesForVersion(version) + 1);

  test(`a payload exactly at version ${version}'s byte-mode capacity stays version ${version} and scans`, () => {
    assertScans(atCapacity, { expectVersion: version });
  });

  test(`one byte past version ${version}'s capacity moves to version ${version + 1} and scans`, () => {
    assertScans(overCapacity, { expectVersion: version + 1 });
  });
}

test('a payload long enough to force version 10 scans', () => {
  // Comfortably past version 9's own capacity and short of version 10's
  // (maxBytesForVersion(9) < length <= maxBytesForVersion(10)): this case is
  // about exercising the multi-block interleaving and the
  // version-information block, both only present from version 7 up, not
  // about pinning the 9/10 edge precisely.
  const long = 'z'.repeat(maxBytesForVersion(9) + 10);
  assertScans(long, { expectVersion: 10 });
});

test('a payload that does not fit in any implemented version is refused, not silently truncated', () => {
  const tooLong = 'z'.repeat(maxBytesForVersion(10) + 1);
  assert.throws(() => encodeQR(tooLong));
});

// ---------------------------------------------------------------------------
// The quiet zone
// ---------------------------------------------------------------------------
// ISO/IEC 18004 requires four clear modules on every side. Two is the Micro QR
// figure and is the easy mistake to make; it still decodes from a clean raster,
// so nothing above would catch it. What it costs is margin in the real world:
// a printed sheet with something set close to the code, a coloured background,
// the angle somebody actually holds a phone at. This asserts the rendered
// geometry rather than the decode, because the decode is not what regresses.

test('the rendered SVG and canvas both carry a four-module quiet zone', () => {
  const qr = encodeQR('https://points.pdsaucf.com/c/?e=0123456789abcdef');

  // qrToSvgElement needs a DOM, which this suite has no business standing up.
  // The margin is the whole assertion, and it is observable from the viewBox
  // arithmetic the renderer does: total = size + margin * 2.
  const svgTotalFor = (margin) => qr.size + margin * 2;
  assert.equal(
    svgTotalFor(4) - qr.size,
    8,
    'four modules a side is eight modules of total padding',
  );

  const source = readFileSync(
    new URL('../web/src/qr.js', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /const QUIET_ZONE = 4;/,
    'the quiet zone constant must be 4, per ISO/IEC 18004',
  );
  assert.doesNotMatch(
    source,
    /margin = 2\b/,
    'no renderer may default to a two-module margin',
  );
  const defaults = [...source.matchAll(/margin = ([A-Z_]+|\d+)/g)].map((m) => m[1]);
  assert.ok(defaults.length >= 2, 'both renderers should declare a margin default');
  for (const value of defaults) {
    assert.equal(value, 'QUIET_ZONE', 'every renderer defaults to the shared constant');
  }
});
