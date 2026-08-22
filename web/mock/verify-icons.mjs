// Checks the shared labeled-button icon system without a browser layout engine.
// The visual pass covers sizing and wrapping; these checks hold the semantic
// contract that is easier to break silently: every prominent action maps to the
// right symbol, its words stay in place, and the SVG stays decorative.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { declarations, rule } from './css-rules.mjs';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

const { document, $ } = installDom(`
  <body>
    <button id="event-detail-back" class="button">Back</button>
    <button id="event-detail-qr" class="button">QR</button>
    <button id="event-detail-preview" class="button">Preview check-in</button>
    <button id="event-detail-edit" class="button">Edit</button>
    <button id="event-detail-duplicate" class="button">Duplicate</button>
    <button id="event-detail-delete" class="button button-danger">Delete</button>
    <button id="event-new" class="button button-primary">New event</button>
    <button id="attendee-add" class="button">Add members</button>
    <button id="card-qr" class="button button-small">QR</button>
    <button id="card-edit" class="button button-small">Edit</button>
    <button id="loading" class="button"><span id="loading-label">Save</span></button>
    <button id="tab" class="tab">Edit</button>
    <button id="exception" class="button" data-no-icon>Unusual action</button>
  </body>
`);

const { decorateButtonIcons, icon } = await import('../src/icons.js');

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

decorateButtonIcons(document);

process.stdout.write('\nbutton icons\n');

const expected = {
  'event-detail-back': 'M19 12H5',
  'event-detail-qr': 'M14 14h3v3h-3zM18 18h3v3h-3zM21 14h-1M14 21h1',
  'event-detail-preview': 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z',
  'event-detail-edit': 'M12 20h9',
  'event-detail-duplicate': 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  'event-detail-delete': 'M3 6h18',
  'event-new': 'M12 5v14',
  'attendee-add': 'M3 21v-2a6 6 0 0 1 12 0v2M19 8v6M16 11h6',
};

for (const [id, identifyingPath] of Object.entries(expected)) {
  await check(`${id} keeps its label and receives its expected icon`, () => {
    const button = $(id);
    assert.ok(button.querySelector('.button-label-icon'), 'missing icon');
    assert.ok(
      button.querySelectorAll('path').some((path) => path.getAttribute('d') === identifyingPath),
      'wrong icon',
    );
    assert.ok(button.textContent.trim(), 'label was removed');
  });
}

await check('compact and full-size actions use the same SVG language', () => {
  assert.equal(
    $('event-detail-qr').querySelector('path').getAttribute('d'),
    $('card-qr').querySelector('path').getAttribute('d'),
  );
  assert.equal(
    $('event-detail-edit').querySelector('path').getAttribute('d'),
    $('card-edit').querySelector('path').getAttribute('d'),
  );
});

await check('icons are decorative, unfocusable and inherit the button color', () => {
  const svg = $('event-detail-delete').querySelector('svg');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('focusable'), 'false');
  assert.equal(svg.getAttribute('stroke'), 'currentColor');
  assert.equal(svg.getAttribute('stroke-width'), '2');
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
});

await check('a nested loading label survives decoration and can still change', () => {
  const label = $('loading-label');
  assert.equal(label.textContent, 'Save');
  label.textContent = 'Saving…';
  assert.equal($('loading').textContent, 'Saving…');
  assert.ok($('loading').querySelector('.button-label-icon'));
});

await check('tabs and exceptional text-only actions are not decorated', () => {
  assert.equal($('tab').querySelector('svg'), null);
  assert.equal($('exception').querySelector('svg'), null);
});

await check('decorating twice does not duplicate icons', () => {
  decorateButtonIcons(document);
  assert.equal($('event-detail-edit').querySelectorAll('.button-label-icon').length, 1);
});

await check('the footer symbols are part of the local icon vocabulary', () => {
  const tiktok = icon('tiktok');
  const instagram = icon('instagram');
  const globe = icon('globe');
  const mail = icon('mail');

  assert.ok(tiktok.querySelector('path').getAttribute('d').startsWith('M12.525.02'));
  assert.equal(tiktok.querySelector('path').getAttribute('fill'), 'currentColor');
  assert.equal(instagram.querySelector('rect').getAttribute('rx'), '5');
  assert.ok(
    globe.querySelectorAll('path').some((path) => path.getAttribute('d') === 'M2 12h20'),
  );
  assert.equal(mail.querySelector('rect').getAttribute('width'), '18');
});

process.stdout.write('\nshared styling\n');

const iconCss = await readFile(`${WEB_ROOT}assets/css/icons.css`, 'utf8');
const normal = declarations(rule(iconCss, '.button > .button-label-icon'));
const compact = declarations(rule(iconCss, '.button.button-small > .button-label-icon'));

await check('normal icons are 18px and cannot shrink', () => {
  assert.equal(normal.get('width'), '1.125rem');
  assert.equal(normal.get('height'), '1.125rem');
  assert.equal(normal.get('flex'), '0 0 auto');
});

await check('compact icons are 16px', () => {
  assert.equal(compact.get('width'), '1rem');
  assert.equal(compact.get('height'), '1rem');
});

await check('all three apps load the one shared icon stylesheet', async () => {
  for (const page of ['admin/index.html', 'me/index.html', 'c/index.html']) {
    const html = await readFile(`${WEB_ROOT}${page}`, 'utf8');
    assert.match(html, /assets\/css\/icons\.css/);
  }
});

if (failures) {
  process.stdout.write(`\n${failures} icon check${failures === 1 ? '' : 's'} failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nAll icon checks passed.\n');
}
