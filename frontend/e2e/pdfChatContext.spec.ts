import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, contextualMatches, queryTerms, type Passage } from '../src/pdfChatCore';

function line(text: string, ordinal: number, page = 1, role: Passage['role'] = 'original'): Passage {
  return { role, page, ordinal, text };
}
const rows = [
  line('Fictional notice', 1),
  line('Applications from rural districts', 2),
  line('must include a residence certificate', 3),
  line('Application fee: Rs. 500', 4),
];

test('strict search still abstains on a split query', () => {
  const answer = answerQuestion(buildIndex(rows), 'rural residence certificate', 'original');
  expect(answer.kind).toBe('insufficient');
  expect(answer.contextGroups).toEqual([]);
});
test('nearby lines collectively retrieve all query terms with separate citations', () => {
  const answer = answerQuestion(buildIndex(rows), 'rural residence certificate', 'original', true);
  expect(answer.kind).toBe('passages');
  expect(answer.citations).toEqual([rows[1], rows[2]]);
  expect(answer.contextGroups).toEqual([{ role: 'original', page: 1, citations: [1, 2] }]);
  expect(answer.printedFields).toEqual([]);
  expect(answer.missingRoles).toEqual([]);
  expect(answer.matchedCounts.original).toBe(0);
});
test('strict matches take priority over contextual matches', () => {
  const exact = line('Rural residence certificate: required', 7);
  const answer = answerQuestion(buildIndex([...rows, exact]), 'rural residence certificate', 'original', true);
  expect(answer.citations).toEqual([exact]);
  expect(answer.contextGroups).toEqual([]);
  expect(answer.printedFields[0]?.value).toBe('required');
});
test('three fragments may cover a query without creating a joined quote', () => {
  const parts = [line('Rural applicants', 1), line('Supporting materials', 2), line('Residence certificate', 3)];
  const answer = answerQuestion(buildIndex(parts), 'rural supporting certificate', 'original', true);
  expect(answer.citations).toEqual(parts);
  expect(answer.contextGroups[0]?.citations).toEqual([1, 2, 3]);
  expect(answer.printedFields).toEqual([]);
});
test('minimal windows omit noncontributing endpoints', () => {
  const parts = [line('Rural applicants', 1), line('Rural residents', 2), line('Residence certificate', 3)];
  const answer = answerQuestion(buildIndex(parts), 'rural residence certificate', 'original', true);
  expect(answer.citations).toEqual(parts.slice(1));
});
test('fragments must not cross physical pages', () => {
  const parts = [line('Rural applicants', 1, 1), line('Residence certificate', 2, 2)];
  expect(answerQuestion(buildIndex(parts), 'rural residence certificate', 'original', true).kind)
    .toBe('insufficient');
});
test('fragments must not cross source roles', () => {
  const parts = [line('Rural applicants', 1), line('Residence certificate', 2, 1, 'revised')];
  const answer = answerQuestion(buildIndex(parts), 'rural residence certificate', 'both', true);
  expect(answer.kind).toBe('insufficient');
  expect(answer.missingRoles).toEqual(['original', 'revised']);
});
test('omitted ordinals prohibit bridging missing or oversized text', () => {
  const parts = [line('Rural applicants', 1), line('Residence certificate', 3)];
  expect(answerQuestion(buildIndex(parts), 'rural residence certificate', 'original', true).kind)
    .toBe('insufficient');
});
test('four-line windows are not constructed', () => {
  const parts = [line('Rural applicants', 1), line('Other details', 2),
    line('More details', 3), line('Residence certificate', 4)];
  expect(answerQuestion(buildIndex(parts), 'rural residence certificate', 'original', true).kind)
    .toBe('insufficient');
});
test('context window size remains bounded', () => {
  const parts = [line('Rural ' + 'x'.repeat(800), 1), line('Certificate ' + 'x'.repeat(800), 2)];
  expect(answerQuestion(buildIndex(parts), 'rural certificate', 'original', true).kind)
    .toBe('insufficient');
});
test('an absent term prevents contextual matching', () => {
  expect(answerQuestion(buildIndex(rows), 'rural residence certificate passport', 'original', true).kind)
    .toBe('insufficient');
});
test('one term and excessive query terms are not contextualized', () => {
  const index = buildIndex(rows);
  expect(contextualMatches(index, ['rural'], 'original')).toEqual([]);
  expect(contextualMatches(index, Array.from({ length: 17 }, (_, i) => String(i)), 'original')).toEqual([]);
});
test('at most two non-overlapping contextual groups are shown per role', () => {
  const parts = Array.from({ length: 4 }, (_, i) => [
    line('Rural applicants', 1, i + 1), line('Residence certificate', 2, i + 1),
  ]).flat();
  const answer = answerQuestion(buildIndex(parts), 'rural residence certificate', 'original', true);
  expect(answer.contextGroups).toHaveLength(2);
  expect(answer.citations).toEqual(parts.slice(0, 4));
  expect(answer.contextGroups.map(group => group.citations)).toEqual([[1, 2], [3, 4]]);
});
test('overlapping groups cannot repeat a citation', () => {
  const parts = [line('Rural applicants', 1), line('Residence certificate', 2),
    line('Rural households', 3)];
  const answer = answerQuestion(buildIndex(parts), 'rural residence certificate', 'original', true);
  expect(answer.contextGroups).toHaveLength(1);
  expect(answer.citations).toHaveLength(2);
});
test('source order is deterministic even if input rows are shuffled', () => {
  const index = buildIndex([...rows].reverse());
  expect(contextualMatches(index, queryTerms('rural residence certificate'), 'original')).toEqual([
    [rows[1], rows[2]],
  ]);
});
test('mixed strict and contextual results preserve role-specific citation offsets', () => {
  const exact = line('Rural residence certificate: required', 1, 1, 'original');
  const parts = [exact, line('Rural applicants', 1, 2, 'revised'),
    line('Residence certificate', 2, 2, 'revised')];
  const answer = answerQuestion(buildIndex(parts), 'rural residence certificate', 'both', true);
  expect(answer.citations).toEqual(parts);
  expect(answer.contextGroups).toEqual([{ role: 'revised', page: 2, citations: [2, 3] }]);
  expect(answer.printedFields).toEqual([{ citation: 1, label: 'Rural residence certificate', value: 'required' }]);
});
test('a colon field from only part of a contextual answer is not promoted', () => {
  const parts = [line('Rural applicants', 1), line('Residence certificate: mandatory', 2)];
  const answer = answerQuestion(buildIndex(parts), 'rural residence certificate', 'original', true);
  expect(answer.printedFields).toEqual([]);
});
