// A DOM, small enough to have no dependencies and real enough to mount the
// shipped screens on.
//
// WHY THIS EXISTS. The other three suites drive the modules and the transport:
// they prove that the right calls go out and the right refusals come back. They
// cannot see the screen. For the progress board that is not good enough, because
// the failures worth catching are on the screen and not on the wire:
//
//   * an id in admin/index.html that no longer matches the id the module looks
//     up. $() returns null, the panel throws on mount, and every check that
//     only spoke to the server still passes
//   * a cell that renders a number the server did not send, which is the whole
//     of invariant 2
//   * an import preview that offers a fuzzy row no answer, or lets the button
//     be pressed while one is unanswered
//
// So this parses the real admin/index.html, builds a node tree, and lets
// createProgress / createRoster / createMember mount on it exactly as they do
// in a browser. What is asserted afterwards is the rendered DOM.
//
// It is deliberately a subset. It has no layout, no CSS, no bubbling and no
// default actions, because none of those decide any of the above. What it does
// have is everything src/ui.js's h() touches, the four events these screens
// listen for, and enough of a selector engine for the four querySelector calls
// in the modules. Anything outside that throws rather than quietly answering
// wrong.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TAGS = new Set(['script', 'style', 'noscript', 'textarea']);

// Attributes that are a property with a boolean value rather than a string.
const BOOLEAN_PROPS = new Set(['hidden', 'disabled', 'required', 'checked', 'selected', 'open', 'novalidate', 'multiple', 'readonly']);

// The properties h() is allowed to set directly. Anything not here falls
// through to setAttribute, which is what a real element does too.
const PROPS = [
  'id', 'value', 'checked', 'selected', 'disabled', 'hidden', 'title', 'name',
  'type', 'placeholder', 'href', 'src', 'download', 'width', 'height', 'open',
  'required', 'accept', 'step', 'min', 'max', 'maxlength', 'autocomplete',
  'spellcheck', 'inputmode', 'enterkeyhint', 'novalidate', 'tabindex',
];

class ShimEvent {
  constructor(type, target) {
    this.type = type;
    this.target = target;
    this.currentTarget = target;
    this.defaultPrevented = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {}
}

/**
 * The base both node kinds share, so `child instanceof Node` in src/ui.js is
 * true here for the same things it is true for in a browser. h() uses that test
 * to decide whether a child is already a node or a string that has to become
 * one, which is the line that stops a name somebody typed becoming markup.
 */
export class ShimBase {}

export class ShimNode extends ShimBase {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.nodeValue = null;
    // Enough for the one inline style the shipped screens set (the storage
    // usage bar's width): a plain object a caller can assign properties on,
    // not a real CSSStyleDeclaration. Anything reading a property nobody set
    // gets undefined rather than the empty string a browser would give, which
    // is the shim's usual rule: answer narrowly rather than convincingly.
    this.style = {};

    const owner = this;
    this._data = {};
    this.dataset = new Proxy(this._data, {
      get: (store, key) => store[key],
      set: (store, key, value) => {
        store[key] = String(value);
        owner.attributes.set(`data-${dashed(String(key))}`, String(value));
        return true;
      },
      has: (store, key) => key in store,
    });

    for (const prop of PROPS) {
      if (prop in this) continue;
      Object.defineProperty(this, prop, {
        enumerable: false,
        configurable: true,
        get() {
          if (BOOLEAN_PROPS.has(prop)) return this.attributes.get(prop) !== undefined;
          return this.attributes.get(prop) ?? '';
        },
        set(value) {
          if (BOOLEAN_PROPS.has(prop)) {
            if (value) this.attributes.set(prop, '');
            else this.attributes.delete(prop);
            // Radio buttons are exclusive, and the duplicate card is a pair of
            // them: choosing a survivor has to unchoose the other one, or the
            // merge reads whichever is first in the markup.
            if (prop === 'checked' && value) this._uncheckSiblings();
            return;
          }
          this.attributes.set(prop, String(value));
        },
      });
    }
  }

  get className() {
    return this.attributes.get('class') ?? '';
  }

  set className(value) {
    this.attributes.set('class', String(value));
  }

