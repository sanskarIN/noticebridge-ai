import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { answerQuestionSet, comparePrintedValues, groupPrintedValues, nearbyPassages,
  planQuestions, resolveChatQuestion, requestedScope, effectiveScope, answerScopedQuestions, parsePageFilter } from '../src/pdfChatInsights';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Fictional notice only' },
  { role: 'original', page: 1, ordinal: 2, text: 'Application deadline: 19 December 2026' },
  { role: 'original', page: 1, ordinal: 3, text: 'Application fee: Rs. 500' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12 or equivalent' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application deadline: 13 December 2026' },
  { role: 'revised', page: 1, ordinal: 2, text: 'Application fee: Rs. 350' },
  { role: 'revised', page: 2, ordinal: 1, text: 'Eligibility: Class 12 or equivalent' },
];
const index = buildIndex(rows);

test('recognized field list retrieves two independent source answers', () => {
  const results = answerQuestionSet(index, 'What are the application deadline and fee?', 'both');
  expect(results).toHaveLength(2);
  expect(results[0].citations).toEqual([rows[1], rows[4]]);
  expect(results[1].citations).toEqual([rows[2], rows[5]]);
});
test('each explicit question can independently abstain', () => {
  const results = answerQuestionSet(index, 'Application fee? Refund policy? Who can apply?', 'both');
  expect(results.map(answer => answer.kind)).toEqual(['passages', 'insufficient', 'passages']);
  expect(results[1].citations).toEqual([]);
  expect(results[2].citations).toEqual([rows[3], rows[6]]);
});
test('semicolon separators preserve distinct scopes and qualifiers', () => {
  const results = answerQuestionSet(index, 'Application fee; Interview fee', 'original');
  expect(results.map(answer => answer.kind)).toEqual(['passages', 'insufficient']);
  expect(results[0].citations).toEqual([rows[2]]);
});
test('arbitrary conjunctions are not broken into misleading independent claims', () => {
  const question = 'Can applicants with Class 10 and work experience apply?';
  expect(planQuestions(question)).toEqual([question]);
  expect(answerQuestionSet(index, question, 'both')[0].kind).toBe('insufficient');
});
test('alternatives and qualified fees are not split', () => {
  for (const question of ['Is the fee 350 or 500?', 'Application fee and refund policy?',
    'Application deadline and interview fee?']) {
    expect(planQuestions(question)).toEqual([question]);
  }
});
test('four subquestions are supported but five are rejected', () => {
  expect(planQuestions('fee; eligibility; deadline; refund')).toHaveLength(4);
  expect(() => planQuestions('fee; eligibility; deadline; refund; address')).toThrow();
  expect(() => planQuestions('')).toThrow();
  expect(() => planQuestions('a'.repeat(401))).toThrow();
});
test('a narrow three-field list uses the application prefix only where appropriate', () => {
  expect(planQuestions('What are the application deadline, fee, and eligibility?'))
    .toEqual(['application deadline', 'application fee', 'eligibility']);
});
test('follow-up context does not create a second query at a trailing question mark', () => {
  const question = resolveChatQuestion('What about the updated notice?', 'What is the application fee?', true);
  const results = answerQuestionSet(index, question, 'revised');
  expect(results).toHaveLength(1);
  expect(results[0].citations).toEqual([rows[5]]);
});
test('multi-question context requires a specific new question', () => {
  expect(() => resolveChatQuestion('What about revised?', 'Application deadline and fee?', true)).toThrow();
  expect(() => resolveChatQuestion('Fee; deadline', 'Eligibility?', true)).toThrow();
  expect(resolveChatQuestion('Application fee?', 'Deadline and fee?', false)).toBe('Application fee?');
});
test('different literal printed values are separated by source role', () => {
  const answer = answerQuestion(index, 'application fee', 'both');
  const groups = groupPrintedValues(answer);
  const comparison = comparePrintedValues(groups);
  expect(comparison).toHaveLength(1);
  expect(comparison[0].outcome).toBe('different_printed_text');
  expect(comparison[0].original.values).toEqual([{ value: 'Rs. 500', citations: [1] }]);
  expect(comparison[0].revised.values).toEqual([{ value: 'Rs. 350', citations: [2] }]);
});
test('identical displayed text does not imply absence of other changes', () => {
  const groups = groupPrintedValues(answerQuestion(index, 'eligibility', 'both'));
  expect(comparePrintedValues(groups)[0].outcome).toBe('same_printed_text');
});
test('multiple printed values prevent a single definitive comparison', () => {
  const modified = buildIndex([...rows, {
    role: 'revised', page: 3, ordinal: 1, text: 'APPLICATION FEE: Rs. 900',
  }]);
  const groups = groupPrintedValues(answerQuestion(modified, 'application fee', 'both'));
  const result = comparePrintedValues(groups)[0];
  expect(result.outcome).toBe('multiple_printed_values');
  expect(result.revised.values.map(item => item.value).sort()).toEqual(['Rs. 350', 'Rs. 900']);
});
test('repeated identical values retain citations to both pages', () => {
  const repeated = buildIndex([...rows, { ...rows[2], page: 3 }]);
  const groups = groupPrintedValues(answerQuestion(repeated, 'application fee', 'original'));
  expect(groups[0].values).toEqual([{ value: 'Rs. 500', citations: [1, 2] }]);
});
test('different labels are not paired merely because both concern fees', () => {
  const separate = buildIndex([
    rows[2], { role: 'revised', page: 1, ordinal: 1, text: 'Exam fee: Rs. 350' },
  ]);
  expect(comparePrintedValues(groupPrintedValues(answerQuestion(separate, 'fee', 'both')))).toEqual([]);
});
test('source context stays on same page and same document', () => {
  expect(nearbyPassages(index, rows[1])).toEqual([rows[0], rows[1], rows[2]]);
  expect(nearbyPassages(index, rows[4])).toEqual([rows[4], rows[5]]);
});
test('source context includes at most two neighboring fragments per side', () => {
  const many = Array.from({ length: 10 }, (_, i): Passage => ({
    role: 'original', page: 1, ordinal: i + 1, text: 'Fragment ' + (i + 1),
  }));
  expect(nearbyPassages(buildIndex(many), many[5])).toEqual(many.slice(3, 8));
});


