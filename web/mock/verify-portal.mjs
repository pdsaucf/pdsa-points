// Checks for the member portal at /me.
//
// Same rule as the other four suites: assert what fails SILENTLY. A portal that
// draws is easy to see. What is not:
//
//   1. THAT THE REQUIREMENT LIST IS THE PUBLISHED RULE SET, DRAWN. Invariant 1
//      says a category added in September appears in September with no code
//      change, and a list hardcoded in JavaScript would look identical on this
//      fixture and be wrong the first time anybody edits a rule. So the check is
//      falsifiable: an officer renames a requirement mid-run and both the
//      explainer box and the scorecard have to follow it, and nothing under src/
//      may name a category at all.
//   2. THAT THE NUMBERS COME FROM THE SERVER. Honorary status is computed in
//      Postgres (invariant 2) and the point total sums only the categories
//      flagged as counting toward it. Both are rendered here, and the sources
//      are checked for a second implementation of either.
//   3. THAT THE PAGE IS ANONYMOUS. There is no sign-in on this screen any more.
//      A page that quietly sent a session would behave differently for an
//      officer with a laptop open than for a member on a phone, and the
//      difference would only show up in front of somebody.
//   4. THAT A MEMBER IS NEVER SHOWN A SCREEN OF ZEROES. Somebody who is not on
//      this year's roster is told so. Zeroes read as "you have attended
//      nothing", which is the one wrong answer this page can give.
//   5. THAT PROGRESS IS NOT CONVEYED BY COLOUR ALONE. A tick and a star are
//      nothing to a screen reader, so every row carries its verdict in words.
//   6. THAT THE MOCK IS NOT KINDER THAN POSTGRES. The refusal migration 21
//      makes is made here, for the reason the SQL makes it.
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
import { signInAs as signInAsAccount } from './sign-in.mjs';
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
    search: '',
    href: `http://localhost:${PORT}/me/`,
    replace() {},
    reload() {},
  },
  history: { replaceState() {} },
};

// The page and the stylesheet, as they ship.
const portalHtml = await readFile(`${WEB_ROOT}me/index.html`, 'utf8');
const portalCss = await readFile(`${WEB_ROOT}assets/css/portal.css`, 'utf8');
const checkinCss = await readFile(`${WEB_ROOT}assets/css/checkin.css`, 'utf8');
const PDF_FONTS = {
  fontBytes: await readFile(`${WEB_ROOT}assets/fonts/public-sans/PublicSans-Regular.ttf`),
  fallbackFontBytes: await readFile(`${WEB_ROOT}assets/fonts/public-sans/NotoSans-Regular.ttf`),
};

let dom = installDom(portalHtml);

const auth = await import('../src/auth.js');
const { select, patch, callRpc } = await import('../src/rest.js');
const { rpc } = await import('../src/api.js');
const { RpcError } = await import('../src/errors.js');
const { describeMember } = await import('../src/member-errors.js');
const { buildAttendancePdf, attendancePdfFilename } = await import('../src/attendance-pdf.js');
const {
  approvedRecordSummary,
  durationLabel,
  durationMinutes,
  easternTime,
  timeDetails,
} = await import('../src/portal-record.js');
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
 * An officer session, for the checks that move a rule and watch the page follow.
 *
 * The portal itself never signs in: these are the writes an officer would make
 * on the admin screens, made from here so that "the rules move and the screen
 * moves with them" is driven rather than asserted about the source.
 */
const signInAs = (email) => signInAsAccount(email, PORT);

/** A fresh copy of the shipped page, with the portal mounted on it. */
function mountPortal(search = '') {
  window.location.search = search;
  dom = installDom(portalHtml);
  start();
  return dom;
}

/** Types a name into the one form on the page and submits it. */
function lookUp(name) {
  dom.$('lookup-name').value = name;
  dom.fire(dom.$('lookup-form'), 'submit');
}

const scorecardShown = () => !dom.$('scorecard').hidden;
const checklistRows = () => dom.$('score-list').querySelectorAll('li');
const honoraryRows = () => dom.$('honorary-list').querySelectorAll('li');
const boardRows = () => dom.$('board-list').querySelectorAll('.board-row');
const live = () => dom.$('live').textContent;

