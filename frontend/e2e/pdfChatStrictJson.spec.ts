import { expect, test } from '@playwright/test';
import { parseStrictJson } from '../evaluation/strictJson';

const parse = (text: string, max = 100000) => parseStrictJson(text, max);
for (const input of [
  '{}', '[]', 'null', 'true', 'false', '0', '-0', '1.2e-5', '0.1E+3',
  '{"a":[{},[],null,false,"text",2]}',
  ' \r\n\t { "a" : 1, "b": { "a": 2 } } \n',
  '{"a":1,"A":2}', '{"__proto__":1,"constructor":2}',
  String.raw`{"text":"\"{}[],:\\\/\b\f\n\r\t\u20ac","emoji":"😀"}`,
  '{"a":"a","b":"a"}', '[{"key":1},{"key":2}]',
]) {
  test('strict parser matches valid JSON ' + JSON.stringify(input), () => {
    expect(parse(input)).toEqual(JSON.parse(input));
  });
}
for (const input of [
  '{"x":1,"x":2}',
  String.raw`{"x":1,"\u0078":2}`,
  String.raw`{"\u0078":1,"x":2}`,
  '{"outer":{"x":1,"x":2}}',
  '[{"x":1},{"a":{"x":1,"x":2}}]',
  '{"__proto__":1,"__proto__":2}',
  String.raw`{"😀":1,"\ud83d\ude00":2}`,
  String.raw`{"a\\b":1,"a\u005cb":2}`,
  '{"":1,"":2}',
  '{"x":{"y":1},"x":{"y":2}}',
]) {
  test('strict parser rejects duplicate decoded member ' + JSON.stringify(input), () => {
    expect(() => parse(input)).toThrow();
  });
}
for (const input of [
  '', ' ', 'undefined', 'NaN', 'Infinity', '-Infinity', '1e999', '-1e999',
  '01', '-01', '1.', '.1', '1e', '1e+', '+1', '0x10', 'truefalse',
  '{', '}', '[', ']', '{"a"}', '{"a":}', '{"a":1,}', '{"a":1 "b":2}',
  '{a:1}', '["a",]', '[,1]', '[1 2]', '[1,,2]', '[] []', '{}true',
  '"unfinished', String.raw`"bad\q"`, String.raw`"bad\u12"`, String.raw`"bad\uZZZZ"`, '"bad' + String.fromCharCode(92),
  '"line\nbreak" trailing', '"bad' + String.fromCharCode(0x01) + '"',
  '\uFEFF{}', '/* comment */{}', '{"a":1}// comment',
]) {
  test('strict parser refuses malformed or nonfinite input ' + JSON.stringify(input), () => {
    expect(() => parse(input)).toThrow();
  });
}
test('byte budget counts UTF-8 and rejects nonpositive or invalid budgets', () => {
  expect(parse('"é"', 4)).toBe('é');
  expect(() => parse('"é"', 3)).toThrow();
  expect(() => parse('{}', 0)).toThrow();
  expect(() => parse('{}', Infinity)).toThrow();
  expect(() => parse('{}', 1.5)).toThrow();
});
test('nesting is bounded independently of file size', () => {
  expect(parse('['.repeat(32) + 'null' + ']'.repeat(32))).toBeTruthy();
  expect(() => parse('['.repeat(65) + 'null' + ']'.repeat(65))).toThrow();
  expect(() => parse('{"a":'.repeat(100) + '0' + '}'.repeat(100))).toThrow();
});
test('parser failure does not quote private keys or values', () => {
  try {
    parse('{"private-question":"private-answer","private-question":2}');
    throw new Error('unexpected success');
  } catch (error) {
    expect(String(error)).not.toContain('private-question');
    expect(String(error)).not.toContain('private-answer');
  }
});
