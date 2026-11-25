import { expect, test } from '@playwright/test';

// Import the production module through Vite in the browser, not a duplicate
// test implementation. Each test exercises the exact parser shipped to users.
test.beforeEach(async ({ page }) => { await page.goto('/?view=batch'); });

const valid = [
  'null', 'true', 'false', '0', '-0', '-1.2e+3', '1E-2',
  ' [ 1, 2, null, false ] ', '{}', '[]',
  '{"outer":{"a":1},"a":2}',
  '{"a":[{"name":"x"},{"name":"y"}]}',
  '{"__proto__":{"x":1},"constructor":2}',
  '{"escaped":"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00e9"}',
  '{"emoji":"\\uD83D\\uDE00","other":"😀"}',
  '{"a":"{ [ } ] , :","b":"\\\\\\""}',
];

for (const text of valid) {
  test('accepts valid JSON ' + text.slice(0, 60), async ({ page }) => {
    const result = await page.evaluate(async input => {
      const path = '/src/strictJson.ts';
      const { parseStrictJson } = await import(path);
      return JSON.stringify(parseStrictJson(input)) === JSON.stringify(JSON.parse(input));
    }, text);
    expect(result).toBe(true);
  });
}

const invalid = [
  '', ' ', 'undefined', 'NaN', 'Infinity', '-Infinity', '1e400', '-1e400',
  '+1', '01', '-01', '1.', '.1', '1e', '1e+', '-', '0x10',
  '{}{}', 'true false', '[1,]', '{"a":1,}', '{"a" 1}', '{a:1}',
  '["unclosed]', '"unclosed', '"\\x00"', '"\\u000z"', '"\\u123"',
  '"literal\nnewline"', '"literal\tcontrol"', '{"a":1,"a":2}',
  '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}',
  '[{"x":1,"x":2}]', '{"😀":1,"\\uD83D\\uDE00":2}',
  '{"__proto__":1,"__proto__":2}', '{"a":1,"a":null}',
  '\ufeff{}', '\u00a0{}', '[truefalse]', '{"a":01}',
];

for (const text of invalid) {
  test('rejects ambiguous or invalid JSON ' + JSON.stringify(text), async ({ page }) => {
    const result = await page.evaluate(async input => {
      const path = '/src/strictJson.ts';
      const { parseStrictJson, StrictJsonError } = await import(path);
      try {
        parseStrictJson(input);
        return false;
      } catch (error) {
        return error instanceof StrictJsonError;
      }
    }, text);
    expect(result).toBe(true);
  });
}

test('rejects nesting above the fixed depth budget', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = '/src/strictJson.ts';
    const { parseStrictJson } = await import(path);
    const text = '['.repeat(1000) + '0' + ']'.repeat(1000);
    try { parseStrictJson(text); return false; } catch { return true; }
  });
  expect(result).toBe(true);
});

test('rejects a JSON node count beyond the bounded parser budget', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = '/src/strictJson.ts';
    const { parseStrictJson } = await import(path);
    const text = '[' + '0,'.repeat(1_000_000) + '0]';
    try { parseStrictJson(text); return false; } catch { return true; }
  });
  expect(result).toBe(true);
});
