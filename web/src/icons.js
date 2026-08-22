// One outline-icon language for every labeled action in the three web apps.
//
// Buttons keep their text as ordinary DOM text. This module only prepends a
// decorative SVG, so the words remain the accessible name and every existing
// event listener, disabled state and loading-label update stays untouched.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Lucide-style geometry: 24px viewBox, round joins and caps, 2px stroke.
// Each entry is a list of [element, attributes] so no screen has to carry SVG
// markup of its own.
const ICONS = {
  'arrow-left': [
    ['path', { d: 'm12 19-7-7 7-7' }],
    ['path', { d: 'M19 12H5' }],
  ],
  'arrow-right': [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'm12 5 7 7-7 7' }],
  ],
  archive: [
    ['path', { d: 'M21 8v13H3V8' }],
    ['path', { d: 'M1 3h22v5H1z' }],
    ['path', { d: 'M10 12h4' }],
  ],
  camera: [
    ['path', { d: 'M14.5 4 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3z' }],
    ['circle', { cx: '12', cy: '13', r: '3' }],
  ],
  check: [['path', { d: 'm20 6-11 11-5-5' }]],
  clipboard: [
    ['rect', { x: '5', y: '4', width: '14', height: '17', rx: '2' }],
    ['path', { d: 'M9 4.5V3h6v1.5' }],
  ],
  copy: [
    ['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }],
    ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }],
  ],
  download: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'm7 10 5 5 5-5' }],
    ['path', { d: 'M5 21h14' }],
  ],
  eye: [
    ['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  globe: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M2 12h20' }],
    ['path', { d: 'M12 2a15.3 15.3 0 0 1 0 20' }],
    ['path', { d: 'M12 2a15.3 15.3 0 0 0 0 20' }],
  ],
  instagram: [
    ['rect', { x: '2', y: '2', width: '20', height: '20', rx: '5' }],
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['circle', { cx: '17.5', cy: '6.5', r: '1', fill: 'currentColor', stroke: 'none' }],
  ],
  link: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1' }],
  ],
  'log-out': [
    ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }],
    ['path', { d: 'm16 17 5-5-5-5' }],
    ['path', { d: 'M21 12H9' }],
  ],
  mail: [
    ['rect', { x: '3', y: '5', width: '18', height: '14', rx: '2' }],
    ['path', { d: 'm3 7 9 6 9-6' }],
  ],
  pencil: [
    ['path', { d: 'M12 20h9' }],
    ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z' }],
  ],
  plus: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'M5 12h14' }],
  ],
  'qr-code': [
    ['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
    ['path', { d: 'M14 14h3v3h-3zM18 18h3v3h-3zM21 14h-1M14 21h1' }],
  ],
  'refresh-cw': [
    ['path', { d: 'M20 6v5h-5' }],
    ['path', { d: 'M4 18v-5h5' }],
    ['path', { d: 'M18.5 9A7 7 0 0 0 6 6.5L4 8' }],
    ['path', { d: 'M5.5 15A7 7 0 0 0 18 17.5l2-1.5' }],
  ],
  save: [
    ['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z' }],
    ['path', { d: 'M17 21v-8H7v8M7 3v5h8' }],
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['path', { d: 'm20 20-4-4' }],
  ],
  tiktok: [
    ['path', {
      d: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.72-.03-.5-.04-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.08-.14 1.62.24 1.64 1.82 3.02 3.5 2.87 1.11-.01 2.17-.66 2.75-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
      fill: 'currentColor',
      stroke: 'none',
    }],
  ],
  trash: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M8 6V4h8v2' }],
    ['path', { d: 'm19 6-1 15H6L5 6' }],
    ['path', { d: 'M10 11v5M14 11v5' }],
  ],
  upload: [
    ['path', { d: 'M12 16V4' }],
    ['path', { d: 'm7 9 5-5 5 5' }],
    ['path', { d: 'M5 21h14' }],
  ],
  'user-plus': [
    ['circle', { cx: '9', cy: '8', r: '4' }],
    ['path', { d: 'M3 21v-2a6 6 0 0 1 12 0v2M19 8v6M16 11h6' }],
  ],
  x: [
    ['path', { d: 'm18 6-12 12' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
};

// IDs disambiguate generic labels such as Add. Text rules cover the repeated
// and dynamically rendered controls without making every renderer know about
// icons. A data-icon attribute remains available for a genuinely exceptional
// action and data-no-icon opts a button out.
const ICON_BY_ID = {
  'attendee-add': 'user-plus',
  'attendee-add-submit': 'user-plus',
  'blocked-retry': 'refresh-cw',
  'claimed-back': 'arrow-left',
  'denied-signout': 'log-out',
  'event-category-add': 'plus',
  'event-detail-back': 'arrow-left',
  'event-detail-delete': 'trash',
  'event-detail-duplicate': 'copy',
  'event-detail-edit': 'pencil',
  'event-detail-preview': 'eye',
  'event-detail-qr': 'qr-code',
  'event-new': 'plus',
  'event-new-category-confirm': 'plus',
  'event-save': 'save',
  'form-message-retake': 'refresh-cw',
  'form-message-skip': 'check',
  'import-run': 'upload',
  'lookup-submit': 'search',
  'new-category-confirm': 'plus',
  'no-name-button': 'user-plus',
  'paste-run': 'user-plus',
  'photo-retake': 'refresh-cw',
  'progress-export': 'download',
  'qr-copy': 'copy',
  'qr-download': 'download',
  'qr-preview': 'eye',
  refresh: 'refresh-cw',
  'roster-add': 'user-plus',
  'roster-export': 'download',
  'roster-import': 'upload',
  'roster-paste': 'clipboard',
  'screen-message-action': 'refresh-cw',
  signout: 'log-out',
  'storage-purge-confirm': 'trash',
  'storage-reclaim': 'trash',
  'submit-button': 'check',
};

const TEXT_RULES = [
  [/^back(?:\s|$)/i, 'arrow-left'],
  [/^qr$/i, 'qr-code'],
  [/^preview(?:\s|$)/i, 'eye'],
  [/^edit(?:\s|$)/i, 'pencil'],
  [/^duplicate$/i, 'copy'],
  [/^(?:delete|remove|discard|clear)(?:\s|$)/i, 'trash'],
  [/^retire$/i, 'archive'],
  [/^(?:new event|add members?|add new member|add as new|enroll and approve)$/i, 'user-plus'],
  [/^add and link$/i, 'link'],
  [/^(?:add|new|start a draft)(?:\s|$)/i, 'plus'],
  [/^save(?:d)?$/i, 'save'],
  [/^(?:cancel|close|decline|reject|dismiss)$/i, 'x'],
  [/^(?:import|upload)(?:\s|$)/i, 'upload'],
  [/^(?:export|download)(?:\s|$)/i, 'download'],
  [/^(?:approve|publish|done|finish deleting|merge)(?:\s|$)/i, 'check'],
  [/^(?:link selected|link member)$/i, 'link'],
  [/^(?:refresh|retry|try again|reload)(?:\s|$)/i, 'refresh-cw'],
  [/^sign out$/i, 'log-out'],
  [/^(?:copy|paste)(?:\s|$)/i, 'copy'],
  [/^(?:show all|review|compare photos|open(?:\s|$))/i, 'eye'],
  [/^(?:show my points|search)$/i, 'search'],
  [/^(?:take photo|retake photo)$/i, 'camera'],
  [/^not you\?$/i, 'x'],
  [/^restore$/i, 'refresh-cw'],
  [/^change$/i, 'pencil'],
  [/^check in(?:\s|$)/i, 'check'],
];

export function icon(name) {
  const parts = ICONS[name];
  if (!parts) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'button-label-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  for (const [tag, attributes] of parts) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
}

export function iconNameFor(button) {
  if (!button || button.hasAttribute?.('data-no-icon')) return null;
  const explicit = button.getAttribute?.('data-icon');
  if (explicit) return ICONS[explicit] ? explicit : null;

  const byId = ICON_BY_ID[button.id];
  if (byId) return byId;

  const label = String(button.textContent ?? '').replace(/\s+/g, ' ').trim();
  for (const [pattern, name] of TEXT_RULES) {
    if (pattern.test(label)) return name;
  }
  return null;
}

export function decorateButton(button) {
  if (!button?.classList?.contains('button') || button.classList.contains('button-icon')) return;
  if (button.querySelector?.('.button-label-icon')) return;

  const name = iconNameFor(button);
  const svg = name ? icon(name) : null;
  if (!svg) return;

  // replaceChildren preserves the original nodes, including spans used for
  // loading labels. It also works in the project's small DOM test harness.
  button.replaceChildren(svg, ...button.childNodes);
}

export function decorateButtonIcons(root = document) {
  for (const button of root.querySelectorAll('.button')) decorateButton(button);
}

let observer = null;

export function installButtonIcons(root = document) {
  decorateButtonIcons(root);
  if (observer || typeof MutationObserver === 'undefined') return;

  observer = new MutationObserver(() => decorateButtonIcons(root));
  observer.observe(root.body ?? root.documentElement ?? root, {
    childList: true,
    subtree: true,
  });
}
