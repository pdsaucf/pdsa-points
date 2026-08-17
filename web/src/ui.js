// The DOM helpers every signed-in screen shares: the admin app, and the member
// portal at /me, which uses the same h() and the same announce().
//
// Everything here builds nodes and sets textContent. There is no innerHTML in
// this codebase and no template string that becomes markup, which matters more
// than usual on these screens: they render a name a stranger typed into a phone
// at an event, and that string arrives with no sanitising anywhere between the
// keyboard and here.

export const $ = (id) => document.getElementById(id);

/**
 * A very small hyperscript.
 *
 *   h('p', { class: 'muted' }, 'No photo')
 *   h('button', { class: 'button', onClick: fn, dataset: { id } }, 'Approve')
 *
 * Children that are strings become text nodes, so nothing a member typed can
 * turn into an element. Null and false children are dropped, which is what
 * makes conditional rows readable at the call site.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'onClick') node.addEventListener('click', value);
    else if (key === 'onInput') node.addEventListener('input', value);
    else if (key === 'onChange') node.addEventListener('change', value);
    else if (key === 'text') node.textContent = value;
    else if (key in node && key !== 'list' && typeof value !== 'object') node[key] = value;
    else node.setAttribute(key, String(value));
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

/**
 * An inline chevron, for the buttons that move a row up or down.
 *
 * Built with createElementNS rather than as markup, for the same reason nothing
 * here touches innerHTML, and because an svg assembled by createElement lands
 * in the HTML namespace and renders as nothing at all.
 *
 * The icon is aria-hidden and the button around it carries the words, so a
 * screen reader still hears "Move GBMs up" while the screen shows an arrow.
 */
export function chevron(direction) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', direction === 'up' ? 'M3.5 10 L8 5.5 L12.5 10' : 'M3.5 6 L8 10.5 L12.5 6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');

  svg.append(path);
  return svg;
}

/**
 * The button that moves one row among its siblings. Every list that can be
 * reordered uses this one, so they cannot drift apart.
 *
 * @param {{direction: 'up'|'down', title: string, disabled?: boolean, onClick: Function}} spec
 */
export function moveButton({ direction, title, disabled = false, onClick }) {
  return h(
    'button',
    {
      type: 'button',
      class: 'button button-icon',
      title,
      'aria-label': title,
      disabled,
      onClick,
    },
    chevron(direction),
  );
}

/** Says something to a screen reader without moving focus or drawing a box. */
export function announce(message) {
  const live = $('live');
  if (live) live.textContent = message;
}

export function setHidden(node, hidden) {
  if (node) node.hidden = Boolean(hidden);
}

/** '4 check-ins' / '1 check-in'. Nothing here decides anything, it only labels. */
export function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many ?? `${one}s`}`;
}

/**
 * 'Mar 12' for a date column that arrives as 'YYYY-MM-DD'.
 * Parsed by parts, never by `new Date(string)`: that reads a bare date as UTC
 * midnight and shows the previous day to everybody west of Greenwich, which is
 * everybody at this club. Same reasoning as format.js.
 */
export function shortDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(isoDate);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 'Aug 2025', for "joined Aug 2025". */
export function monthYear(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  if (!y || !m) return '';
  return new Date(y, m - 1, d || 1).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
}

/** '2:14 PM', for when a check-in arrived. */
export function clockTime(isoTimestamp) {
  if (!isoTimestamp) return '';
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