test('automatic scope recognizes only explicit source-version phrases', () => {
  expect(requestedScope('Fee in the original notice?')).toBe('original');
  expect(requestedScope('Deadline in the updated PDF?')).toBe('revised');
  expect(requestedScope('Eligibility in both versions?')).toBe('both');
  expect(requestedScope('Original notice versus revised notice')).toBe('both');
  expect(requestedScope('New applicants with old certificates')).toBeNull();
  expect(requestedScope('Current registration date')).toBeNull();
});
test('auto scope uses attached roles only when no explicit role is requested', () => {
  expect(effectiveScope('Application fee', 'auto', ['revised'])).toBe('revised');
  expect(effectiveScope('Application fee', 'auto', ['original', 'revised'])).toBe('both');
  expect(effectiveScope('Fee in the original notice', 'auto', ['revised'])).toBe('original');
  expect(effectiveScope('Fee in the updated notice', 'original', ['original', 'revised'])).toBe('original');
});
test('each explicit question can select a different source automatically', () => {
  const answers = answerScopedQuestions(index,
    'Application fee in original notice? Application fee in updated notice?', 'auto', ['original', 'revised']);
  expect(answers.map(answer => answer.scope)).toEqual(['original', 'revised']);
  expect(answers[0].citations).toEqual([rows[2]]);
  expect(answers[1].citations).toEqual([rows[5]]);
});
test('auto scope never substitutes the available source for a missing requested source', () => {
  const partial = buildIndex(rows.filter(row => row.role === 'original'));
  const answer = answerScopedQuestions(partial, 'Application fee in updated notice?', 'auto', ['original'])[0];
  expect(answer.scope).toBe('revised');
  expect(answer.kind).toBe('insufficient');
  expect(answer.missingRoles).toEqual(['revised']);
});


test('explicit source phrases are not accidental required lexical terms', () => {
  const answers = answerScopedQuestions(index, 'Fee in first document? Fee in second version?', 'auto', ['original', 'revised']);
  expect(answers[0].citations).toEqual([rows[2]]);
  expect(answers[1].citations).toEqual([rows[5]]);
  expect(answerScopedQuestions(index, 'Fee in both versions?', 'auto', ['original', 'revised'])[0].citations)
    .toEqual([rows[2], rows[5]]);
});
test('follow-up changes explicit role without carrying a stale source phrase', () => {
  const resolved = resolveChatQuestion('What about the revised notice?', 'Fee in the original notice?', true);
  const answer = answerScopedQuestions(index, resolved, 'auto', ['original', 'revised'])[0];
  expect(answer.scope).toBe('revised');
  expect(answer.citations).toEqual([rows[5]]);
});


