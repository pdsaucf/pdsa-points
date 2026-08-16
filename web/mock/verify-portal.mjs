// Checks for the member portal at /me.
//
// Same rule as the other four suites: assert what fails SILENTLY. A portal that
// draws is easy to see. What is not:
//
//   1. THAT THE PROGRESS LIST IS THE PUBLISHED RULE SET, DRAWN. Invariant 1
//      says a category added in September appears in September with no code
//      change, and a list hardcoded in JavaScript would look identical on this
//      fixture and be wrong the first time anybody edits a rule. So the check
//      is falsifiable: an admin renames a requirement mid-run and the screen
//      has to follow it, and nothing under src/ may name a category at all.
//   2. THAT THE NUMBERS COME FROM THE SERVER. Honorary status is computed in
//      Postgres (invariant 2) and the point total sums only the categories
//      flagged as counting toward it. Both are read and rendered here, and the
//      sources are checked for a second implementation of either.
//   3. THAT AN UNLINKED ACCOUNT SEES NOBODY'S DATA. Three of the four screens
//      exist because of that, and the one that reads the roster reads names and
//      ids through an RPC that hides anybody already spoken for.
//   4. THAT A MISSING-CREDIT REQUEST IS A REQUEST. Invariant 6: it lands
//      pending, in the same review queue as a scanned check-in, and the copy
//      never lets somebody conclude they have been given credit.
//   5. THAT PROGRESS IS NOT CONVEYED BY COLOUR ALONE. A bar is nothing to a
//      screen reader and nothing to somebody who cannot tell the two fills
//      apart, so it is aria-hidden and every row carries its verdict in words.
//   6. THAT THE MOCK IS NOT KINDER THAN POSTGRES. Every refusal migration 18
//      makes is made here, and the ones the portal can reach are made through
//      the portal.
//
// HOW THE SCREENS ARE DRIVEN. mock/dom.mjs parses the real me/index.html and
// portal.js's own start() runs against it, so what is asserted below is the
// rendered DOM of the shipped page. An id that stopped matching between the
// markup and a module fails here rather than in front of a member.
//
// Run: node web/mock/verify-portal.mjs   (npm run verify:portal, from web/)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';
import { IDS } from './admin-fixtures.mjs';
import { installDom } from './dom.mjs';
import {
  BRAND_TOKENS,
  CONTRAST,
  SEMANTIC_CONTRAST,
  asRatio,
  goldMisuse,
  ratio,
  schemes,
} from './brand.mjs';
import { declarations, rule } from './css-rules.mjs';

const PORT = 8797;
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

globalThis.window = {
  location: {
    origin: `http://localhost:${PORT}`,
    pathname: '/me/',
    href: `http://localhost:${PORT}/me/`,
    replace() {},
  },
  history: { replaceState() {} },
};

// The page and the stylesheet, as they ship.
const portalHtml = await readFile(`${WEB_ROOT}me/index.html`, 'utf8');
const portalCss = await readFile(`${WEB_ROOT}assets/css/portal.css`, 'utf8');
const checkinCss = await readFile(`${WEB_ROOT}assets/css/checkin.css`, 'utf8');

let dom = installDom(portalHtml);

const auth = await import('../src/auth.js');
const { select, insert, patch, callRpc } = await import('../src/rest.js');
const { RpcError } = await import('../src/errors.js');
const { describeMember, describeMemberSignIn } = await import('../src/member-errors.js');
const { start } = await import('../src/portal.js');

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

/** Waits for the screen to settle, rather than for a fixed number of turns. */
async function until(predicate, message, timeout = 4000) {
  const stop = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > stop) throw new Error(`timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Signing in as somebody.
 *
 * createUser is what the portal sends and the officer screens do not: an
 * address the club has never seen is a member who has never signed in, and
 * making that account is the whole point. See web/src/portal.js.
 */
async function signInAs(email, { createUser = true } = {}) {
  auth.forgetSession();
  await auth.sendMagicLink(email, `http://localhost:${PORT}/me/`, { createUser });
  const answer = await api(`/__mock/magic-link?email=${encodeURIComponent(email)}`);
  assert.ok(answer.url, `no sign-in link for ${email}`);
  const parsed = auth.parseAuthRedirect(answer.url);
  assert.ok(parsed?.session, `no session in the sign-in link for ${email}`);
  auth.adoptSession(parsed.session);
  return parsed.session;
}

/** A fresh copy of the shipped page, with the portal mounted on it. */
async function mountPortal() {
  dom = installDom(portalHtml);
  start();
  return dom;
}

const shown = (view) => !dom.$(`view-${view}`).hidden;
const live = () => dom.$('live').textContent;

const server = await startMock(PORT);
await api('/__mock/reset');

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const sources = {
  'src/portal.js': await readFile(`${WEB_ROOT}src/portal.js`, 'utf8'),
  'src/portal-claim.js': await readFile(`${WEB_ROOT}src/portal-claim.js`, 'utf8'),
  'src/portal-progress.js': await readFile(`${WEB_ROOT}src/portal-progress.js`, 'utf8'),
  'src/member-errors.js': await readFile(`${WEB_ROOT}src/member-errors.js`, 'utf8'),
};

await check('no em dash in anything the portal is made of', async () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    ...sources,
    'me/index.html': portalHtml,
    'assets/css/portal.css': portalCss,
    'mock/verify-portal.mjs': await readFile(new URL(import.meta.url), 'utf8'),
  };
  for (const [label, source] of Object.entries(files)) {
    assert.ok(!source.includes(emDash), `${label} contains an em dash`);
  }
});

