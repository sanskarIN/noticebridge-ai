/** Strict JSON input for offline research artifacts.
 *
 * JSON.parse silently accepts repeated object members. Reject them at every
 * nesting level, including equivalent escape spellings, before returning any
 * values. Preserve normal JSON member order and whitespace compatibility.
 * Explicit nesting and token budgets avoid unbounded recursive scanning.
 */
const MAX_DEPTH = 64;
const MAX_TOKENS = 4_000_000;
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
function invalid(): never {
  throw new Error('Invalid, duplicate-member or excessively complex JSON input.');
}
function whitespace(c: string | undefined): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t';
}
function delimiter(c: string | undefined): boolean {
  return c === undefined || whitespace(c) || c === ',' || c === ']' || c === '}';
}

export function parseStrictJson(text: string, maximumBytes: number): unknown {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !text ||
      text.length > maximumBytes || new TextEncoder().encode(text).length > maximumBytes) invalid();
  let cursor = 0;
  let tokens = 0;
  function token() {
    if (++tokens > MAX_TOKENS) invalid();
  }
  function skipWhitespace() {
    while (whitespace(text[cursor])) cursor++;
  }
  function stringToken(decode: boolean): string {
    if (text[cursor] !== '"') invalid();
    const start = cursor++;
    while (cursor < text.length) {
      const c = text[cursor++];
      if (c === '"') {
        if (!decode) return '';
        // Decode the actual key, not its source spelling: "x" and
        // "\\u0078" are the same member. JSON.parse validates escapes.
        try { return JSON.parse(text.slice(start, cursor)) as string; }
        catch { return invalid(); }
      }
      if (c === '\\') {
        const escaped = text[cursor++];
        if (escaped === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(cursor, cursor + 4))) invalid();
          cursor += 4;
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) invalid();
      } else if (c.charCodeAt(0) < 0x20) invalid();
    }
    return invalid();
  }
  function primitive() {
    const start = cursor;
    while (!delimiter(text[cursor])) cursor++;
    const raw = text.slice(start, cursor);
    if (raw === 'true' || raw === 'false' || raw === 'null') return;
    if (!NUMBER.test(raw) || !Number.isFinite(Number(raw))) invalid();
  }
  function array(depth: number) {
    cursor++;
    skipWhitespace();
    if (text[cursor] === ']') { cursor++; return; }
    while (true) {
      value(depth + 1);
      skipWhitespace();
      if (text[cursor] === ']') { cursor++; return; }
      if (text[cursor++] !== ',') invalid();
      skipWhitespace();
    }
  }
  function object(depth: number) {
    cursor++;
    const keys = new Set<string>();
    skipWhitespace();
    if (text[cursor] === '}') { cursor++; return; }
    while (true) {
      token();
      const key = stringToken(true);
      if (keys.has(key)) invalid();
      keys.add(key);
      skipWhitespace();
      if (text[cursor++] !== ':') invalid();
      value(depth + 1);
      skipWhitespace();
      if (text[cursor] === '}') { cursor++; return; }
      if (text[cursor++] !== ',') invalid();
      skipWhitespace();
    }
  }
  function value(depth: number) {
    if (depth > MAX_DEPTH) invalid();
    token();
    skipWhitespace();
    const c = text[cursor];
    if (c === '{') object(depth);
    else if (c === '[') array(depth);
    else if (c === '"') stringToken(false);
    else primitive();
  }
  value(0);
  skipWhitespace();
  if (cursor !== text.length) invalid();
  // The native parser builds the final object using standard JSON semantics
  // and acts as a second syntax check. Do not attach input excerpts to errors.
  try { return JSON.parse(text); }
  catch { return invalid(); }
}
