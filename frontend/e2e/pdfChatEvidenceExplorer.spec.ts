import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { explorerPage, highlightedSegments, literalRanges, parseReference, questionReferences,
  searchAllQuestionMatches, searchLiteral, searchReference, MAX_HIGHLIGHTS,
  MAX_LITERAL_CHARS, EXPLORER_PAGE_SIZE } from '../src/pdfChatEvidenceExplorer';

function row(text: string, page = 1, ordinal = 1, role: Passage['role'] = 'original'): Passage {
  return { text, page, ordinal, role };
}
const rows = [
  row('Clause 4.2(a): Application fee: Rs. 500'),
  row('See Clause 4.2(a) for exceptions.', 2),
  row('Clause 4.20: Examination fee: Rs. 800', 2, 2),
  row('Clause 4.2(b): Other fee', 3),
  row('Section 4.2(a): Different provision', 3, 2),
  row('Clause 4.2(a): Application fee: Rs. 350', 1, 1, 'revised'),
];
const index = buildIndex(rows);
test('literal search retains complete source text and exact UTF-16 offsets', () => {
  const line = row('😀 Fee: ₹500; Fee: ₹750');
  const hit = searchLiteral(buildIndex([line]), { scope: 'original' }, 'Fee').hits[0];
  expect(hit.source).toBe(line);
  expect(hit.ranges).toEqual([{ start: 3, end: 6 }, { start: 14, end: 17 }]);
  const segments = highlightedSegments(line.text, hit.ranges);
  expect(segments.map(part => part.text).join('')).toBe(line.text);
  expect(segments.filter(part => part.match).map(part => part.text)).toEqual(['Fee', 'Fee']);
});
test('literal search does not interpret regex or normalize Unicode', () => {
  const idx = buildIndex([row('a.b [x] $500 café Ｆｅｅ')]);
  for (const query of ['a.b', '[x]', '$500', 'café', 'Ｆｅｅ']) {
    expect(searchLiteral(idx, { scope: 'both' }, query).hits).toHaveLength(1);
  }
  for (const query of ['a.*b', 'cafe\u0301', 'Fee', 'CAFE']) {
    expect(searchLiteral(idx, { scope: 'both' }, query, true).hits).toHaveLength(0);
  }
});
test('ASCII folding does not change offsets or fold non-ASCII text', () => {
  const idx = buildIndex([row('Fee FEE fee É é İ i')]);
  expect(searchLiteral(idx, { scope: 'original' }, 'fee', true).hits[0].ranges)
    .toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
  expect(searchLiteral(idx, { scope: 'original' }, 'fee', false).hits[0].ranges)
    .toEqual([{ start: 8, end: 11 }]);
  expect(searchLiteral(idx, { scope: 'original' }, 'É', true).hits[0].ranges)
    .toEqual([{ start: 12, end: 13 }]);
});
test('literal matching never joins separate fragments or pages', () => {
  const idx = buildIndex([row('Application'), row('fee', 1, 2), row('fee', 2)]);
  expect(searchLiteral(idx, { scope: 'original' }, 'Application fee').hits).toEqual([]);
});
test('literal scope never substitutes another PDF or page', () => {
  expect(searchLiteral(index, { scope: 'revised', page: 1 }, 'Application fee').hits.map(h => h.source))
    .toEqual([rows[5]]);
  expect(searchLiteral(index, { scope: 'original', page: 2 }, 'Application fee').hits).toEqual([]);
  expect(searchLiteral(index, { scope: 'both' }, 'Application fee').countByRole)
    .toEqual({ original: 1, revised: 1 });
});
test('same source identity deduplicated, repeated text across fragments preserved', () => {
  const a = row('Application fee');
  const b = row('Application fee', 2);
  const c = row('Application fee', 1, 2);
  expect(searchLiteral(buildIndex([b, c, a, a]), { scope: 'original' }, 'fee').hits.map(h => h.source))
    .toEqual([a, c, b]);
});
test('literal bounds enforced even on empty index', () => {
  for (const text of ['', '   ', 'x'.repeat(MAX_LITERAL_CHARS + 1)]) {
    expect(() => searchLiteral(buildIndex([]), { scope: 'original' }, text)).toThrow();
  }
  for (const page of [0, 81, 1.5, NaN]) {
    expect(() => searchLiteral(index, { scope: 'both', page }, 'fee')).toThrow();
  }
  expect(literalRanges('a'.repeat(100), 'a')).toHaveLength(MAX_HIGHLIGHTS);
});
test('references distinguish exact identifiers, kinds and sources', () => {
  const ref = parseReference('Clause 4.2(a)');
  expect(ref).toEqual({ kind: 'clause', identifier: '4.2(a)' });
  const result = searchReference(index, { scope: 'both' }, ref);
  expect(result.hits.map(hit => hit.source)).toEqual([rows[0], rows[1], rows[5]]);
  expect(result.hits.map(hit => hit.startsWithReference)).toEqual([true, false, true]);
  expect(result.countByRole).toEqual({ original: 2, revised: 1 });
  expect(searchReference(index, { scope: 'original', page: 2 }, ref).hits.map(hit => hit.source))
    .toEqual([rows[1]]);
});
test('reference matching recognizes case but preserves printed text', () => {
  const source = row('CLAUSE 4.2(A): Condition');
  const hit = searchReference(buildIndex([source]), { scope: 'both' }, parseReference('clause 4.2(a)')).hits[0];
  expect(hit.source.text.slice(hit.ranges[0].start, hit.ranges[0].end)).toBe('CLAUSE 4.2(A)');
});
test('parent identifiers never match child or longer numeric identifiers', () => {
  const extra = row('Clause 4.2: Parent', 4);
  const idx = buildIndex([...rows, extra]);
  expect(searchReference(idx, { scope: 'both' }, parseReference('Clause 4.2')).hits.map(hit => hit.source))
    .toEqual([extra]);
  expect(searchReference(idx, { scope: 'both' }, parseReference('Clause 4')).hits).toEqual([]);
});
test('explicit reference kinds are not conflated', () => {
  expect(searchReference(index, { scope: 'both' }, parseReference('Section 4.2(a)')).hits.map(hit => hit.source))
    .toEqual([rows[4]]);
});
test('annexure and schedule allow bounded letter identifiers', () => {
  const list = [row('Annexure B: Documents'), row('Annexure BB: Form', 2), row('Schedule B-2: Calendar', 3)];
  const idx = buildIndex(list);
  expect(searchReference(idx, { scope: 'both' }, parseReference('Annexure B')).hits.map(hit => hit.source))
    .toEqual([list[0]]);
  expect(searchReference(idx, { scope: 'both' }, parseReference('Schedule B-2')).hits.map(hit => hit.source))
    .toEqual([list[2]]);
});
for (const query of ['4.2', 'Clause', 'Clauses 4 and 5', 'Clause 4.2(a) and 5',
  'Section foo', 'Clause 12345', 'Clause 4.2.', 'Clause 4.2(a', 'Clause 4.2(a)(b)(c)(d)(e)',
  'Annexure ABCDE', 'See Clause 4.2', 'Clause 4.2 or Section 3']) {
  test('rejects unsupported reference: ' + query, () => expect(() => parseReference(query)).toThrow());
}
test('question reference planning deduplicates and bounds explicit references', () => {
  expect(questionReferences('Compare Clause 4.2(a) and Clause 4.2(A) with Section 3?'))
    .toEqual([{ kind: 'clause', identifier: '4.2(a)' }, { kind: 'section', identifier: '3' }]);
  expect(questionReferences('What is the application fee of 500?')).toEqual([]);
  expect(questionReferences('Clause 1, Clause 2, Clause 3, Clause 4, Clause 5')).toEqual([]);
});
test('all strict matches reproduce ranking and source counts beyond four', () => {
  const lines = Array.from({ length: 17 }, (_, i) => row('Application fee: Rs. ' + (500 + i), i + 1));
  const revised = Array.from({ length: 5 }, (_, i) =>
    row('Application charges: Rs. ' + (300 + i), i + 1, 1, 'revised'));
  const idx = buildIndex([...lines, ...revised]);
  const answer = answerQuestion(idx, 'Application fee?', 'both');
  const all = searchAllQuestionMatches(idx, answer);
  expect(all.countByRole).toEqual(answer.matchedCounts);
  expect(all.hits).toHaveLength(22);
  expect(all.hits.filter(h => h.source.role === 'original').slice(0, 4).map(h => h.source))
    .toEqual(answer.citations.slice(0, 4));
  expect(all.hits.filter(h => h.source.role === 'revised').slice(0, 4).map(h => h.source))
    .toEqual(answer.citations.slice(4));
});
test('all strict matches enforce exact routed physical page and source', () => {
  const idx = buildIndex([row('Application fee: Rs. 500'), row('Application fee: Rs. 600', 2),
    row('Application fee: Rs. 300', 1, 1, 'revised')]);
  const answer = answerScopedQuestions(idx, 'Application fee in original notice on page 2?',
    'auto', ['original', 'revised'])[0];
  expect(searchAllQuestionMatches(idx, answer).hits.map(h => h.source.text))
    .toEqual(['Application fee: Rs. 600']);
  expect(() => searchAllQuestionMatches(idx, { ...answer, pageFilter: 1 })).toThrow();
});
test('contextual evidence is not promoted to strict matches', () => {
  const idx = buildIndex([row('Rural applicants'), row('Residence certificate', 1, 2)]);
  const answer = answerQuestion(idx, 'Rural residence certificate', 'original', true);
  expect(answer.contextGroups).toHaveLength(1);
  expect(searchAllQuestionMatches(idx, answer).hits).toEqual([]);
});
test('pagination retains all identities without overlap or omissions', () => {
  const lines = Array.from({ length: 39 }, (_, i) => row('Fee ' + i, i + 1));
  const hits = searchLiteral(buildIndex(lines), { scope: 'original' }, 'Fee').hits;
  const pages = Math.ceil(lines.length / EXPLORER_PAGE_SIZE);
  const all = Array.from({ length: pages }, (_, i) => explorerPage(hits, i + 1));
  expect(all.flatMap(page => page.hits.map(hit => hit.source))).toEqual(lines);
  expect(all[0].first).toBe(1);
  expect(all.at(-1)?.last).toBe(39);
  expect(() => explorerPage(hits, pages + 1)).toThrow();
  expect(explorerPage([], 1)).toEqual({ hits: [], page: 1, pages: 1, first: 0, last: 0 });
});
test('highlight reconstruction rejects out-of-range, overlapping or nonintegral spans', () => {
  for (const ranges of [
    [{ start: -1, end: 1 }], [{ start: 0, end: 10 }], [{ start: 1, end: 1 }],
    [{ start: 0.5, end: 1 }], [{ start: 0, end: 2 }, { start: 1, end: 3 }],
  ]) expect(() => highlightedSegments('abc', ranges)).toThrow();
  expect(highlightedSegments('abc', [])).toEqual([{ text: 'abc', match: false, start: 0 }]);
});
