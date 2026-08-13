// Checks for the officer review queue.
//
// The same rule as verify.mjs: assert the things that fail SILENTLY. A queue
// that renders is easy to see. What is not easy to see, and what each block
// below exists for:
//
//   1. That the queue is actually behind a login, rather than behind a UI that
//      hides itself. An anon-key request has to be refused by the server, and a
//      member account has to come back empty rather than come back with
//      everybody's check-ins.
//   2. That approving something with nobody attached is refused (PDS06). That
//      constraint is the entire reason the unmatched-name flow exists, and a
//      client that quietly stopped honouring it would look fine until somebody
//      audited the points.
//   3. That "Approve all 43" is ONE call carrying 43 ids. Forty-three calls
//      would also clear the screen, and would also pass any test that only
//      counted approved rows.
//   4. That a rejection stores its reason. The reason is the whole value of the
//      record six months later.
//   5. That confirming an account claim as an OFFICER does not silently report
//      success for a write that RLS refused. PostgREST answers a refused PATCH
//      with 200 and an empty array, so this one is invisible by construction.
//
// Run: node web/mock/verify-admin.mjs   (or npm run verify:admin, from web/)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';
import { IDS, UNKNOWN_EMAIL } from './admin-fixtures.mjs';
import { declarations, rule } from './css-rules.mjs';

const PORT = 8798;
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

