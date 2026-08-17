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
    reload() {},
  },
  history: { replaceState() {} },
};

// The page and the stylesheet, as they ship.
const portalHtml = await readFile(`${WEB_ROOT}me/index.html`, 'utf8');
const portalCss = await readFile(`${WEB_ROOT}assets/css/portal.css`, 'utf8');
const checkinCss = await readFile(`${WEB_ROOT}assets/css/checkin.css`, 'utf8');

let dom = installDom(portalHtml);

const auth = await import('../src/auth.js');
const { select, patch, callRpc } = await import('../src/rest.js');
const { rpc } = await import('../src/api.js');
const { RpcError } = await import('../src/errors.js');
const { describeMember } = await import('../src/member-errors.js');
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
async function signInAs(email) {
  auth.forgetSession();
  await auth.sendMagicLink(email, `http://localhost:${PORT}/admin/`, { createUser: false });
  const answer = await api(`/__mock/magic-link?email=${encodeURIComponent(email)}`);
  const parsed = auth.parseAuthRedirect(answer.url);
  assert.ok(parsed?.session, `no session in the sign-in link for ${email}`);
  auth.adoptSession(parsed.session);
}

/** A fresh copy of the shipped page, with the portal mounted on it. */
function mountPortal() {
  dom = installDom(portalHtml);
  start();
  return dom;
}

/** Types a name into the one form on the page and submits it. */
function lookUp(first, last) {
  dom.$('lookup-first').value = first;
  dom.$('lookup-last').value = last;
  dom.fire(dom.$('lookup-form'), 'submit');
}

const scorecardShown = () => !dom.$('scorecard').hidden;
const checklistRows = () => dom.$('score-list').querySelectorAll('li');
const honoraryRows = () => dom.$('honorary-list').querySelectorAll('li');
const boardRows = () => dom.$('board-list').querySelectorAll('.board-row');
const live = () => dom.$('live').textContent;

const server = await startMock(PORT);
await api('/__mock/reset');

// ---------------------------------------------------------------------------
process.stdout.write('\nhouse rules\n');
// ---------------------------------------------------------------------------

