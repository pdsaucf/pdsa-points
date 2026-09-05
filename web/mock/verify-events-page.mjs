// Checks for the public events page at /events.
//
// Same rule as the other suites: assert what fails SILENTLY. A page that
// draws is easy to see. What is not:
//
//   1. THE PAGE TOUCHES NO TABLE (invariant 3). It calls portal_events() and
//      nothing else: no name, no login, no PostgREST table read.
//   2. A NULL FIELD OMITS ITS ROW ENTIRELY. Location, attire, sign-up and
//      description are all optional. A card with none of them must not print
//      four empty labels, and a card with some must not print the rest as
//      blanks.
//   3. VARIES, NEVER 0. A category with credit_mode = 'from_submission' has
//      no fixed figure to promise. Summing an empty set of fixed credits
//      reads as 0, which is the one wrong answer this field can give.
//   4. A URL SIGN-UP IS A BUTTON WITH rel="noopener noreferrer"; ANYTHING
//      ELSE IS TEXT, AND NULL IS NOTHING AT ALL. Rendering an officer's typed
//      sentence as a clickable link, or a real form URL as inert text, are
//      both wrong in a way a screenshot alone would not catch.
//   5. THE BRAND TOKENS MATCH portal.css. Compared here too, and not only in
//      mock/verify-portal.mjs, so this suite catches its own drift even if
//      run alone.
//
// HOW THE SCREEN IS DRIVEN. mock/dom.mjs parses the real events/index.html
// and events-page.js's own start() runs against it, so what is asserted below
// is the rendered DOM of the shipped page.
//
// Fixture events are created through the same officer RPCs the admin screen
// uses (save_event_config, set_event_published) rather than by editing
// mock/admin-fixtures.mjs, so each check controls exactly the fields it is
// testing without disturbing what the other suites already assume about the
// shared fixture set.
//
// Run: node web/mock/verify-events-page.mjs   (npm run verify:events-page, from web/)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.mjs';
import { signInAs as signInAsAccount } from './sign-in.mjs';
import { IDS } from './admin-fixtures.mjs';
import { installDom } from './dom.mjs';
import { BRAND_TOKENS, asRatio, goldMisuse, ratio, schemes } from './brand.mjs';

const PORT = 8802;
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

globalThis.__PDSA_CONFIG__ = {
  SUPABASE_URL: `http://localhost:${PORT}`,
  SUPABASE_ANON_KEY: 'mock-anon-key',
};

globalThis.window = {
  location: {
    origin: `http://localhost:${PORT}`,
    pathname: '/events/',
    search: '',
    href: `http://localhost:${PORT}/events/`,
    replace() {},
    reload() {},
  },
};

// auth.js reads this optionally (globalThis.localStorage?.getItem), which
// this page never exercises since it signs nobody in. Stubbed anyway so the
// import graph never touches Node's own experimental localStorage, the same
// way every other verify file avoids that warning.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

const eventsHtml = await readFile(`${WEB_ROOT}events/index.html`, 'utf8');
const eventsCss = await readFile(`${WEB_ROOT}assets/css/events.css`, 'utf8');
const portalCss = await readFile(`${WEB_ROOT}assets/css/portal.css`, 'utf8');
const eventsPageSource = await readFile(`${WEB_ROOT}src/events-page.js`, 'utf8');

let dom = installDom(eventsHtml);

const { callRpc } = await import('../src/rest.js');
const { start } = await import('../src/events-page.js');

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

