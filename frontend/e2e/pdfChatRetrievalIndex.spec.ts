import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, contextualMatches, knownQuestionField, pageScopedIndex,
  queryTerms, rankedMatches, MAX_PASSAGES, type Passage, type Role, type SearchIndex } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { searchAllQuestionMatches } from '../src/pdfChatEvidenceExplorer';

const roles: Role[] = ['original', 'revised'];
function row(text: string, page: number, ordinal: number, role: Role = 'original'): Passage {
  return { text, page, ordinal, role };
}
// A spread intentionally uses the existing exhaustive compatibility path.
const scan = (index: SearchIndex): SearchIndex => ({ ...index });
const queries = [
  'application fee', 'deadline', 'examination fee', 'application opening date',
  'rural residence certificate', 'application fee for rural applicants',
  'date of examination', 'eligibility', 'nothing anywhere', 'constructor',
  'résumé', 'café', 'Ｆｅｅ', 'application fee fee',
];
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
}
function fixture(count: number, seed: number): Passage[] {
  const random = seeded(seed);
  const texts = [
    'Application charges: Rs. 500', 'Application fee: Rs. 350',
    'Application last date: 19 December 2026', 'Educational qualification: Class 12',
    'Application opening date: 1 December 2026', 'Examination fee: Rs. 800',
    'Date of examination: 20 December 2026', 'Rural applicants', 'Residence certificate',
    'Application fee for rural applicants: Rs. 100', 'Résumé and café', 'Ｆｅｅ',
    'Unrelated administrative text', 'Eligibility: Class 12', 'constructor',
  ];
  return Array.from({ length: count }, (_, i) => row(texts[random() % texts.length],
    1 + random() % 80, 1 + Math.floor(i / 80), roles[random() % roles.length]));
}
test('postings preserve exact rank order, duplicate policy and original references', () => {
  const first = row('Application fee: Rs. 500', 2, 3);
  const equal = { ...first };
  const differentPage = { ...first, page: 3 };
  const otherRole = { ...first, role: 'revised' as const };
  const index = buildIndex([differentPage, first, equal, otherRole]);
  const words = queryTerms('application fee');
  const field = knownQuestionField(words);
  const actual = rankedMatches(index, words, 'original', field);
  expect(actual).toEqual([first, differentPage]);
  expect(actual[0]).toBe(first);
  expect(actual[1]).toBe(differentPage);
  expect(rankedMatches(index, words, 'revised', field)).toEqual([otherRole]);
  expect(actual).toEqual(rankedMatches(scan(index), words, 'original', field));
});
test('field alias postings remain eligible with missing lexical terms', () => {
  const alias = row('Educational qualification: Class 12', 1, 1);
  const literal = row('Eligibility: Class 10', 1, 2);
  const index = buildIndex([alias, literal]);
  // Direct ranker call ensures field union is exercised even when no word
  // exists in either posting. This is not a new public question expansion.
  const field = knownQuestionField(queryTerms('eligibility'));
  expect(field).not.toBeNull();
  expect(rankedMatches(index, ['not-present'], 'original', field)).toEqual([alias, literal]);
  expect(rankedMatches(index, ['not-present'], 'original', null)).toEqual([]);
  expect(rankedMatches(index, [], 'original', null)).toEqual([alias, literal]);
});
test('lexical conjunction never drops a qualifier just because the field is recognized elsewhere', () => {
  const general = row('Application fee: Rs. 500', 1, 1);
  const rural = row('Application fee for rural applicants: Rs. 100', 1, 2);
  const revised = row('Application fee for rural applicants: Rs. 75', 1, 1, 'revised');
  const result = answerQuestion(buildIndex([general, rural, revised]), 'application fee rural applicants', 'both');
  expect(result.citations).toEqual([rural, revised]);
  expect(result.matchedCounts).toEqual({ original: 1, revised: 1 });
});
for (const seed of [1, 7, 137, 20261128]) {
  test('deterministic mixed-corpus differential ranking seed ' + seed, () => {
    const index = buildIndex(fixture(640, seed));
    for (const question of queries) {
      for (const role of roles) {
        const words = queryTerms(question), field = knownQuestionField(words);
        const actual = rankedMatches(index, words, role, field);
        const expected = rankedMatches(scan(index), words, role, field);
        expect(actual).toEqual(expected);
        expect(actual.every((source, i) => source === expected[i])).toBe(true);
        expect(contextualMatches(index, words, role)).toEqual(contextualMatches(scan(index), words, role));
      }
      for (const context of [false, true]) {
        expect(answerQuestion(index, question, 'both', context))
          .toEqual(answerQuestion(scan(index), question, 'both', context));
      }
    }
  });
}
test('page views preserve corpus statistics, role isolation and evidence explorer equivalence', () => {
  const rows = [row('Application fee: Rs. 500', 1, 1),
    row('Application fee: Rs. 300', 2, 1), row('Application fee: Rs. 200', 2, 1, 'revised'),
    row('Rural applicants', 2, 2), row('Residence certificate', 2, 3)];
  const index = buildIndex(rows);
  const page = pageScopedIndex(index, 2);
  expect(pageScopedIndex(index, 2)).toBe(page);
  expect(page.df).toBe(index.df);
  expect(page.average).toBe(index.average);
  expect(page.corpusSize).toBe(index.corpusSize);
  expect(page.rows.map(x => x.passage)).toEqual(rows.slice(1));
  const selected = answerScopedQuestions(index, 'Application fee on page 2?', 'both', roles)[0];
  expect(selected.citations).toEqual(rows.slice(1, 3));
  expect(searchAllQuestionMatches(index, selected).hits.map(x => x.source)).toEqual(selected.citations);
  expect(selected).toEqual(answerScopedQuestions(scan(index), 'Application fee on page 2?', 'both', roles)[0]);
  const contextual = answerScopedQuestions(index, 'Rural residence certificate on page 2?', 'original', roles, true)[0];
  expect(contextual.citations).toEqual(rows.slice(3));
  expect(contextual.printedFields).toEqual([]);
  expect(answerQuestion(pageScopedIndex(index, 80), 'application fee', 'both').kind).toBe('insufficient');
  for (const invalid of [0, -1, 81, 1.5, NaN, Infinity]) expect(() => pageScopedIndex(index, invalid)).toThrow();
});
test('page cache is bounded, recent views reused, and evicted views can still be used', () => {
  const index = buildIndex(fixture(320, 42));
  const first = pageScopedIndex(index, 1);
  const second = pageScopedIndex(index, 2);
  for (let p = 3; p <= 8; p++) pageScopedIndex(index, p);
  expect(pageScopedIndex(index, 2)).toBe(second);
  pageScopedIndex(index, 9);
  expect(pageScopedIndex(index, 2)).toBe(second);
  expect(pageScopedIndex(index, 1)).not.toBe(first);
  expect(answerQuestion(first, 'fee', 'both')).toEqual(answerQuestion(pageScopedIndex(index, 1), 'fee', 'both'));
});
test('foreign filtered indexes cannot inherit stale candidate postings', () => {
  const index = buildIndex([row('Application fee: Rs. 500', 1, 1),
    row('Application fee: Rs. 350', 2, 1)]);
  const filtered = { ...index, rows: index.rows.slice(1) };
  expect(answerQuestion(filtered, 'application fee', 'original').citations)
    .toEqual([index.rows[1].passage]);
  expect(answerQuestion(pageScopedIndex(filtered, 1), 'application fee', 'original').kind).toBe('insufficient');
  expect(answerQuestion(index, 'application fee', 'original').citations).toHaveLength(2);
});
test('geometry and page boundaries are unchanged by precomputed reading order', () => {
  const rows = [
    { ...row('Residence certificate', 1, 2), position: { x0: 300, x1: 400, y: 200, height: 10 } },
    { ...row('Rural applicants', 1, 1), position: { x0: 10, x1: 100, y: 212, height: 10 } },
    row('Rural applicants', 2, 2), row('Residence certificate', 2, 3),
    row('Rural applicants', 3, 1), row('Residence certificate', 4, 2),
  ];
  const index = buildIndex(rows);
  const words = queryTerms('rural residence certificate');
  expect(contextualMatches(index, words, 'original')).toEqual([[rows[2], rows[3]]]);
  expect(contextualMatches(index, words, 'original')).toEqual(contextualMatches(scan(index), words, 'original'));
});
test('maximum corpus rare queries inspect only the rare posting candidates', () => {
  const rows = Array.from({ length: MAX_PASSAGES }, (_, i) => row(
    i === 123 ? 'Raremarker special permit' : 'Common administrative notice ' + (i % 50),
    1 + Math.floor(i / 150), 1 + i % 150));
  const index = buildIndex(rows);
  let checks = 0;
  // Count membership operations, not wall-clock time (which is noisy in CI).
  for (const entry of index.rows) {
    const has = entry.counts.has.bind(entry.counts);
    entry.counts.has = key => { checks++; return has(key); };
  }
  const terms = queryTerms('raremarker special permit');
  const actual = rankedMatches(index, terms, 'original', null);
  const acceleratedChecks = checks;
  checks = 0;
  const expected = rankedMatches(scan(index), terms, 'original', null);
  expect(actual).toEqual([rows[123]]);
  expect(actual).toEqual(expected);
  expect(acceleratedChecks).toBe(3);
  expect(checks).toBeGreaterThanOrEqual(MAX_PASSAGES);
  checks = 0;
  expect(rankedMatches(index, ['absentword'], 'original', null)).toEqual([]);
  expect(checks).toBe(0);
});
test('empty index and repeated Unicode queries preserve output', () => {
  for (const index of [buildIndex([]), buildIndex(fixture(16, 9))]) {
    for (const q of ['Ｆｅｅ', 'résumé', 'café', '???', 'what']) {
      expect(answerQuestion(index, q, 'both', true)).toEqual(answerQuestion(scan(index), q, 'both', true));
    }
  }
});
