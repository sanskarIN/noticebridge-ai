import { expect, test } from '@playwright/test';
import type { Passage } from '../src/pdfChatCore';
import { allowedPassages, passageId } from '../src/pdfChatResearch';
import { validateExtractiveProposal, MAX_PROPOSAL_BYTES } from '../src/pdfChatProposal';

const original: Passage = { role: 'original', page: 1, ordinal: 1, text: 'Application fee: Rs. 500' };
const updated: Passage = { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: Rs. 350' };
const unicode: Passage = { role: 'original', page: 2, ordinal: 1, text: 'A📄B' };
const long: Passage = { role: 'original', page: 3, ordinal: 1, text: 'x'.repeat(301) };
const allowed = allowedPassages([original, updated, unicode, long], ['original']);
const id = passageId(original);
const span = { id, start: 17, end: 24 };
const serialize = (spans: unknown[], status = 'extract') => JSON.stringify({ status, spans });

test('extractive proposal resolves exact original text and source role locally', () => {
  const result = validateExtractiveProposal(serialize([span]), allowed);
  expect(result.status).toBe('extract');
  if (result.status === 'extract') {
    expect(result.spans[0].text).toBe(original.text.slice(17, 24));
    expect(result.spans[0].source).toBe(original);
  }
});
test('explicit abstention contains no evidence span', () => {
  expect(validateExtractiveProposal(serialize([], 'insufficient'), allowed)).toEqual({ status: 'insufficient', spans: [] });
  expect(() => validateExtractiveProposal(serialize([span], 'insufficient'), allowed)).toThrow();
});
test('unknown and out-of-scope sources are rejected', () => {
  for (const other of ['invented', passageId(updated), 'original:9:1']) {
    expect(() => validateExtractiveProposal(serialize([{ ...span, id: other }]), allowed)).toThrow();
  }
});
test('offsets must be bounded safe integers with nonempty spans', () => {
  for (const item of [
    { ...span, start: -1 }, { ...span, end: 100 }, { ...span, start: 1.5 },
    { ...span, start: 24 }, { ...span, start: 25 },
    { ...span, start: '17' }, { ...span, end: null },
    { id: passageId(long), start: 0, end: 301 },
  ]) expect(() => validateExtractiveProposal(serialize([item]), allowed)).toThrow();
});
test('UTF-16 offsets cannot bisect a surrogate pair', () => {
  const key = passageId(unicode);
  const valid = validateExtractiveProposal(serialize([{ id: key, start: 1, end: 3 }]), allowed);
  expect(valid.spans[0]?.text).toBe('📄');
  expect(() => validateExtractiveProposal(serialize([{ id: key, start: 2, end: 3 }]), allowed)).toThrow();
  expect(() => validateExtractiveProposal(serialize([{ id: key, start: 1, end: 2 }]), allowed)).toThrow();
});
test('overlapping or duplicate spans cannot amplify evidence', () => {
  expect(() => validateExtractiveProposal(serialize([span, span]), allowed)).toThrow();
  expect(() => validateExtractiveProposal(serialize([span, { ...span, start: 16, end: 19 }]), allowed)).toThrow();
  expect(validateExtractiveProposal(serialize([{ ...span, start: 0, end: 11 }, span]), allowed).spans).toHaveLength(2);
});
test('no model-supplied answer, source metadata, or claim of verification is accepted', () => {
  expect(() => validateExtractiveProposal(serialize([{ ...span, text: 'Rs. 999' }]), allowed)).toThrow();
  expect(() => validateExtractiveProposal(serialize([{ ...span, page: 2 }]), allowed)).toThrow();
  expect(() => validateExtractiveProposal(JSON.stringify({ status: 'extract', spans: [span], verified: true }), allowed)).toThrow();
});
test('rejects duplicated and escaped-equivalent object keys', () => {
  const valid = serialize([span]);
  expect(() => validateExtractiveProposal(valid.replace('"status":"extract"', '"status":"extract","status":"extract"'), allowed)).toThrow();
  expect(() => validateExtractiveProposal(valid.replace('"id":', '"\\u0069d":"other","id":'), allowed)).toThrow();
});
test('bounded malformed, oversized and deeply nested payloads fail closed', () => {
  for (const value of ['', 'not JSON', 'null', '[]', '{"status":"extract","spans":[]}', '['.repeat(20) + ']'.repeat(20),
    ' '.repeat(MAX_PROPOSAL_BYTES + 1), serialize(Array(9).fill(span)), serialize([span], 'verified')]) {
    expect(() => validateExtractiveProposal(value, allowed)).toThrow();
  }
});
test('JSON escapes within strings do not confuse the depth scanner', () => {
  const odd: Passage = { role: 'original', page: 5, ordinal: 1, text: 'A quote: "{[]}"' };
  const map = allowedPassages([odd], ['original']);
  const result = validateExtractiveProposal(serialize([{ id: passageId(odd), start: 0, end: odd.text.length }]), map);
  expect(result.spans[0]?.text).toBe(odd.text);
});