test('page filter strips only the explicit routing phrase', () => {
  expect(parsePageFilter('Application fee on page 2?')).toEqual({ content: 'Application fee ?', page: 2 });
  expect(parsePageFilter('Clause 2 application fee')).toEqual({ content: 'Clause 2 application fee' });
  expect(parsePageFilter('Application fee from PDF page 3')).toEqual({ content: 'Application fee', page: 3 });
});
test('physical page constraints do not retrieve matches from other pages', () => {
  const answer = answerScopedQuestions(index, 'Application fee on page 2?', 'both', ['original', 'revised'])[0];
  expect(answer.pageFilter).toBe(2);
  expect(answer.kind).toBe('insufficient');
  expect(answer.citations).toEqual([]);
});
test('page-filtered search preserves full corpus IDF statistics', () => {
  const repeated = buildIndex([...rows, ...Array.from({ length: 8 }, (_, i): Passage => ({
    role: 'original', page: i + 3, ordinal: 1, text: 'Application fee: Rs. 100',
  }))]);
  const answer = answerScopedQuestions(repeated, 'Application fee on page 1?', 'both', ['original', 'revised'])[0];
  expect(answer.citations).toEqual([rows[2], rows[5]]);
  expect(answer.pageFilter).toBe(1);
});
test('page filter applies independently to multiple questions', () => {
  const answers = answerScopedQuestions(index, 'Application fee on page 1? Eligibility on page 2?',
    'both', ['original', 'revised']);
  expect(answers.map(answer => answer.pageFilter)).toEqual([1, 2]);
  expect(answers[0].citations).toEqual([rows[2], rows[5]]);
  expect(answers[1].citations).toEqual([rows[3], rows[6]]);
});
test('new page constraints replace earlier constraints in an explicit follow-up', () => {
  const resolved = resolveChatQuestion('What about on page 2?', 'Application fee on page 1?', true);
  const result = answerScopedQuestions(index, resolved, 'original', ['original'])[0];
  expect(result.pageFilter).toBe(2);
  expect(result.kind).toBe('insufficient');
});
test('page constraints cannot bridge contextual fragments on another page', () => {
  const parts: Passage[] = [
    { role: 'original', page: 1, ordinal: 1, text: 'Rural applicants' },
    { role: 'original', page: 1, ordinal: 2, text: 'Residence certificate' },
    { role: 'original', page: 2, ordinal: 1, text: 'Rural applicants' },
  ];
  const answer = answerScopedQuestions(buildIndex(parts), 'Rural certificate on page 2?', 'original', ['original'], true)[0];
  expect(answer.kind).toBe('insufficient');
  expect(answer.contextGroups).toEqual([]);
});
for (const value of ['0', '81', '-1', '2.5', '1-3', '2 to 3', '2 and 3', '2 on page 3', 'two', '9999999999999999999']) {
  test('rejects invalid or ambiguous physical page filter: ' + value, () => {
    expect(() => parsePageFilter('Fee on page ' + value)).toThrow();
  });
}
test('plural page constraints are rejected rather than silently broadened', () => {
  expect(() => parsePageFilter('Fee on pages 1-3')).toThrow();
});

test('route-only follow-ups preserve subject and replace source and page exactly', () => {
  const first = resolveChatQuestion('What about the revised notice?',
    'Application fee for Reserved category in the original notice on page 3?', true);
  expect(first).toBe('Application fee for Reserved category in the revised notice on page 3?');
  const second = resolveChatQuestion('How about on page 2?', first, true);
  expect(second).toBe('Application fee for Reserved category in the revised notice on page 2?');
  const third = resolveChatQuestion('Both PDFs on page 1?', second, true);
  expect(third).toBe('Application fee for Reserved category in both PDFs on page 1?');
});

test('repeated routing does not grow prior question length or accumulate words', () => {
  let question = 'Application fee on page 1?';
  for (let i = 0; i < 24; i++) {
    question = resolveChatQuestion(i % 2 ? 'What about the original notice?' :
      'What about the revised notice?', question, true);
  }
  expect(question).toBe('Application fee in the original notice on page 1?');
  expect(answerScopedQuestions(index, question, 'auto', ['original', 'revised'])[0].citations)
    .toEqual([rows[2]]);
});

test('routing-only follow-up retains material qualifiers rather than turning them into a bare field', () => {
  const resolved = resolveChatQuestion('On page 1?', 'Application fee for rural applicants in revised notice?', true);
  expect(resolved).toBe('Application fee for rural applicants in the revised notice on page 1?');
  expect(answerScopedQuestions(index, resolved, 'auto', ['original', 'revised'])[0].kind).toBe('insufficient');
});

test('substantive follow-up words stay in the query, even with source routing', () => {
  const resolved = resolveChatQuestion('What about refund in the revised notice?', 'Application fee?', true);
  expect(resolved).toContain('refund');
  expect(answerScopedQuestions(index, resolved, 'auto', ['original', 'revised'])[0].kind).toBe('insufficient');
});

test('routing follow-up rejects malformed page selectors and missing subjects', () => {
  expect(() => resolveChatQuestion('On pages 2-3?', 'Application fee?', true)).toThrow();
  expect(() => resolveChatQuestion('On page 2?', 'On page 1?', true)).toThrow();
});
