// The brand, in the two ways it fails silently.
//
// 1. DRIFT. checkin.css and admin.css declare the same brand tokens with the
//    same values, on purpose, and there is no build step that could share one
//    file between them. Somebody retunes a colour on the screen they happen to
//    have open, the other screen keeps the old one, and the product quietly
//    stops looking like one product. Nothing renders wrong, so nothing catches
//    it. schemes() and BRAND_TOKENS are here so a check can compare them.
//
// 2. CONTRAST. A palette is a set of numbers, and a number that is one point
//    too light still paints. The page looks fine to whoever changed it, on
//    their screen, in their scheme. ratio() is here so contrast is measured
//    rather than eyeballed.
//
// Plus the one rule the gold cannot be trusted with on its own: #e6c845 is
// 1.57:1 on the light page background, so it is a fill or a bar and never a
// foreground. goldMisuse() reads the CSS that applies in the LIGHT scheme and
// reports every place that forgets.

import { atRule, declarations, rule, withoutComments } from './css-rules.mjs';

/** The tokens both stylesheets must declare identically, in both schemes. */
export const BRAND_TOKENS = [
  '--bg',
  '--surface',
  '--ink',
  '--ink-muted',
  '--line',
  '--line-strong',
  '--accent',
  '--accent-ink',
  '--accent-soft',
  '--gold',
  '--gold-ink',
  '--gold-soft',
];

/**
 * Foreground/background pairs that must hold in both schemes, in both files,
 * with the minimum each one is held to. 4.5 is AA for body text, 3 is AA for a
 * control boundary such as the focus ring, and 7 is AAA, which the two ink
 * tokens clear comfortably and are held to so that a "small" retune of either
 * one has to be deliberate.
 */
export const CONTRAST = [
  ['--ink', '--bg', 7],
  ['--ink', '--surface', 7],
  ['--ink', '--gold-soft', 4.5],
  ['--ink-muted', '--bg', 4.5],
  ['--ink-muted', '--surface', 4.5],
  ['--accent', '--bg', 4.5],
  ['--accent', '--surface', 4.5],
  ['--accent', '--accent-soft', 4.5],
  ['--accent-ink', '--accent', 4.5],
  ['--gold-ink', '--gold', 4.5],
  // The ring, against everything it can be drawn on. outline-offset means the
  // ring sits on the page rather than on the control, so these are the colours
  // it has to clear.
  ['--focus', '--bg', 3],
  ['--focus', '--surface', 3],
];

/**
 * The same, for the tokens that are NOT brand. Applied only where the file
 * declares them, since checkin.css has no --warn or --surface-sunken.
 */
export const SEMANTIC_CONTRAST = [
  ['--danger', '--surface', 4.5],
  ['--danger', '--danger-soft', 4.5],
  ['--ok', '--surface', 4.5],
  ['--ok', '--ok-soft', 4.5],
  ['--warn', '--surface', 4.5],
  ['--warn', '--warn-soft', 4.5],
  ['--ink', '--surface-sunken', 7],
  ['--ink-muted', '--surface-sunken', 4.5],
  ['--focus', '--surface-sunken', 3],
];

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** #abc and #aabbcc to three 0..1 channels. Throws on anything else. */
function channels(colour) {
  const hex = String(colour).trim().replace(/^#/, '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new Error(`"${colour}" is not a plain hex colour, so it cannot be measured`);
  }
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255);
}

/** WCAG 2.x relative luminance. */
function luminance(colour) {
  const [r, g, b] = channels(colour).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function ratio(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Two decimal places, for a message somebody has to read. */
export const asRatio = (value) => `${value.toFixed(2)}:1`;

// ---------------------------------------------------------------------------
// Reading the stylesheets
// ---------------------------------------------------------------------------

/**
 * The custom properties on :root, per scheme. Dark starts as a copy of light,
 * so a token the dark block does not override reads as the value that actually
 * applies rather than as missing.
 * @returns {{light: Map<string,string>, dark: Map<string,string>}}
 */
export function schemes(css) {
  const light = declarations(rule(css, ':root'));
  const darkBlock = atRule(css, /prefers-color-scheme:\s*dark/);
  const dark = new Map(light);
  for (const [name, value] of declarations(rule(css, ':root', { scope: darkBlock }))) {
    dark.set(name, value);
  }
  return { light, dark };
}

/**
 * The stylesheet with the dark block cut out: what is left is what paints in
 * the light scheme, which is the only scheme where the gold rule bites.
 */
export function lightOnly(css) {
  const source = withoutComments(css);
  const darkBlock = atRule(css, /prefers-color-scheme:\s*dark/);
  return darkBlock === null ? source : source.split(darkBlock).join('');
}

const GOLD = /var\(\s*--gold\s*\)|#e6c845\b/i;

// Properties that draw a line rather than fill a shape. Gold is allowed here
// only at a weight that reads as a bar.
const LINES = new Set([
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'outline',
  'box-shadow',
  'text-decoration',
]);

const BAR = 3;

/**
 * Every place the light scheme puts gold somewhere it cannot carry on its own.
 * @returns {Array<{property: string, value: string, why: string}>}
 */
export function goldMisuse(css) {
  const found = [];
  for (const match of lightOnly(css).matchAll(/(?:^|[;{}])\s*(--)?([a-z][-a-z]*)\s*:\s*([^;{}]*)/gim)) {
    const property = `${match[1] ?? ''}${match[2]}`;
    const value = match[3].trim();
    if (!GOLD.test(value)) continue;

    if (property.startsWith('--')) {
      // Defining the gold tokens is the point. Feeding gold to any other token
      // is how it ends up as a foreground somewhere nobody looked.
      if (!property.startsWith('--gold')) {
        found.push({ property, value, why: 'a token other than --gold is being fed the gold' });
      }
      continue;
    }

    if (property === 'color' || (property.endsWith('-color') && property !== 'background-color')) {
      found.push({ property, value, why: 'gold is 1.57:1 on the light page, so it cannot be a foreground' });
      continue;
    }

    if (LINES.has(property)) {
      const widths = [...value.matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]));
      if (!widths.some((px) => px >= BAR)) {
        found.push({ property, value, why: `a gold line needs at least ${BAR}px to read as a bar` });
      }
    }
  }
  return found;
}

/** Every <img> in a page, as its raw tag text. */
export const images = (html) => [...String(html).matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
