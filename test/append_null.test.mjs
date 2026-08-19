// Node.append() is not h().
//
// h() (web/src/ui.js) drops null and false children, which is what makes
// conditional rows readable at the call site:
//
//   h('div', {}, canDelete ? h('button', ...) : null)
//
// Node.append() does the opposite: it stringifies what it is given, so the
// same ternary written against a real DOM node puts the literal word "null"
// on screen. That shipped once, on every row of the event categories screen,
// beside the Retire button, and no assertion in either suite noticed, because
// the screen rendered and every request succeeded. It is only visible to
// somebody looking at the page.
//
// This is a static check rather than a rendering one on purpose: it costs no
// DOM shim, it covers every screen at once including ones with no coverage
// today, and the pattern it looks for is the whole bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../web/src/', import.meta.url));

/**
 * The argument list of every `.append(` call in a source file, found by
 * balancing parentheses from the opening one so a nested h(...) call does not
 * end the match early.
 */
function appendCallArguments(source) {
  const calls = [];
  const opener = /\.append\(/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    calls.push({
      text: source.slice(start, i - 1),
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return calls;
}

const files = readdirSync(SRC).filter((name) => name.endsWith('.js'));

test('no .append() call is handed a branch that can evaluate to null', () => {
  const offenders = [];

  for (const name of files) {
    const source = readFileSync(SRC + name, 'utf8');
    for (const call of appendCallArguments(source)) {
      // A ternary whose alternative is null or undefined, at any nesting
      // depth inside the argument list. h() would drop it; append() prints it.
      if (/:\s*(null|undefined)\s*(,|$)/m.test(call.text)) {
        offenders.push(`${name}:${call.line}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `append() stringifies null. Guard the branch with an if, or build the ` +
      `children through h(), which drops null. Offending calls: ${offenders.join(', ')}`,
  );
});

test('the guard actually catches the shape it is looking for', () => {
  // Without this, a broken matcher would report a clean pass forever.
  const sample = `
    const actions = h('div', {});
    actions.append(
      h('button', {}, 'Retire'),
      canDelete(category, { allEventCount: 0 })
        ? h('button', {}, 'Delete')
        : null,
    );
  `;
  const [call] = appendCallArguments(sample);
  assert.ok(call, 'the parser should find the append call');
  assert.match(call.text, /:\s*null\s*,/, 'and see the null branch inside it');
});
