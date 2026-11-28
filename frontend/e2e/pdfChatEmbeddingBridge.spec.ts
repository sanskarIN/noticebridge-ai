import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { prepareExperiment, reviewRanking, MAX_RANK_FILE } from '../src/pdfChatEmbeddingBridge';
import { answerScopedQuestions } from '../src/pdfChatInsights';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: Rs. 500' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: Rs. 350' },
  { role: 'revised', page: 2, ordinal: 1, text: 'Eligibility: Class 12' },
];
const index = buildIndex(rows);
const answer = answerQuestion(index, 'Application fee', 'both');
const experiment = prepareExperiment(index, answer);
const digest = 'a'.repeat(64);
const result = {
  format: 'noticebridge-chat-embedding-result', version: 1, request_sha256: digest,
  model: 'example-embedding:latest', model_digest: 'b'.repeat(64), dimension: 2,
  candidate_count: 4,
  ranks: { original: ['original:2:1', 'original:1:1'], revised: ['revised:1:1', 'revised:2:1'] },
  authority_verified: false,
};
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

test('request exports only the scoped source and page', () => {
  const selected = answerScopedQuestions(index, 'Application fee on page 1?', 'original', ['original', 'revised'])[0];
  const request = JSON.parse(prepareExperiment(index, selected).text);
  expect(request.passages).toEqual([{ id: 'original:1:1', text: rows[0].text }]);
  expect(request.question).toBe(selected.question);
  expect(Object.keys(request)).toEqual(['format', 'version', 'question', 'passages']);
});
test('rank import resolves local passages and combines provenance without changing answer', () => {
  const review = reviewRanking(encode(result), experiment, digest);
  expect(review.candidates.map(row => row.passage)).toEqual([rows[0], rows[1], rows[2], rows[3]]);
  expect(review.candidates[0].ranks.map(rank => rank.channel)).toEqual(['baseline', 'dense']);
  expect(answer.citations).toEqual([rows[0], rows[2]]);
});
test('no hidden truncation of an oversized candidate set', () => {
  const many = Array.from({ length: 513 }, (_, i): Passage => ({
    role: 'original', page: 1, ordinal: i + 1, text: 'Application fee: Rs. 500',
  }));
  const large = buildIndex(many);
  expect(() => prepareExperiment(large, answerQuestion(large, 'fee', 'original'))).toThrow();
});
test('empty candidate set cannot be exported', () => {
  const empty = buildIndex([]);
  expect(() => prepareExperiment(empty, answerQuestion(empty, 'fee', 'original'))).toThrow();
});
for (const [name, update] of [
  ['hash', { request_sha256: 'c'.repeat(64) }],
  ['count', { candidate_count: 5 }],
  ['authority', { authority_verified: true }],
  ['model', { model: 'https://example.com/model' }],
  ['cloud model', { model: 'example:cloud' }],
  ['digest', { model_digest: 'bad' }],
  ['dimension', { dimension: 0 }],
  ['extra answer', { answer: 'invented' }],
  ['duplicate candidate', { ranks: { ...result.ranks, original: ['original:1:1', 'original:1:1'] } }],
  ['foreign role', { ranks: { ...result.ranks, original: ['revised:1:1', 'original:1:1'] } }],
  ['unknown identity', { ranks: { ...result.ranks, original: ['original:7:1', 'original:1:1'] } }],
  ['partial rank', { ranks: { ...result.ranks, original: ['original:1:1'] } }],
  ['missing role', { ranks: { original: result.ranks.original } }],
] as const) {
  test('rejects incompatible result: ' + name, () => {
    expect(() => reviewRanking(encode({ ...result, ...update }), experiment, digest)).toThrow();
  });
}
test('canonical result check rejects duplicate keys and oversized data', () => {
  expect(() => reviewRanking(encode(result).replace('"version": 1,', '"version": 1, "version": 1,'), experiment, digest)).toThrow();
  expect(() => reviewRanking(JSON.stringify(result), experiment, digest)).toThrow();
  expect(() => reviewRanking(' '.repeat(MAX_RANK_FILE + 1), experiment, digest)).toThrow();
});
