// Checks that hold the two things about this page that fail silently.
//
//   1. The client_nonce reaches all three call sites that accept it. Dropping
//      it breaks nothing visible: the server falls back to the rate-limit
//      bucket the whole event shares, every test still passes, and the page
//      then turns away most of a 167-person GBM. So it is asserted twice, once
//      against the source and once against a server that refuses a call
//      without one.
//
//   2. PDS09 is ridden out rather than shown. The limiter counts per calendar
//      minute, so backing off for a few seconds and giving up would put an
//      error in front of somebody who is simply inside a full window.
//
// Run: node web/mock/verify.mjs   (or npm run verify, from web/)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';

const PORT = 8799;
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

// api.js reads config.js at import time, so the override goes in first.
globalThis.__PDSA_CONFIG__ = {
  SUPABASE_URL: `http://localhost:${PORT}`,
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

const { rpc, uploadEvidence, RpcError } = await import('../src/api.js');
const { describe } = await import('../src/errors.js');

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
const reset = () => api('/__mock/reset');

const server = await startMock(PORT);

// ---------------------------------------------------------------------------
process.stdout.write('\nclient_nonce, in the source\n');
// ---------------------------------------------------------------------------

const source = await readFile(`${WEB_ROOT}src/checkin.js`, 'utf8');

await check('get_checkin_context response is kept as state.nonce', () => {
  assert.match(source, /state\.nonce\s*=\s*context\?\.client_nonce/);
});

for (const fn of ['search_members', 'create_evidence_upload', 'submit_checkin']) {
  await check(`${fn}() call site passes p_client_nonce`, () => {
    const at = source.indexOf(`'${fn}'`);
    assert.notEqual(at, -1, `no call to ${fn}() found in src/checkin.js`);
    const callSite = source.slice(at, at + 600);
    assert.match(
      callSite,
      /p_client_nonce:\s*state\.nonce/,
      `${fn}() is called without p_client_nonce: state.nonce`,
    );
  });
}

// ---------------------------------------------------------------------------
process.stdout.write('\nclient_nonce, against the server\n');
// ---------------------------------------------------------------------------

await reset();
const context = await rpc('get_checkin_context', { p_token: 'gbm' });
const nonce = context.client_nonce;

await check('get_checkin_context mints a nonce', () => {
  assert.equal(typeof nonce, 'string');
  assert.ok(nonce.length >= 16);
});

await check('search_members is accepted with the nonce', async () => {
  const rows = await rpc('search_members', {
    p_token: 'gbm',
    p_q: 'catto',
    p_client_nonce: nonce,
  });
  assert.ok(rows.some((r) => r.display_name === 'Abigail Catto'));
});

await check('search_members is REFUSED without the nonce', async () => {
  await assert.rejects(
    () => rpc('search_members', { p_token: 'gbm', p_q: 'catto' }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDSMOCK01',
  );
});

await check('create_evidence_upload is REFUSED without the nonce', async () => {
  await assert.rejects(
    () =>
      rpc(
        'create_evidence_upload',
        { p_token: 'shirt', p_member_id: null, p_kind: 'shirt_photo' },
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.code === 'PDSMOCK01',
  );
});

await check('submit_checkin is REFUSED without the nonce', async () => {
  await assert.rejects(
    () =>
      rpc(
        'submit_checkin',
        { p_token: 'gbm', p_member_id: 'm0000000-0000-4000-a000-000000000001' },
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.code === 'PDSMOCK01',
  );
});

await check('every accepted call carried the nonce it was issued', async () => {
  const { calls } = await api('/__mock/audit');
  const guarded = calls.filter((c) =>
    ['search_members', 'create_evidence_upload', 'submit_checkin'].includes(c.fn),
  );
  assert.ok(guarded.length > 0, 'no guarded calls were recorded');
  for (const call of guarded) {
    assert.equal(call.nonce, nonce, `${call.fn} used an unexpected nonce`);
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe two closed-window codes are two different screens\n');
// ---------------------------------------------------------------------------
// PDS02 and PDS10 were one code that the page told apart by reading the
// server's sentence. They ask the member for opposite things, so the thing
// worth protecting is not that each has copy, it is that the two behave
// DIFFERENTLY. Copy is meant to be rewritten freely; if a rewrite ever
// collapses them back into one behaviour, these fail.

const window02 = new RpcError('PDS02', 'Check-in for this event has not opened yet.', 400);
const window10 = new RpcError('PDS10', 'Check-in for this event has closed.', 400);

await check('PDS02 offers a retry, PDS10 does not', () => {
  assert.equal(describe(window02).retry, true, 'coming back later is the whole point of PDS02');
  assert.equal(describe(window10).retry, false, 'waiting cannot fix a closed check-in');
});

await check('PDS02 and PDS10 are different screens, not one screen twice', () => {
  const early = describe(window02);
  const closed = describe(window10);
  assert.notEqual(early.title, closed.title);
  assert.notEqual(early.body, closed.body);
});

await check('PDS10 sends the member to a person, PDS02 does not', () => {
  const closed = describe(window10);
  assert.match(
    `${closed.title} ${closed.body}`,
    /officer/i,
    'a closed check-in is only recoverable by an officer, so the copy has to say so',
  );
  const early = describe(window02);
  assert.doesNotMatch(
    `${early.title} ${early.body}`,
    /officer/i,
    'sending somebody to find an officer when they are simply early is wrong',
  );
});

await check('neither code is decided by reading the message text', () => {
  // Same codes, messages reworded past recognition. The screens must not move.
  const rewordedEarly = describe(new RpcError('PDS02', 'Doors open at five.', 400));
  const rewordedClosed = describe(new RpcError('PDS10', 'That was yesterday.', 400));
  assert.deepEqual(rewordedEarly, describe(window02));
  assert.deepEqual(rewordedClosed, describe(window10));
});

await check('get_checkin_context: an unopened event answers PDS02', async () => {
  await assert.rejects(
    () => rpc('get_checkin_context', { p_token: 'early' }),
    (err) => err instanceof RpcError && err.code === 'PDS02',
  );
});

await check('get_checkin_context: a closed event answers PDS10', async () => {
  await assert.rejects(
    () => rpc('get_checkin_context', { p_token: 'closed' }),
    (err) => err instanceof RpcError && err.code === 'PDS10',
  );
});

await check('submit_checkin: past the grace period answers PDS10, once', async () => {
  // The page loaded while check-in was open, so this reaches somebody who has
  // already filled the form in. It must not be retried: the ladder would put
  // seventy seconds between the button and the bad news.
  await reset();
  const late = await rpc('get_checkin_context', { p_token: 'latesubmit' });
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      rpc('submit_checkin', {
        p_token: 'latesubmit',
        p_member_id: 'm0000000-0000-4000-a000-000000000001',
        p_evidence: [],
        p_client_nonce: late.client_nonce,
      }),
    (err) => err instanceof RpcError && err.code === 'PDS10',
  );
  const elapsed = Date.now() - startedAt;

  const { calls } = await api('/__mock/audit');
  const submits = calls.filter((c) => c.fn === 'submit_checkin');
  assert.equal(submits.length, 1, `the refusal was sent ${submits.length} times, it should be once`);
  assert.ok(elapsed < 1000, `took ${elapsed}ms, so it was backing off rather than answering`);
});

await check('submit_checkin: before the window opens answers PDS02', async () => {
  await assert.rejects(
    () =>
      rpc('submit_checkin', {
        p_token: 'early',
        p_member_id: 'm0000000-0000-4000-a000-000000000001',
        p_evidence: [],
      }),
    (err) => err instanceof RpcError && err.code === 'PDS02',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\nPDS09 is ridden out, not shown\n');
// ---------------------------------------------------------------------------

await check('two PDS09 answers are absorbed and the submit lands', async () => {
  await reset();
  const busy = await rpc('get_checkin_context', { p_token: 'busy' });
  const reasons = [];
  const startedAt = Date.now();
  const result = await rpc(
    'submit_checkin',
    {
      p_token: 'busy',
      p_member_id: 'm0000000-0000-4000-a000-000000000004',
      p_evidence: [],
      p_client_nonce: busy.client_nonce,
    },
    { onRetry: ({ reason }) => reasons.push(reason) },
  );
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(reasons, ['busy', 'busy'], 'both refusals should be seen as rate limits');
  assert.equal(result.status, 'pending');
  // First two waits are 2s and 5s before jitter, so a schedule that gives up in
  // a couple of seconds would not have got here.
  assert.ok(elapsed > 5000, `expected to wait out the window, waited ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nphoto upload\n');
// ---------------------------------------------------------------------------

await check('an upload repeated after a lost answer counts as sent', async () => {
  await reset();
  const shirt = await rpc('get_checkin_context', { p_token: 'shirt' });
  const grant = await rpc('create_evidence_upload', {
    p_token: 'shirt',
    p_member_id: null,
    p_kind: 'shirt_photo',
    p_client_nonce: shirt.client_nonce,
  });
  const blob = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });

  assert.equal(await uploadEvidence(grant.object_path, blob), true);
  // The retry a dropped response would cause: Storage answers 409, and the
  // page must read that as "already there" rather than making somebody retake
  // a photo that is sitting in the bucket.
  assert.equal(await uploadEvidence(grant.object_path, blob), true);
});

await check('an event that does not collect that kind of photo answers PDS04', async () => {
  const gbm = await rpc('get_checkin_context', { p_token: 'gbm' });
  await assert.rejects(
    () =>
      rpc(
        'create_evidence_upload',
        {
          p_token: 'gbm',
          p_member_id: null,
          p_kind: 'shirt_photo',
          p_client_nonce: gbm.client_nonce,
        },
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.code === 'PDS04',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\na refusal is shown, not retried\n');
// ---------------------------------------------------------------------------

await check('a PDS code arriving as HTTP 500 is shown at once, not retried', async () => {
  // PostgREST does not know the PDS SQLSTATE class, so a raise carrying
  // errcode 'PDS01' can surface with a 500 rather than a 400. Retrying that
  // would put ten seconds between a member scanning a dead QR code and being
  // told so. The default retry policy is used deliberately here.
  await reset();
  const startedAt = Date.now();
  await assert.rejects(
    () => rpc('get_checkin_context', { p_token: 'oddstatus' }),
    (err) => err instanceof RpcError && err.code === 'PDS01',
  );
  const elapsed = Date.now() - startedAt;

  const { calls } = await api('/__mock/audit');
  assert.equal(calls.length, 1, `the refusal was sent ${calls.length} times, it should be sent once`);
  assert.ok(elapsed < 1000, `took ${elapsed}ms, so it was backing off rather than answering`);
});

const { violations } = await api('/__mock/audit');
await check('no unexpected nonce violations were recorded in the last run', () => {
  assert.deepEqual(violations, []);
});

server.close();
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exit(failures ? 1 : 0);
