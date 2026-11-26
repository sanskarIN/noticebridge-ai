import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { canSearchCrossPage, crossPageLeads, MAX_CROSS_PAGE_CANDIDATES } from '../src/pdfChatCrossPage';

function line(text: string, page: number, ordinal = 1, role: Passage['role'] = 'original'): Passage {
  return { text, page, ordinal, role };
}
const rural = line('Applicants from rural districts', 1);
const certificate = line('A residence certificate must be submitted', 3);
const question = 'Rural residence certificate?';

test('separate pages provide verbatim review leads without changing strict evidence', () => {
  const idx = buildIndex([rural, certificate]);
  const answer = answerQuestion(idx, question, 'original', true);
  const snapshot = JSON.stringify(answer);
  expect(answer.kind).toBe('insufficient');
  expect(canSearchCrossPage(idx, answer)).toBe(true);
  expect(crossPageLeads(idx, answer)).toEqual([{ role: 'original', limited: false, leads: [
    { source: rural, matchedTerms: ['rural'] },
    { source: certificate, matchedTerms: ['residence', 'certificate'] },
  ] }]);
  expect(JSON.stringify(answer)).toBe(snapshot);
  expect(answer.citations).toEqual([]);
  expect(answer.printedFields).toEqual([]);
});

test('never combines different document versions', () => {
  const idx = buildIndex([rural, { ...certificate, role: 'revised' }]);
  const answer = answerQuestion(idx, question, 'both', true);
  expect(canSearchCrossPage(idx, answer)).toBe(false);
  expect(crossPageLeads(idx, answer)).toEqual([]);
});

test('separate source pairs remain separate in both-PDF scope', () => {
  const idx = buildIndex([rural, certificate,
    { ...rural, role: 'revised', page: 2 },
    { ...certificate, role: 'revised', page: 4 }]);
  const answer = answerQuestion(idx, question, 'both', true);
  expect(crossPageLeads(idx, answer).map(result => [result.role, result.leads.map(lead => lead.source.page)]))
    .toEqual([['original', [1, 3]], ['revised', [2, 4]]]);
});

test('never broadens a physical page filter', () => {
  const idx = buildIndex([rural, certificate]);
  const answer = answerScopedQuestions(idx, 'Rural residence certificate on page 1?', 'original', ['original'], true)[0];
  expect(canSearchCrossPage(idx, answer)).toBe(false);
  expect(crossPageLeads(idx, answer)).toEqual([]);
});

test('never replaces a full passage match or a successful nearby window', () => {
  const idx = buildIndex([rural, certificate, line('Rural residence certificate', 5)]);
  const answer = answerQuestion(idx, question, 'original', true);
  expect(crossPageLeads(idx, answer)).toEqual([]);
  const adjacent = buildIndex([rural, { ...certificate, page: 1, ordinal: 2 }, certificate]);
  const contextual = answerQuestion(adjacent, question, 'original', true);
  expect(contextual.contextGroups).toHaveLength(1);
  expect(canSearchCrossPage(adjacent, contextual)).toBe(false);
});

test('fallback can explore only the unanswered side of a successful two-source search', () => {
  const idx = buildIndex([rural, certificate, line('Rural residence certificate', 1, 1, 'revised')]);
  const answer = answerQuestion(idx, question, 'both', true);
  expect(answer.missingRoles).toEqual(['original']);
  expect(crossPageLeads(idx, answer).map(result => result.role)).toEqual(['original']);
});

test('two partial matches must collectively contain every query term', () => {
  const idx = buildIndex([rural, certificate]);
  expect(crossPageLeads(idx, answerQuestion(idx, 'Rural residence certificate deadline?', 'original'))).toEqual([]);
});

test('same-page fragments and one-word queries are not cross-page leads', () => {
  const idx = buildIndex([rural, { ...certificate, page: 1, ordinal: 3 }]);
  expect(crossPageLeads(idx, answerQuestion(idx, question, 'original'))).toEqual([]);
  expect(crossPageLeads(idx, answerQuestion(idx, 'Rural?', 'original'))).toEqual([]);
});

test('equivalent masks on the same page use shortest original text and stable ordering', () => {
  const short = line('Rural applicants', 1, 3);
  const idx = buildIndex([certificate, rural, short, short]);
  const a = answerQuestion(idx, question, 'original');
  expect(crossPageLeads(idx, a)[0].leads[0].source).toBe(short);
  const reversed = buildIndex([short, rural, certificate]);
  expect(crossPageLeads(reversed, answerQuestion(reversed, question, 'original')))
    .toEqual(crossPageLeads(idx, a));
});

test('candidate ceiling is explicit and does not convert a bounded miss into a claim', () => {
  const terms = ['rural', 'residence', 'certificate', 'deadline', 'fee', 'interview', 'exam', 'venue'];
  const rows: Passage[] = [];
  for (let mask = 1; mask <= MAX_CROSS_PAGE_CANDIDATES + 2; mask++) {
    rows.push(line(terms.filter((_, i) => mask & (1 << i)).join(' '), 1, mask));
  }
  rows.push(line('Rural residence', 2));
  const idx = buildIndex(rows);
  const answer = answerQuestion(idx, terms.join(' '), 'original');
  const result = crossPageLeads(idx, answer);
  expect(result[0].limited).toBe(true);
  expect(result[0].leads.length).toBeLessThanOrEqual(2);
});

test('long queries remain outside the bounded fallback', () => {
  const idx = buildIndex([rural, certificate]);
  const answer = answerQuestion(idx, Array.from({ length: 17 }, (_, i) => 'term' + i).join(' '), 'original');
  expect(canSearchCrossPage(idx, answer)).toBe(false);
  expect(crossPageLeads(idx, answer)).toEqual([]);
});
