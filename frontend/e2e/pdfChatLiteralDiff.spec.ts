import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { changedNumericMarkers, compareLiteralSources, diffCandidatePage, diffCandidates,
  exactWordingOccurrences, literalTokens, MAX_WORD_DIFF_TOKENS, numericMarkers } from '../src/pdfChatLiteralDiff';

const o = (text: string, ordinal = 1, page = 1): Passage => ({ role: 'original', page, ordinal, text });
const r = (text: string, ordinal = 1, page = 1): Passage => ({ role: 'revised', page, ordinal, text });
function compare(a: string, b: string) {
  return compareLiteralSources(buildIndex([o(a), r(b)]), 'original:1:1', 'revised:1:1');
}
test('exact UTF-16 offsets reconstruct words, marks, numbers, punctuation and whitespace', () => {
  const text = '😀 café e\u0301 ₹500.00 — fee\t10%';
  const tokens = literalTokens(text);
  expect(tokens.map(token => token.text).join('')).toBe(text);
  expect(tokens[0]).toEqual({ text: '😀', start: 0, end: 2 });
  for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  expect(tokens.some(token => token.text === 'e\u0301')).toBe(true);
});
test('numeric change keeps full original and revised literal source text', () => {
  const diff = compare('Application fee: INR 500', 'Application fee: INR 350');
  expect(diff.originalSegments.map(row => row.text).join('')).toBe(diff.original.text);
  expect(diff.revisedSegments.map(row => row.text).join('')).toBe(diff.revised.text);
  expect(diff.originalSegments.filter(row => row.kind === 'unpaired').map(row => row.text)).toEqual(['500']);
  expect(diff.revisedSegments.filter(row => row.kind === 'unpaired').map(row => row.text)).toEqual(['350']);
  expect(changedNumericMarkers(diff)).toMatchObject({ original: [{ text: '500', kind: 'digits' }],
    revised: [{ text: '350', kind: 'digits' }] });
});
test('literal differences preserve capitalization, whitespace and punctuation', () => {
  const result = compare('Fee: INR 500.', 'fee:  INR 500!');
  expect(result.identical).toBe(false);
  expect(result.originalSegments.filter(row => row.kind === 'unpaired').map(row => row.text)).toEqual(['Fee', ' ', '.']);
  expect(result.revisedSegments.filter(row => row.kind === 'unpaired').map(row => row.text)).toEqual(['fee', '  ', '!']);
});
test('identical wording has no unpaired tokens', () => {
  const result = compare('Fee: INR 500', 'Fee: INR 500');
  expect(result.identical).toBe(true);
  expect(result.changes).toEqual([]);
  expect(result.sameTokens).toBe(result.originalTokens);
  expect(result.sameTokens).toBe(result.revisedTokens);
});
test('completely different wording still retains exact source segments', () => {
  const result = compare('Alpha', 'Beta');
  expect(result.sameTokens).toBe(0);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0].original[0].text).toBe('Alpha');
  expect(result.changes[0].revised[0].text).toBe('Beta');
});
test('Unicode numeric markers keep original offsets and never calculate quantities', () => {
  expect(numericMarkers({ text: '₹123', start: 7, end: 11 })).toEqual([
    { text: '₹', start: 7, end: 8, kind: 'currency_symbol' },
    { text: '123', start: 8, end: 11, kind: 'digits' },
  ]);
  expect(changedNumericMarkers(compare('Fee: ₹500', 'Fee: €600')).original.map(row => row.text)).toEqual(['₹', '500']);
});
test('repeated words warn of multiple possible alignments and remain deterministic', () => {
  const a = 'fee fee amount', b = 'fee amount fee';
  const result = compare(a, b);
  expect(result.repeatedTokens).toBe(true);
  expect(compare(a, b)).toEqual(result);
  for (const segment of result.originalSegments) expect(a.slice(segment.start, segment.end)).toBe(segment.text);
  for (const segment of result.revisedSegments) expect(b.slice(segment.start, segment.end)).toBe(segment.text);
});
test('insertion and deletion at edges are represented as one-sided groups', () => {
  const result = compare('old fee', 'fee revised');
  expect(result.changes).toHaveLength(2);
  expect(result.changes[0].revised).toEqual([]);
  expect(result.changes[1].original).toEqual([]);
});
test('tokens are bounded before dynamic programming', () => {
  expect(() => literalTokens('!'.repeat(MAX_WORD_DIFF_TOKENS + 1))).toThrow('token limit');
  expect(() => literalTokens('')).toThrow();
  expect(() => literalTokens('\ud800')).toThrow();
  expect(() => literalTokens('x'.repeat(901))).toThrow();
});
test('manual candidate filtering remains within one physical source', () => {
  const sources = [o('Fee 500', 2), o('Fee 600', 1, 2), o('Other', 1), r('Fee 350')];
  const idx = buildIndex(sources);
  expect(diffCandidates(idx, { role: 'original', keyword: 'FEE' })).toEqual([sources[0], sources[1]]);
  expect(diffCandidates(idx, { role: 'original', page: 2, keyword: '' })).toEqual([sources[1]]);
  expect(diffCandidates(idx, { role: 'revised', keyword: 'Fee' })).toEqual([sources[3]]);
  expect(diffCandidates(idx, { role: 'original', keyword: 'Fee.*' })).toEqual([]);
  expect(() => diffCandidates(idx, { role: 'original', page: 81, keyword: '' })).toThrow();
  expect(() => diffCandidatePage([], 2)).toThrow();
});
test('duplicate identity, missing identity and swapped roles are rejected', () => {
  const a = o('Fee'), b = r('Fee');
  expect(() => compareLiteralSources(buildIndex([a, b]), 'revised:1:1', 'original:1:1')).toThrow();
  expect(() => compareLiteralSources(buildIndex([a, b]), 'original:1:2', 'revised:1:1')).toThrow();
  expect(() => compareLiteralSources(buildIndex([a, a, b]), 'original:1:1', 'revised:1:1')).toThrow();
});
test('occurrence counts report exact wording only and reject forged text', () => {
  const a = o('Fee'), idx = buildIndex([a, o('Fee', 2), r('Fee'), r('fee', 2)]);
  expect(exactWordingOccurrences(idx, a)).toEqual({ original: 2, revised: 1 });
  expect(() => exactWordingOccurrences(idx, { ...a, text: 'Forged' })).toThrow();
});
