// A very small CSS reader, for checks that need to assert what a rule declares.
//
// This is not a parser and is not trying to be one. It does three things: strip
// comments, find the body of one rule by its exact selector text, and split a
// body into declarations. That is enough to assert that a stylesheet still
// says what a check depends on it saying, and it fails loudly (null) rather
// than creatively when it cannot find something.
//
// WHAT THIS CANNOT DO. It reads the source, not the cascade, so it cannot tell
// you the computed value of anything, cannot resolve a custom property, and
// cannot measure a box. Checks written against it guard the MECHANISM a fix
// relies on, which is a weaker claim than measuring the rendered result. Where
// that distinction matters it is called out at the check itself.

export const withoutComments = (css) => String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text between the braces that open at or after `from`, brace matched. */
function bodyAt(css, from) {
  const open = css.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * The body of the first rule whose selector is exactly `selector`.
 * @returns {string|null}
 */
export function rule(css, selector, { scope = null } = {}) {
  const source = scope === null ? withoutComments(css) : scope;
  const at = new RegExp(`(?:^|[};{])\\s*${escapeRe(selector)}\\s*\\{`, 'm').exec(source);
  if (!at) return null;
  return bodyAt(source, at.index + at[0].length - 1);
}

/**
 * The body of the first at-rule whose prelude matches `pattern`, for reading
 * rules that only apply inside a media query.
 * @returns {string|null}
 */
export function atRule(css, pattern) {
  const source = withoutComments(css);
  const at = new RegExp(`@media[^{]*${pattern.source ?? pattern}[^{]*\\{`, 'm').exec(source);
  if (!at) return null;
  return bodyAt(source, at.index + at[0].length - 1);
}

/**
 * A rule body as a Map of property to value.
 * @returns {Map<string, string>}
 */
export function declarations(body) {
  const out = new Map();
  if (body === null || body === undefined) return out;
  // Only top level declarations, so a nested rule cannot leak its properties.
  let depth = 0;
  let current = '';
  const flush = () => {
    const at = current.indexOf(':');
    if (at !== -1) {
      const prop = current.slice(0, at).trim();
      if (prop && !prop.includes('{')) out.set(prop, current.slice(at + 1).trim());
    }
    current = '';
  };
  for (const char of String(body)) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === ';' && depth === 0) {
      flush();
      continue;
    }
    if (depth === 0) current += char;
  }
  flush();
  return out;
}