await check('the page loads no font, script or style from anywhere else', () => {
  for (const [label, source] of [
    ['me/index.html', portalHtml],
    ['assets/css/portal.css', portalCss],
  ]) {
    assert.doesNotMatch(source, /fonts\.googleapis|fonts\.gstatic/i, `${label} links Google Fonts`);
    assert.doesNotMatch(
      source,
      /https?:\/\/(?!localhost)[^"')\s]+\.(js|css|woff2?)/i,
      `${label} loads a file from another host`,
    );
    assert.doesNotMatch(source, /cdn\.|unpkg\.com|jsdelivr/i, `${label} references a CDN`);
  }
});

await check('Public Sans is self hosted with font-display: swap and a real fallback', () => {
  assert.match(portalCss, /@font-face\s*{[^}]*font-family:\s*'Public Sans'/);
  assert.match(portalCss, /font-display:\s*swap/);
  assert.match(portalCss, /url\('\.\.\/fonts\/public-sans\/PublicSans-VariableFont\.woff2'\)/);
  assert.match(portalCss, /--font:\s*'Public Sans',\s*ui-sans-serif,\s*system-ui,\s*sans-serif/);
});

await check('every column of digits on this screen is tabular', () => {
  // A member reads two columns of figures here: the requirement list and their
  // records. A proportional 1 among 9s is the difference between scanning and
  // reading.
  assert.match(portalCss, /body\s*{[^}]*font-variant-numeric:\s*tabular-nums/);
  for (const selector of ['.check-figures', '.figures', '.points', '.record-date']) {
    const block = new RegExp(`\\${selector}\\s*\\{[^}]*font-variant-numeric:\\s*tabular-nums`);
    assert.match(portalCss, block, `${selector} does not line its digits up`);
  }
});

/**
 * The source with its comments taken out.
 *
 * Used by both checks below, and it is the honest cut for each of them: a
 * comment explaining why Volunteering hours are excluded from the point total
 * is documentation, and a category name in a string literal is a rule somebody
 * wrote down.
 */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every string literal that is plainly copy rather than an identifier. */
function uiStrings(source) {
  const stripped = withoutComments(source);
  const found = [];
  for (const pattern of [/'((?:[^'\\\n]|\\.)*)'/g, /"((?:[^"\\\n]|\\.)*)"/g, /`((?:[^`\\]|\\.)*)`/g]) {
    for (const match of stripped.matchAll(pattern)) {
      const text = match[1];
      if (!text) continue;
      if (!/\s/.test(text) && !/[A-Z]/.test(text)) continue;
      found.push(text);
    }
  }
  return found;
}

const portalCopy = [
  ...Object.entries(sources).flatMap(([label, source]) =>
    uiStrings(source).map((text) => [label, text]),
  ),
  ['me/index.html', portalHtml.replace(/<!--[\s\S]*?-->/g, ' ')],
];

await check('the database vocabulary never reaches a member', () => {
  const banned = [
    'node', 'nodes', 'threshold', 'schema', 'RLS', 'PostgREST', 'uuid', 'jsonb',
    'foreign key', 'profile',
  ];
  for (const [label, text] of portalCopy) {
    for (const word of banned) {
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i'),
        `${label} shows the word "${word}": ${JSON.stringify(text.slice(0, 90))}`,
      );
    }
  }
});

await check('the officer register never reaches a member', () => {
  // "Reload the queue" is a sentence about somebody else's job. This is the
  // whole reason member-errors.js exists rather than an import of
  // officer-errors.js, so it is asserted rather than trusted.
  for (const [label, text] of portalCopy) {
    for (const word of ['queue', 'officer account', 'admin', 'approve', 'decline']) {
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${word}\\b`, 'i'),
        `${label} talks to a member in an officer's words: ${JSON.stringify(text.slice(0, 90))}`,
      );
    }
  }
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      withoutComments(source),
      /officer-errors/,
      `${label} imports the officer error copy`,
    );
  }
});

await check('nothing under the portal computes a point total or an honorary flag', () => {
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /is_honorary\s*=[^=]/, `${label} assigns is_honorary`);
    assert.doesNotMatch(source, /point_total\s*[+-]?=[^=]/, `${label} computes a point total`);
    assert.doesNotMatch(
      source,
      /counts_toward_point_total/,
      `${label} branches on which categories count, which is the database's job`,
    );
  }
  assert.match(sources['src/portal-progress.js'], /select\('v_member_status'/);
  assert.match(sources['src/portal-progress.js'], /callRpc\('fn_member_requirement_status'/);
});