const decodeUtf16Hex = (hex) => {
  let value = '';
  for (let index = 0; index < hex.length; index += 4) {
    value += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return value;
};

/** Extracts text through the generated PDF's ToUnicode maps, as a reader does. */
async function extractPdfText(blob) {
  const pdf = await blob.text();
  const maps = new Map();
  for (const [fontNumber, name] of [[1, 'PublicSans'], [2, 'NotoSans']]) {
    const start = pdf.indexOf(`/CMapName /PDSA${name}UCS`);
    const end = pdf.indexOf('endcmap', start);
    assert.ok(start >= 0 && end > start, `${name} has no ToUnicode map`);
    const cmap = new Map();
    const source = pdf.slice(start, end);
    for (const match of source.matchAll(/<([0-9A-F]{4})> <([0-9A-F]{4,8})>/g)) {
      cmap.set(match[1], decodeUtf16Hex(match[2]));
    }
    maps.set(fontNumber, cmap);
  }

  const lines = [];
  for (const textObject of pdf.matchAll(/BT ([\s\S]*?) ET/g)) {
    let fontNumber = 1;
    let line = '';
    const tokens = /\/F([12])\s+[\d.]+\s+Tf|<([0-9A-F]+)>\s+Tj/g;
    for (const token of textObject[1].matchAll(tokens)) {
      if (token[1]) {
        fontNumber = Number(token[1]);
        continue;
      }
      for (let index = 0; index < token[2].length; index += 4) {
        line += maps.get(fontNumber).get(token[2].slice(index, index + 4)) ?? '';
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const server = await startMock(PORT);
await api('/__mock/reset');

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const sources = {
  'src/portal.js': await readFile(`${WEB_ROOT}src/portal.js`, 'utf8'),
  'src/portal-scorecard.js': await readFile(`${WEB_ROOT}src/portal-scorecard.js`, 'utf8'),
  'src/portal-leaderboard.js': await readFile(`${WEB_ROOT}src/portal-leaderboard.js`, 'utf8'),
  'src/portal-history.js': await readFile(`${WEB_ROOT}src/portal-history.js`, 'utf8'),
  'src/portal-record.js': await readFile(`${WEB_ROOT}src/portal-record.js`, 'utf8'),
  'src/attendance-pdf.js': await readFile(`${WEB_ROOT}src/attendance-pdf.js`, 'utf8'),
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
  const pdfSource = sources['src/attendance-pdf.js'];
  assert.doesNotMatch(pdfSource, /https?:\/\//, 'the PDF generator fetches an external asset');
  assert.match(pdfSource, /\.\.\/assets\/fonts\/public-sans\/PublicSans-Regular\.ttf/);
  assert.match(pdfSource, /\.\.\/assets\/fonts\/public-sans\/NotoSans-Regular\.ttf/);
  for (const [label, bytes] of Object.entries(PDF_FONTS)) {
    assert.equal(bytes.subarray(0, 4).toString('hex'), '00010000', `${label} is not a TrueType font`);
  }
});

await check('Public Sans is self hosted with font-display: swap and a real fallback', () => {
  assert.match(portalCss, /@font-face\s*{[^}]*font-family:\s*'Public Sans'/);
  assert.match(portalCss, /font-display:\s*swap/);
  assert.match(portalCss, /url\('\.\.\/fonts\/public-sans\/PublicSans-VariableFont\.woff2'\)/);
  assert.match(portalCss, /--font:\s*'Public Sans',\s*ui-sans-serif,\s*system-ui,\s*sans-serif/);
});

await check('footer links are icon-only and carry exact accessible names', () => {
  const expected = [
    ['TikTok', 'https://www.tiktok.com/@ucf_pdsa', 'tiktok'],
    ['Instagram', 'https://www.instagram.com/ucf_pdsa/', 'instagram'],
    ['Main Website', 'https://pdsaucf.com', 'globe'],
    ['Contact', 'mailto:pdsa.ucf@gmail.com', 'mail'],
  ];
  const links = dom.document.querySelectorAll('.footer-link');
  assert.equal(links.length, expected.length);

  for (const [index, [label, href, iconName]] of expected.entries()) {
    const link = links[index];
    assert.equal(link.getAttribute('aria-label'), label);
    assert.equal(link.getAttribute('title'), label);
    assert.equal(link.getAttribute('href'), href);
    assert.equal(link.getAttribute('data-icon'), iconName);
    assert.equal(link.textContent.trim(), '', `${label} still has visible link text`);

    const svg = link.querySelector('.footer-icon');
    assert.ok(svg, `${label} has no icon in the shipped markup`);
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(svg.getAttribute('focusable'), 'false');
    assert.equal(svg.getAttribute('width'), '24');
    assert.equal(svg.getAttribute('height'), '24');
  }
});

await check('the footer uses the content container and can wrap without overflow', () => {
  const appLayout = declarations(rule(portalCss, '.app'));
  const footer = declarations(rule(portalCss, '.site-footer'));
  const inner = declarations(rule(portalCss, '.footer-inner'));
  const links = declarations(rule(portalCss, '.footer-links'));
  const link = declarations(rule(portalCss, '.footer-link'));
  const icon = declarations(rule(portalCss, '.footer-icon'));
  const meta = declarations(rule(portalCss, '.footer-meta'));

  assert.equal(footer.get('width'), '100%');
  assert.equal(inner.get('width'), '100%');
  assert.equal(inner.get('max-width'), appLayout.get('max-width'));
  assert.equal(inner.get('margin'), '0 auto');
  assert.match(inner.get('padding') ?? '', /env\(safe-area-inset-bottom\)/);
  assert.equal(links.get('display'), 'flex');
  assert.equal(links.get('flex-wrap'), 'wrap');
  assert.equal(links.get('justify-content'), 'center');
  assert.ok(Number.parseFloat(link.get('min-width')) * 16 >= 44);
  assert.ok(Number.parseFloat(link.get('min-height')) * 16 >= 44);
  assert.equal(icon.get('width'), '1.5rem');
  assert.equal(icon.get('height'), '1.5rem');
  assert.equal(meta.get('text-align'), 'center');
  assert.equal(meta.get('overflow-wrap'), 'anywhere');

  const desktop = portalCss.slice(portalCss.lastIndexOf('@media (min-width: 40rem)'));
  const desktopInner = declarations(rule(portalCss, '.footer-inner', { scope: desktop }));
  const desktopLinks = declarations(rule(portalCss, '.footer-links', { scope: desktop }));
  const desktopMeta = declarations(rule(portalCss, '.footer-meta', { scope: desktop }));
  assert.equal(desktopInner.get('max-width'), '36rem');
  assert.equal(desktopLinks.get('justify-content'), 'flex-start');
  assert.equal(desktopMeta.get('text-align'), 'left');
});

await check('footer links have distinct hover, keyboard focus and active states', () => {
  for (const selector of ['.footer-link:hover', '.footer-link:focus-visible', '.footer-link:active']) {
    const state = declarations(rule(portalCss, selector));
    assert.ok(state.has('color'), `${selector} does not change the icon color`);
    assert.ok(state.has('background'), `${selector} does not change the target background`);
  }
  const active = declarations(rule(portalCss, '.footer-link:active'));
  assert.equal(active.get('color'), 'var(--accent-ink)');
  assert.equal(active.get('background'), 'var(--accent)');
});

await check('every column of digits on this screen is tabular', () => {
  // A member reads three columns of figures here: their own requirement list,
  // what the requirements ask for, and the leaderboard. A proportional 1 among
  // 9s is the difference between scanning and reading.
  assert.match(portalCss, /body\s*{[^}]*font-variant-numeric:\s*tabular-nums/);
  for (const selector of [
    '.check-figures',
    '.figures',
    '.points',
    '.honorary-need',
    '.board-rank',
    '.board-points',
    '.board-figure-value',
  ]) {
    const block = new RegExp(`\\${selector}\\s*\\{[^}]*font-variant-numeric:\\s*tabular-nums`);
    assert.match(portalCss, block, `${selector} does not line its digits up`);
  }
});

/**
 * The source with its comments taken out.
 *
 * Used by the checks below, and it is the honest cut for each of them: a comment
 * explaining why Volunteering hours are excluded from the point total is
 * documentation, and a category name in a string literal is a rule somebody
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
  // Comments are not copy, and neither is a link target: nobody reads an
  // href or src off the screen.
  [
    'me/index.html',
    portalHtml.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s(?:href|src)="[^"]*"/g, ' '),
  ],
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
  assert.match(sources['src/portal-scorecard.js'], /rpc\('portal_scorecard'|rpc\(\s*'portal_/);
});

await check('the portal writes nothing at all, and asks for nothing signed in', () => {
  // Every answer this page draws comes from one of the five public functions,
  // through api.js, which sends the anon key and never a session. A page that
  // imported rest.js would behave differently for an officer with a laptop open,
  // and that difference would only ever show up in front of somebody.
  for (const [label, source] of Object.entries(sources)) {
    const code = withoutComments(source);
    for (const verb of ['select', 'insert', 'patch', 'remove']) {
      assert.doesNotMatch(
        code,
        new RegExp(`(?<![.\\w])${verb}\\s*\\(`),
        `${label} calls the table ${verb} path instead of a public RPC`,
      );
    }
    assert.doesNotMatch(code, /from '\.\/rest\.js'/, `${label} imports the signed-in request path`);
    assert.doesNotMatch(code, /from '\.\/auth\.js'/, `${label} imports the session`);
  }
});

await check('there is no sign-in, and nothing asks a member for an address', () => {
  const markup = portalHtml.replace(/<!--[\s\S]*?-->/g, ' ');
  assert.doesNotMatch(markup, /type="email"/i, 'the portal still has an email field');
  assert.doesNotMatch(markup, /autocomplete="email"/i, 'the portal still asks for an address');
  assert.doesNotMatch(markup, /sign\s*in/i, 'the portal still offers a sign-in');
  assert.doesNotMatch(markup, /sign\s*out/i, 'the portal still offers a sign-out');
  for (const [label, source] of Object.entries(sources)) {
    assert.doesNotMatch(
      withoutComments(source),
      /signInWithPasscode|adoptSession|currentSession/,
      `${label} still handles a session`,
    );
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
process.stdout.write('\nwhat the page says before anybody types anything\n');
// ---------------------------------------------------------------------------

await check('the initial lookup has one complete-name field', () => {
  mountPortal();
  assert.equal(dom.$('lookup-form').hidden, false);
  assert.equal(dom.$('lookup-name').getAttribute('autocomplete'), 'name');
  assert.equal(dom.$('lookup-name').getAttribute('enterkeyhint'), 'go');
  assert.equal(dom.$('lookup-name').getAttribute('autocapitalize'), 'words');
  assert.equal(dom.$('lookup-name').getAttribute('autocorrect'), 'off');
  assert.equal(dom.$('lookup-name').getAttribute('spellcheck'), 'false');
  assert.equal(dom.$('lookup-first'), null);
  assert.equal(dom.$('lookup-last'), null);
  assert.equal(dom.$('lookup-submit-label').textContent, 'Show my points');
  assert.equal(dom.$('no-match').hidden, true);
  assert.equal(dom.$('scorecard').hidden, true);
  assert.equal(dom.$('honorary').hidden, false, 'the initial Honorary Q&A was hidden');
  assert.equal(dom.$('honorary-intro').hidden, false, 'the initial Honorary intro was hidden');
  assert.equal(dom.$('honorary-about').hidden, false, 'the initial About Q&A was hidden');
});

await check('ordinary /me/ leaves the form open without a name request', async () => {
  await api('/__mock/reset');
  const before = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  ).length;

  mountPortal();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  ).length;
  assert.equal(dom.$('lookup-form').hidden, false);
  assert.equal(dom.$('lookup-name').value, '');
  assert.equal(after, before, 'ordinary /me/ sent an automatic name request');

  mountPortal('?name=%20%20');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterBlank = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  ).length;
  assert.equal(dom.$('lookup-form').hidden, false);
  assert.equal(afterBlank, after, 'a blank query name sent an automatic request');
});

await check('a query name prefills and automatically opens its unique member', async () => {
  await signInAs('officers@pdsaucf.com');
  await patch(
    'members',
    { id: `eq.${IDS.MEMBER_ABBY}` },
    { first_name: 'Benjamin', last_name: 'Le' },
  );

  mountPortal('?name=Benjamin%20Le');
  assert.equal(dom.$('lookup-name').value, 'Benjamin Le');
  await until(scorecardShown, 'the query name did not open its unique member');
  assert.equal(dom.$('lookup-form').hidden, true);

  await api('/__mock/reset');
});

await check('editing a name discards a delayed automatic lookup', async () => {
  await signInAs('officers@pdsaucf.com');
  await patch(
    'members',
    { id: `eq.${IDS.MEMBER_ABBY}` },
    { first_name: 'Benjamin', last_name: 'Le' },
  );

  const realFetch = globalThis.fetch;
  let releaseLookup = null;
  let markLookupStarted;
  const lookupStarted = new Promise((resolve) => {
    markLookupStarted = resolve;
  });
  globalThis.fetch = (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (String(url).includes('/rpc/portal_find_members') && body.p_name === 'Benjamin Le') {
      return new Promise((resolve) => {
        let released = false;
        releaseLookup = () => {
          if (released) return;
          released = true;
          resolve(realFetch(url, init));
        };
        markLookupStarted();
      });
    }
    return realFetch(url, init);
  };

  try {
    mountPortal('?name=Benjamin%20Le');
    await lookupStarted;
    dom.$('lookup-name').value = 'Abigail Catto';
    dom.fire(dom.$('lookup-name'), 'input');
    releaseLookup();
    await until(() => !dom.$('lookup-submit').disabled, 'the stale lookup never settled');

    assert.equal(dom.$('scorecard').hidden, true, 'the stale member scorecard opened');
    const staleCards = (await api('/__mock/audit')).admin.calls.filter(
      (call) => call.fn === 'portal_scorecard',
    );
    assert.equal(staleCards.length, 0, 'the stale lookup requested a scorecard');

    dom.fire(dom.$('lookup-form'), 'submit');
    await until(scorecardShown, 'the edited name did not resolve manually');
    assert.equal(dom.$('score-name-text').textContent.trim(), 'Abigail Catto');
  } finally {
    releaseLookup?.();
    globalThis.fetch = realFetch;
    await api('/__mock/reset');
  }
});

await check('a multiword name is sent intact and resolves', async () => {
  await signInAs('officers@pdsaucf.com');
  await patch(
    'members',
    { id: `eq.${IDS.MEMBER_ABBY}` },
    { first_name: 'María', last_name: "de la O'Neil-Smith" },
  );

  const complete = "María   de la O'Neil-Smith";
  mountPortal();
  lookUp(`  ${complete}  `);
  await until(scorecardShown, 'the multiword name did not resolve');

  const calls = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  );
  assert.equal(calls.at(-1)?.name, complete);

  await api('/__mock/reset');
});

await check('the requirements box is the published rules, not copy in a file', async () => {
  mountPortal();
  await until(() => honoraryRows().length > 0, 'the requirements box never filled in');

  const published = await rpc('portal_requirements', {});
  const measured = published.nodes.filter((node) => node.type === 'threshold');
  assert.ok(measured.length > 0, 'the fixture publishes no measured requirement');

  const text = dom.$('honorary-list').textContent;
  for (const node of measured) {
    assert.ok(text.includes(node.label), `the box does not name the requirement "${node.label}"`);
  }
});

await check('the blurb is on the page, and it is the words the club asked for', () => {
  const body = dom.$('honorary').textContent.replace(/\s+/g, ' ');
  assert.match(body, /What is an Honorary Member\?/);
  assert.match(
    body,
    /Honorary Members are those who go above and beyond as active and engaged members of PDSA\./,
  );
});

await check('the number a requirement asks for is beside it, with no noun on it', async () => {
  // This check used to require the word: "25 hours" for an hours category and
  // "9 events" for an event count, from the unit column. Migration 22 dropped
  // that column, because all three of its values were one behaviour, so the
  // number stands on its own and the requirement's own name says what is being
  // counted. A noun here would be the client inventing one.
  const published = await rpc('portal_requirements', {});
  const measured = published.nodes.filter((node) => node.type === 'threshold');
  assert.ok(measured.length > 0, 'the fixture publishes no measured requirement');

  for (const node of measured) {
    const row = [...honoraryRows()].find((li) => li.textContent.includes(node.label));
    assert.ok(row, `${node.label} is not in the box`);
    const need = row.querySelector('.honorary-need');
    assert.ok(need, `${node.label} does not say what it asks for`);
    assert.match(
      need.textContent.trim(),
      /^\d+(\.\d+)?$/,
      `${node.label} asks for "${need.textContent.trim()}", which is not just a number`,
    );
  }

  const box = dom.$('honorary').textContent;
  for (const noun of ['events', 'hours']) {
    assert.doesNotMatch(box, new RegExp(`\\d\\s*${noun}\\b`, 'i'), `the box still counts in ${noun}`);
  }
});

await check('a requirement measuring two categories names both', async () => {
  const published = await rpc('portal_requirements', {});
  const compound = published.nodes.find((node) => (node.categories ?? []).length > 1);
  assert.ok(compound, 'the fixture has no multi-category requirement, so this proves little');

  const row = [...honoraryRows()].find((node) => node.textContent.includes(compound.label));
  assert.ok(row, `${compound.label} is not in the box`);
  for (const category of compound.categories) {
    assert.ok(
      row.textContent.includes(category.name),
      `${compound.label} does not say it counts ${category.name}`,
    );
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\ntyping your name\n');
// ---------------------------------------------------------------------------

await check('a name on the roster draws that members own figures', async () => {
  mountPortal();
  lookUp('Abigail Catto');
  await until(scorecardShown, 'the scorecard never drew');

  const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  assert.equal(dom.$('score-name-text').textContent.trim(), card.member.display_name);
  assert.match(dom.$('score-points').textContent, new RegExp(`\\b${Number(card.point_total)}\\b`));
  assert.equal(dom.$('score-state').textContent, card.is_honorary ? 'Earned' : 'Not yet');
  assert.equal(
    dom.$('score-state').parentNode.querySelector('dt').textContent.replace('★', '').trim(),
    'Honorary Status',
  );
  assert.ok(checklistRows().length > 0, 'the requirement list is empty');
});

await check('Honorary status and name stars follow only the servers verdict', async () => {
  mountPortal();
  lookUp('Abigail Catto');
  await until(scorecardShown, 'the non-honorary scorecard never drew');
  const notYet = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  assert.equal(notYet.is_honorary, false, 'the non-honorary fixture changed');
  assert.equal(dom.$('score-state').textContent, 'Not yet');
  assert.equal(dom.$('score-name-star').hidden, true, 'a non-honorary name has a star');
  assert.equal(dom.$('score-label-star').hidden, false, 'the status label lost its star');
  assert.ok(dom.$('score-label-star').classList.contains('board-star'));

  mountPortal();
  lookUp('Daniel Nguyen');
  await until(scorecardShown, 'the honorary scorecard never drew');
  const earned = await rpc('portal_scorecard', { p_member_id: IDS.STORAGE.MEMBER_DANIEL });
  assert.equal(earned.is_honorary, true, 'the honorary fixture changed');
  assert.equal(dom.$('score-state').textContent, 'Earned');
  assert.equal(dom.$('score-name-star').hidden, false, 'the honorary name has no star');
  assert.ok(dom.$('score-name-star').classList.contains('board-star'));
  assert.equal(dom.$('score-name-star').getAttribute('aria-hidden'), 'true');
  assert.equal(dom.$('score-label-star').hidden, false, 'the earned status label lost its star');
  assert.equal(dom.$('score-label-star').getAttribute('aria-hidden'), 'true');
  assert.match(dom.$('score-state').textContent, /^(Earned|Not yet)$/);
});

await check('Not you? is a bordered secondary action with its existing X icon', () => {
  const button = dom.$('score-change');
  assert.ok(button.classList.contains('button-secondary'));
  assert.ok(!button.classList.contains('button-quiet'));
  assert.ok(button.querySelector('.button-label-icon'), 'Not you? lost its X icon');
  const base = declarations(rule(portalCss, '.button'));
  assert.match(base.get('border') ?? '', /1px\s+solid\s+var\(--line-strong\)/);
  assert.equal(base.get('min-height'), 'var(--tap)');
});

await check('the form is put away, and Not you? brings it back with the name still in it', async () => {
  mountPortal();
  lookUp('Abigail Catto');
  await until(scorecardShown, 'the scorecard never drew');
  assert.equal(dom.$('lookup-form').hidden, true, 'the form is still on screen under the scorecard');
  dom.click(dom.$('score-change'));
  assert.equal(dom.$('lookup-form').hidden, false, 'Not you? did not bring the form back');
  assert.equal(dom.$('scorecard').hidden, true, 'the scorecard stayed on screen');
  assert.equal(
    dom.$('lookup-name').value,
    'Abigail Catto',
    'the name was cleared, so a typo means typing it all again',
  );
});

await check('the checklist is what the server said, line for line', async () => {
  mountPortal();
  lookUp('Abigail Catto');
  await until(scorecardShown, 'the scorecard never drew');

  const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  // The root is the whole rule and its figures are in the line above the list.
  const expected = card.requirements.filter((row) => row.type !== 'group');
  assert.equal(
    checklistRows().length,
    expected.length,
    'the list has a different number of requirements than the server sent',
  );
  for (const row of expected) {
    const node = [...checklistRows()].find((li) => li.textContent.includes(row.label));
    assert.ok(node, `the list does not carry "${row.label}"`);
    assert.equal(
      node.dataset.met,
      String(row.passed),
      `${row.label} is drawn as ${node.dataset.met} and the server said ${row.passed}`,
    );
  }
});

await check('the summary counts all measured requirements, not an N-of-M root value', async () => {
  await signInAs('officers@pdsaucf.com');
  const draft = await callRpc('clone_requirement_set', { p_set_id: IDS.SET_CURRENT });
  const [draftRoot] = await select('requirement_nodes', {
    select: 'id',
    filters: { requirement_set_id: `eq.${draft}`, parent_id: 'is.null' },
  });
  assert.ok(draftRoot, 'the cloned set has no root');
  const changed = await patch(
    'requirement_nodes',
    { id: `eq.${draftRoot.id}` },
    { min_children_passing: 2 },
  );
  assert.equal(changed.length, 1, 'the N-of-M root edit was refused');
  await callRpc('publish_requirement_set', { p_set_id: draft });
  try {
    mountPortal();
    lookUp('Abigail Catto');
    await until(
      () => !dom.$('history').hidden && dom.$('history-loading').hidden,
      'the atomic scorecard never drew',
    );
    const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
    const root = card.requirements.find((row) => row.node_id === card.root_node_id);
    const measured = card.requirements.filter((row) => row.type !== 'group');
    const met = measured.filter((row) => row.passed).length;
    assert.equal(root.target, 2, 'the fixture root is not N-of-M for this check');
    assert.ok(measured.some((row) => row.parent_id !== card.root_node_id), 'the seeded nested requirement vanished');
    assert.equal(dom.$('score-figures').textContent, `${met} of ${measured.length}`);
    assert.notEqual(dom.$('score-figures').textContent, `${root.value} of ${root.target}`);
    assert.equal(checklistRows().length, measured.length);
    for (const requirement of measured) {
      const row = [...checklistRows()].find((node) => node.textContent.includes(requirement.label));
      assert.ok(row, `${requirement.label} is missing`);
      assert.ok(row.textContent.includes(`${requirement.value} of ${requirement.target}`));
      assert.equal(row.dataset.met, String(requirement.passed));
    }
    assert.equal(dom.$('score-state').textContent, card.is_honorary ? 'Earned' : 'Not yet');
  } finally {
    await api('/__mock/reset');
  }
});

await check('progress is never conveyed by colour alone', () => {
  for (const node of checklistRows()) {
    const mark = node.querySelector('.check-mark');
    assert.ok(mark, 'a requirement row has no mark at all');
    assert.equal(mark.getAttribute('aria-hidden'), 'true', 'the glyph is read out as well');
    const words = node.querySelector('.visually-hidden');
    assert.ok(words, 'a requirement row carries its verdict in colour and nothing else');
    assert.match(words.textContent, /^(Met|Not met)$/);
  }
});

await check('a name nobody on the roster has shows the compact result and retains the name', async () => {
  mountPortal();
  lookUp('Nobody Whatsoever');
  await until(() => !dom.$('no-match').hidden, 'nothing was said about a name that is not there');

  assert.equal(dom.$('scorecard').hidden, true, 'a scorecard was drawn for nobody');
  assert.equal(dom.$('no-match-title').textContent, 'Name not found');
  assert.match(dom.$('no-match').textContent, /Check the spelling\. Only paid members are listed\./);
  assert.match(dom.$('no-match').textContent, /pdsa\.ucf@gmail\.com/);
  assert.equal(dom.$('no-match-contact').getAttribute('href'), 'mailto:pdsa.ucf@gmail.com');
  assert.equal(dom.$('lookup-name').value, 'Nobody Whatsoever');
  assert.equal(dom.$('screen-message').hidden, true, 'a name that is not on the roster read as a failure');

  dom.click(dom.$('no-match-board'));
  assert.equal(dom.$('tab-board').getAttribute('aria-selected'), 'true');
  assert.equal(dom.$('view-board').hidden, false);
});

await check('an empty name is refused before anything is sent', async () => {
  mountPortal();
  const before = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  ).length;

  lookUp('   ');
  assert.equal(dom.$('lookup-error').hidden, false, 'nothing was said');
  assert.match(dom.$('lookup-error').textContent, /full name/i);

  const after = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  ).length;
  assert.equal(after, before, 'an empty name was sent to the server anyway');
});

await check('two members with one name are told apart, not guessed between', async () => {
  // Two roster rows, one name, which is exactly what the club has when somebody
  // is added twice or when two people genuinely share a name. With no address on
  // file the join month is all there is, so it has to be on the button.
  await signInAs('officers@pdsaucf.com');
  const twin = await callRpc('upsert_member_and_enroll', {
    p_first_name: 'Catherine',
    p_last_name: 'Diaz',
    p_email: null,
    p_ucf_nid: null,
    p_academic_year_id: IDS.YEAR_CURRENT,
    p_matched_member_id: null,
  });
  assert.ok(twin?.member_id, 'the fixture twin was not created');
  // The name tier found the existing Catherine Diaz, which is the roster screen's
  // own rule, so a second row has to be made deliberately.
  const made = await callRpc('upsert_member_and_enroll', {
    p_first_name: 'Catherine',
    p_last_name: 'Diaz',
    p_email: null,
    p_ucf_nid: null,
    p_academic_year_id: IDS.YEAR_CURRENT,
    p_matched_member_id: null,
  });
  assert.equal(made.member_id, twin.member_id, 'the same name made two rows by itself');

  const second = '77777777-0000-4000-a000-000000000001';
  await fetch(`http://localhost:${PORT}/__mock/twin`, { method: 'POST' }).catch(() => {});
  await patch('members', { id: `eq.${IDS.MEMBER_ABBY}` }, { first_name: 'Catherine', last_name: 'Diaz' });

  mountPortal();
  lookUp('Catherine Diaz');
  await until(() => !dom.$('pick-block').hidden, 'the portal never asked which one');

  const buttons = dom.$('pick-list').querySelectorAll('button');
  assert.equal(buttons.length, 2, 'the portal picked one of two people with the same name');
  for (const button of buttons) {
    assert.match(button.textContent, /joined/i, 'nothing on the button tells the two apart');
  }
  assert.match(live(), /pick/i, 'the choice was not announced');

  dom.click(buttons[0]);
  await until(scorecardShown, 'picking one drew nothing');
  assert.equal(dom.$('pick-block').hidden, true, 'the picker stayed open behind the scorecard');

  // Put the roster back, so the checks after this one see the fixture they expect.
  await patch('members', { id: `eq.${IDS.MEMBER_ABBY}` }, { first_name: 'Abby', last_name: 'Catto' });
  await api('/__mock/reset');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nyour own event history\n');
// ---------------------------------------------------------------------------

const historyShown = () => !dom.$('history').hidden && dom.$('history-loading').hidden;
const historyRows = () => dom.$('history-table-body').querySelectorAll('tr');
const rowFor = (title) => [...historyRows()].find((row) => row.querySelector('th').textContent === title) ?? null;

await check('the same Honorary Q&A follows each successful attendance record', async () => {
  mountPortal();
  await until(() => honoraryRows().length > 0, 'the initial Honorary Q&A never filled in');
  const honorary = dom.$('honorary');
  const about = dom.$('honorary-about');
  const initialCopy = about.textContent.replace(/\s+/g, ' ').trim();
  assert.equal(honorary.hidden, false, 'the initial Q&A is not visible');
  assert.equal(dom.$('honorary-intro').hidden, false, 'the initial intro is not visible');
  assert.ok(honoraryRows().length > 0, 'the initial published Requirements are missing');

  lookUp('Abigail Catto');
  await until(historyShown, 'the attendance record never drew');

  assert.equal(dom.$('honorary'), honorary, 'the results use a second Q&A node');
  assert.equal(honorary.hidden, false, 'the results Q&A is hidden');
  assert.equal(dom.$('honorary-intro').hidden, true, 'results repeat the general requirements');
  assert.equal(about.hidden, false, 'the About Q&A is hidden in results');
  assert.equal(
    about.textContent.replace(/\s+/g, ' ').trim(),
    initialCopy,
    'the initial and results Q&A copies drifted',
  );
  const siblings = dom.$('view-points').children;
  assert.ok(
    siblings.indexOf(dom.$('history')) < siblings.indexOf(honorary),
    'the Q&A does not follow the attendance record',
  );
  assert.equal(
    (portalHtml.match(/Why become an Honorary Member\?/g) ?? []).length,
    1,
    'the Q&A prose is duplicated in the page',
  );
});

await check('the history draws approved events once with grouped category credit', async () => {
  mountPortal();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    String(url).includes('portal_attendance')
      ? new Promise((resolve) => setTimeout(() => resolve(realFetch(url, init)), 100))
      : realFetch(url, init);
  try {
    lookUp('Abigail Catto');
    await until(scorecardShown, 'the scorecard never drew');
    assert.equal(dom.$('score-download').disabled, true, 'download enabled before history loaded');
    await until(historyShown, 'the event history never drew');
    assert.equal(dom.$('score-download').disabled, false, 'download stayed disabled after history loaded');
  } finally {
    globalThis.fetch = realFetch;
  }

  const answer = await rpc('portal_attendance', { p_member_id: IDS.MEMBER_ABIGAIL });
  assert.ok(Array.isArray(answer.events));
  assert.equal(new Set(answer.events.map((event) => event.id)).size, answer.events.length);
  assert.ok(!answer.events.some((event) => event.title === 'Draft Workshop'));
  const multi = answer.events.find((event) => event.title === 'Health Fair');
  assert.ok(multi.categories.length > 1, 'the fixture has no grouped multi-category event');
  assert.equal(answer.events.filter((event) => event.id === multi.id).length, 1);

  const approved = answer.events.filter((event) => event.status === 'attended');
  assert.equal(historyRows().length, approved.length, 'approved is not the default view');
  for (const event of approved) {
    const row = rowFor(event.title);
    assert.ok(row, `${event.title} is missing`);
    for (const category of event.categories) {
      assert.ok(row.textContent.includes(category.name), `${event.title} lost ${category.name}`);
    }
    assert.match(row.textContent, /Approved/);
  }
});

await check('the final screen and PDF use the attendance RPCs atomic scorecard snapshot', async () => {
  await signInAs('officers@pdsaucf.com');
  const [record] = await select('attendance_records', {
    select: 'id,event_id,status',
    filters: { member_id: `eq.${IDS.MEMBER_ABIGAIL}`, status: 'eq.approved' },
  });
  assert.ok(record, 'the fixture needs an approved record to change between requests');

  const realFetch = globalThis.fetch;
  let releaseAttendance;
  const heldAttendance = new Promise((resolve) => {
    releaseAttendance = resolve;
  });
  globalThis.fetch = (url, init) =>
    String(url).includes('portal_attendance')
      ? heldAttendance.then(() => realFetch(url, init))
      : realFetch(url, init);

  let savedBlob = null;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    savedBlob = blob;
    return 'blob:atomic-snapshot-test';
  };
  URL.revokeObjectURL = () => {};

  try {
    mountPortal();
    lookUp('Abigail Catto');
    await until(scorecardShown, 'the fast scorecard never drew');
    const initialPoints = dom.$('score-points').textContent;
    await callRpc('review_records', {
      p_ids: [record.id],
      p_decision: 'reject',
      p_note: 'snapshot consistency test',
    });
    releaseAttendance();
    await until(historyShown, 'the atomic attendance response never drew');

    const atomic = await rpc('portal_attendance', { p_member_id: IDS.MEMBER_ABIGAIL });
    assert.notEqual(String(atomic.scorecard.point_total), initialPoints);
    assert.equal(dom.$('score-points').textContent, String(atomic.scorecard.point_total));
    assert.equal(dom.$('score-year').textContent, atomic.scorecard.year.label);
    assert.equal(atomic.year.id, atomic.scorecard.year.id);
    assert.equal(atomic.member.id, atomic.scorecard.member.id);
    assert.equal(dom.$('score-download').disabled, false);

    dom.click(dom.$('score-download'));
    await until(() => savedBlob !== null, 'the atomic PDF was not generated');
    const extracted = await extractPdfText(savedBlob);
    assert.ok(extracted.includes(`Total points: ${atomic.scorecard.point_total}`));
    const changedEvent = atomic.events.find((event) => event.id === record.event_id);
    assert.equal(changedEvent.status, 'declined');
    assert.ok(!extracted.includes(changedEvent.title), 'the PDF mixed the old approval into the new total');
  } finally {
    releaseAttendance?.();
    globalThis.fetch = realFetch;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    await callRpc('review_records', {
      p_ids: [record.id],
      p_decision: 'approve',
      p_note: null,
    });
  }
});

await check('actual Eastern times, duration and missing times are rendered without the check-in window', async () => {
  mountPortal();
  lookUp('Abigail Catto');
  await until(historyShown, 'attendance did not reload for the time check');
  const answer = await rpc('portal_attendance', { p_member_id: IDS.MEMBER_ABIGAIL });
  const timed = answer.events.find((event) => event.status === 'attended' && event.starts_at);
  const missing = answer.events.find((event) => event.status === 'attended' && !event.starts_at);
  assert.ok(timed && missing, 'the fixture needs timed and untimed approved events');
  assert.equal(durationMinutes(timed), (new Date(timed.ends_at) - new Date(timed.starts_at)) / 60000);
  assert.ok(rowFor(timed.title).textContent.includes(easternTime(timed.starts_at)));
  assert.ok(rowFor(timed.title).textContent.includes(timeDetails(timed).duration));
  assert.ok(rowFor(missing.title).textContent.includes('Time not recorded'));
  assert.ok(!('checkin_closes_at' in missing), 'the public response exposed the check-in window');
});

await check('waiting and declined records stay separate from approved attendance', async () => {
  mountPortal();
  lookUp('Aaron Ozan');
  await until(historyShown, 'Aarons history never drew');
  const waiting = [...dom.$('history-filters').querySelectorAll('button')].find((button) => button.textContent.startsWith('Waiting'));
  dom.click(waiting);
  const row = rowFor('Spring GBM 5');
  assert.ok(row, 'the waiting record is unavailable');
  assert.equal(row.dataset.status, 'waiting');
  assert.match(row.textContent, /Waiting/);
});

await check('attendance failure leaves the scorecard visible with retry and download disabled', async () => {
  mountPortal();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    String(url).includes('portal_attendance')
      ? Promise.resolve(new Response(JSON.stringify({ code: 'TEMP', message: 'offline' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }))
      : realFetch(url, init);
  try {
    lookUp('Abigail Catto');
    await until(scorecardShown, 'the scorecard never drew');
    await until(() => !dom.$('history-error').hidden, 'attendance failure was not shown', 8000);
    assert.equal(dom.$('scorecard').hidden, false, 'attendance failure hid the scorecard');
    assert.equal(dom.$('score-download').disabled, true, 'download enabled without attendance');
    assert.equal(dom.$('history-retry').textContent, 'Try again');
  } finally {
    globalThis.fetch = realFetch;
  }
  dom.click(dom.$('history-retry'));
  await until(historyShown, 'attendance retry did not recover');
  assert.equal(dom.$('score-download').disabled, false, 'download stayed disabled after retry');
});

await check('a mismatched attendance snapshot never enables the download', async () => {
  mountPortal();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await realFetch(url, init);
    if (!String(url).includes('portal_attendance')) return response;
    const answer = await response.json();
    answer.scorecard.year.id = IDS.YEAR_PAST;
    return new Response(JSON.stringify(answer), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    lookUp('Abigail Catto');
    await until(() => !dom.$('history-error').hidden, 'the mismatched snapshot was accepted');
    assert.equal(dom.$('scorecard').hidden, false);
    assert.equal(dom.$('score-download').disabled, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('the history carries no private record context or location', async () => {
  const answer = await rpc('portal_attendance', { p_member_id: IDS.MEMBER_AARON });
  const text = JSON.stringify(answer);
  for (const forbidden of [
    'review_note', 'reviewed_by', 'reviewed_at', 'submitted_at', 'flags',
    'claimed_name', 'claimed_email', 'object_path', 'member_note', 'location',
  ]) assert.ok(!text.includes(forbidden), `portal_attendance carries ${forbidden}`);
  assert.equal(Object.keys(answer.member).sort().join(','), 'display_name,id');
});

await check('the PDF is a real local Blob with approved rows, totals and a safe filename', async () => {
  const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  const attendance = await rpc('portal_attendance', { p_member_id: IDS.MEMBER_ABIGAIL });
  const blob = buildAttendancePdf({
    card,
    attendance,
    ...PDF_FONTS,
    generatedAt: new Date('2026-08-22T12:00:00Z'),
  });
  assert.equal(blob.type, 'application/pdf');
  assert.ok(blob.size > 500);
  const text = await blob.text();
  const extracted = await extractPdfText(blob);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(extracted.includes(card.member.display_name));
  assert.ok(extracted.includes(card.year.label));
  assert.ok(extracted.includes('Requirement progress'));
  assert.ok(extracted.includes('Recorded duration'));
  assert.ok(extracted.includes('Approved events without recorded duration'));
  const summary = approvedRecordSummary(attendance.events);
  assert.ok(extracted.includes(`Approved events: ${summary.approved.length}`));
  assert.ok(extracted.includes(`Recorded duration: ${durationLabel(summary.recordedMinutes)}`));
  assert.ok(extracted.includes(`Approved events without recorded duration: ${summary.missingTimes}`));
  for (const event of summary.approved) {
    assert.equal(extracted.split(event.title).length - 1, 1, `${event.title} is duplicated in the PDF`);
  }
  for (const event of attendance.events.filter((row) => row.status !== 'attended')) {
    assert.ok(!extracted.includes(event.title), `${event.title} was counted as approved in the PDF`);
  }
  assert.ok(!extracted.toLowerCase().includes('location'));
  assert.equal(attendancePdfFilename(card), 'pdsa-attendance-abigail-catto-2026-2027.pdf');
});

await check('PDF text extraction preserves accented and non-Latin member, event and category text', async () => {
  const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  const attendance = await rpc('portal_attendance', { p_member_id: IDS.MEMBER_ABIGAIL });
  const approved = attendance.events.find((event) => event.status === 'attended');
  const unicodeCard = {
    ...card,
    member: { ...card.member, display_name: 'Jos\u00e9 Mar\u00eda \u0418\u0432\u0430\u043d\u043e\u0432\u0430' },
    requirements: (() => {
      let replaced = false;
      return card.requirements.map((row) => {
        if (replaced || row.type === 'group') return row;
        replaced = true;
        return { ...row, label: 'Participaci\u00f3n \u041e\u0431\u0449\u0435\u043d\u0438\u0435' };
      });
    })(),
  };
  const unicodeAttendance = {
    ...attendance,
    events: [{
      ...approved,
      title: 'Cl\u00ednica \u0421\u043e\u0431\u044b\u0442\u0438\u0435',
      categories: [{ id: 'unicode', name: 'Odontolog\u00eda \u0421\u0442\u043e\u043c\u0430\u0442\u043e\u043b\u043e\u0433\u0438\u044f', credit: 2 }],
    }],
  };
  const blob = buildAttendancePdf({
    card: unicodeCard,
    attendance: unicodeAttendance,
    ...PDF_FONTS,
    generatedAt: new Date('2026-08-22T12:00:00Z'),
  });
  const extracted = await extractPdfText(blob);
  for (const expected of [
    'Jos\u00e9 Mar\u00eda \u0418\u0432\u0430\u043d\u043e\u0432\u0430',
    'Participaci\u00f3n \u041e\u0431\u0449\u0435\u043d\u0438\u0435',
    'Cl\u00ednica \u0421\u043e\u0431\u044b\u0442\u0438\u0435',
    'Odontolog\u00eda \u0421\u0442\u043e\u043c\u0430\u0442\u043e\u043b\u043e\u0433\u0438\u044f',
  ]) assert.ok(extracted.includes(expected), `PDF extraction lost ${expected}`);
});

await check('long attendance records make a multi-page Letter PDF with repeated headings', async () => {
  const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  const attendance = await rpc('portal_attendance', { p_member_id: IDS.MEMBER_ABIGAIL });
  const sample = attendance.events.find((event) => event.status === 'attended');
  assert.ok(sample, 'the fixture needs an approved event');
  const manyEvents = Array.from({ length: 60 }, (_, index) => ({
    ...sample,
    id: `pdf-event-${index + 1}`,
    title: `PDF event ${index + 1}`,
  }));
  const blob = buildAttendancePdf({
    card,
    attendance: { ...attendance, events: manyEvents },
    ...PDF_FONTS,
    generatedAt: new Date('2026-08-22T12:00:00Z'),
  });
  const text = await blob.text();
  const extracted = await extractPdfText(blob);
  const pageCount = Number(text.match(/\/Type \/Pages .*\/Count (\d+)/)?.[1] ?? 0);
  assert.ok(pageCount > 1, 'the long attendance record stayed on one page');
  assert.equal(
    (text.match(/\/MediaBox \[0 0 612 792\]/g) ?? []).length,
    pageCount,
    'a generated page is not US Letter size',
  );
  assert.ok(
    (extracted.match(/Event \| Date \| Time \| Duration \| Categories and credit/g) ?? []).length > 1,
    'continued event pages do not repeat the table heading',
  );
});

await check('a failed browser download keeps results visible and Try again recovers', async () => {
  mountPortal();
  lookUp('Abigail Catto');
  await until(historyShown, 'attendance never loaded for the download check');
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let savedName = null;
  URL.createObjectURL = () => {
    throw new Error('download blocked');
  };
  dom.click(dom.$('score-download'));
  await until(() => !dom.$('download-error').hidden, 'download failure was not shown');
  assert.equal(dom.$('scorecard').hidden, false);
  assert.match(live(), /Download failed/);

  URL.createObjectURL = () => 'blob:attendance-test';
  URL.revokeObjectURL = () => {};
  const originalCreateElement = document.createElement;
  document.createElement = (tag) => {
    const node = originalCreateElement(tag);
    if (tag === 'a') {
      const originalClick = node.click.bind(node);
      node.click = () => {
        savedName = node.download;
        originalClick();
      };
    }
    return node;
  };
  try {
    dom.click(dom.$('download-retry'));
    await until(() => savedName !== null, 'download retry did not save the PDF');
    assert.equal(savedName, 'pdsa-attendance-abigail-catto-2026-2027.pdf');
    assert.match(live(), /PDF downloaded/);
  } finally {
    document.createElement = originalCreateElement;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});

await check('a slow, superseded history answer cannot paint over the member on screen', async () => {
  // Not you? followed by a fresh lookup fires a second history request before
  // the first has necessarily answered: app.history.load() is deliberately
  // not awaited by show(), so the network is free to answer out of order. A
  // slow first answer landing after the second would show one member's own
  // event history under another member's name and points, which is exactly
  // the kind of leak this page exists to prevent. This drives that sequence
  // for real, delaying only Abigail's portal_attendance response, and proves
  // Aaron's screen is not eventually overwritten by it.
  mountPortal();

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (String(url).includes('portal_attendance') && body.includes(IDS.MEMBER_ABIGAIL)) {
      return new Promise((resolve) => setTimeout(() => resolve(realFetch(url, init)), 200));
    }
    return realFetch(url, init);
  };

  try {
    lookUp('Abigail Catto');
    await until(scorecardShown, 'the first lookup never drew');
    assert.equal(dom.$('score-name-text').textContent.trim(), 'Abigail Catto');
    dom.click(dom.$('score-change')); // "Not you?", the real path back to the form

    lookUp('Aaron Ozan');
    // scorecardShown() alone is not enough here: the card stayed visible
    // across the switch, so it would read true immediately, before Aaron's
    // own lookup has actually finished. Wait for his name specifically.
    await until(
      () => dom.$('score-name-text').textContent.trim() === 'Aaron Ozan',
      'the second lookup never drew',
    );
    await until(historyShown, 'the second lookups history never drew');

    // Past the 200ms delay, so Abigail's superseded answer has had time to
    // arrive and, if unguarded, overwrite what is on screen.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      dom.$('score-name-text').textContent.trim(),
      'Aaron Ozan',
      'a slower, superseded lookup overwrote the member on screen',
    );
    const waiting = [...dom.$('history-filters').querySelectorAll('button')].find((button) => button.textContent.startsWith('Waiting'));
    dom.click(waiting);
    const row = rowFor('Spring GBM 5');
    assert.ok(row, 'Aarons own event history was overwritten by a stale answer');
    assert.equal(row.dataset.status, 'waiting');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('the leaderboard is still figures only, with no event on it', async () => {
  // The club asked for the history on the page you reach by typing your name,
  // and asked for the board to stay minimal. An event title appearing here
  // would be that decision quietly reversed.
  const board = await rpc('portal_leaderboard', {});
  const text = JSON.stringify(board);
  for (const title of ['Spring GBM 5', 'Soap Carving', 'Health Fair', 'Field Day']) {
    assert.ok(!text.includes(title), `the leaderboard carries the event "${title}"`);
  }
  assert.ok(!text.includes('occurred_on'), 'the leaderboard carries event dates');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe rules move, and the screen moves with them\n');
// ---------------------------------------------------------------------------

await check('renaming a requirement renames it on the member screen, with no deploy', async () => {
  // The falsifiable half of invariant 1. A list hardcoded in JavaScript passes
  // every check above and fails this one.
  await signInAs('officers@pdsaucf.com');
  const draft = await callRpc('clone_requirement_set', { p_set_id: IDS.SET_CURRENT });
  const [node] = await select('requirement_nodes', {
    select: 'id,label,type',
    filters: { requirement_set_id: `eq.${draft}`, label: 'eq.Tabling' },
    limit: 1,
  });
  assert.ok(node, 'the fixture no longer has the requirement this check renames');

  const renamed = `${node.label} (renamed)`;
  const rows = await patch('requirement_nodes', { id: `eq.${node.id}` }, { label: renamed });
  assert.equal(rows.length, 1, 'the rename was refused, so this check proves nothing');
  await callRpc('publish_requirement_set', { p_set_id: draft });

  mountPortal();
  await until(
    () => dom.$('honorary-list').textContent.includes(renamed),
    'the requirements box did not follow the rename',
  );

  lookUp('Abigail Catto');
  await until(scorecardShown, 'the scorecard never drew');
  assert.ok(
    dom.$('score-list').textContent.includes(renamed),
    'the members own checklist did not follow the rename',
  );

  await patch('requirement_nodes', { id: `eq.${node.id}` }, { label: node.label });
});

await check('no category or requirement name is baked into the portal', async () => {
  const names = new Set(
    (await select('categories', { select: 'name' })).map((row) => String(row.name).toLowerCase()),
  );
  for (const [label, source] of Object.entries(sources)) {
    for (const text of uiStrings(source)) {
      assert.ok(
        !names.has(text.trim().toLowerCase()),
        `${label} names the category "${text}", which is a row rather than copy`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe leaderboard\n');
// ---------------------------------------------------------------------------

await check('the board is the whole roster, in the order the server ranked it', async () => {
  mountPortal();
  dom.click(dom.$('tab-board'));
  await until(() => boardRows().length > 0, 'the leaderboard never drew');

  const board = await rpc('portal_leaderboard', {});
  assert.equal(boardRows().length, board.members.length, 'the board lost or invented a member');

  const drawn = [...boardRows()].map((row) => ({
    name: row.querySelector('.board-name').textContent.trim(),
    points: Number(row.querySelector('.board-points').textContent.trim()),
    rank: Number(row.querySelector('.board-rank').textContent.trim()),
  }));
  assert.deepEqual(
    drawn.map((row) => row.name),
    board.members.map((row) => row.display_name),
    'the board is not in the order the server sent',
  );
  assert.deepEqual(
    drawn.map((row) => row.points),
    board.members.map((row) => Number(row.point_total)),
    'a point total on the board is not the one the server sent',
  );
  assert.deepEqual(
    drawn.map((row) => row.rank),
    board.members.map((row) => Number(row.rank)),
    'the ranks on the board are not the servers ranks',
  );
  assert.match(dom.$('board-meta').textContent, /member/i);
});

await check('the honorary star is never the star alone', async () => {
  const board = await rpc('portal_leaderboard', {});
  const honorary = board.members.filter((row) => row.is_honorary);
  assert.ok(honorary.length > 0, 'nobody on this fixture is honorary, so this proves nothing');

  const starred = [...boardRows()].filter((row) => row.querySelector('.board-star'));
  assert.equal(starred.length, honorary.length, 'the stars and the servers verdicts disagree');
  for (const row of starred) {
    const words = row.querySelector('.board-star .visually-hidden');
    assert.ok(words, 'the star carries no words at all');
    assert.match(words.textContent, /Honorary Member/);
  }
});

await check('tapping a row opens the breakdown behind that total, and only one at a time', async () => {
  const board = await rpc('portal_leaderboard', {});
  const rows = [...boardRows()];
  const first = rows[0];
  const second = rows[1];

  assert.equal(first.querySelector('.board-breakdown').hidden, true, 'a breakdown is open already');
  dom.click(first.querySelector('.board-button'));
  assert.equal(first.querySelector('.board-breakdown').hidden, false, 'tapping opened nothing');
  assert.equal(first.querySelector('.board-button').getAttribute('aria-expanded'), 'true');

  const member = board.members.find((row) => row.member_id === first.dataset.member);
  const figures = first.querySelectorAll('.board-figure');
  assert.equal(figures.length, board.categories.length, 'the breakdown is missing a category');
  for (const category of board.categories) {
    const figure = [...figures].find((node) => node.textContent.includes(category.name));
    assert.ok(figure, `the breakdown does not carry ${category.name}`);
    const expected = Number(member.totals?.[category.id] ?? 0);
    assert.match(
      figure.querySelector('.board-figure-value').textContent,
      new RegExp(`^${expected}\\b`),
      `${category.name} shows a figure the server did not send`,
    );
  }

  dom.click(second.querySelector('.board-button'));
  assert.equal(first.querySelector('.board-breakdown').hidden, true, 'two breakdowns are open at once');
  assert.equal(second.querySelector('.board-breakdown').hidden, false);

  dom.click(second.querySelector('.board-button'));
  assert.equal(second.querySelector('.board-breakdown').hidden, true, 'tapping again did not close it');
});

await check('the breakdown adds up to the total on the row', async () => {
  // Every category's credit is points now, so this holds for every one of them
  // rather than for the ones a flag admitted. That flag was false for
  // Volunteering hours alone, and migration 22 dropped it with the unit.
  const board = await rpc('portal_leaderboard', {});
  for (const member of board.members.slice(0, 5)) {
    const sum = board.categories.reduce(
      (acc, row) => acc + Number(member.totals?.[row.id] ?? 0),
      0,
    );
    assert.equal(
      sum,
      Number(member.point_total),
      `${member.display_name}: the breakdown does not add up to the total shown`,
    );
  }
});

await check('the leaderboard is read once, not on every tab press', async () => {
  const calls = () =>
    api('/__mock/audit').then(
      (body) => body.admin.calls.filter((call) => call.fn === 'portal_leaderboard').length,
    );
  const before = await calls();
  dom.click(dom.$('tab-points'));
  dom.click(dom.$('tab-board'));
  dom.click(dom.$('tab-points'));
  dom.click(dom.$('tab-board'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await calls(), before, 'switching tabs re-counted the whole club');
});

// ---------------------------------------------------------------------------
process.stdout.write('\nthe mock is not kinder than the database\n');
// ---------------------------------------------------------------------------

await check('somebody who is not on this years roster is refused, not zeroed', async () => {
  // The refusal migration 21 makes, made here for the same reason: a screen of
  // zeroes reads as "you have attended nothing".
  await signInAs('officers@pdsaucf.com');
  const [past] = await select('member_enrollments', {
    select: 'member_id,academic_year_id',
    filters: { academic_year_id: `eq.${IDS.YEAR_PAST}` },
    limit: 1,
  });

  const onThisYear = await select('member_enrollments', {
    select: 'member_id',
    filters: {
      academic_year_id: `eq.${IDS.YEAR_CURRENT}`,
      member_id: `eq.${past?.member_id ?? IDS.MEMBER_ABIGAIL}`,
    },
  });
  if (past && onThisYear.length === 0) {
    await assert.rejects(
      () => rpc('portal_scorecard', { p_member_id: past.member_id }, { attempts: 1 }),
      (err) => err instanceof RpcError && err.code === 'PDS03',
      'last years member was answered with a scorecard',
    );
  }

  await assert.rejects(
    () =>
      rpc(
        'portal_scorecard',
        { p_member_id: '00000000-0000-4000-a000-0000000000ff' },
        { attempts: 1 },
      ),
    (err) => err instanceof RpcError && err.code === 'PDS03',
    'an id nobody has was answered with a scorecard',
  );
});

await check('the refusal is written for a member, not for an officer', () => {
  const copy = describeMember(
    new RpcError('PDS03', 'Nobody by that name is on this years roster.', 400),
  );
  assert.match(copy.title, /roster/i);
  assert.doesNotMatch(`${copy.title} ${copy.body}`, /queue|constraint|null|row/i);
});

await check('the public functions carry no address and no student id', async () => {
  const board = JSON.stringify(await rpc('portal_leaderboard', {}));
  const card = JSON.stringify(await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL }));
  const found = JSON.stringify(await rpc('portal_find_members', { p_name: 'Abigail Catto' }));
  for (const [label, payload] of [['leaderboard', board], ['scorecard', card], ['name search', found]]) {
    for (const secret of ['email', 'ucf_nid', 'notes', 'claimed_name', 'review_note']) {
      assert.ok(!payload.includes(secret), `the ${label} carries ${secret}`);
    }
  }
});

process.stdout.write('\nthe emblem\n');

await check('the emblem is a plain image, not a link to the officer screens', () => {
  const row = portalHtml.match(/<p class="brand-row">[\s\S]*?<\/p>/);
  assert.ok(row, 'there is no brand row on the member portal');
  assert.doesNotMatch(row[0], /<a\b/, 'the emblem is wrapped in a link');
  assert.match(row[0], /pdsa-emblem-96\.png/, 'the brand row is not the emblem');
  assert.match(row[0], /alt=""/, 'the emblem names itself when the page title already does');
});

server.close();

// ---------------------------------------------------------------------------
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exitCode = failures ? 1 : 0;
