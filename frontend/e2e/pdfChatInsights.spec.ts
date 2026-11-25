import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { answerQuestionSet, comparePrintedValues, groupPrintedValues, nearbyPassages,
  planQuestions, resolveChatQuestion } from '../src/pdfChatInsights';

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
