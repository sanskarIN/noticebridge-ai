import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { analyzeSearchRecovery, oneSpellingEdit, recoveryPage,
  MAX_RECOVERY_LEADS, MAX_RECOVERY_VOCABULARY, RECOVERY_PAGE_SIZE } from '../src/pdfChatSearchRecovery';

const p = (text: string, ordinal = 1, page = 1, role: Passage['role'] = 'original'): Passage =>
  ({ text, ordinal, page, role });
const source = [
  p('Application deadline: 19 December 2026'),
  p('Application fee: INR 500', 2),
  p('Rural applicants must submit a certificate', 3),
  p('A residence certificate is required', 1, 2),
  p('Application deadline: 20 December 2026', 2, 2),
  p('Application deadlien for revised notice', 1, 1, 'revised'),
  p('Application fee: INR 350', 2, 1, 'revised'),
];
const index = buildIndex(source);
function search(question: string, scope: 'original' | 'revised' | 'both' | 'auto' = 'original') {
  const answer = answerScopedQuestions(index, question, scope, ['original', 'revised'], true)[0];
  return { answer, diagnostics: analyzeSearchRecovery(index, answer) };
}

test('diagnostics distinguish absent terms and preserve full original answer object', () => {
  const { answer, diagnostics } = search('Application deadlien?');
  expect(answer.kind).toBe('insufficient');
  expect(answer.citations).toEqual([]);
  expect(diagnostics.terms).toEqual(['application', 'deadlien']);
  const side = diagnostics.sides[0];
  expect(side).toMatchObject({
    role: 'original', state: 'missing_terms', indexedFragments: 5, indexedPages: 2,
    fullLexicalFragments: 0, recognizedFieldFragments: 0, partialFragments: 3, partialPages: 2,
    partialHistogram: [2, 3, 0], leadsTruncated: false,
  });
  expect(side.coverage).toEqual([
    { term: 'application', fragments: 3, pages: 2 },
    { term: 'deadlien', fragments: 0, pages: 0 },
  ]);
  expect(side.suggestions).toContainEqual({ term: 'deadlien', candidate: 'deadline',
    fragments: 2, question: 'Application deadline?' });
  expect(side.leads.every(lead => lead.matchedTerms.join() === 'application' &&
    lead.missingTerms.join() === 'deadlien')).toBe(true);
  expect(side.leads.every(lead => lead.source.role === 'original')).toBe(true);
  expect(answer.citations).toEqual([]);
  expect(answer.printedFields).toEqual([]);
});
test('physical page restriction is never widened for diagnostics or spelling', () => {
  const { diagnostics } = search('Application deadlien on page 2?');
  expect(diagnostics.page).toBe(2);
  const side = diagnostics.sides[0];
  expect(side.indexedFragments).toBe(2);
  expect(side.coverage[0]).toMatchObject({ fragments: 1, pages: 1 });
  expect(side.leads.map(lead => lead.source)).toEqual([source[4]]);
  expect(side.suggestions).toContainEqual({ term: 'deadlien', candidate: 'deadline',
    fragments: 1, question: 'Application deadline on page 2?' });
  const none = search('Application deadlien on page 3?').diagnostics.sides[0];
  expect(none.state).toBe('no_indexed_text');
  expect(none.leads).toEqual([]);
  expect(none.suggestions).toEqual([]);
});
test('both-source diagnostics remain independent when a typo is printed in one PDF', () => {
  const { diagnostics, answer } = search('Application deadlien in both PDFs?', 'auto');
  expect(diagnostics.scope).toBe('both');
  expect(diagnostics.sides.map(side => side.state)).toEqual(['missing_terms', 'full_match_available']);
  expect(diagnostics.sides[0].suggestions[0].question).toBe('Application deadline in both PDFs?');
  expect(diagnostics.sides[1].suggestions).toEqual([]);
  expect(diagnostics.sides[1].fullLexicalFragments).toBe(1);
  expect(answer.citations).toEqual([source[5]]);
});
test('terms split across fragments are distinguished from completely missing wording', () => {
  const { answer, diagnostics } = search('Rural residence certificate?');
  expect(diagnostics.sides[0].state).toBe('terms_separated');
  expect(diagnostics.sides[0].coverage.every(term => term.fragments > 0)).toBe(true);
  expect(diagnostics.sides[0].leads.every(lead => lead.missingTerms.length > 0)).toBe(true);
  expect(answer.kind).toBe('insufficient');
  const empty = search('Reimbursement procedure?').diagnostics.sides[0];
  expect(empty.state).toBe('no_term_overlap');
  expect(empty.partialFragments).toBe(0);
});
test('recognized printed field matches are tracked separately from lexical matches', () => {
  const alternate = buildIndex([p('Last date to apply: 19 December 2026')]);
  const answer = answerScopedQuestions(alternate, 'Application deadline?', 'original', ['original'])[0];
  const side = analyzeSearchRecovery(alternate, answer).sides[0];
  expect(side.state).toBe('full_match_available');
  expect(side.recognizedFieldFragments).toBe(1);
  expect(side.partialFragments).toBe(0);
  expect(side.suggestions).toEqual([]);
});
test('empty search terms and excessive query length in terms remain explicit', () => {
  const none = search('What?').diagnostics.sides[0];
  expect(none.state).toBe('no_search_terms');
  expect(none.coverage).toEqual([]);
  const many = search(Array.from({ length: 17 }, (_, i) => 'term' + i).join(' ') + '?').diagnostics.sides[0];
  expect(many.state).toBe('query_budget');
  expect(many.leads).toEqual([]);
  expect(many.suggestions).toEqual([]);
});
for (const [a,b] of [
  ['deadlien','deadline'], ['certifcate','certificate'], ['eligibility','eligibilty'],
  ['applicatoin','application'], ['paymant','payment'], ['document','documen'],
]) {
  test('accepts one spelling edit ' + a + ' -> ' + b, () => {
    expect(oneSpellingEdit(a,b)).toBe(true);
    expect(oneSpellingEdit(b,a)).toBe(true);
  });
}
for (const [a,b] of [
  ['deadline','deadline'], ['deadline','dead'], ['deadline','headlines'],
  ['fee','feet'], ['50000','50001'], ['résumé','resume'], ['abcde','fghij'],
  ['abcdef','cbadef'], ['abcdef','abXXef'],
]) {
  test('rejects non-single eligible edit ' + a + ' -> ' + b, () => {
    expect(oneSpellingEdit(a,b)).toBe(false);
  });
}
test('spelling never rewrites numeric terms, repeated occurrences, protected route words or existing terms', () => {
  const corpus = buildIndex([p('Application deadline 12346 before revision'), p('Application deadlines certificate', 2)]);
  const diagnose = (question: string) => analyzeSearchRecovery(corpus,
    answerScopedQuestions(corpus, question, 'original', ['original'])[0]).sides[0];
  expect(diagnose('Application 12345?').suggestions).toEqual([]);
  expect(diagnose('Deadlien deadlien?').suggestions).toEqual([]);
  expect(diagnose('Application befor deadline?').suggestions).toEqual([]);
  expect(diagnose('Application deadline deadlien?').suggestions).toEqual([]);
});
test('spelling suggestions preserve explicit numeric and category qualifiers in the proposed draft', () => {
  const { diagnostics } = search('Application deadlien for rural applicants in the original notice on page 1?','auto');
  expect(diagnostics.sides[0].suggestions).toContainEqual({
    term: 'deadlien', candidate: 'deadline', fragments: 1,
    question: 'Application deadline for rural applicants in the original notice on page 1?',
  });
});
test('more complete partial leads rank first, then locally rare terms, then physical order', () => {
  const rows = [
    p('Application certificate', 3), p('Application', 2), p('Application', 1),
    p('Rural', 4), p('Unrelated', 5), p('Certificate', 6),
  ];
  const local = buildIndex(rows);
  const answer = answerQuestion(local, 'Application certificate rural?', 'original');
  const side = analyzeSearchRecovery(local, answer).sides[0];
  expect(side.leads.map(lead => lead.source.ordinal)).toEqual([3, 4, 6, 1, 2]);
  expect(side.partialHistogram).toEqual([1, 4, 1, 0]);
  expect(analyzeSearchRecovery(buildIndex([...rows].reverse()), answer)).toEqual(analyzeSearchRecovery(local, answer));
});
test('all physical occurrences count independently, display cap and pagination are explicit', () => {
  const rows = Array.from({ length: MAX_RECOVERY_LEADS + 15 }, (_, i) => p('Application', i + 1));
  const local = buildIndex(rows);
  const result = analyzeSearchRecovery(local, answerQuestion(local, 'Application deadlien?', 'original')).sides[0];
  expect(result.partialFragments).toBe(rows.length);
  expect(result.coverage[0].fragments).toBe(rows.length);
  expect(result.leads).toHaveLength(MAX_RECOVERY_LEADS);
  expect(result.leadsTruncated).toBe(true);
  expect(recoveryPage(result.leads, 1).leads).toHaveLength(RECOVERY_PAGE_SIZE);
  expect(recoveryPage(result.leads, 999)).toMatchObject({ page: 20, pages: 20 });
  expect(recoveryPage([], 1)).toEqual({ page: 1, pages: 1, leads: [] });
  expect(() => recoveryPage(result.leads, 0)).toThrow();
});
function word(value: number) {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix = String.fromCharCode(97 + value % 26) + suffix;
    value = Math.floor(value / 26);
  }
  return 'vocab' + suffix;
}
test('vocabulary over-budget withholds suggestions but retains exact counts', () => {
  const rows: Passage[] = [];
  for (let start = 0; start <= MAX_RECOVERY_VOCABULARY; start += 60) {
    const words = Array.from({ length: Math.min(60, MAX_RECOVERY_VOCABULARY + 1 - start) }, (_, i) => word(start + i));
    rows.push(p(words.join(' '), rows.length + 1));
  }
  rows.push(p('Application deadline', rows.length + 1));
  const local = buildIndex(rows);
  const side = analyzeSearchRecovery(local, answerQuestion(local, 'Application deadlien?', 'original')).sides[0];
  expect(side.spellingLimited).toBe(true);
  expect(side.suggestions).toEqual([]);
  expect(side.partialFragments).toBe(1);
  expect(side.coverage[0].fragments).toBe(1);
});
test('malformed scope, inconsistent physical route and duplicate physical identity fail closed', () => {
  const { answer } = search('Application deadlien on page 2?');
  expect(() => analyzeSearchRecovery(index, { ...answer, pageFilter: 1 })).toThrow();
  expect(() => analyzeSearchRecovery(index, { ...answer, scope: 'all' as any })).toThrow();
  const duplicate = buildIndex([source[4], source[4]]);
  expect(() => analyzeSearchRecovery(duplicate, answer)).toThrow();
});
