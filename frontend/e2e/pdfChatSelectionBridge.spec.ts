import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { prepareSelection, reviewSelection, MAX_SELECTION_RESULT_BYTES } from '../src/pdfChatSelectionBridge';
import type { CandidateReview } from '../src/pdfChatEmbeddingBridge';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: Rs. 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Application fee: Rs. 750' },
  { role: 'original', page: 2, ordinal: 1, text: 'Do not pay unless registered.' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: Rs. 350' },
];
const index = buildIndex(rows);
const answer = answerQuestion(index, 'Application fee', 'both');
const candidates: CandidateReview = {
  model: 'example:latest', digest: 'b'.repeat(64), dimension: 2,
  candidates: rows.map(passage => ({ passage, ranks: [{ channel: 'dense', rank: 1 }] })),
};
const request = prepareSelection(index, answer, candidates);
const digest = 'a'.repeat(64);
const result = {
  format: 'noticebridge-chat-selection-result', version: 1, request_sha256: digest,
  model: 'example-local:latest', model_digest: 'b'.repeat(64),
  selection: { status: 'select', ids: ['original:2:1', 'revised:1:1'] },
  authority_verified: false,
};
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

test('selection includes baseline and additional candidates exactly once', () => {
  const parsed = JSON.parse(request.text);
  expect(parsed.passages).toHaveLength(4);
  expect(parsed.passages.map((row: {id: string}) => row.id)).toEqual([
    'original:1:1', 'original:1:2', 'revised:1:1', 'original:2:1',
  ]);
  expect(parsed.passages.map((row: {text: string}) => row.text)).toEqual([
    rows[0].text, rows[1].text, rows[3].text, rows[2].text,
  ]);
});
test('no model ranking is required when deterministic evidence is present', () => {
  const baseline = prepareSelection(index, answer, null);
  expect(baseline.allowed.size).toBe(answer.citations.length);
});
test('when there is no strict evidence, local candidates can seed selection', () => {
  const absent = answerQuestion(index, 'Unknown condition', 'both');
  expect(absent.citations).toHaveLength(0);
  expect(() => prepareSelection(index, absent, null)).toThrow();
  expect(prepareSelection(index, absent, candidates).allowed.size).toBe(4);
});
test('selection resolves local full quotes and flags omitted baseline evidence', () => {
  const review = reviewSelection(encode(result), request, digest);
  expect(review.selected).toEqual([rows[2], rows[3]]);
  expect(review.omittedBaseline).toEqual([rows[0], rows[1]]);
  expect(answer.citations).toEqual([rows[0], rows[1], rows[3]]);
});
test('explicit model abstention cannot erase deterministic evidence', () => {
  const review = reviewSelection(encode({ ...result, selection: { status: 'insufficient', ids: [] } }), request, digest);
  expect(review.status).toBe('insufficient');
  expect(review.selected).toEqual([]);
  expect(review.omittedBaseline).toEqual(answer.citations);
});
test('foreign role, page and rewritten candidate text cannot enter the request', () => {
  const scoped = answerQuestion(index, 'Application fee', 'original');
  expect(() => prepareSelection(index, scoped, candidates)).toThrow();
  const forged = { ...candidates, candidates: [{ passage: { ...rows[0], text: 'Invented' }, ranks: [] }] };
  expect(() => prepareSelection(index, scoped, forged)).toThrow();
});
test('selection budget preserves baseline and counts excluded candidates', () => {
  const many: Passage[] = Array.from({ length: 16 }, (_, i) => ({
    role: 'original', page: 1, ordinal: i + 1, text: 'Application fee: Rs. ' + (500 + i),
  }));
  const idx = buildIndex(many);
  const base = answerQuestion(idx, 'Application fee', 'original');
  const review = { ...candidates, candidates: many.map(passage => ({ passage, ranks: [] })) };
  const exp = prepareSelection(idx, base, review);
  expect(exp.allowed.size).toBe(12);
  expect(exp.omittedCandidates).toBe(4);
  expect(base.citations.every(p => exp.allowed.has(p.role + ':' + p.page + ':' + p.ordinal))).toBe(true);
});
for (const [name, update] of [
  ['hash', { request_sha256: 'c'.repeat(64) }],
  ['authority', { authority_verified: true }],
  ['model', { model: 'https://example.com/model' }],
  ['cloud', { model: 'example:cloud' }],
  ['digest', { model_digest: 'bad' }],
  ['extra answer', { answer: 'Invented' }],
  ['unknown id', { selection: { status: 'select', ids: ['original:8:1'] } }],
  ['duplicate id', { selection: { status: 'select', ids: ['original:1:1', 'original:1:1'] } }],
  ['empty selection', { selection: { status: 'select', ids: [] } }],
  ['abstention with id', { selection: { status: 'insufficient', ids: ['original:1:1'] } }],
  ['extra claim', { selection: { status: 'select', ids: ['original:1:1'], claim: 'Verified' } }],
] as const) {
  test('rejects incompatible model selection: ' + name, () => {
    expect(() => reviewSelection(encode({ ...result, ...update }), request, digest)).toThrow();
  });
}
test('strict result encoding rejects duplicates and oversized data', () => {
  expect(() => reviewSelection(encode(result).replace('"version": 1,', '"version": 1, "version": 1,'), request, digest)).toThrow();
  expect(() => reviewSelection(JSON.stringify(result), request, digest)).toThrow();
  expect(() => reviewSelection(' '.repeat(MAX_SELECTION_RESULT_BYTES + 1), request, digest)).toThrow();
});