await check('the portal writes no table at all', () => {
  // Every write a member can make goes through a SECURITY DEFINER function, and
  // the one that files a record files it pending with no argument that could
  // ask for anything else. A direct insert would be refused by RLS, but a
  // client that tried is a client that believed it could.
  for (const [label, source] of Object.entries(sources)) {
    for (const verb of ['insert\\(', 'patch\\(', 'remove\\(']) {
      assert.doesNotMatch(
        source,
        new RegExp(verb),
        `${label} writes a table directly instead of calling a function`,
      );
    }
    assert.doesNotMatch(source, /status:\s*['"]approved['"]/, `${label} writes an approved status`);
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe brand\n');
// ---------------------------------------------------------------------------
//
// A third stylesheet, and the third copy of one token block. There is no build
// step that could share it, so the guard against drift is this check, exactly
// as mock/verify-admin.mjs guards the other two.

const portalTokens = schemes(portalCss);
const checkinTokens = schemes(checkinCss);

for (const scheme of ['light', 'dark']) {
  await check(`${scheme}: the portal and the check-in page declare the same brand tokens`, () => {
    const mine = portalTokens[scheme];
    const theirs = checkinTokens[scheme];
    for (const token of BRAND_TOKENS) {
      assert.ok(mine.has(token), `portal.css does not declare ${token} for ${scheme}`);
      assert.ok(theirs.has(token), `checkin.css does not declare ${token} for ${scheme}`);
      assert.equal(
        mine.get(token).trim().toLowerCase(),
        theirs.get(token).trim().toLowerCase(),
        `${token} is ${mine.get(token)} in portal.css and ${theirs.get(token)} in checkin.css`,
      );
    }
  });

  await check(`${scheme}: every pairing on this screen clears its contrast floor`, () => {
    const tokens = portalTokens[scheme];
    let measured = 0;
    for (const [ink, ground, floor] of [...CONTRAST, ...SEMANTIC_CONTRAST]) {
      if (!tokens.has(ink) || !tokens.has(ground)) continue;
      measured += 1;
      const got = ratio(tokens.get(ink), tokens.get(ground));
      assert.ok(got >= floor, `${ink} on ${ground} is ${asRatio(got)}, and the floor is ${asRatio(floor)}`);
    }
    assert.ok(measured >= 16, `only ${measured} pairs were measurable, so the tokens moved`);
  });
}

await check('gold is a fill or a bar, never a foreground', () => {
  const misuse = goldMisuse(portalCss);
  assert.deepEqual(misuse, [], misuse.map((m) => `${m.property}: ${m.value} (${m.why})`).join('; '));
});

await check('the focus ring is drawn clear of the control, not on top of it', () => {
  const decls = declarations(
    rule(portalCss, ':where(a, button, input, select, textarea, [tabindex]):focus-visible'),
  );
  assert.ok(decls.size, 'no focus-visible rule in portal.css');
  const offset = Number.parseFloat(decls.get('outline-offset') ?? '0');
  assert.ok(offset >= 2, `outline-offset is ${decls.get('outline-offset')}`);
  assert.match(decls.get('outline') ?? '', /var\(--focus\)/, 'the ring is not drawn in --focus');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nsigning in\n');
// ---------------------------------------------------------------------------

await check('with no session, the page is the sign-in form and nothing else', async () => {
  auth.forgetSession();
  await mountPortal();
  assert.ok(shown('signin'), 'the sign-in form is not on screen');
  for (const view of ['portal', 'search', 'pending', 'rejected']) {
    assert.ok(!shown(view), `${view} is on screen with nobody signed in`);
  }
  assert.ok(dom.$('topbar').hidden, 'the sign-out bar is offered to nobody');
});

await check('the portal asks for an account to be created, where the officer screens refuse to', async () => {
  dom.$('signin-email').value = 'first.timer@knights.ucf.edu';
  dom.fire(dom.$('view-signin'), 'submit');
  await until(() => !dom.$('signin-message').hidden, 'no answer to the sign-in form');

  const { calls } = await adminAudit();
  const otp = calls.filter((call) => call.fn === 'auth.otp');
  assert.ok(otp.length, 'no sign-in request was made');
  assert.equal(
    otp[otp.length - 1].create_user,
    true,
    'the portal would refuse a member who has never signed in',
  );
  // The copy never implies the address has to be known already, because here
  // it does not.
  assert.match(dom.$('signin-message-title').textContent, /inbox/i);
});

await check('a refused sign-in says what to do without naming who has an account', () => {
  const copy = describeMemberSignIn(new RpcError('over_email_send_rate_limit', 'slow down', 429));
  assert.match(copy.title, /just sent/i);
  assert.doesNotMatch(`${copy.title} ${copy.body}`, /account/i);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nnot linked, no claim: which of these is you\n');
// ---------------------------------------------------------------------------

const NEWCOMER = 'first.timer@knights.ucf.edu';
await signInAs(NEWCOMER);
await mountPortal();
await until(() => shown('search'), 'the claim search never opened');

await check('an account the database has never seen is bootstrapped as a member', async () => {
  const { profiles, auditLog } = await adminAudit();
  const session = auth.currentSession();
  const profile = profiles.find((row) => row.user_id === session.user.id);
  assert.ok(profile, 'signing in created no account of its own');
  assert.equal(profile.role, 'member', `a first sign-in came out ${profile.role}`);
  assert.equal(profile.member_id, null, 'an unmatched address was linked to somebody');
  assert.ok(
    auditLog.some((row) => row.action === 'start_portal_session' && row.detail.created_profile),
    'creating an account was not audited',
  );
});

await check('nobody else data is on the screen', () => {
  const text = dom.$('view-search').textContent;
  assert.doesNotMatch(text, /points/i, 'the claim screen shows progress');
  assert.ok(dom.$('view-portal').hidden, 'an unlinked account can see the progress screen');
  assert.equal(dom.$('claim-results').children.length, 0, 'the roster is on screen unasked');
});

await check('two letters are not a way to walk the roster', async () => {
  dom.$('claim-search').value = 'ca';
  dom.fire(dom.$('claim-search'), 'input');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(dom.$('claim-results').children.length, 0, 'a two letter search returned names');
  assert.match(dom.$('claim-hint').textContent, /keep typing/i);

  await assert.rejects(
    () => callRpc('search_roster_for_claim', { p_q: 'ca' }),
    (err) => err.code === 'PDS03',
    'the database would have answered a two letter search',
  );
});

await check('the search hides anybody already claimed, so a name on the list can be claimed', async () => {
  dom.$('claim-search').value = 'catto';
  dom.fire(dom.$('claim-search'), 'input');
  await until(() => dom.$('claim-results').children.length > 0, 'the search never answered');

  const names = dom
    .$('claim-results')
    .querySelectorAll('button')
    .map((button) => button.textContent.trim());

  // Abigail Catto is claimed by another account in the fixtures. Abby Catto is
  // not, and both of them match this search.
  assert.ok(names.includes('Abby Catto'), `Abby Catto was not offered: ${names.join(', ')}`);
  assert.ok(
    !names.includes('Abigail Catto'),
    'a member somebody else is already claiming was offered',
  );
  assert.match(live(), /name/i, 'the result count was not announced');
});

await check('a name returns a name and an id, and nothing else about that person', async () => {
  const rows = await callRpc('search_roster_for_claim', { p_q: 'catto' });
  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['display_name', 'id'],
      `the roster search leaked ${Object.keys(row).join(', ')}`,
    );
  }
});

await check('picking a name asks before it sends', () => {
  const abby = dom
    .$('claim-results')
    .querySelectorAll('button')
    .find((button) => button.textContent.trim() === 'Abby Catto');
  dom.click(abby);
  assert.ok(!dom.$('claim-confirm').hidden, 'nothing was confirmed, the claim just went');
  assert.equal(dom.$('claim-chosen').textContent.trim(), 'Abby Catto');
  assert.match(live(), /Abby Catto/);
});

await check('sending the claim files it, and the screen becomes the waiting one', async () => {
  dom.$('claim-note').value = 'I signed up with my old address.';
  dom.fire(dom.$('claim-confirm'), 'submit');
  await until(() => shown('pending'), 'the waiting screen never arrived');

  const session = auth.currentSession();
  const { claims } = await adminAudit();
  const filed = claims.find((row) => row.user_id === session.user.id);
  assert.ok(filed, 'no claim was filed');
  assert.equal(filed.status, 'pending', `the claim was filed ${filed.status}`);
  assert.equal(filed.member_id, IDS.MEMBER_ABBY, 'the claim names somebody else');
  assert.equal(filed.note, 'I signed up with my old address.');
  assert.equal(filed.review_note, null, "the member's words were written as an officer's");
  assert.match(live(), /officer/i, 'nothing was announced when the claim went');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nwaiting for an officer\n');
// ---------------------------------------------------------------------------

await check('the waiting screen is a state, a name and a date, and no data', () => {
  assert.ok(shown('pending'));
  assert.match(dom.$('pending-who').textContent, /Abby Catto/);
  assert.match(dom.$('pending-who').textContent, /asked/i);
  assert.ok(dom.$('view-portal').hidden, 'a pending claim shows somebody progress');
  assert.doesNotMatch(
    dom.$('view-pending').textContent,
    /points|record/i,
    'a claim nobody has confirmed is showing a roster row',
  );
});

await check('asking twice is refused by the database, not by the screen', async () => {
  // one_live_claim_per_user. The member is done and should stop pressing the
  // button, which is a different situation from somebody else holding the
  // claim, which is why they are different codes.
  await assert.rejects(
    () => callRpc('file_member_claim', { p_member_id: IDS.MEMBER_AARON, p_note: null }),
    (err) => err.code === 'PDS13',
  );
  const copy = describeMember(new RpcError('PDS13', 'You already have a claim waiting.', 400));
  assert.match(copy.title, /already asked/i);
  assert.equal(copy.recover, 'reload');
});

await check('a second account cannot claim a member somebody is already claiming', async () => {
  await signInAs('second.timer@knights.ucf.edu');
  await callRpc('start_portal_session');
  await assert.rejects(
    () => callRpc('file_member_claim', { p_member_id: 'm0000000-0000-4000-a000-000000000002' }),
    (err) => err.code === 'PDS14',
    'one_live_claim_per_member did not fire',
  );
  const copy = describeMember(new RpcError('PDS14', 'Somebody has already claimed that member.', 400));
  assert.match(copy.title, /already claimed/i);
  // No recovery button: the screen they are on is the search, and picking
  // another name is the next step.
  assert.equal(copy.recover, 'none');
});

// ---------------------------------------------------------------------------
process.stdout.write('\ndeclined, with the reason\n');
// ---------------------------------------------------------------------------

const DECLINE_REASON = 'That is not the Ethan Wallace on our roster.';

await check('an officer declines a claim, and the member reads why', async () => {
  await signInAs('sara@pdsaucf.com', { createUser: false });
  await callRpc('review_member_claim', {
    p_claim_id: IDS.CLAIM_WITHOUT_NAME,
    p_decision: 'reject',
    p_note: DECLINE_REASON,
  });

  await signInAs('ewallace99@gmail.com', { createUser: false });
  await mountPortal();
  await until(() => shown('rejected'), 'the declined screen never arrived');

  assert.match(dom.$('rejected-who').textContent, /Ethan Wallace/);
  assert.equal(dom.$('rejected-reason').textContent.trim(), DECLINE_REASON);
  assert.ok(!dom.$('rejected-reason').hidden, "the officer's reason is hidden from the member");
  assert.match(live(), /not confirmed/i);
});

await check('trying again is a real offer, not a button back to the same refusal', async () => {
  dom.click(dom.$('rejected-retry'));
  assert.ok(shown('search'), 'Try again went nowhere');

  // Both partial unique indexes exclude rejected rows, so the member and the
  // account are free again. The database is what says so.
  const rows = await callRpc('search_roster_for_claim', { p_q: 'wallace' });
  assert.ok(
    rows.some((row) => row.display_name === 'Ethan Wallace'),
    'a declined claim left the member unclaimable',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write('\nlinked: the progress screen\n');
// ---------------------------------------------------------------------------

// Two records for this member before the portal opens, filed the way an officer
// files them: one left pending, one declined with a reason. Both are things
// docs/04 says the member has to be able to see for themselves.
const DECLINED_RECORD_NOTE = 'Photo was taken at a different event.';

await signInAs('sara@pdsaucf.com', { createUser: false });
const officerFiled = await (async () => {
  const pending = await insert('attendance_records', [
    { event_id: IDS.EVENT_GBM, member_id: IDS.MEMBER_PRIYA, source: 'officer_entry' },
  ]);
  const declined = await insert('attendance_records', [
    { event_id: IDS.EVENT_SOAP, member_id: IDS.MEMBER_PRIYA, source: 'officer_entry' },
  ]);
  await callRpc('review_records', {
    p_ids: [declined[0].id],
    p_decision: 'reject',
    p_note: DECLINED_RECORD_NOTE,
  });
  return { pending: pending[0].id, declined: declined[0].id };
})();

await signInAs('priya@knights.ucf.edu', { createUser: false });
await mountPortal();
await until(() => shown('portal'), 'the progress screen never opened');
await until(() => dom.$('progress-list').children.length > 0, 'the requirement list never drew');

const status = (
  await select('v_member_status', {
    select: 'member_id,point_total,is_honorary,requirement_set_id',
    filters: { member_id: `eq.${IDS.MEMBER_PRIYA}`, academic_year_id: `eq.${IDS.YEAR_CURRENT}` },
    limit: 1,
  })
)[0];

const requirementRows = () =>
  dom.$('progress-list').querySelectorAll('li').map((node) => ({
    label: node.querySelector('.check-label').textContent.trim(),
    figures: node.querySelector('.check-figures')?.textContent.trim() ?? '',
    met: node.dataset.met === 'true',
    spoken: node.querySelector('.visually-hidden')?.textContent.trim() ?? '',
    depth: node.dataset.depth,
  }));

await check('an address that matches a roster row is linked with nobody in the middle', async () => {
  const { profiles, auditLog } = await adminAudit();
  const session = auth.currentSession();
  const profile = profiles.find((row) => row.user_id === session.user.id);
  assert.equal(profile.member_id, IDS.MEMBER_PRIYA, 'the address did not link itself');
  assert.ok(
    auditLog.some((row) => row.action === 'start_portal_session' && row.detail.auto_linked),
    'linking an account was not audited',
  );
  assert.equal(dom.$('who').textContent.trim(), 'Priya Raman');
});

await check('the requirement list is what the server said, line for line', async () => {
  const answered = await callRpc('fn_member_requirement_status', {
    p_member_id: IDS.MEMBER_PRIYA,
    p_requirement_set_id: status.requirement_set_id,
  });
  const root = answered.find((row) => !row.parent_id);
  const expected = answered.filter((row) => row.node_id !== root.node_id);

  const drawn = requirementRows();
  assert.equal(drawn.length, expected.length, 'the list and the rules disagree on how many there are');
  assert.deepEqual(
    drawn.map((row) => row.label).sort(),
    expected.map((row) => row.label).sort(),
    'the screen drew requirements the rules do not have',
  );

  for (const row of expected) {
    const line = drawn.find((entry) => entry.label === row.label);
    assert.equal(line.met, Boolean(row.passed), `${row.label} is drawn as the opposite verdict`);
    if (row.type !== 'group') {
      assert.ok(
        line.figures.startsWith(`${Number(row.value)} of ${Number(row.target)}`),
        `${row.label} shows "${line.figures}" and the server says ${row.value} of ${row.target}`,
      );
    }
  }

  // The heading is the root's own verdict, in words, and the figures beside it
  // are the ones the bar is drawn from.
  assert.equal(
    dom.$('progress-figures').textContent.trim(),
    `${Number(root.value)} of ${Number(root.target)} met`,
  );
});

await check('the unit word comes from the category, not from the client', () => {
  // "29.5 of 25" is a worse sentence than "29.5 of 25 hours", and nothing in
  // the client knows the word: it is unit_label on the category the
  // requirement measures. A requirement counting plain events says neither.
  const rows = requirementRows();
  const hours = rows.find((row) => /hours$/.test(row.figures));
  assert.ok(hours, `no requirement is counted in a named unit: ${rows.map((r) => r.figures).join(' | ')}`);
  assert.ok(
    rows.some((row) => /^\d+(\.\d+)? of \d+(\.\d+)?$/.test(row.figures)),
    'every requirement invented a unit word',
  );
});

await check('the point total and the honorary state are the server answers, rendered', () => {
  assert.equal(
    dom.$('progress-points').textContent.trim(),
    `${Number(status.point_total)} points total`,
  );
  assert.equal(
    !dom.$('progress-state').hidden,
    Boolean(status.is_honorary),
    'the honorary state on screen is not the one the server computed',
  );
  if (status.is_honorary) assert.equal(dom.$('progress-state').textContent.trim(), 'Honorary');
});

await check('progress is never conveyed by colour alone', () => {
  // The bar is decorative and says so. Every row carries its verdict as a word
  // a screen reader will read, beside a glyph, beside the figures.
  assert.equal(dom.$('progress-bar').getAttribute('aria-hidden'), 'true');
  assert.match(dom.$('progress-figures').textContent, /\d+ of \d+ met/);

  const rows = requirementRows();
  assert.ok(rows.length > 3, 'too few rows to prove anything');
  for (const row of rows) {
    assert.equal(
      row.spoken,
      row.met ? 'Met' : 'Not met',
      `"${row.label}" says its verdict in colour and nothing else`,
    );
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\nlinked: their records\n');
// ---------------------------------------------------------------------------

const recordRows = () =>
  dom.$('records-list').querySelectorAll('li.record').map((node) => ({
    id: node.dataset.record,
    status: node.dataset.status,
    text: node.textContent,
    note: node.querySelector('.record-note')?.textContent.trim() ?? '',
    categories: node.querySelector('.record-categories')?.textContent.trim() ?? '',
  }));

await check('a pending record is visible, so "did my check-in work" has an answer at 8pm', () => {
  const row = recordRows().find((entry) => entry.id === officerFiled.pending);
  assert.ok(row, 'a record waiting for review is invisible to the member it belongs to');
  assert.match(row.text, /In review/);
});

await check('a declined record shows the reason an officer typed', () => {
  const row = recordRows().find((entry) => entry.id === officerFiled.declined);
  assert.ok(row, 'a declined record is hidden from the member');
  assert.match(row.text, /Not counted/);
  assert.equal(row.note, DECLINED_RECORD_NOTE, 'the reason is hidden, so they have to ask for it');
});

await check('a member sees their own records and nobody else', async () => {
  const mine = await select('attendance_records', { select: 'id,member_id' });
  assert.ok(mine.length > 0, 'a member can read none of their own records');
  assert.ok(
    mine.every((row) => row.member_id === IDS.MEMBER_PRIYA),
    'somebody else records came back',
  );
});

// ---------------------------------------------------------------------------
process.stdout.write("\nsomething's missing\n");
// ---------------------------------------------------------------------------

await check('the form offers events this member has no record for, and no others', () => {
  dom.click(dom.$('missing-open'));
  const offered = dom.$('missing-event').children.map((node) => node.value);
  assert.ok(offered.length > 0, 'the event list is empty');
  assert.ok(
    !offered.includes(IDS.EVENT_GBM),
    'an event the member already has a record for was offered again',
  );
  assert.ok(
    offered.includes(IDS.EVENT_TWO_CATEGORIES),
    'an event with no record was left out of the list',
  );
  assert.ok(
    !offered.includes(IDS.EVENT_LAST_YEAR),
    "another year's event was offered",
  );
});

await check('an event that reads a number asks for it, labelled from the category', () => {
  dom.$('missing-event').value = IDS.EVENT_TWO_CATEGORIES;
  dom.fire(dom.$('missing-event'), 'change');
  assert.ok(!dom.$('missing-value-field').hidden, 'the number field is not offered');
  assert.equal(dom.$('missing-value-label').textContent.trim(), 'Volunteering hours');

  dom.$('missing-event').value = IDS.EVENT_SOAP;
  dom.fire(dom.$('missing-event'), 'change');
  assert.ok(dom.$('missing-value-field').hidden, 'an event that collects no number asked for one');
});

await check('the two refusals a member can fix are made before anything is sent', async () => {
  const callsBefore = (await adminAudit()).calls.length;

  dom.$('missing-event').value = IDS.EVENT_TWO_CATEGORIES;
  dom.fire(dom.$('missing-event'), 'change');
  dom.$('missing-note').value = '';
  dom.fire(dom.$('missing-form'), 'submit');
  assert.ok(!dom.$('missing-error').hidden, 'an empty note was sent');
  assert.match(dom.$('missing-error').textContent, /say what is missing/i);

  dom.$('missing-note').value = 'I was there for the whole morning.';
  dom.$('missing-value').value = '';
  dom.fire(dom.$('missing-form'), 'submit');
  assert.match(dom.$('missing-error').textContent, /number/i);

  const callsAfter = (await adminAudit()).calls.length;
  assert.equal(callsAfter, callsBefore, 'the form spent a request on something it could see was wrong');
});

await check('a request is filed pending, in the same review queue as a scanned check-in', async () => {
  dom.$('missing-value').value = '4';
  dom.fire(dom.$('missing-form'), 'submit');
  await until(
    () => recordRows().some((row) => row.text.includes('Health Fair')),
    'the request never appeared in the record list',
  );

  const { attendance } = await adminAudit();
  const filed = attendance.find(
    (row) => row.event_id === IDS.EVENT_TWO_CATEGORIES && row.member_id === IDS.MEMBER_PRIYA,
  );
  assert.ok(filed, 'nothing was filed');
  assert.equal(filed.status, 'pending', `a member filed a record as ${filed.status}`);
  assert.ok(filed.flags.includes('member_requested'), 'the request is not flagged as one');

  const calls = (await adminAudit()).calls;
  const call = calls.filter((entry) => entry.fn === 'request_missing_credit').pop();
  assert.equal(call.value, 4, 'the number was dropped on the way');
});

await check('the member cannot conclude they have been given credit', () => {
  const row = recordRows().find((entry) => entry.text.includes('Health Fair'));
  assert.equal(row.status, 'pending');
  assert.match(row.text, /In review/);
  assert.doesNotMatch(row.text, /Counted/);
  assert.equal(dom.$('screen-note').textContent.trim(), 'Sent for review.');
  assert.match(live(), /sent for review/i);
});

await check('an event counting for two categories shows both', () => {
  const row = recordRows().find((entry) => entry.text.includes('Health Fair'));
  assert.match(row.categories, /Tabling/);
  assert.match(row.categories, /Volunteering/);
  assert.match(row.categories, /4 hours/, 'the number they sent is not shown back to them');
});

await check('a second request for the same event is refused, at the form, in their words', async () => {
  // The race the copy exists for: the form was filled in from a list that was
  // right when it was drawn, and an officer filed the record in between.
  dom.click(dom.$('missing-open'));
  dom.$('missing-event').value = IDS.EVENT_GKAS;
  dom.fire(dom.$('missing-event'), 'change');
  dom.$('missing-note').value = 'I stayed for the afternoon session too.';
  dom.$('missing-value').value = '2';

  await signInAs('sara@pdsaucf.com', { createUser: false });
  await insert('attendance_records', [
    { event_id: IDS.EVENT_GKAS, member_id: IDS.MEMBER_PRIYA, source: 'officer_entry', submitted_value: 1 },
  ]);
  await signInAs('priya@knights.ucf.edu', { createUser: false });

  dom.fire(dom.$('missing-form'), 'submit');
  await until(() => !dom.$('missing-error').hidden, 'the refusal never reached the screen');
  assert.match(dom.$('missing-error').textContent, /already on your list/i);
  assert.match(live(), /already on your list/i);
});

await check('an event from a year they were not on the roster for is refused at the point of asking', async () => {
  await assert.rejects(
    () =>
      callRpc('request_missing_credit', {
        p_event_id: IDS.EVENT_LAST_YEAR,
        p_note: 'I was at this one.',
        p_value: null,
      }),
    (err) => err.code === 'PDS03' && /roster for that year/i.test(err.message),
  );

  // The sentence the function raised is already written to the member. What it
  // does not carry is a heading, so member-errors.js gives it one.
  const copy = describeMember(
    new RpcError('PDS03', 'You are not on the roster for that year.', 400),
  );
  assert.equal(copy.title, 'That was not sent');
  assert.match(copy.body, /roster for that year/);
});

await check('an account that is not linked cannot file a request at all', async () => {
  await signInAs(NEWCOMER, { createUser: false });
  await assert.rejects(
    () =>
      callRpc('request_missing_credit', {
        p_event_id: IDS.EVENT_TWO_CATEGORIES,
        p_note: 'Something for somebody else.',
        p_value: 1,
      }),
    (err) => err.code === 'PDS07',
  );
  const copy = describeMember(new RpcError('PDS07', 'This account is not linked to a member yet.', 400));
  assert.equal(copy.recover, 'reload');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe rules move, and the screen moves with them\n');
// ---------------------------------------------------------------------------

await check('renaming a requirement renames it on the member screen, with no deploy', async () => {
  // INVARIANT 1, made falsifiable. A list hardcoded in JavaScript would draw
  // this fixture perfectly and would be wrong the first time anybody edits a
  // rule, so the rule is edited here and the screen has to follow.
  const before = requirementRows().map((row) => row.label);
  assert.ok(before.includes('Tabling'), `the fixture no longer has a Tabling rule: ${before.join(', ')}`);

  await signInAs('ben@pdsaucf.com', { createUser: false });
  const written = await patch(
    'requirement_nodes',
    { id: `eq.${IDS.NODES.tabling}` },
    { label: 'Outreach Tables' },
  );
  assert.equal(written.length, 1, 'the rule was not renamed, so this proves nothing');

  await signInAs('priya@knights.ucf.edu', { createUser: false });
  await mountPortal();
  await until(() => dom.$('progress-list').children.length > 0, 'the list never drew again');

  const after = requirementRows().map((row) => row.label);
  assert.ok(after.includes('Outreach Tables'), `the screen kept the old name: ${after.join(', ')}`);
  assert.ok(!after.includes('Tabling'), 'the old name is still on screen');
});

await check('no category or requirement name is baked into the portal', async () => {
  const categories = await select('categories', { select: 'name' });
  assert.ok(categories.length > 5, 'too few categories to prove anything');
  for (const [label, source] of Object.entries(sources)) {
    const code = withoutComments(source);
    for (const { name } of categories) {
      assert.ok(
        !code.includes(name),
        `${label} names the category "${name}", which the club owns and this file may not`,
      );
    }
    assert.doesNotMatch(code, /Honorary Member/, `${label} names the rule set`);
  }
});

/*
  UNIT WORDS ARE THE SAME CLAIM AS THE TWO CHECKS ABOVE, made against a word
  rather than a name, and a static scan cannot make it: grepping source for
  "hour" or "session" would just as easily flag a comment as a hardcoded
  label, and it would have to be loosened the moment somebody legitimately
  wrote either word down. What actually pins invariant 1 for units is the same
  shape as renaming a requirement: mutate the fixture through the same
  officer-only writes an admin would use, remount with no JavaScript change,
  and check the copy followed.

  unitWord() in requirement-model.js stays a client-side read of data rather
  than an RPC's job, because unit is a Postgres ENUM: adding a value to it is
  an ALTER TYPE migration by definition, so "no deploy" was never available
  for the set of units that exist. What invariant 1 promises is that a
  CATEGORY's name, its threshold, and which categories exist can move with no
  deploy, and all three are rows. The word a given unit is read out as, for
  the units that already exist, is exactly such a row: unit_label on
  categories. The two checks below are what proves that promise is kept.
*/

await check('renaming a unit label renames it on the member screen, with no deploy', async () => {
  const before = requirementRows().find((row) => row.label === 'Volunteering');
  assert.ok(before, `the fixture no longer has a Volunteering rule: not found`);
  assert.match(before.figures, /\bhours$/, `Volunteering does not read in hours to start: "${before.figures}"`);

  await signInAs('ben@pdsaucf.com', { createUser: false });
  const written = await patch(
    'categories',
    { id: `eq.${IDS.CATEGORY_VOLUNTEERING}` },
    { unit_label: 'workshift' },
  );
  assert.equal(written.length, 1, 'the label was not renamed, so this proves nothing');

  await signInAs('priya@knights.ucf.edu', { createUser: false });
  await mountPortal();
  await until(() => dom.$('progress-list').children.length > 0, 'the list never drew again');

  const after = requirementRows().find((row) => row.label === 'Volunteering');
  assert.match(after.figures, /\bworkshifts$/, `the screen kept the old word: "${after.figures}"`);
  assert.doesNotMatch(after.figures, /\bhours?\b/, 'the old word is still on screen');

  // The record list reads the same column, through the same helper, for a
  // record that carries a submitted value. It has to follow too.
  const record = recordRows().find((row) => row.text.includes('Health Fair'));
  assert.match(record.categories, /workshifts/, `the record list kept the old word: "${record.categories}"`);
});

await check('two categories that share a unit but disagree on its word show neither', async () => {
  // THE BUG THE ARBITRATION FOUND. Before this fix, kinds.size was 1 (both
  // 'hours') so the mixed-unit guard did not fire, labels.size was 2 so the
  // single-label branch did not fire either, and the function fell through to
  // UNIT_WORD['hours'], printing "hours" for a requirement neither category
  // is actually labelled that. A category is added here and linked onto the
  // Volunteering requirement with a THIRD label, so the fixture proves the
  // fix rather than merely matching what the fix happens to return.
  await signInAs('ben@pdsaucf.com', { createUser: false });
  const created = await insert('categories', [
    {
      name: 'Study Sessions',
      slug: 'study-sessions-mutation-test',
      unit: 'hours',
      unit_label: 'session',
      counts_toward_point_total: false,
      sort_order: 999,
    },
  ]);
  assert.equal(created.length, 1, 'the category was not created, so this proves nothing');

  const linked = await insert('requirement_node_categories', [
    { node_id: IDS.NODES.volunteering, category_id: created[0].id },
  ]);
  assert.equal(linked.length, 1, 'the category was not attached to the requirement');

  await signInAs('priya@knights.ucf.edu', { createUser: false });
  await mountPortal();
  await until(() => dom.$('progress-list').children.length > 0, 'the list never drew again');

  const row = requirementRows().find((entry) => entry.label === 'Volunteering');
  assert.ok(row, 'the Volunteering requirement is gone');
  assert.doesNotMatch(row.figures, /workshift|session|hour/i, `a disagreeing pair still printed a word: "${row.figures}"`);
  assert.match(row.figures, /^\d+(\.\d+)? of \d+(\.\d+)?$/, `figures carry something besides the numbers: "${row.figures}"`);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe mock is not kinder than the database\n');
// ---------------------------------------------------------------------------

await check('none of the portal functions is open to an anonymous caller', async () => {
  for (const fn of [
    'start_portal_session',
    'search_roster_for_claim',
    'file_member_claim',
    'request_missing_credit',
  ]) {
    const res = await fetch(`http://localhost:${PORT}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: 'mock-anon-key',
        Authorization: 'Bearer mock-anon-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_q: 'catto' }),
    });
    const body = await res.json();
    assert.equal(body.code, 'PDS07', `${fn}() served an anonymous caller`);
  }
});

await check('a linked account is refused the roster search and the claim', async () => {
  await signInAs('priya@knights.ucf.edu', { createUser: false });
  await assert.rejects(
    () => callRpc('search_roster_for_claim', { p_q: 'catto' }),
    (err) => err.code === 'PDS07',
    'a linked account can still read the roster',
  );
  await assert.rejects(
    () => callRpc('file_member_claim', { p_member_id: IDS.MEMBER_AARON }),
    (err) => err.code === 'PDS07',
  );
});

await check('a claim on an unknown member is refused', async () => {
  await signInAs('third.timer@knights.ucf.edu');
  await callRpc('start_portal_session');
  await assert.rejects(
    () => callRpc('file_member_claim', { p_member_id: 'm0000000-0000-4000-a000-0000000000ff' }),
    (err) => err.code === 'PDS03',
  );
});

await check('a note longer than the column allows is refused before it is written', async () => {
  await assert.rejects(
    () => callRpc('file_member_claim', { p_member_id: IDS.MEMBER_AARON, p_note: 'x'.repeat(501) }),
    (err) => err.code === 'PDS03' && /too long/i.test(err.message),
  );
});

await check('both limiters exist, and count per caller', async () => {
  // 30 searches a minute, from 18.9. The retry ladder in api.js is switched off
  // for this one call: waiting out a real window is correct behaviour and a
  // poor thing to sit through in a suite.
  let refused = null;
  for (let i = 0; i < 40 && !refused; i += 1) {
    try {
      await callRpc('search_roster_for_claim', { p_q: 'catto' }, { rateLimitAttempts: 0 });
    } catch (err) {
      refused = err;
    }
  }
  assert.ok(refused, 'the roster search can be called without limit');
  assert.equal(refused.code, 'PDS09');

  // And the counter is per caller, so somebody else is unaffected by it.
  await signInAs('fourth.timer@knights.ucf.edu');
  await callRpc('start_portal_session');
  const rows = await callRpc('search_roster_for_claim', { p_q: 'catto' }, { rateLimitAttempts: 0 });
  assert.ok(Array.isArray(rows), 'one caller spent everybody allowance');
});

// ---------------------------------------------------------------------------

server.close();
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exit(failures ? 1 : 0);