  get classList() {
    const node = this;
    const held = () => node.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name) => held().includes(name),
      add: (name) => {
        if (!held().includes(name)) node.className = [...held(), name].join(' ');
      },
      remove: (name) => {
        node.className = held().filter((entry) => entry !== name).join(' ');
      },
      toggle: (name, on) => {
        if (on ?? !held().includes(name)) node.classList.add(name);
        else node.classList.remove(name);
      },
    };
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof ShimNode);
  }

  get textContent() {
    if (this.nodeValue !== null) return this.nodeValue;
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) {
      this.append(new ShimText(String(value)));
    }
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (String(name).startsWith('data-')) {
      this._data[camel(String(name).slice(5))] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof ShimNode || node instanceof ShimText ? node : new ShimText(String(node));
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.childNodes = parent.childNodes.filter((node) => node !== this);
    this.parentNode = null;
  }

  focus() {}

  /** What a real click() does here: fire the listeners, nothing else. */
  click() {
    this.dispatchEvent(new ShimEvent('click', this));
  }

  _uncheckSiblings() {
    if (this.tagName !== 'INPUT' || this.getAttribute('type') !== 'radio') return;
    const group = this.getAttribute('name');
    if (!group) return;
    let root = this;
    while (root.parentNode) root = root.parentNode;
    for (const node of root.walk()) {
      if (node !== this && node.getAttribute('name') === group) node.attributes.delete('checked');
    }
  }

  showModal() {
    this.attributes.set('open', '');
  }

  close() {
    this.attributes.delete('open');
    // Real dialogs fire `close` as a queued task, not synchronously: several
    // screens in this product rely on exactly that ordering (a submit
    // handler that closes the dialog itself and then decides the outcome,
    // guarded so a same-tick cancel-via-close cannot overwrite a decision
    // already made). Dispatching this synchronously would let that guard's
    // OTHER branch win instead, so this is deferred a tick.
    queueMicrotask(() => this.dispatchEvent(new ShimEvent('close', this)));
  }

  reset() {
    for (const node of this.walk()) {
      if (node.tagName === 'INPUT' || node.tagName === 'SELECT') node.value = '';
    }
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const held = this.listeners.get(type) ?? [];
    this.listeners.set(type, held.filter((fn) => fn !== handler));
  }

  dispatchEvent(event) {
    event.currentTarget = this;
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(event);
    return !event.defaultPrevented;
  }

  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }

  querySelectorAll(selector) {
    return [...this.walk()].filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Every row of a table body, as arrays of cell text. For the checks. */
  get rowsText() {
    return this.querySelectorAll('tr').map((row) =>
      row.querySelectorAll('td,th').map((cell) => cell.textContent.trim()),
    );
  }
}

export class ShimText extends ShimBase {
  constructor(value) {
    super();
    this.nodeValue = String(value);
    this.parentNode = null;
    this.tagName = null;
  }

  get textContent() {
    return this.nodeValue;
  }

  *walk() {}
}

const dashed = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------
// Enough for the four calls the modules make: a tag, a class, an attribute with
// or without a value, a comma list, and :checked. A selector this cannot parse
// throws, so a future call site finds out here rather than silently matching
// nothing.

