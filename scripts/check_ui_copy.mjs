// UI copy must not read like an assistant's pronouncement.
//
// A clipped fragment closed with a period ("Everything.", "Nobody has checked
// in yet.", "Upcoming published events. No sign-in.") is a hallmark of
// AI-generated interfaces. Labels, empty states, descriptions, metadata and
// messages are written as software labels: one clause, no sentence-final
// period, never two sentences in one string, and no opening "Nobody",
// "Nothing" or "Everything". See "UI copy style" in CLAUDE.md.
//
// Checked: text and user-facing attributes in web/**/*.html, and every string
// and template literal in web/src/*.js and web/config.js. Not checked: the
// privacy policy and terms of use, which are documents, and the mock server.
//
// A literal that is not copy (a path, a selector, a regex source) ending in a
// period is rare; where one exists, put `copy-ok` in a comment on its line.
//
//   node scripts/check_ui_copy.mjs

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const WEB = join(REPO, 'web');
const SKIP_DIRS = new Set(['mock', 'privacy', 'terms', 'assets', 'node_modules']);
const ATTRS = ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'data-empty'];

// Ends in a period that closes a sentence: a letter, digit, closing bracket or
// quote, then the period. Excludes an ellipsis, ".." and a lone ".".
const TERMINAL = /[\p{L}\p{N})\]"'’]\.$/u;
// Two sentences in one string: "Their records are kept. They can be added back".
const SENTENCE_BREAK = /\p{Ll}[)"'’]?\. +\p{Lu}/u;
// A pronouncement about who has or has not acted: "Nobody on the roster yet".
// Empty states name what is absent instead: "No members".
const PRONOUNCEMENT = /^(Nobody|Nothing|Everything|Everyone|Everybody|Somebody|Someone|No one)\b/;
// PostgREST filter prefixes, `eq.${id}`, are code.
const OPERATOR = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|ov|fts)\.$/;

/** True when one piece of copy breaks the rule. Exported for the test. */
export function readsAsPronouncement(text) {
  if (OPERATOR.test(text)) return false;
  if (!TERMINAL.test(text) && !SENTENCE_BREAK.test(text) && !PRONOUNCEMENT.test(text)) return false;
  // Not copy: no space and a path or file shape.
  if (!text.includes(' ') && /[/\\]|^\.|\.(js|mjs|css|html|json|png|svg|woff2)$/.test(text)) return false;
  return true;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await walk(join(dir, entry.name))));
    } else if (/\.(html|js)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// The string and template literal segments of a script, with offsets. Enough
// of a tokenizer for this codebase: comments, the three quote kinds, template
// substitutions (recursively), and regex literals after an operator.
export function jsLiterals(src) {
  const found = [];
  let i = 0;
  let lastSignificant = '';

  function readTemplate() {
    // src[i] is the opening backtick.
    i++;
    const start = i;
    let depth = 0;
    let buf = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        buf += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        found.push({ value: buf, index: start });
        i++;
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        // The substitution reads as a word, so `It names ${found}.` is seen
        // as the sentence it renders.
        buf += 'x';
        i += 2;
        depth = 1;
        // Scan the substitution as code until its braces balance.
        while (i < src.length && depth > 0) {
          const d = src[i];
          if (d === '{') depth++;
          else if (d === '}') depth--;
          else if (d === '`') {
            readTemplate();
            continue;
          } else if (d === "'" || d === '"') {
            readQuoted(d);
            continue;
          }
          i++;
        }
      } else {
        buf += c;
        i++;
      }
    }
  }

  function readQuoted(q) {
    const start = i + 1;
    i++;
    let buf = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        buf += src.slice(i, i + 2);
        i += 2;
      } else {
        buf += src[i++];
      }
    }
    i++;
    found.push({ value: buf, index: start });
  }

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i = src.indexOf('*/', i + 2);
      i = i < 0 ? src.length : i + 2;
    } else if (c === "'" || c === '"') {
      readQuoted(c);
      lastSignificant = 'x';
    } else if (c === '`') {
      readTemplate();
      lastSignificant = 'x';
    } else if (c === '/' && (lastSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant))) {
      // A regex literal. Skip it, respecting classes and escapes.
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') i += 2;
        else if (src[i] === '[') (inClass = true), i++;
        else if (src[i] === ']') (inClass = false), i++;
        else if (src[i] === '/' && !inClass) break;
        else i++;
      }
      i++;
      lastSignificant = 'x';
    } else {
      if (!/\s/.test(c)) lastSignificant = /[\w$)\]]/.test(c) ? 'x' : c;
      i++;
    }
  }
  return found;
}

function htmlCopy(src) {
  const found = [];
  const body = src.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => ' '.repeat(m.length));
  // A club-authored document inside a page (the honorary description) sits
  // between <!-- copy-ok:start --> and <!-- copy-ok:end -->.
  const noComments = body
    .replace(/<!-- copy-ok:start[\s\S]*?<!-- copy-ok:end -->/g, (m) => ' '.repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  for (const m of noComments.matchAll(/>([^<]+)</g)) {
    found.push({ value: m[1], index: m.index + 1 });
  }
  const attr = new RegExp(`\\s(${ATTRS.join('|')})="([^"]*)"`, 'g');
  for (const m of noComments.matchAll(attr)) found.push({ value: m[2], index: m.index });
  // Inline scripts are code, and get the same treatment as a .js file.
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const offset = m.index + m[0].indexOf(m[1]);
    for (const lit of jsLiterals(m[1])) found.push({ value: lit.value, index: offset + lit.index });
  }
  return found;
}

export async function findTerminalPeriods() {
  const files = [...(await walk(WEB)), join(WEB, 'config.js')];
  const problems = [];
  for (const file of [...new Set(files)]) {
    const src = await readFile(file, 'utf8');
    const lines = src.split('\n');
    const literals = file.endsWith('.html') ? htmlCopy(src) : jsLiterals(src);
    for (const { value, index } of literals) {
      const text = value.replace(/\s+/g, ' ').trim();
      if (!readsAsPronouncement(text)) continue;
      const line = lineOf(src, index);
      if (/copy-ok/.test(lines[line - 1] ?? '')) continue;
      problems.push(`${relative(REPO, file)}:${line}: ${text.length > 90 ? text.slice(0, 87) + '...' : text}`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await findTerminalPeriods();
  if (problems.length) {
    console.error(
      `UI copy that reads as a pronouncement (${problems.length}). No closing period, one clause per ` +
        `string, and no "Nobody", "Nothing" or "Everything" openers. See "UI copy style" in CLAUDE.md.\n` +
        problems.join('\n'),
    );
    process.exit(1);
  }
  console.log('OK: UI copy reads as labels');
}
