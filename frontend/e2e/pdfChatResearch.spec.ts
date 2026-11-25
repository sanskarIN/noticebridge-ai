import { expect, test } from '@playwright/test';
import type { Passage } from '../src/pdfChatCore';
import { allowedPassages, cosineRank, fuseRanks, passageId, unitVector } from '../src/pdfChatResearch';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: Rs. 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Application deadline: 19 December 2026' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: Rs. 350' },
];
const [a, b, c, d] = rows.map(passageId);
const all = allowedPassages(rows, ['original', 'revised']);

test('rank fusion rewards agreement without comparing raw scores', () => {
  const fused = fuseRanks(all, [
    { name: 'lexical', ids: [a, b, c] },
    { name: 'dense', ids: [b, d, a] },
  ]);
  expect(fused.map(row => row.id)).toEqual([b, a, d, c]);
  expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
  expect(fused[0].ranks).toEqual([{ channel: 'lexical', rank: 2 }, { channel: 'dense', rank: 1 }]);
});
test('only allowed role and page identities can enter candidate fusion', () => {
  const scoped = allowedPassages(rows, ['original'], 1);
  expect([...scoped.keys()]).toEqual([a, b]);
  expect(() => fuseRanks(scoped, [{ name: 'dense', ids: [d] }])).toThrow();
  expect(() => fuseRanks(scoped, [{ name: 'dense', ids: [c] }])).toThrow();
});
test('duplicates and invalid scopes cannot silently increase a score', () => {
  expect(() => allowedPassages([rows[0], rows[0]], ['original'])).toThrow();
  expect(() => allowedPassages(rows, ['original', 'original'])).toThrow();
  expect(() => allowedPassages(rows, ['original'], 0)).toThrow();
  expect(() => fuseRanks(all, [{ name: 'dense', ids: [a, a] }])).toThrow();
  expect(() => fuseRanks(all, [{ name: 'dense', ids: [a] }, { name: 'dense', ids: [b] }])).toThrow();
  expect(() => fuseRanks(all, [{ name: 'dense', ids: ['invented'] }])).toThrow();
});
test('empty channels do not invent candidates and output is bounded', () => {
  expect(fuseRanks(all, [])).toEqual([]);
  expect(fuseRanks(all, [{ name: 'dense', ids: [a, b, c] }], 1).map(row => row.id)).toEqual([a]);
  expect(() => fuseRanks(all, [], 0)).toThrow();
  expect(() => fuseRanks(all, [], 1, NaN)).toThrow();
});
test('ties use source and physical page ordering', () => {
  const results = fuseRanks(all, [{ name: 'dense', ids: [d] }, { name: 'lexical', ids: [a] }]);
  expect(results.map(row => row.id)).toEqual([a, d]);
});
test('normalization avoids overflow and rejects zero or nonfinite vectors', () => {
  const v = unitVector([1e308, 1e308], 2);
  expect(v[0]).toBeCloseTo(Math.SQRT1_2, 6);
  expect(v[1]).toBeCloseTo(Math.SQRT1_2, 6);
  for (const input of [[0, 0], [NaN, 1], [Infinity, 1], [1]]) {
    expect(() => unitVector(input, 2)).toThrow();
  }
  expect(() => unitVector([1], 2049)).toThrow();
});
test('cosine ranking is deterministic and preserves negative similarity', () => {
  const result = cosineRank(all, [1, 0], [
    { id: c, values: [-1, 0] }, { id: b, values: [0, 1] },
    { id: a, values: [4, 0] }, { id: d, values: [1, 0] },
  ]);
  expect(result.map(row => row.id)).toEqual([a, d, b, c]);
  expect(result.map(row => row.similarity)).toEqual([1, 1, 0, -1]);
});
test('vector ranking rejects foreign and duplicate candidates and dimensions', () => {
  const scoped = allowedPassages(rows, ['original'], 1);
  expect(() => cosineRank(scoped, [1, 0], [{ id: d, values: [1, 0] }])).toThrow();
  expect(() => cosineRank(scoped, [1, 0], [{ id: a, values: [1] }])).toThrow();
  expect(() => cosineRank(scoped, [1, 0], [{ id: a, values: [1, 0] }, { id: a, values: [1, 0] }])).toThrow();
});
