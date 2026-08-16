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
import {
  BRAND_TOKENS,
  CONTRAST,
  SEMANTIC_CONTRAST,
  asRatio,
  goldMisuse,
  images,
  ratio,
  schemes,
} from './brand.mjs';

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
const { describeOfficer, CLAIM } = await import('../src/officer-errors.js');
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
/** The rows themselves, for asserting what a write actually did. */
const adminState = () => api('/__mock/audit').then((body) => body.admin);
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

// ---------------------------------------------------------------------------
process.stdout.write('\nthe brand\n');
// ---------------------------------------------------------------------------
//
// The check-in page and the queue are one product wearing one identity, and
// there is no build step that could share a token block between two
// stylesheets. So the guard against them drifting apart is this check rather
// than an import. See mock/brand.mjs.

const checkinCss = await readFile(`${WEB_ROOT}assets/css/checkin.css`, 'utf8');
const checkinHtml = await readFile(`${WEB_ROOT}c/index.html`, 'utf8');
const adminTokens = schemes(adminCss);
const checkinTokens = schemes(checkinCss);

for (const scheme of ['light', 'dark']) {
  await check(`${scheme}: both stylesheets declare the same brand tokens`, () => {
    const mine = adminTokens[scheme];
    const theirs = checkinTokens[scheme];
    for (const token of BRAND_TOKENS) {
      assert.ok(mine.has(token), `admin.css does not declare ${token} for ${scheme}`);
      assert.ok(theirs.has(token), `checkin.css does not declare ${token} for ${scheme}`);
      assert.equal(
        mine.get(token).trim().toLowerCase(),
        theirs.get(token).trim().toLowerCase(),
        `${token} is ${mine.get(token)} in admin.css and ${theirs.get(token)} in checkin.css`,
      );
    }
  });
}

for (const [scheme, tokens] of Object.entries(adminTokens)) {
  await check(`${scheme}: every pairing on this screen clears its contrast floor`, () => {
    let measured = 0;
    for (const [ink, ground, floor] of [...CONTRAST, ...SEMANTIC_CONTRAST]) {
      if (!tokens.has(ink) || !tokens.has(ground)) continue;
      measured += 1;
      const got = ratio(tokens.get(ink), tokens.get(ground));
      assert.ok(
        got >= floor,
        `${ink} on ${ground} is ${asRatio(got)}, and the floor is ${asRatio(floor)}`,
      );
    }
    assert.ok(measured >= 18, `only ${measured} pairs were measurable, so the tokens moved`);
  });
}

await check('gold is a fill or a bar, never a foreground', () => {
  const misuse = goldMisuse(adminCss);
  assert.deepEqual(
    misuse,
    [],
    misuse.map((m) => `${m.property}: ${m.value} (${m.why})`).join('; '),
  );
});

await check('the amber a flag is drawn in is not the gold the brand is drawn in', () => {
  // A flagged card carries a --warn edge and the top bar carries a --gold one.
  // If those ever become the same colour, the officer is reading brand as
  // signal, on the one screen whose whole job is telling those apart.
  for (const [scheme, tokens] of Object.entries(adminTokens)) {
    assert.notEqual(
      tokens.get('--warn').trim().toLowerCase(),
      tokens.get('--gold').trim().toLowerCase(),
      `--warn and --gold are the same colour in the ${scheme} scheme`,
    );
  }
});