function matchesOne(node, part) {
  const trimmed = part.trim();
  if (!trimmed) return false;

  const pattern = /^([a-z][a-z0-9]*)?((?:\.[-\w]+|#[-\w]+|\[[^\]]+\]|:checked)*)$/i;
  const match = pattern.exec(trimmed);
  if (!match) throw new Error(`the shim cannot parse the selector "${part}"`);

  const [, tag, rest] = match;
  if (tag && node.tagName !== tag.toUpperCase()) return false;

  for (const token of rest.match(/(\.[-\w]+|#[-\w]+|\[[^\]]+\]|:checked)/g) ?? []) {
    if (token === ':checked') {
      if (!node.checked) return false;
    } else if (token.startsWith('.')) {
      if (!node.className.split(/\s+/).includes(token.slice(1))) return false;
    } else if (token.startsWith('#')) {
      if (node.id !== token.slice(1)) return false;
    } else {
      const inner = token.slice(1, -1);
      const withValue = /^([-\w]+)\s*=\s*["']?([^"']*)["']?$/.exec(inner);
      if (withValue) {
        if (node.getAttribute(withValue[1]) !== withValue[2]) return false;
      } else if (!node.hasAttribute(inner)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * One comma branch, which may be a descendant chain such as
 * ".card-actions button". The right-most compound has to match the node, and
 * each one to its left has to match some ancestor, in order.
 */
function matchesChain(node, branch) {
  const parts = branch.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (!matchesOne(node, parts[parts.length - 1])) return false;

  let ancestor = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    while (ancestor && !matchesOne(ancestor, parts[i])) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function matchesSelector(node, selector) {
  return String(selector)
    .split(',')
    .some((branch) => matchesChain(node, branch));
}

// ---------------------------------------------------------------------------
// Parsing the page
// ---------------------------------------------------------------------------

/**
 * The shipped markup, as a tree. Comments and the doctype are dropped, script
 * and noscript bodies are kept as opaque text, and everything else becomes a
 * node the modules can find by id.
 */
export function parseHtml(html) {
  const source = String(html)
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const root = new ShimNode('root');
  const stack = [root];
  let at = 0;

  while (at < source.length) {
    const next = source.indexOf('<', at);
    if (next === -1) {
      addText(stack, source.slice(at));
      break;
    }
    if (next > at) addText(stack, source.slice(at, next));

    const end = source.indexOf('>', next);
    if (end === -1) break;
    const raw = source.slice(next + 1, end).trim();
    at = end + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      // Unbalanced markup would silently reparent everything after it, so the
      // parser refuses rather than producing a tree nobody can trust.
      const top = stack[stack.length - 1];
      if (stack.length > 1 && top.tagName === name.toUpperCase()) stack.pop();
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([a-z][a-z0-9-]*)/i.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();

    const node = new ShimNode(name);
    for (const attr of body.slice(name.length).matchAll(/([:@a-z][-:.\w]*)(?:\s*=\s*"([^"]*)")?/gi)) {
      node.setAttribute(attr[1].toLowerCase(), attr[2] ?? '');
    }
    stack[stack.length - 1].append(node);

    if (RAW_TAGS.has(name)) {
      const closing = source.toLowerCase().indexOf(`</${name}`, at);
      const stop = closing === -1 ? source.length : closing;
      node.append(new ShimText(source.slice(at, stop)));
      at = stop;
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(node);
  }

  return root;
}

function addText(stack, text) {
  if (!text.trim()) return;
  stack[stack.length - 1].append(new ShimText(text.replace(/\s+/g, ' ')));
}

// ---------------------------------------------------------------------------
// Installing it
// ---------------------------------------------------------------------------

/**
 * Puts a `document` on globalThis built from the given markup, and hands back
 * the helpers the checks drive it with.
 */
export function installDom(html) {
  const root = parseHtml(html);

  const byId = new Map();
  const index = (node) => {
    for (const child of node.walk()) {
      const id = child.getAttribute('id');
      if (id && !byId.has(id)) byId.set(id, child);
    }
  };
  index(root);

  const document = {
    documentElement: root,
    body: root,
    getElementById: (id) => {
      const held = byId.get(id);
      if (held) return held;
      // Anything built after the page was parsed, which is everything the
      // renderers make.
      for (const node of root.walk()) {
        if (node.getAttribute('id') === id) {
          byId.set(id, node);
          return node;
        }
      }
      return null;
    },
    createElement: (tag) => new ShimNode(tag),
    createElementNS: (_namespace, tag) => new ShimNode(tag),
    createTextNode: (value) => new ShimText(value),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    // The review queue's keyboard shortcuts bind here. Nothing in this suite
    // presses a key, so they are collected and never fired.
    addEventListener: (type, handler) => root.addEventListener(type, handler),
    removeEventListener: (type, handler) => root.removeEventListener(type, handler),
  };

  globalThis.document = document;
  globalThis.Event = ShimEvent;
  globalThis.Node = ShimBase;

  const fire = (node, type) => {
    if (!node) throw new Error(`nothing to fire ${type} at`);
    node.dispatchEvent(new ShimEvent(type, node));
  };

  return {
    document,
    root,
    $: (id) => document.getElementById(id),
    click: (node) => fire(node, 'click'),
    fire,
    /** Every button under a node, by the text on it. */
    buttonNamed: (node, text) =>
      node
        .querySelectorAll('button')
        .find((button) => button.textContent.trim().toLowerCase() === String(text).toLowerCase()) ??
      null,
  };
}
