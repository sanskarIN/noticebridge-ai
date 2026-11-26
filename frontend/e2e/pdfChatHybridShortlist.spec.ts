import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { buildHybridShortlist, MAX_SHORTLIST } from '../src/pdfChatHybridShortlist';
import { prepareExperiment, reviewRanking } from '../src/pdfChatEmbeddingBridge';
import { passageId } from '../src/pdfChatResearch';

function rows(role: Passage['role'], count: number): Passage[] {
  return Array.from({ length: count }, (_, i) => ({
    role, page: i % 80 + 1, ordinal: Math.floor(i / 80) + 1,
    text: i % 13 === 0 ? 'Application fee: INR ' + (i + 100) :
      i % 7 === 0 ? 'Fee waiver conditions ' + i : 'Other printed notice text ' + i,
  }));
}
test('large scoped corpus exports bounded balanced candidates without changing strict answer', () => {
  const idx = buildIndex([...rows('original', 1000), ...rows('revised', 700)]);
  const answer = answerQuestion(idx, 'Application fee?', 'both');
  const before = JSON.stringify(answer);
  expect(() => prepareExperiment(idx, answer)).toThrow();
  const experiment = prepareExperiment(idx, answer, 'shortlist');
  expect(experiment.allowed.size).toBe(MAX_SHORTLIST);
  expect(experiment.shortlistCoverage?.map(side => [side.role, side.eligible, side.selected]))
    .toEqual([['original', 1000, 256], ['revised', 700, 256]]);
  expect(answer.citations.every(p => experiment.allowed.has(passageId(p)))).toBe(true);
  expect(JSON.stringify(answer)).toBe(before);
  expect(prepareExperiment(idx, answer, 'shortlist').text).toBe(experiment.text);
});
test('unused quota transfers to larger source', () => {
  const idx = buildIndex([...rows('original', 3), ...rows('revised', 80)]);
  const answer = answerQuestion(idx, 'Application fee?', 'both');
  const result = buildHybridShortlist(idx, answer, 16);
  expect(result.coverage.map(s => s.selected)).toEqual([3, 13]);
});
test('single source and page filter cannot leak other fragments', () => {
  const idx = buildIndex([...rows('original', 1600), ...rows('revised', 1600)]);
  const answer = answerScopedQuestions(idx, 'Application fee on page 5?', 'revised', ['original', 'revised'])[0];
  const result = buildHybridShortlist(idx, answer, 16);
  expect(result.entries).toHaveLength(16);
  expect(result.entries.every(e => e.source.role === 'revised' && e.source.page === 5)).toBe(true);
  expect(result.coverage[0].eligible).toBe(20);
});
test('page samples expose additional inspection leads without asserting relevance', () => {
  const idx = buildIndex(rows('original', 400));
  const answer = answerQuestion(idx, 'Application fee?', 'original');
  const result = buildHybridShortlist(idx, answer, 32);
  expect(result.coverage[0].reasons.page_sample).toBeGreaterThan(0);
  expect(result.coverage[0].selectedPages).toBeGreaterThan(1);
  expect(Object.values(result.coverage[0].reasons).reduce((a,b) => a+b,0)).toBe(32);
  expect(new Set(result.entries.map(e => passageId(e.source))).size).toBe(32);
});
test('partial lexical candidates do not replace abstention', () => {
  const idx = buildIndex(rows('original', 100));
  const answer = answerQuestion(idx, 'Fee waiver nonexistent qualifier?', 'original');
  expect(answer.kind).toBe('insufficient');
  const result = buildHybridShortlist(idx, answer, 16);
  expect(result.coverage[0].strict).toBe(0);
  expect(result.coverage[0].reasons.partial).toBeGreaterThan(0);
  expect(answer.citations).toEqual([]);
});
test('invalid budgets, forged baseline text and wrong physical page fail closed', () => {
  const idx = buildIndex(rows('original', 100));
  const answer = answerQuestion(idx, 'Application fee?', 'original');
  for (const budget of [0, 15, 513, 16.5, NaN]) {
    expect(() => buildHybridShortlist(idx, answer, budget)).toThrow();
  }
  expect(() => buildHybridShortlist(idx, { ...answer, pageFilter: 1 })).toThrow();
  expect(() => buildHybridShortlist(idx, { ...answer, citations: [{ ...answer.citations[0], text: 'forged' }] })).toThrow();
});
test('dense result can only reference candidates included in exact shortlist', () => {
  const idx = buildIndex(rows('original', 600));
  const answer = answerQuestion(idx, 'Application fee?', 'original');
  const experiment = prepareExperiment(idx, answer, 'shortlist');
  const ids = [...experiment.allowed.keys()].slice(0, 8);
  const excluded = idx.rows.find(row => !experiment.allowed.has(passageId(row.passage)))!;
  const digest = 'a'.repeat(64);
  const result = { format: 'noticebridge-chat-embedding-result', version: 1, request_sha256: digest,
    model: 'fixture:latest', model_digest: 'b'.repeat(64), dimension: 2,
    candidate_count: experiment.allowed.size, ranks: { original: ids }, authority_verified: false };
  const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  expect(reviewRanking(encode(result), experiment, digest).candidates.length).toBeGreaterThan(0);
  expect(() => reviewRanking(encode({ ...result, ranks: { original: [passageId(excluded.passage), ...ids.slice(1)] } }), experiment, digest)).toThrow();
});

test('maximum-sized index preserves both sources and all baseline citations', () => {
  const idx = buildIndex([...rows('original', 6000), ...rows('revised', 6000)]);
  const answer = answerQuestion(idx, 'Application fee?', 'both', true);
  const result = buildHybridShortlist(idx, answer);
  expect(result.entries).toHaveLength(512);
  expect(result.coverage.map(side => side.eligible)).toEqual([6000, 6000]);
  expect(result.coverage.map(side => side.selected)).toEqual([256, 256]);
  const selected = new Set(result.entries.map(entry => passageId(entry.source)));
  expect(answer.citations.every(source => selected.has(passageId(source)))).toBe(true);
  expect(result.coverage.every(side => side.selectedPages > 0 && side.selectedPages <= 80)).toBe(true);
});
test('every eligible fragment remains available for small scopes', () => {
  const idx = buildIndex([...rows('original', 8), ...rows('revised', 5)]);
  const answer = answerQuestion(idx, 'Application fee?', 'both');
  const result = buildHybridShortlist(idx, answer, 16);
  expect(result.entries).toHaveLength(13);
  expect(result.coverage.every(side => side.selected === side.eligible)).toBe(true);
});
test('requested missing source is explicitly reported without reallocating outside scope', () => {
  const idx = buildIndex(rows('original', 60));
  const answer = answerQuestion(idx, 'Application fee?', 'both');
  const result = buildHybridShortlist(idx, answer, 16);
  expect(result.coverage.map(side => [side.role, side.eligible, side.selected]))
    .toEqual([['original', 60, 16], ['revised', 0, 0]]);
  expect(answer.missingRoles).toEqual(['revised']);
});