await check('the focus ring is drawn clear of the control, not on top of it', () => {
  // Blue on a purple button is 1.88:1. outline-offset is what keeps the two
  // from touching, by leaving a strip of page between them.
  const decls = declarations(rule(adminCss, ':where(a, button, input, select, [tabindex]):focus-visible'));
  assert.ok(decls.size, 'no focus-visible rule in admin.css');
  const offset = Number.parseFloat(decls.get('outline-offset') ?? '0');
  assert.ok(offset >= 2, `outline-offset is ${decls.get('outline-offset')}, so the ring can touch the fill`);
  assert.match(decls.get('outline') ?? '', /var\(--focus\)/, 'the ring is not drawn in --focus');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe emblem and the lockup\n');
// ---------------------------------------------------------------------------

await check('the emblem is in the brand bar, and says nothing a screen reader already heard', () => {
  const bar = /<span class="brand">([\s\S]*?)<\/span>/.exec(adminHtml);
  assert.ok(bar, 'there is no brand bar in admin/index.html');
  assert.match(bar[1], /pdsa-emblem-96\.png/, 'the emblem is not in the brand bar');
  assert.match(bar[1], /alt=""/, 'the emblem repeats the wordmark that is right beside it');
  assert.match(bar[1], /PDSA Points/, 'the wordmark left the brand bar');
});

await check('the full lockup is on the sign-in screen and nowhere else', () => {
  // 250KB. It is worth it once, on the screen where the wordmark is large
  // enough to read, and nowhere the officer goes repeatedly.
  const signin = /<main id="view-signin"[\s\S]*?<\/main>/.exec(adminHtml);
  assert.ok(signin, 'there is no sign-in screen');
  assert.match(signin[0], /pdsa-logo-512\.png/, 'the sign-in screen does not carry the lockup');
  assert.equal(
    adminHtml.split('pdsa-logo-512').length - 1,
    1,
    'the 250KB lockup is used more than once',
  );
});

await check('every image reserves its box before it loads', () => {
  // Only images with a src in the markup: the queue builds its photo tiles at
  // runtime from whatever Storage returns.
  for (const [label, html] of [
    ['admin/index.html', adminHtml],
    ['c/index.html', checkinHtml],
  ]) {
    for (const tag of images(html).filter((tag) => /\ssrc="/.test(tag))) {
      assert.match(tag, /\swidth="\d+"/, `${label}: an <img> has no width: ${tag}`);
      assert.match(tag, /\sheight="\d+"/, `${label}: an <img> has no height: ${tag}`);
    }
  }
});

await check('officers who pin this page get an icon rather than a screenshot', () => {
  assert.match(adminHtml, /<link[^>]+rel="icon"[^>]+pdsa-emblem-96\.png/, 'no favicon');
  assert.match(
    adminHtml,
    /<link[^>]+rel="apple-touch-icon"[^>]+pdsa-emblem-256\.png/,
    'no apple-touch-icon, so a pinned page gets a thumbnail of the screen',
  );
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

await check('the card leads with the address the account signed in with', async () => {
  await signInAs('sara@pdsaucf.com');

  const claims = await callRpc('list_pending_claims');
  assert.equal(claims.length, 2);
  const claim = claims.find((row) => row.claim_id === IDS.CLAIM_WITH_NAME);
  assert.equal(claim.member_name, 'Abigail Catto');
  assert.equal(claim.account_email, 'a.catto.2027@knights.ucf.edu');

  // WHY THIS IS THE WHOLE REASON THE FUNCTION EXISTS. auth.users is not in the
  // `public` schema, so the same claim read straight off the table carries no
  // address at all, and the nearest thing PostgREST can offer is the address on
  // the ROSTER row, which is a different address and belongs to the person
  // being claimed rather than the person asking.
  const [row] = await select('member_claims', {
    select: '*',
    filters: { id: `eq.${IDS.CLAIM_WITH_NAME}` },
  });
  assert.ok(row, 'the claim is not readable off the table at all');
  assert.ok(
    !('account_email' in row),
    'the table now serves the sign-in address, so this check proves nothing',
  );

  const [member] = await select('members', {
    select: 'id,email',
    filters: { id: `eq.${claim.member_id}` },
  });
  assert.notEqual(
    String(member.email).toLowerCase(),
    String(claim.account_email).toLowerCase(),
    'the fixture no longer tells the two addresses apart, so leading with either would look right',
  );
});

await check('an account with no address on file is a row, not a gap in the queue', async () => {
  // The LEFT JOIN. A claim from an account this mock has no auth.users row for
  // still reaches the officer, with a null where the address would be, because
  // dropping it would hide a claim nobody could then decide.
  const claims = await callRpc('list_pending_claims');
  const second = claims.find((row) => row.claim_id === IDS.CLAIM_WITHOUT_NAME);
  assert.ok(second, 'the second claim fell out of the queue');
  assert.equal(second.account_name, null, 'this claim is meant to have no name on the profile');
  assert.equal(second.member_name, 'Ethan Wallace');
});

await check('the claim queue is officer only, both ways', async () => {
  // A viewer reads the review queue and decides nothing, and could read
  // member_claims off the table before. list_pending_claims() carries an email
  // address out of auth.users, so it is narrower on purpose.
  await signInAs('advisor@ucf.edu');
  await assert.rejects(
    () => callRpc('list_pending_claims'),
    (err) => err instanceof RpcError && err.code === 'PDS07',
    'a viewer read the claim queue',
  );

  await signInAs('priya@knights.ucf.edu');
  await assert.rejects(
    () => callRpc('list_pending_claims'),
    (err) => err instanceof RpcError && err.code === 'PDS07',
    'a member read the claim queue',
  );
});

await check('the screen does not ask for a queue it will be refused', () => {
  // The panel answers a read-only account itself rather than sending one
  // request whose only possible answer is a refusal, which is the same rule
  // the review queue holds about an approve on an unmatched card.
  assert.match(claimsSource, /if \(!ctx\.canReview\)/);
});

await check("an OFFICER's Confirm links the account", async () => {
  // THE POINT OF THE CHANGE. Before this, an officer's Confirm recorded a
  // decision it could not carry out and the screen had to say so; only an
  // admin could finish the link. Now one call does both, and it is an officer
  // making it.
  await reset();
  await signInAs('sara@pdsaucf.com');

  const [claim] = await callRpc('list_pending_claims');
  const result = await callRpc('review_member_claim', {
    p_claim_id: IDS.CLAIM_WITH_NAME,
    p_decision: 'approve',
    p_note: null,
  });

  assert.equal(result.status, 'approved');
  assert.equal(result.linked, true);
  assert.equal(result.member_id, IDS.MEMBER_ABIGAIL);
  assert.equal(result.followed_merge, false);

  const { profiles, claims } = await adminState();
  const profile = profiles.find((row) => row.user_id === IDS.USERS.claimant);
  assert.equal(profile.member_id, IDS.MEMBER_ABIGAIL, 'the officer did not finish the link');
  assert.equal(
    claims.find((row) => row.id === IDS.CLAIM_WITH_NAME).status,
    'approved',
    'the decision was not recorded',
  );
  assert.equal(claim.claim_id, IDS.CLAIM_WITH_NAME, 'the queue is no longer ordered oldest first');
});

await check('and the policy that used to refuse that write still refuses it', async () => {
  // The link is legitimate because review_member_claim() owns it, not because
  // profiles_write_admin was widened. If this ever comes back with a row, an
  // officer can write profiles directly and the SECURITY DEFINER function has
  // stopped being the only way in.
  await reset();
  await signInAs('sara@pdsaucf.com');

  const refused = await patch(
    'profiles',
    { user_id: `eq.${IDS.USERS.claimant}` },
    { member_id: IDS.MEMBER_ABIGAIL },
  );
  assert.deepEqual(refused, [], 'an officer can now write profiles.member_id directly');

  const profiles = await select('profiles', {
    select: 'user_id,member_id',
    filters: { user_id: `eq.${IDS.USERS.claimant}` },
  });
  assert.equal(profiles[0].member_id, null, 'the refused write landed anyway');
});

await check('Confirm goes through review_member_claim(), and writes nothing itself', () => {
  assert.match(claimsSource, /callRpc\(\s*'review_member_claim'/);
  assert.match(claimsSource, /p_decision:\s*'approve'/);
  assert.match(claimsSource, /p_decision:\s*'reject'/);
  // The workaround is gone rather than hidden behind a branch: this screen no
  // longer writes any table at all, so the PATCH that RLS answers with an empty
  // array cannot be misread here because there is none.
  assert.doesNotMatch(claimsSource, /\bpatch\(/, 'the claims screen still writes a table directly');
  assert.doesNotMatch(
    claimsSource,
    /admin still has to finish/i,
    'the screen still says an admin has to finish the link',
  );
});

await check('confirming a claim never changes the role on the account', async () => {
  // profiles.member_id is explicitly "optional: officer who is also a member".
  // Writing role here would lock an officer out of this very screen the first
  // time one of them claimed their own roster row, so the case is driven rather
  // than only read off the source: the claimant is made an officer first, and
  // has to come out of an approval still being one.
  await reset();
  await signInAs('ben@pdsaucf.com');
  const raised = await patch(
    'profiles',
    { user_id: `eq.${IDS.USERS.claimant}` },
    { role: 'officer' },
  );
  assert.equal(raised[0].role, 'officer', 'the fixture could not be set up');

  await signInAs('sara@pdsaucf.com');
  await callRpc('review_member_claim', {
    p_claim_id: IDS.CLAIM_WITH_NAME,
    p_decision: 'approve',
    p_note: null,
  });

  const { profiles } = await adminState();
  const profile = profiles.find((row) => row.user_id === IDS.USERS.claimant);
  assert.equal(profile.role, 'officer', 'approving a claim demoted the account to member');
  assert.equal(profile.member_id, IDS.MEMBER_ABIGAIL, 'and it did not link them either');
  assert.doesNotMatch(claimsSource, /role:\s*['"]member['"]/);
});

await check('a merged roster row is followed, and the officer is told', async () => {
  // THE GAP THE CLAIM WAITS IN. Abigail Catto is merged into Abby Catto while
  // the claim on Abigail is still pending, which is exactly what roster cleanup
  // after an import does. merge_members() took every attendance record with it,
  // so linking the account to the tombstone would hand somebody an empty
  // portal. Confirm on one row therefore links another, and saying only
  // "linked" would leave the officer reading a name they never pressed.
  await reset();
  await signInAs('sara@pdsaucf.com');

  const abby = 'm0000000-0000-4000-a000-000000000002';
  await callRpc('merge_members', { p_from_id: IDS.MEMBER_ABIGAIL, p_into_id: abby });

  const result = await callRpc('review_member_claim', {
    p_claim_id: IDS.CLAIM_WITH_NAME,
    p_decision: 'approve',
    p_note: null,
  });

  assert.equal(result.followed_merge, true, 'the merge was not followed');
  assert.equal(result.claimed_member_id, IDS.MEMBER_ABIGAIL, 'the claimed row was rewritten');
  assert.equal(result.member_id, abby, 'the account was linked to the tombstone');

  const { profiles, claims } = await adminState();
  assert.equal(
    profiles.find((row) => row.user_id === IDS.USERS.claimant).member_id,
    abby,
    'the link landed somewhere other than the survivor',
  );
  // The claim still records the assertion the member actually made.
  assert.equal(
    claims.find((row) => row.id === IDS.CLAIM_WITH_NAME).member_id,
    IDS.MEMBER_ABIGAIL,
    'following a merge edited the claim to tidy an index',
  );
});

await check('the status line names the row that was linked, not the row that was pressed', () => {
  // The screen holds only the name the member picked, which after a followed
  // merge is a tombstone. It reads the survivor's name back before it says
  // anything, and it says both.
  assert.match(claimsSource, /followed_merge/);
  assert.match(claimsSource, /survivorName/);
  const said = claimsSource.slice(claimsSource.indexOf('result?.followed_merge'));
  assert.match(said.slice(0, 600), /was merged into/, 'the status line does not mention the merge');
});

await check('the audit row carries both ids, so the merge can be seen later', async () => {
  const { auditLog } = await adminState();
  const row = auditLog.find((entry) => entry.action === 'review_member_claim');
  assert.ok(row, 'approving a claim wrote no audit row');
  assert.equal(row.detail.claimed_member_id, IDS.MEMBER_ABIGAIL);
  assert.equal(row.detail.followed_merge, true);
  assert.notEqual(row.detail.member_id, row.detail.claimed_member_id);
});

await check('an archived member is refused rather than linked', async () => {
  // The other half of the same window. search_roster_for_claim() declines to
  // offer an archived row, so approving one here would leave the two halves of
  // one rule disagreeing.
  await reset();
  await signInAs('ben@pdsaucf.com');
  await patch(
    'members',
    { id: `eq.${IDS.MEMBER_ABIGAIL}` },
    { archived_at: new Date().toISOString() },
  );

  await signInAs('sara@pdsaucf.com');
  await assert.rejects(
    () =>
      callRpc('review_member_claim', {
        p_claim_id: IDS.CLAIM_WITH_NAME,
        p_decision: 'approve',
        p_note: null,
      }),
    (err) => err instanceof RpcError && err.code === 'PDS03' && /archived/i.test(err.message),
    'an archived member was linked anyway',
  );

  const { profiles } = await adminState();
  assert.equal(
    profiles.find((row) => row.user_id === IDS.USERS.claimant).member_id,
    null,
    'a refused approval linked the account anyway',
  );
});

await check('a member another account already holds is refused by the constraint', async () => {
  await reset();
  await signInAs('ben@pdsaucf.com');
  // Somebody else is given the roster row first, which is what a race between
  // two officers, or an admin patching profiles by hand, actually looks like.
  await patch('profiles', { user_id: `eq.${IDS.USERS.member}` }, { member_id: IDS.MEMBER_ABIGAIL });

  await signInAs('sara@pdsaucf.com');
  await assert.rejects(
    () =>
      callRpc('review_member_claim', {
        p_claim_id: IDS.CLAIM_WITH_NAME,
        p_decision: 'approve',
        p_note: null,
      }),
    (err) => err instanceof RpcError && err.code === 'PDS14',
    'two accounts were allowed to hold one member',
  );
});

await check('an account that already holds a different member is refused', async () => {
  await reset();
  await signInAs('ben@pdsaucf.com');
  await patch(
    'profiles',
    { user_id: `eq.${IDS.USERS.claimant}` },
    { member_id: 'm0000000-0000-4000-a000-000000000003' },
  );

  await signInAs('sara@pdsaucf.com');
  await assert.rejects(
    () =>
      callRpc('review_member_claim', {
        p_claim_id: IDS.CLAIM_WITH_NAME,
        p_decision: 'approve',
        p_note: null,
      }),
    (err) => err instanceof RpcError && err.code === 'PDS13',
    'an approval moved a member_id that was already set',
  );
});

await check('a claim somebody else already decided is refused, not decided twice', async () => {
  await reset();
  await signInAs('sara@pdsaucf.com');
  await callRpc('review_member_claim', {
    p_claim_id: IDS.CLAIM_WITH_NAME,
    p_decision: 'approve',
    p_note: null,
  });
  await assert.rejects(
    () =>
      callRpc('review_member_claim', {
        p_claim_id: IDS.CLAIM_WITH_NAME,
        p_decision: 'reject',
        p_note: 'changed my mind',
      }),
    (err) => err instanceof RpcError && err.code === 'PDS03' && /already been decided/i.test(err.message),
  );
});

await check('turning a claim down keeps the reason, and lets them ask again', async () => {
  await reset();
  await signInAs('sara@pdsaucf.com');

  const result = await callRpc('review_member_claim', {
    p_claim_id: IDS.CLAIM_WITHOUT_NAME,
    p_decision: 'reject',
    p_note: 'That roster row belongs to somebody else.',
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.linked, false);

  const { profiles, claims } = await adminState();
  for (const profile of profiles) {
    assert.equal(profile.member_id, null, 'a turned-down claim linked somebody anyway');
  }

  const claim = claims.find((row) => row.id === IDS.CLAIM_WITHOUT_NAME);
  // The member reads this on their own screen, which is why it is a column of
  // its own rather than being written over what the member said.
  assert.match(claim.review_note, /belongs to somebody else/);
  assert.equal(claim.note, null, "the decline reason overwrote the member's own note");

  // Both partial indexes exclude rejected rows, so the member and the roster
  // row are both free again, which is what the screen tells the officer.
  const left = await callRpc('list_pending_claims');
  assert.equal(left.length, 1, 'a decided claim is still in the queue');
});

await check('the decline reason is required, and the member is told it is for them', () => {
  assert.match(adminHtml, /id="claim-decline-dialog"/, 'there is nowhere to type a reason');
  assert.match(claimsSource, /p_note:\s*note/, 'the reason is not sent');
  const guard = claimsSource.slice(claimsSource.indexOf('submitDecline'));
  assert.match(guard.slice(0, 500), /if \(!note\)/, 'a claim can be declined with no reason');
});

await check('a member cannot decide a claim, whatever the queue showed them', async () => {
  await reset();
  await signInAs('priya@knights.ucf.edu');
  await assert.rejects(
    () =>
      callRpc('review_member_claim', {
        p_claim_id: IDS.CLAIM_WITH_NAME,
        p_decision: 'approve',
        p_note: null,
      }),
    (err) => err instanceof RpcError && err.code === 'PDS07',
  );
});

await check('the new refusals read as an officer decision, not as a database message', () => {
  const linked = describeOfficer(
    new RpcError('PDS13', 'That account is already linked to a member.', 400),
  );
  assert.match(linked.title, /already linked/i);
  assert.match(linked.body, /decline/i, 'PDS13 leaves the officer with no next step');

  const claimed = describeOfficer(
    new RpcError('PDS14', 'That member is already linked to another account.', 400),
  );
  assert.match(claimed.title, /already claimed/i);
  assert.match(claimed.body, /decline/i, 'PDS14 leaves the officer with no next step');

  // PDS03 is the whole product's "that was not accepted", so on this screen it
  // is told which call raised it and names the state instead. The sentence the
  // function raised is the body, because it is the only thing that separates
  // archived from already decided, and reading it is the caller's job here
  // rather than this file's.
  const archived = describeOfficer(
    new RpcError('PDS03', 'That member is archived.', 400),
    CLAIM,
  );
  assert.match(archived.title, /claim/i);
  assert.match(archived.body, /archived/i);
  assert.notEqual(
    archived.title,
    describeOfficer(new RpcError('PDS03', 'That member is archived.', 400)).title,
    'the claim screen shows the same generic heading as everything else',
  );

  for (const copy of [linked, claimed, archived]) {
    assert.doesNotMatch(
      `${copy.title} ${copy.body}`,
      /constraint|policy|RLS|profiles|null|row/i,
      'the database vocabulary reached the officer',
    );
  }
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