async function until(predicate, message, timeout = 4000) {
  const stop = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > stop) throw new Error(`timed out waiting: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const signInAs = (email) => signInAsAccount(email, PORT);

/** A fresh copy of the shipped page, with events-page.js mounted on it. */
function mountEvents() {
  dom = installDom(eventsHtml);
  start();
  return dom;
}

const groupsShown = () => !dom.$('event-groups').hidden;

const cardFor = (title) =>
  [...dom.$('event-groups').querySelectorAll('.event-card')].find(
    (card) => card.querySelector('.event-card-title')?.textContent.trim() === title,
  ) ?? null;

const factLabels = (card) =>
  [...(card?.querySelectorAll('.event-card-facts dt') ?? [])].map((dt) => dt.textContent.trim());

const factValue = (card, label) => {
  const dt = [...(card?.querySelectorAll('.event-card-facts dt') ?? [])].find(
    (node) => node.textContent.trim() === label,
  );
  return dt?.parentNode.querySelector('dd')?.textContent.trim() ?? null;
};

const server = await startMock(PORT);
await api('/__mock/reset');

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

await check('no em dash in anything the events page is made of', async () => {
  const emDash = String.fromCharCode(0x2014);
  const files = {
    'src/events-page.js': eventsPageSource,
    'events/index.html': eventsHtml,
    'assets/css/events.css': eventsCss,
    'mock/verify-events-page.mjs': await readFile(new URL(import.meta.url), 'utf8'),
  };
  for (const [label, source] of Object.entries(files)) {
    assert.ok(!source.includes(emDash), `${label} contains an em dash`);
  }
});

await check('the page loads no font, script or style from anywhere else', () => {
  for (const [label, source] of [
    ['events/index.html', eventsHtml],
    ['assets/css/events.css', eventsCss],
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
  assert.match(eventsCss, /@font-face\s*{[^}]*font-family:\s*'Public Sans'/);
  assert.match(eventsCss, /font-display:\s*swap/);
  assert.match(eventsCss, /url\('\.\.\/fonts\/public-sans\/PublicSans-VariableFont\.woff2'\)/);
  assert.match(eventsCss, /--font:\s*'Public Sans',\s*ui-sans-serif,\s*system-ui,\s*sans-serif/);
});

await check('every column of digits on this screen is tabular', () => {
  assert.match(eventsCss, /body\s*{[^}]*font-variant-numeric:\s*tabular-nums/);
});

await check('the page touches no table: it calls portal_events() and nothing else', () => {
  const code = eventsPageSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const verb of ['select', 'insert', 'patch', 'remove']) {
    assert.doesNotMatch(
      code,
      new RegExp(`(?<![.\\w])${verb}\\s*\\(`),
      `events-page.js calls the table ${verb} path instead of a public RPC`,
    );
  }
  assert.doesNotMatch(code, /from '\.\/rest\.js'/, 'events-page.js imports the signed-in request path');
  assert.doesNotMatch(code, /from '\.\/auth\.js'/, 'events-page.js imports the session');
  assert.match(code, /rpc\(\s*'portal_events'/, 'events-page.js never calls portal_events()');
  const otherRpcNames = [...code.matchAll(/rpc\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(otherRpcNames)], ['portal_events'], 'the page calls something other than portal_events()');
});

await check('the page is anonymous: no accessToken is ever passed to rpc()', () => {
  const code = eventsPageSource.replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.doesNotMatch(code, /accessToken/, 'the page carries a session token');
});

await check('a single-word link goes back to the member portal', () => {
  const row = eventsHtml.match(/<p class="brand-row">[\s\S]*?<\/p>/);
  assert.ok(row, 'there is no brand row on the events page');
  const link = /<a class="brand-link" href="([^"]*)">([^<]*)<\/a>/.exec(row[0]);
  assert.ok(link, 'no brand-link back to /me on the events page');
  assert.equal(link[1], '../me/');
  assert.equal(link[2].trim(), 'Points');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe brand\n');
// ---------------------------------------------------------------------------

const portalTokens = schemes(portalCss);
const eventsTokens = schemes(eventsCss);

for (const scheme of ['light', 'dark']) {
  await check(`${scheme}: events.css declares the same brand tokens as portal.css`, () => {
    const mine = eventsTokens[scheme];
    const theirs = portalTokens[scheme];
    for (const token of BRAND_TOKENS) {
      assert.ok(mine.has(token), `events.css does not declare ${token} for ${scheme}`);
      assert.ok(theirs.has(token), `portal.css does not declare ${token} for ${scheme}`);
      assert.equal(
        mine.get(token).trim().toLowerCase(),
        theirs.get(token).trim().toLowerCase(),
        `${token} is ${mine.get(token)} in events.css and ${theirs.get(token)} in portal.css`,
      );
    }
  });
}

await check('gold is a fill or a bar on the events page, never a foreground', () => {
  const misuse = goldMisuse(eventsCss);
  assert.deepEqual(misuse, [], misuse.map((m) => `${m.property}: ${m.value} (${m.why})`).join('; '));
});

await check('every measurable pairing on this page clears its contrast floor', () => {
  const tokens = eventsTokens.light;
  let measured = 0;
  for (const [ink, ground, floor] of [
    ['--ink', '--bg', 7],
    ['--ink', '--surface', 7],
    ['--ink-muted', '--bg', 4.5],
    ['--ink-muted', '--surface', 4.5],
    ['--accent', '--bg', 4.5],
    ['--accent', '--surface', 4.5],
    ['--accent-ink', '--accent', 4.5],
    ['--focus', '--bg', 3],
    ['--focus', '--surface', 3],
  ]) {
    if (!tokens.has(ink) || !tokens.has(ground)) continue;
    measured += 1;
    const got = ratio(tokens.get(ink), tokens.get(ground));
    assert.ok(got >= floor, `${ink} on ${ground} is ${asRatio(got)}, and the floor is ${asRatio(floor)}`);
  }
  assert.ok(measured >= 8, `only ${measured} pairs were measurable, so the tokens moved`);
});

await check('the focus ring is drawn clear of the control, not on top of it', () => {
  const match = /:where\([^)]*\):focus-visible\s*{([^}]*)}/.exec(eventsCss);
  assert.ok(match, 'no focus-visible rule in events.css');
  assert.match(match[1], /outline-offset:\s*[2-9]/, 'the ring sits on the control rather than clear of it');
  assert.match(match[1], /var\(--focus\)/, 'the ring is not drawn in --focus');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nwhat the page shows before anything is loaded\n');
// ---------------------------------------------------------------------------

await check('the loading state shows before the empty state or the list', () => {
  mountEvents();
  assert.equal(dom.$('loading').hidden, false);
  assert.equal(dom.$('empty').hidden, true);
  assert.equal(dom.$('event-groups').hidden, true);
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe eight facts, and the ones that are missing\n');
// ---------------------------------------------------------------------------

await signInAs('officers@pdsaucf.com');

const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Creates and publishes a fixture event through the same RPCs the admin screen uses. */
async function makeVisibleEvent(fields, categories = []) {
  const id = crypto.randomUUID();
  await callRpc('save_event_config', {
    p_event_id: id,
    p_academic_year_id: IDS.YEAR_CURRENT,
    p_event: {
      title: fields.title,
      occurred_on: fields.occurred_on,
      starts_at: fields.starts_at ?? null,
      ends_at: fields.ends_at ?? null,
      location: fields.location ?? '',
      attire: fields.attire ?? '',
      signup: fields.signup ?? '',
      description: fields.description ?? '',
    },
    p_categories: categories,
    p_evidence: null,
    p_expected_config_version: null,
    p_create: true,
  });
  await callRpc('set_event_published', { p_event_id: id, p_published: true });
  return id;
}

const CATEGORY_GBMS = IDS.CATEGORY_GBMS;
const CATEGORY_VOLUNTEERING = IDS.CATEGORY_VOLUNTEERING;

await check('every eight-fact field is drawn when present, with a URL sign-up as a button', async () => {
  await makeVisibleEvent(
    {
      title: 'Verify Full Card',
      occurred_on: daysFromNow(10),
      starts_at: new Date(Date.now() + 10 * 86400000 + 18 * 3600000).toISOString(),
      ends_at: new Date(Date.now() + 10 * 86400000 + 20 * 3600000).toISOString(),
      location: 'Student Union 218',
      attire: 'Business casual',
      signup: 'https://forms.example.com/verify-full-card',
      description: 'What a member reads before deciding to come.',
    },
    [{ category_id: CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 2 }],
  );

  mountEvents();
  await until(groupsShown, 'the full card never rendered');

  const card = cardFor('Verify Full Card');
  assert.ok(card, 'Verify Full Card is missing from the page');
  assert.equal(factValue(card, 'Location'), 'Student Union 218');
  assert.equal(factValue(card, 'Attire'), 'Business casual');
  assert.match(factValue(card, 'Points') ?? '', /GBMs.*2/);
  assert.match(card.querySelector('.event-card-description')?.textContent ?? '', /What a member reads/);

  const link = card.querySelector('a.event-card-signup');
  assert.ok(link, 'the URL sign-up did not become a link');
  assert.equal(link.getAttribute('href'), 'https://forms.example.com/verify-full-card');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.textContent.trim(), 'Sign up');
  assert.equal(factLabels(card).includes('Sign up'), false, 'a URL sign-up is also printed as text');

  const time = card.querySelector('.event-card-time')?.textContent ?? '';
  assert.match(time, /\d{1,2}:\d{2}\s*(AM|PM)\s*to\s*\d{1,2}:\d{2}\s*(AM|PM)/i);
});

await check('every null optional field omits its row, never an empty label', async () => {
  await makeVisibleEvent({
    title: 'Verify Bare Card',
    occurred_on: daysFromNow(11),
  });

  mountEvents();
  await until(groupsShown, 'the bare card never rendered');

  const card = cardFor('Verify Bare Card');
  assert.ok(card, 'Verify Bare Card is missing from the page');
  assert.equal(card.querySelector('.event-card-time'), null, 'a card with no times drew a time row');
  assert.equal(card.querySelector('.event-card-facts'), null, 'a card with no facts still drew a facts list');
  assert.equal(card.querySelector('.event-card-description'), null, 'a null description still drew a paragraph');
  assert.equal(card.querySelector('.event-card-signup'), null, 'a null sign-up still drew a button');
  assert.doesNotMatch(card.textContent, /TBD|N\/A|None|\u2014/, 'a placeholder word stood in for a missing fact');
});

await check('a from_submission category reads Varies, and never 0', async () => {
  await makeVisibleEvent(
    { title: 'Verify Varies Alone', occurred_on: daysFromNow(12) },
    [{ category_id: CATEGORY_VOLUNTEERING, credit_mode: 'from_submission', fixed_credit: 1 }],
  );

  mountEvents();
  await until(groupsShown, 'the Varies card never rendered');

  const card = cardFor('Verify Varies Alone');
  assert.ok(card, 'Verify Varies Alone is missing from the page');
  const points = factValue(card, 'Points');
  assert.match(points ?? '', /Varies/, `Points reads "${points}", not Varies`);
  assert.doesNotMatch(points ?? '', /\b0\b/, `an event with only a member-entered category showed "${points}"`);
});

await check('a mixed fixed-and-varies event names every category', async () => {
  await makeVisibleEvent(
    { title: 'Verify Mixed Points', occurred_on: daysFromNow(13) },
    [
      { category_id: CATEGORY_GBMS, credit_mode: 'fixed', fixed_credit: 3 },
      { category_id: CATEGORY_VOLUNTEERING, credit_mode: 'from_submission', fixed_credit: 1 },
    ],
  );

  mountEvents();
  await until(groupsShown, 'the mixed card never rendered');

  const card = cardFor('Verify Mixed Points');
  const points = factValue(card, 'Points') ?? '';
  assert.match(points, /GBMs/);
  assert.match(points, /3/);
  assert.match(points, /Volunteering/);
  assert.match(points, /Varies/);
});

await check('a non-URL sign-up renders as text, never as a link', async () => {
  await makeVisibleEvent({
    title: 'Verify Text Signup',
    occurred_on: daysFromNow(14),
    signup: 'Sign up at GBM',
  });

  mountEvents();
  await until(groupsShown, 'the text sign-up card never rendered');

  const card = cardFor('Verify Text Signup');
  assert.equal(card.querySelector('a.event-card-signup'), null, 'a plain sentence became a link');
  assert.equal(factValue(card, 'Sign up'), 'Sign up at GBM');
});

await check('a same-day event with no times shows the date alone, no time row', async () => {
  await makeVisibleEvent({ title: 'Verify No Time', occurred_on: daysFromNow(15) });

  mountEvents();
  await until(groupsShown, 'the timeless card never rendered');

  const card = cardFor('Verify No Time');
  assert.equal(card.querySelector('.event-card-time'), null);
});

await check('an event dated today groups under a heading that reads Today', async () => {
  await makeVisibleEvent({ title: 'Verify Today Heading', occurred_on: daysFromNow(0) });

  mountEvents();
  await until(groupsShown, 'the today card never rendered');

  const card = cardFor('Verify Today Heading');
  assert.ok(card, 'Verify Today Heading is missing from the page');
  const section = [...dom.$('event-groups').querySelectorAll('.event-date-group')].find((group) =>
    group.querySelectorAll('.event-card').includes(card),
  );
  assert.ok(section, 'the today card is not inside a date group');
  const heading = section.querySelector('.event-date-heading');
  assert.ok(heading, 'the today card has no date heading above it');
  assert.equal(heading.textContent.trim(), 'Today');
  assert.equal(heading.getAttribute('data-today'), 'true');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nfailure and empty states\n');
// ---------------------------------------------------------------------------

await check('a load failure shows a message with a working Try again', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    String(url).includes('portal_events')
      ? Promise.resolve(
          new Response(JSON.stringify({ code: 'TEMP', message: 'offline' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      : realFetch(url, init);
  try {
    mountEvents();
    await until(() => !dom.$('screen-message').hidden, 'the failure was never shown', 8000);
    assert.equal(dom.$('loading').hidden, true);
    assert.ok(dom.$('screen-message-title').textContent.length > 0);
    assert.equal(dom.$('screen-message-action').textContent, 'Try again');
  } finally {
    globalThis.fetch = realFetch;
  }
  dom.click(dom.$('screen-message-action'));
  await until(groupsShown, 'Try again did not recover');
  assert.equal(dom.$('screen-message').hidden, true);
});

await check('no events at all shows only a heading, and nothing else', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await realFetch(url, init);
    if (!String(url).includes('portal_events')) return response;
    const answer = await response.json();
    return new Response(JSON.stringify({ ...answer, events: [] }), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    mountEvents();
    await until(() => !dom.$('empty').hidden, 'the empty state never showed');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(dom.$('event-groups').hidden, true);
  const heading = dom.$('empty').querySelector('.title');
  assert.ok(heading, 'the empty state has no heading');
  assert.ok(heading.textContent.trim().length > 0);
  // Default is no explanatory prose at all (CLAUDE.md): a heading and nothing
  // else means no second line of body copy underneath it.
  assert.equal(dom.$('empty').children.length, 1, 'the empty state carries more than a heading');
});

server.close();
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exit(failures ? 1 : 0);