const sources = {
  'src/portal.js': await readFile(`${WEB_ROOT}src/portal.js`, 'utf8'),
  'src/portal-scorecard.js': await readFile(`${WEB_ROOT}src/portal-scorecard.js`, 'utf8'),
  'src/portal-leaderboard.js': await readFile(`${WEB_ROOT}src/portal-leaderboard.js`, 'utf8'),
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
  assert.match(sources['src/portal-scorecard.js'], /rpc\('portal_scorecard'|rpc\(\s*'portal_/);
});

await check('the portal writes nothing at all, and asks for nothing signed in', () => {
  // Every answer this page draws comes from one of the four public functions,
  // through api.js, which sends the anon key and never a session. A page that
  // imported rest.js would behave differently for an officer with a laptop open,
  // and that difference would only ever show up in front of somebody.
  for (const [label, source] of Object.entries(sources)) {
    const code = withoutComments(source);
    for (const verb of ['insert\\(', 'patch\\(', 'remove\\(', 'select\\(']) {
      assert.doesNotMatch(
        code,
        new RegExp(verb),
        `${label} reads or writes a table directly instead of calling a public function`,
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
      /sendMagicLink|adoptSession|currentSession/,
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
    /Honorary Members are those who go above and beyond to be an active and valuable member to PDSA\./,
  );
  assert.match(body, /To reach Honorary Member status, certain requirements must be met\./);
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
  lookUp('Abigail', 'Catto');
  await until(scorecardShown, 'the scorecard never drew');

  const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  assert.equal(dom.$('score-name').textContent.trim(), card.member.display_name);
  assert.match(dom.$('score-points').textContent, new RegExp(`\\b${Number(card.point_total)}\\b`));
  assert.equal(
    dom.$('score-state').hidden,
    !card.is_honorary,
    'the honorary pill and the servers verdict disagree',
  );
  assert.ok(checklistRows().length > 0, 'the requirement list is empty');
});

await check('the form is put away, and Not you? brings it back with the name still in it', async () => {
  assert.equal(dom.$('lookup-form').hidden, true, 'the form is still on screen under the scorecard');
  dom.click(dom.$('score-change'));
  assert.equal(dom.$('lookup-form').hidden, false, 'Not you? did not bring the form back');
  assert.equal(dom.$('scorecard').hidden, true, 'the scorecard stayed on screen');
  assert.equal(
    dom.$('lookup-first').value,
    'Abigail',
    'the name was cleared, so a typo means typing it all again',
  );
});

await check('the checklist is what the server said, line for line', async () => {
  mountPortal();
  lookUp('Abigail', 'Catto');
  await until(scorecardShown, 'the scorecard never drew');

  const card = await rpc('portal_scorecard', { p_member_id: IDS.MEMBER_ABIGAIL });
  // The root is the whole rule and its figures are in the line above the list.
  const expected = card.requirements.filter((row) => row.node_id !== card.root_node_id);
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

await check('a name nobody on the roster has is said at the field, not as a failure', async () => {
  mountPortal();
  lookUp('Nobody', 'Whatsoever');
  await until(() => !dom.$('lookup-error').hidden, 'nothing was said about a name that is not there');

  assert.equal(dom.$('scorecard').hidden, true, 'a scorecard was drawn for nobody');
  assert.match(dom.$('lookup-error').textContent, /roster/i);
  assert.equal(dom.$('screen-message').hidden, true, 'a name that is not on the roster read as a failure');
});

await check('half a name is refused before anything is sent', async () => {
  mountPortal();
  const before = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  ).length;

  lookUp('Abigail', '   ');
  assert.equal(dom.$('lookup-error').hidden, false, 'nothing was said');
  assert.match(dom.$('lookup-error').textContent, /first and last/i);

  const after = (await api('/__mock/audit')).admin.calls.filter(
    (call) => call.fn === 'portal_find_members',
  ).length;
  assert.equal(after, before, 'half a name was sent to the server anyway');
});

await check('two members with one name are told apart, not guessed between', async () => {
  // Two roster rows, one name, which is exactly what the club has when somebody
  // is added twice or when two people genuinely share a name. With no address on
  // file the join month is all there is, so it has to be on the button.
  await signInAs('ben@pdsaucf.com');
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
  lookUp('Catherine', 'Diaz');
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
process.stdout.write('\nthe rules move, and the screen moves with them\n');
// ---------------------------------------------------------------------------

await check('renaming a requirement renames it on the member screen, with no deploy', async () => {
  // The falsifiable half of invariant 1. A list hardcoded in JavaScript passes
  // every check above and fails this one.
  await signInAs('ben@pdsaucf.com');
  const [node] = await select('requirement_nodes', {
    select: 'id,label,type',
    filters: { id: `eq.${IDS.NODES.tabling}` },
    limit: 1,
  });
  assert.ok(node, 'the fixture no longer has the requirement this check renames');

  const renamed = `${node.label} (renamed)`;
  const rows = await patch('requirement_nodes', { id: `eq.${node.id}` }, { label: renamed });
  assert.equal(rows.length, 1, 'the rename was refused, so this check proves nothing');

  mountPortal();
  await until(
    () => dom.$('honorary-list').textContent.includes(renamed),
    'the requirements box did not follow the rename',
  );

  lookUp('Abigail', 'Catto');
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
  await signInAs('ben@pdsaucf.com');
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
  const found = JSON.stringify(await rpc('portal_find_members', {
    p_first_name: 'Abigail',
    p_last_name: 'Catto',
  }));
  for (const [label, payload] of [['leaderboard', board], ['scorecard', card], ['name search', found]]) {
    for (const secret of ['email', 'ucf_nid', 'notes', 'claimed_name', 'review_note']) {
      assert.ok(!payload.includes(secret), `the ${label} carries ${secret}`);
    }
  }
});

server.close();

// ---------------------------------------------------------------------------
process.stdout.write(failures ? `\n${failures} check(s) failed\n\n` : '\nAll checks passed\n\n');
process.exitCode = failures ? 1 : 0;