globalThis.__PDSA_CONFIG__ = {
  SUPABASE_URL: `http://localhost:${PORT}`,
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

// auth.js keeps the session in localStorage, which Node does not have. It looks
// the object up on every call rather than capturing it at import time, so this
// is enough and no test seam had to be added to the module itself.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

const auth = await import('../src/auth.js');
const { select, patch, callRpc, signPhotoUrls } = await import('../src/rest.js');
const { rankMembers, splitName, similarity, normaliseName } = await import('../src/match.js');
const { actionsFor, FLAG_COPY, primaryFlag } = await import('../src/flags.js');
const { membersAlreadyOnEvent } = await import('../src/review.js');
const { describeOfficer } = await import('../src/officer-errors.js');
const { RpcError } = await import('../src/errors.js');

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

/** Signs in the way a person does: ask for the link, then open it. */
async function signInAs(email) {
  auth.forgetSession();
  await auth.sendMagicLink(email, `http://localhost:${PORT}/admin/`);
  const { url } = await api(`/__mock/magic-link?email=${encodeURIComponent(email)}`);
  const parsed = auth.parseAuthRedirect(url);
  assert.ok(parsed?.session, `no session in the sign-in link for ${email}`);
  auth.adoptSession(parsed.session);
  return parsed.session;
}

const QUEUE_SELECT = [
  'id,event_id,member_id,claimed_name,claimed_email,status,flags,submitted_at',
  'members(id,display_name,email)',
  'events!inner(id,title,occurred_on,academic_year_id)',
  'attendance_evidence(id,kind,object_path,sha256)',
].join(',');

const loadQueue = () =>
  select('attendance_records', {
    select: QUEUE_SELECT,
    filters: { status: 'eq.pending', 'events.academic_year_id': `eq.${IDS.YEAR_CURRENT}` },
    order: 'submitted_at.asc',
  });

const server = await startMock(PORT);

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const adminHtml = await readFile(`${WEB_ROOT}admin/index.html`, 'utf8');
const adminCss = await readFile(`${WEB_ROOT}assets/css/admin.css`, 'utf8');
const reviewSource = await readFile(`${WEB_ROOT}src/review.js`, 'utf8');
const claimsSource = await readFile(`${WEB_ROOT}src/claims.js`, 'utf8');
const restSource = await readFile(`${WEB_ROOT}src/rest.js`, 'utf8');

await check('the admin page loads no font, script or style from anywhere else', () => {
  for (const [label, source] of [
    ['admin/index.html', adminHtml],
    ['assets/css/admin.css', adminCss],
  ]) {
    assert.doesNotMatch(source, /fonts\.googleapis|fonts\.gstatic/i, `${label} links Google Fonts`);
    assert.doesNotMatch(source, /https?:\/\/(?!localhost)[^"')\s]+\.(js|css|woff2?)/i, `${label} loads a file from another host`);
    assert.doesNotMatch(source, /cdn\.|unpkg\.com|jsdelivr/i, `${label} references a CDN`);
  }
});

await check('Public Sans is self hosted with font-display: swap and a real fallback', () => {
  assert.match(adminCss, /@font-face\s*{[^}]*font-family:\s*'Public Sans'/);
  assert.match(adminCss, /font-display:\s*swap/);
  assert.match(adminCss, /url\('\.\.\/fonts\/public-sans\/PublicSans-VariableFont\.woff2'\)/);
  assert.match(adminCss, /--font:\s*'Public Sans',\s*ui-sans-serif,\s*system-ui,\s*sans-serif/);
});

await check('digits line up: tabular-nums is on the body', () => {
  assert.match(adminCss, /font-variant-numeric:\s*tabular-nums/);
});

await check('no em dash anywhere in the officer sources', async () => {
  const emDash = String.fromCharCode(0x2014);
  for (const [label, source] of [
    ['admin/index.html', adminHtml],
    ['assets/css/admin.css', adminCss],
    ['src/review.js', reviewSource],
    ['src/claims.js', claimsSource],
    ['src/rest.js', restSource],
    ['src/auth.js', await readFile(`${WEB_ROOT}src/auth.js`, 'utf8')],
    ['src/admin.js', await readFile(`${WEB_ROOT}src/admin.js`, 'utf8')],
    ['src/flags.js', await readFile(`${WEB_ROOT}src/flags.js`, 'utf8')],
    ['src/match.js', await readFile(`${WEB_ROOT}src/match.js`, 'utf8')],
    ['src/officer-errors.js', await readFile(`${WEB_ROOT}src/officer-errors.js`, 'utf8')],
    ['src/ui.js', await readFile(`${WEB_ROOT}src/ui.js`, 'utf8')],
  ]) {
    assert.ok(!source.includes(emDash), `${label} contains an em dash`);
  }
});

await check('no jargon reaches the screen', () => {
  // docs/03-admin-ui.md: the word "schema" never appears in the UI, and
  // neither does "node". Checked against the copy an officer actually reads.
  const copy = [
    adminHtml.replace(/<!--[\s\S]*?-->/g, ''),
    Object.values(FLAG_COPY)
      .map((entry) => `${entry.headline} ${entry.detail}`)
      .join(' '),
  ].join(' ');
  for (const word of ['schema', 'RLS', 'RPC', 'PostgREST', 'foreign key', 'constraint']) {
    assert.doesNotMatch(copy, new RegExp(`\\b${word}\\b`, 'i'), `the word "${word}" is on screen`);
  }
  // "node" as a word on its own, not "nobody" or "noted".
  assert.doesNotMatch(copy, /\bnodes?\b/i, 'the word "node" is on screen');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe client never writes status itself\n');
// ---------------------------------------------------------------------------
// RLS would in fact permit it: attendance_write_officer is FOR ALL. What stops
// it is this line, held by the client, so it is asserted rather than assumed.

await check('no officer module PATCHes attendance_records', () => {
  for (const [label, source] of [
    ['src/review.js', reviewSource],
    ['src/claims.js', claimsSource],
  ]) {
    assert.doesNotMatch(
      source,
      /patch\(\s*['"]attendance_records['"]/,
      `${label} writes attendance_records directly instead of going through review_records()`,
    );
  }
});

await check('approve and reject both go through review_records()', () => {
  assert.match(reviewSource, /callRpc\(\s*'review_records'/);
  const call = reviewSource.slice(reviewSource.indexOf("callRpc('review_records'"));
  assert.match(call.slice(0, 300), /p_decision:\s*decision/);
  assert.match(call.slice(0, 300), /p_note:\s*note/);
});

await check('linking an unmatched name goes through resolve_unmatched()', () => {
  assert.match(reviewSource, /callRpc\(\s*'resolve_unmatched'/);
  assert.match(reviewSource, /p_member_id:\s*member\.id/);
  assert.match(reviewSource, /p_new_member:\s*details/);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nan unmatched record cannot be approved, and the screen knows it\n');
// ---------------------------------------------------------------------------

await check('actionsFor an unmatched record offers no approve at all', () => {
  assert.deepEqual(actionsFor(['unmatched_name']), ['resolve', 'reject']);
  // Even when it is also carrying something that would normally be approvable.
  assert.deepEqual(actionsFor(['unmatched_name', 'missing_evidence']), ['resolve', 'reject']);
});

await check('a record with no flags is approvable and rejectable', () => {
  assert.deepEqual(actionsFor([]), ['approve', 'reject']);
});

await check('the card leads with the flag that has to be dealt with first', () => {
  assert.equal(primaryFlag(['missing_evidence', 'unmatched_name']), 'unmatched_name');
  assert.equal(primaryFlag(['outside_window', 'missing_evidence']), 'missing_evidence');
  assert.equal(primaryFlag([]), null);
});

await check('a flag the client has never heard of is dropped, not printed raw', () => {
  assert.deepEqual(actionsFor(['something_added_next_year']), ['approve', 'reject']);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nranking the roster against a typed-in name\n');
// ---------------------------------------------------------------------------

const ROSTER = [
  { id: 'a', display_name: 'Abigail Catto', email: 'abigail.catto@knights.ucf.edu' },
  { id: 'b', display_name: 'Abby Catto', email: null },
  { id: 'c', display_name: 'Catherine Diaz', email: 'cdiaz@knights.ucf.edu' },
  { id: 'd', display_name: 'Aaron Ozan', email: null },
];

await check('normalising matches fn_normalise_name in the database', () => {
  assert.equal(normaliseName('  Abby   O\'Catto-Smith! '), 'abby o catto smith');
  assert.equal(normaliseName(null), '');
});

await check('similarity is pg_trgm shaped: identical is 1, unrelated is near 0', () => {
  assert.equal(similarity('Abigail Catto', 'Abigail Catto'), 1);
  assert.ok(similarity('Abby Cato', 'Abigail Catto') > 0.3);
  assert.ok(similarity('Abby Cato', 'Aaron Ozan') < 0.1);
});

await check('"Abby Cato" ranks the two Cattos above everybody else', () => {
  const ranked = rankMembers({ name: 'Abby Cato' }, ROSTER);
  assert.ok(ranked.length >= 2, 'expected at least two suggestions');
  const top = ranked.slice(0, 2).map((row) => row.member.display_name).sort();
  assert.deepEqual(top, ['Abby Catto', 'Abigail Catto']);
  assert.ok(ranked[0].percent > 40, `top suggestion scored only ${ranked[0].percent}%`);
});

await check('an exact email match is pinned to the top as a certainty, not a score', () => {
  // A name that ranks the OTHER Catto first on spelling alone. The address is
  // what settles it, and it has to outrank the better-looking name.
  const ranked = rankMembers(
    { name: 'Abby Catto', email: 'abigail.catto@knights.ucf.edu' },
    ROSTER,
  );
  assert.equal(ranked[0].member.display_name, 'Abigail Catto');
  assert.equal(ranked[0].certain, true);
  assert.match(ranked[0].reason, /email/i);
});

await check('nobody close means no suggestions, rather than a bad one', () => {
  const ranked = rankMembers({ name: 'Tobias Renner' }, ROSTER);
  assert.equal(ranked.length, 0);
});

await check('a typed-in name splits into the two columns the database requires', () => {
  assert.deepEqual(splitName('Tobias Renner'), { first_name: 'Tobias', last_name: 'Renner' });
  assert.deepEqual(splitName('Maria del Carmen Ruiz'), {
    first_name: 'Maria del Carmen',
    last_name: 'Ruiz',
  });
  assert.deepEqual(splitName('Catto, Abigail'), { first_name: 'Abigail', last_name: 'Catto' });
  // Both columns are NOT NULL with a non-empty check, so one word still has to
  // produce two values or the insert fails in a way nobody can act on.
  assert.equal(splitName('Prince').first_name, 'Prince');
  assert.ok(splitName('Prince').last_name.length > 0);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nsigning in\n');
// ---------------------------------------------------------------------------

await reset();

await check('the tokens are read out of the URL fragment', () => {
  const parsed = auth.parseAuthRedirect(
    'http://localhost/admin/#access_token=a.b.c&refresh_token=r1&expires_in=3600&token_type=bearer',
  );
  assert.equal(parsed.session.refresh_token, 'r1');
  assert.ok(parsed.session.expires_at > Math.floor(Date.now() / 1000));
});

await check('a link that has already been used is reported, not swallowed', () => {
  const parsed = auth.parseAuthRedirect(
    'http://localhost/admin/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
  );
  assert.equal(parsed.error.code, 'otp_expired');
  assert.match(parsed.error.description, /expired/);
});

await check('an address with no officer account gets no link and no clue that it has none', async () => {
  await auth.sendMagicLink(UNKNOWN_EMAIL, `http://localhost:${PORT}/admin/`);
  const answer = await api(`/__mock/magic-link?email=${encodeURIComponent(UNKNOWN_EMAIL)}`);
  assert.ok(answer.error, 'a link was minted for an address with no account');
  // The important half: sendMagicLink resolved rather than threw, so the page
  // shows the same "check your inbox" either way.
});

await check('signups are off, so the request says so explicitly', async () => {
  const { calls } = await api('/__mock/audit').then((body) => body.admin);
  const otp = calls.filter((call) => call.fn === 'auth.otp');
  assert.ok(otp.length > 0);
  for (const call of otp) {
    assert.equal(call.create_user, false, 'sendMagicLink would let a stranger create an account');
  }
});

await check('signing in as an officer produces a session that knows its own user id', async () => {
  const session = await signInAs('sara@pdsaucf.com');
  assert.equal(session.user.id, IDS.USERS.officer);
  assert.equal(session.user.email, 'sara@pdsaucf.com');
  assert.equal(auth.currentSession().user.id, IDS.USERS.officer);
});

await check('an expiring token is refreshed once, not once per waiting request', async () => {
  const before = await api('/__mock/audit').then((body) => body.admin.calls.filter((c) => c.fn === 'auth.refresh').length);

  // Push the stored session to the edge of its life, which is what a laptop
  // left open over a long GBM does on its own.
  const session = auth.currentSession();
  auth.adoptSession({ ...session, expires_at: Math.floor(Date.now() / 1000) + 5 });

  const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
  assert.equal(new Set(tokens).size, 1, 'three callers got three different tokens');

  const after = await api('/__mock/audit').then((body) => body.admin.calls.filter((c) => c.fn === 'auth.refresh').length);
  assert.equal(after - before, 1, `the refresh token was spent ${after - before} times`);
});

await check('signing out clears the session on this machine', async () => {
  await signInAs('sara@pdsaucf.com');
  await auth.signOut();
  assert.equal(auth.currentSession(), null);
  await assert.rejects(() => auth.accessToken(), (err) => err instanceof auth.SessionExpiredError);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nwho is allowed in\n');
// ---------------------------------------------------------------------------

await check('nobody signed in cannot read a single row', async () => {
  auth.forgetSession();
  await assert.rejects(
    () => loadQueue(),
    (err) => err instanceof auth.SessionExpiredError,
    'the client tried to load the queue with no session at all',
  );

  // And the server refuses it too, so the guard is a courtesy rather than the
  // control. This is the request the page would make if the guard were removed.
  const res = await fetch(
    `http://localhost:${PORT}/rest/v1/attendance_records?select=id&status=eq.pending`,
    { headers: { apikey: 'mock-anon-key', Authorization: 'Bearer mock-anon-key' } },
  );
  assert.equal(res.status, 401);
});

await check('a member account is refused the queue entirely', async () => {
  await signInAs('priya@knights.ucf.edu');

  const profiles = await select('profiles', {
    select: 'user_id,role,member_id',
    filters: { user_id: `eq.${IDS.USERS.member}` },
  });
  assert.equal(profiles[0].role, 'member', 'the guard reads the role from here');

  // Even if the guard were bypassed, there is nothing behind it.
  const rows = await loadQueue();
  assert.deepEqual(rows, [], 'a member could read other people\'s check-ins');

  await assert.rejects(
    () => callRpc('review_records', { p_ids: [IDS.RECORD_MISSING_EVIDENCE], p_decision: 'approve' }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );
});

await check('a viewer reads the queue and is refused every decision', async () => {
  await signInAs('advisor@ucf.edu');
  const rows = await loadQueue();
  assert.equal(rows.length, 51, `a viewer saw ${rows.length} pending records`);

  await assert.rejects(
    () => callRpc('review_records', { p_ids: [IDS.RECORD_MISSING_EVIDENCE], p_decision: 'approve' }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );
  await assert.rejects(
    () => callRpc('resolve_unmatched', { p_record_id: IDS.RECORD_UNMATCHED_CLOSE, p_member_id: IDS.MEMBER_ABIGAIL }, { attempts: 1 }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );
});

await check('PDS07 tells an officer what to do about it, without jargon', () => {
  const copy = describeOfficer(new RpcError('PDS07', 'This action requires an officer account.', 400));
  assert.match(`${copy.title} ${copy.body}`, /officer|admin/i);
  assert.doesNotMatch(`${copy.title} ${copy.body}`, /policy|RLS|permission denied/i);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe queue an officer actually sees\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('the queue is this year only, split into flagged and routine', async () => {
  const rows = await loadQueue();
  const flagged = rows.filter((row) => row.flags.length);
  const routine = rows.filter((row) => !row.flags.length);
  assert.equal(routine.length, 43, `expected 43 routine records, got ${routine.length}`);
  assert.equal(flagged.length, 8, `expected 8 flagged records, got ${flagged.length}`);
  for (const row of rows) {
    assert.equal(row.events.academic_year_id, IDS.YEAR_CURRENT, 'last year leaked into the queue');
  }
});

await check('every photo in the queue signs in one request, not one each', async () => {
  const rows = await loadQueue();
  const paths = rows.flatMap((row) => row.attendance_evidence.map((e) => e.object_path));
  assert.ok(paths.length > 40, `only ${paths.length} photos to sign`);

  const before = await api('/__mock/audit').then((b) => b.admin.calls.filter((c) => c.fn === 'storage.sign').length);
  const urls = await signPhotoUrls(paths);
  const after = await api('/__mock/audit').then((b) => b.admin.calls.filter((c) => c.fn === 'storage.sign').length);

  assert.equal(after - before, 1, `signing ${paths.length} photos took ${after - before} requests`);
  assert.equal(urls.size, paths.length);

  const image = await fetch([...urls.values()][0]);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\//);
});

await check('the photo bucket is private: no session, no photo', async () => {
  const res = await fetch(`http://localhost:${PORT}/storage/v1/object/sign/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: 'mock-anon-key', Authorization: 'Bearer mock-anon-key' },
    body: JSON.stringify({ expiresIn: 3600, paths: ['anything'] }),
  });
  assert.notEqual(res.status, 200);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nresolving an unmatched name\n');
// ---------------------------------------------------------------------------

await check('approving one before it is resolved is refused with PDS06', async () => {
  await assert.rejects(
    () =>
      callRpc(
        'review_records',
        { p_ids: [IDS.RECORD_UNMATCHED_CLOSE], p_decision: 'approve' },
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.code === 'PDS06',
  );
});

await check('PDS06 sends the officer to the fix, on the screen they are already on', () => {
  const copy = describeOfficer(new RpcError('PDS06', 'Cannot approve 1 record(s)...', 400));
  assert.match(copy.body, /roster|name|member/i);
  assert.doesNotMatch(copy.body, /constraint|null|column/i);
});

await check('a suggestion who already checked in to this event is not offered', async () => {
  // "Abby Cato" scores highly against both Cattos, and Abby Catto already has
  // a live record for this GBM. Pressing her is refused by the unique index,
  // so the card must not offer her as a button.
  const queue = await loadQueue();
  const record = queue.find((row) => row.id === IDS.RECORD_UNMATCHED_CLOSE);
  const roster = await select('members', {
    select: 'id,display_name,email',
    filters: { archived_at: 'is.null', merged_into_id: 'is.null' },
  });
  const ranked = rankMembers({ name: record.claimed_name, email: record.claimed_email }, roster);
  assert.ok(ranked.length >= 2, 'this record is meant to be genuinely ambiguous');

  const taken = membersAlreadyOnEvent(queue, record);
  const clashing = ranked.filter((row) => taken.has(row.member.id));
  const usable = ranked.filter((row) => !taken.has(row.member.id));
  assert.ok(clashing.length >= 1, 'the fixture no longer exercises the clash at all');
  assert.ok(usable.length >= 1, 'every suggestion clashed, so there is nothing to press');

  // And the backstop, for a clash this screen cannot see because the other
  // record was approved before the queue was loaded.
  await assert.rejects(
    () =>
      callRpc(
        'resolve_unmatched',
        { p_record_id: record.id, p_member_id: clashing[0].member.id },
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.code === 'PDS05',
  );
  // The copy has to say that a record already exists, wherever it puts it:
  // the heading names the state and the body says what to do about it.
  const copy = describeOfficer(new RpcError('PDS05', 'That member already has a live record for this event.', 400));
  assert.match(`${copy.title} ${copy.body}`, /already/i);
  assert.match(copy.body, /duplicate|queue/i, 'PDS05 has to leave the officer with a next step');
});

await check('it links to an existing member, and then it can be approved', async () => {
  const queue = await loadQueue();
  const before = queue.find((row) => row.id === IDS.RECORD_UNMATCHED_CLOSE);
  assert.equal(before.member_id, null);
  assert.deepEqual(before.flags, ['unmatched_name']);

  // The suggestion an officer would press, chosen the way the card offers them.
  const roster = await select('members', {
    select: 'id,display_name,email',
    filters: { archived_at: 'is.null', merged_into_id: 'is.null' },
  });
  const taken = membersAlreadyOnEvent(queue, before);
  const ranked = rankMembers({ name: before.claimed_name, email: before.claimed_email }, roster)
    .filter((row) => !taken.has(row.member.id));
  assert.ok(ranked.length, 'the card would have offered nothing to press');
  assert.equal(ranked[0].member.display_name, 'Abigail Catto');

  const memberId = await callRpc('resolve_unmatched', {
    p_record_id: IDS.RECORD_UNMATCHED_CLOSE,
    p_member_id: ranked[0].member.id,
  });
  assert.equal(memberId, ranked[0].member.id);

  const after = (await loadQueue()).find((row) => row.id === IDS.RECORD_UNMATCHED_CLOSE);
  assert.equal(after.member_id, memberId);
  assert.deepEqual(after.flags, [], 'the unmatched flag survived the resolve');

  // The second decision, which resolve_unmatched deliberately does not make.
  assert.equal(after.status, 'pending', 'resolving must not approve anything by itself');
  const count = await callRpc('review_records', {
    p_ids: [IDS.RECORD_UNMATCHED_CLOSE],
    p_decision: 'approve',
  });
  assert.equal(count, 1);
});

await check('it creates the member when nobody on the roster is them', async () => {
  const record = (await loadQueue()).find((row) => row.id === IDS.RECORD_UNMATCHED_NEW);
  const roster = await select('members', { select: 'id,display_name,email' });
  assert.equal(
    rankMembers({ name: record.claimed_name, email: record.claimed_email }, roster).length,
    0,
    'this record is meant to have no plausible match',
  );

  const details = { ...splitName(record.claimed_name), email: record.claimed_email };
  const memberId = await callRpc('resolve_unmatched', {
    p_record_id: IDS.RECORD_UNMATCHED_NEW,
    p_new_member: details,
  });

  const created = (
    await select('members', { select: 'id,display_name,email', filters: { id: `eq.${memberId}` } })
  )[0];
  assert.equal(created.display_name, 'Tobias Renner');
  assert.equal(created.email, 'tobias.renner@knights.ucf.edu');

  // Whoever they turned out to be, they are on this year's roster now.
  const enrolled = await select('member_enrollments', {
    select: 'member_id,academic_year_id',
    filters: { member_id: `eq.${memberId}`, academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
  });
  assert.equal(enrolled.length, 1, 'a member created here was not put on this year of the roster');

  const after = (await loadQueue()).find((row) => row.id === IDS.RECORD_UNMATCHED_NEW);
  assert.equal(after.member_id, memberId);
  assert.equal(after.status, 'pending');
});

await check('both resolutions are on the audit trail, and say which was which', async () => {
  const { auditLog } = await api('/__mock/audit').then((body) => body.admin);
  const resolves = auditLog.filter((row) => row.action === 'resolve_unmatched');
  assert.equal(resolves.length, 2);
  assert.deepEqual(
    resolves.map((row) => row.detail.created_member).sort(),
    [false, true],
  );
  for (const row of resolves) {
    assert.equal(row.actor_user_id, IDS.USERS.officer, 'the audit row does not say who did it');
    assert.ok(row.detail.claimed_name, 'the audit row lost the name that was typed in');
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\nclearing the routine zone\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('43 routine records are approved by ONE call carrying 43 ids', async () => {
  const routine = (await loadQueue()).filter((row) => !row.flags.length);
  assert.equal(routine.length, 43);

  const before = await api('/__mock/audit').then(
    (body) => body.admin.calls.filter((call) => call.fn === 'review_records').length,
  );

  const count = await callRpc('review_records', {
    p_ids: routine.map((row) => row.id),
    p_decision: 'approve',
    p_note: null,
  });
  assert.equal(count, 43);

  const after = await api('/__mock/audit').then((body) => body.admin.calls);
  const calls = after.filter((call) => call.fn === 'review_records');
  assert.equal(
    calls.length - before,
    1,
    `clearing the grid took ${calls.length - before} calls, it has to be one decision`,
  );
  assert.equal(calls[calls.length - 1].count, 43);

  const left = (await loadQueue()).filter((row) => !row.flags.length);
  assert.equal(left.length, 0, 'the routine zone did not empty');
});

await check('one audit row records the batch, with every id in it', async () => {
  const { auditLog } = await api('/__mock/audit').then((body) => body.admin);
  const batch = auditLog.filter((row) => row.action === 'review_records');
  assert.equal(batch.length, 1);
  assert.equal(batch[0].detail.count, 43);
  assert.equal(batch[0].detail.ids.length, 43);
  assert.equal(batch[0].detail.decision, 'approve');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nturning one down\n');
// ---------------------------------------------------------------------------

await reset();
await signInAs('sara@pdsaucf.com');

await check('a rejection stores the reason on the record itself', async () => {
  const reason = 'Photo was taken outside, and this event was indoors.';
  const count = await callRpc('review_records', {
    p_ids: [IDS.RECORD_MISSING_EVIDENCE],
    p_decision: 'reject',
    p_note: reason,
  });
  assert.equal(count, 1);

  const { attendance } = await api('/__mock/audit').then((body) => body.admin);
  const row = attendance.find((r) => r.id === IDS.RECORD_MISSING_EVIDENCE);
  assert.equal(row.status, 'rejected');
  assert.equal(row.review_note, reason, 'the reason was not stored');
  assert.equal(row.reviewed_by, IDS.USERS.officer, 'nobody is on the hook for the decision');
});

await check('the reason is on the audit trail as well as on the record', async () => {
  const { auditLog } = await api('/__mock/audit').then((body) => body.admin);
  const rejection = auditLog.find((row) => row.detail?.decision === 'reject');
  assert.ok(rejection, 'the rejection is not on the audit trail');
  assert.match(rejection.detail.note, /indoors/);
});

await check('the card that carries a previous rejection can find its reason', async () => {
  // What the queue does when it sees previously_rejected: one query for the
  // earlier row, so the officer reads why before deciding again.
  const rows = await select('attendance_records', {
    select: 'id,event_id,member_id,review_note,reviewed_at',
    filters: {
      status: 'eq.rejected',
      event_id: `in.(${IDS.EVENT_GBM})`,
    },
  });
  const prior = rows.find((row) => row.review_note);
  assert.ok(prior, 'the earlier rejection carries no reason to show');
  assert.match(prior.review_note, /car park/);
});

// ---------------------------------------------------------------------------
process.stdout.write('\naccount claims\n');
// ---------------------------------------------------------------------------

await reset();

await check('an officer can confirm a claim, and is told the link is not finished', async () => {
  await signInAs('sara@pdsaucf.com');

  const claims = await select('member_claims', {
    select: 'id,user_id,member_id,status,note,requested_at,members(id,display_name,email)',
    filters: { status: 'eq.pending' },
  });
  assert.equal(claims.length, 2);
  const claim = claims.find((c) => c.id === IDS.CLAIM_WITH_NAME);
  assert.equal(claim.members.display_name, 'Abigail Catto');

  const updated = await patch(
    'member_claims',
    { id: `eq.${claim.id}` },
    { status: 'approved', reviewed_by: IDS.USERS.officer, reviewed_at: new Date().toISOString() },
  );
  assert.equal(updated.length, 1, 'an officer could not record the decision');
  assert.equal(updated[0].status, 'approved');

  // The link itself is an admin write. PostgREST answers a refused PATCH with
  // 200 and an empty array, so this is the only thing that separates "linked"
  // from "not linked", and the screen has to look at it.
  const linked = await patch(
    'profiles',
    { user_id: `eq.${claim.user_id}` },
    { member_id: claim.member_id },
  );
  assert.deepEqual(linked, [], 'an officer was allowed to link an account');

  const profiles = await select('profiles', {
    select: 'user_id,member_id',
    filters: { user_id: `eq.${claim.user_id}` },
  });
  assert.equal(profiles[0].member_id, null, 'the account was linked when it should not have been');
});

await check('the screen says which of those two things happened', () => {
  // The distinction is drawn from the length of the array and nothing else.
  assert.match(claimsSource, /linked\.length/);
  assert.match(claimsSource, /admin still has to finish/i);
});

await check('an admin confirming a claim finishes the link', async () => {
  await reset();
  await signInAs('ben@pdsaucf.com');

  const claim = (
    await select('member_claims', {
      select: 'id,user_id,member_id,members(display_name)',
      filters: { id: `eq.${IDS.CLAIM_WITH_NAME}` },
    })
  )[0];

  const updated = await patch(
    'member_claims',
    { id: `eq.${claim.id}` },
    { status: 'approved', reviewed_by: IDS.USERS.admin, reviewed_at: new Date().toISOString() },
  );
  assert.equal(updated.length, 1);

  const linked = await patch(
    'profiles',
    { user_id: `eq.${claim.user_id}` },
    { member_id: claim.member_id },
  );
  assert.equal(linked.length, 1, 'an admin could not finish the link either');
  assert.equal(linked[0].member_id, IDS.MEMBER_ABIGAIL);
});

await check('turning a claim down leaves nobody linked, and lets them ask again', async () => {
  await reset();
  await signInAs('sara@pdsaucf.com');

  const updated = await patch(
    'member_claims',
    { id: `eq.${IDS.CLAIM_WITHOUT_NAME}` },
    { status: 'rejected', reviewed_by: IDS.USERS.officer, reviewed_at: new Date().toISOString() },
  );
  assert.equal(updated[0].status, 'rejected');

  const { profiles } = await api('/__mock/audit').then((body) => body.admin);
  for (const profile of profiles) {
    assert.equal(profile.member_id, null, 'a turned-down claim linked somebody anyway');
  }
});

await check('confirming a claim never changes the role on the account', () => {
  // profiles.member_id is explicitly "optional: officer who is also a member".
  // Writing role here would lock an officer out of this very screen the first
  // time one of them claimed their own roster row.
  assert.doesNotMatch(claimsSource, /role:\s*['"]member['"]/);
});

// ---------------------------------------------------------------------------
process.stdout.write('\na suggestion that cannot be pressed looks like one\n');
// ---------------------------------------------------------------------------
//
// The suggestion for somebody who already checked in is `disabled`, which the
// DOM and a screen reader both get right. It looked wrong: measured in the
// browser, its fill came out at a contrast ratio of 1.02 against a live
// suggestion's, so the only difference was a 1px border on a chip that was
// otherwise the same size, the same fill and full strength. An officer scanning
// a queue presses it and nothing happens.
//
// WHAT THIS CHECKS. That the disabled state is carried on more than one visual
// axis, so no single edit can flatten it back into looking pressable. Node has
// no layout engine and this package has no dependencies, so this reads the
// stylesheet rather than the rendered pixels: it is a check on the rule, not a
// measurement of contrast. See web/README.md.

const liveSuggestion = declarations(rule(adminCss, '.suggestion'));
const deadSuggestion = declarations(rule(adminCss, ".suggestion[data-clash='true']"));

await check('the disabled suggestion is not merely disabled in the DOM', () => {
  assert.ok(deadSuggestion.size, "no .suggestion[data-clash='true'] rule in admin.css");

  // Every axis below is one an officer can see without reading the subtext.
  const differs = (prop) =>
    deadSuggestion.has(prop) && deadSuggestion.get(prop) !== liveSuggestion.get(prop);

  const axes = ['background', 'border-color', 'border-style', 'opacity', 'color'].filter(differs);
  assert.ok(
    axes.length >= 3,
    `a disabled suggestion differs from a live one on ${axes.length} visual axis/axes ` +
      `(${axes.join(', ') || 'none'}), which is not enough to read at a glance`,
  );

  // Stepped back rather than merely recoloured. This is the axis the browser
  // pass found missing: it rendered at full strength.
  const opacity = deadSuggestion.has('opacity') ? Number(deadSuggestion.get('opacity')) : 1;
  assert.ok(
    opacity < 1,
    `a disabled suggestion renders at full strength (opacity ${deadSuggestion.get('opacity') ?? 'not set'})`,
  );

  // Not filled like the pressable one, whose fill is what makes it read as a
  // button. Two pale fills was the original failure, so equality is not enough.
  assert.notEqual(
    deadSuggestion.get('background'),
    liveSuggestion.get('background'),
    'a disabled suggestion is filled like a pressable one',
  );
});

await check('and it stays legible while it is stepped back', () => {
  // Reducing opacity composites the text towards the background. The name is
  // the one thing the officer still has to read here, because it is what tells
  // the two Cattos apart, so the colour is raised to pay for the opacity
  // rather than left muted.
  assert.equal(
    deadSuggestion.get('color'),
    'var(--ink)',
    'a disabled suggestion uses muted ink AND reduced opacity, which stacks',
  );
  const why = declarations(rule(adminCss, ".suggestion[data-clash='true'] .suggestion-why"));
  assert.equal(why.get('color'), 'var(--ink)', 'the reason is muted twice over');
});

await check('the reason is still on the card, and still reaches a screen reader', () => {
  // Removing the subtext would leave the officer with a greyed chip and no
  // reason. The label is what a screen reader announces alongside `disabled`.
  assert.match(reviewSource, /'Already checked in'/, 'the subtext was dropped');
  assert.match(
    reviewSource,
    /already checked in to this event/,
    'the accessible name no longer says why it cannot be pressed',
  );
});

// ---------------------------------------------------------------------------

server.close();
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exit(failures ? 1 : 0);
