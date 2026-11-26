import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { preparePipeline, pipelineSelection, reviewPipeline, MAX_PIPELINE_RESULT_BYTES } from '../src/pdfChatPipeline';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: '😀 Application fee: INR 500 unless exempt.' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
];
const index = buildIndex(rows);
const answer = answerQuestion(index, 'Application fee?', 'both');
const request = preparePipeline(index, answer, 'full');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const digest = sha(request.text);
const ranks = { original: ['original:2:1', 'original:1:1'], revised: ['revised:1:1'] };
const selected = pipelineSelection(request, ranks);
const start = rows[0].text.indexOf('INR 500');
const raw = {
  format: 'noticebridge-chat-pipeline-result', version: 1, request_sha256: digest,
  ranking: { format: 'noticebridge-chat-embedding-result', version: 1,
    request_sha256: sha(request.embedding.text), model: 'embedding:latest',
    model_digest: 'a'.repeat(64), dimension: 2, candidate_count: 3, ranks, authority_verified: false },
  extractive: { format: 'noticebridge-chat-extractive-result', version: 1,
    request_sha256: sha(selected.text), model: 'answer:latest', model_digest: 'b'.repeat(64),
    proposal: { status: 'extract', spans: [{ id: 'original:1:1', start, end: start + 7 }] },
    authority_verified: false },
  authority_verified: false,
};
test('combined protocol checks both bindings and reconstructs original quote', async () => {
  const result = await reviewPipeline(encode(raw), request, digest);
  expect(result.selectionCount).toBe(3);
  expect(result.extractive.proposal.spans[0].text).toBe('INR 500');
  expect(result.extractive.proposal.spans[0].source).toBe(rows[0]);
  expect(result.extractive.missingRoles).toEqual(['revised']);
  expect(answer.citations).toEqual([rows[0], rows[2]]);
});
test('pipeline selection retains baseline order before dense ranks', () => {
  expect([...selected.allowed.keys()]).toEqual(['original:1:1', 'revised:1:1', 'original:2:1']);
});
test('valid abstention preserves all baseline citations', async () => {
  const result = await reviewPipeline(encode({ ...raw, extractive: { ...raw.extractive,
    proposal: { status: 'insufficient', spans: [] } } }), request, digest);
  expect(result.extractive.omittedBaseline).toEqual(answer.citations);
  expect(result.extractive.proposal.spans).toEqual([]);
});
for (const [name, value] of [
  ['outer hash', { ...raw, request_sha256: 'c'.repeat(64) }],
  ['embedding hash', { ...raw, ranking: { ...raw.ranking, request_sha256: 'c'.repeat(64) } }],
  ['selection hash', { ...raw, extractive: { ...raw.extractive, request_sha256: 'c'.repeat(64) } }],
  ['cross-source rank', { ...raw, ranking: { ...raw.ranking, ranks: { ...ranks, original: ['revised:1:1', 'original:1:1'] } } }],
  ['unknown quote', { ...raw, extractive: { ...raw.extractive, proposal: {
    status: 'extract', spans: [{ id: 'original:99:1', start: 0, end: 3 }] } } }],
  ['authority', { ...raw, authority_verified: true }],
  ['extra field', { ...raw, answer: 'invented' }],
]) {
  test('rejects ' + name, async () => {
    await expect(reviewPipeline(encode(value), request, digest)).rejects.toThrow();
  });
}
test('canonical outer result rejects duplicate keys and oversized data', async () => {
  await expect(reviewPipeline(encode(raw).replace('"version": 1,', '"version": 1, "version": 1,'), request, digest)).rejects.toThrow();
  await expect(reviewPipeline('x'.repeat(MAX_PIPELINE_RESULT_BYTES + 1), request, digest)).rejects.toThrow();
  await expect(reviewPipeline(encode(raw), request, 'd'.repeat(64))).rejects.toThrow();
});
test('new question cannot replay prior result', async () => {
  const next = preparePipeline(index, answerQuestion(index, 'Eligibility?', 'original'), 'full');
  await expect(reviewPipeline(encode(raw), next, sha(next.text))).rejects.toThrow();
});
