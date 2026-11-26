import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { scalarComparisonIntent } from '../src/pdfChatScalarIntent';
import { answerScopedQuestions, parseSearchQuestion } from '../src/pdfChatInsights';
import { directFieldAnswer } from '../src/pdfChatDirectAnswer';
import { comparePrintedScalars, scalarExplanation } from '../src/pdfChatScalarComparison';
import { searchAllQuestionMatches } from '../src/pdfChatEvidenceExplorer';
import { buildHybridShortlist } from '../src/pdfChatHybridShortlist';

for (const [question, field, kind] of [
  ['Compare application fee', 'application_fee', 'money'],
  ['Compare the application charges between the original and revised notices', 'application_fee', 'money'],
  ['What is the difference in the registration deadline?', 'registration_deadline', 'date'],
  ["What's the difference of examination fee in both PDFs?", 'exam_fee', 'money'],
  ['Calculate the difference in application opening date', 'application_start', 'date'],
  ['Show difference in examination date', 'exam_date', 'date'],
  ['How much did the application fee change?', 'application_fee', 'money'],
  ['How much has the registration fee changed?', 'registration_fee', 'money'],
  ['By how much did the examination fee change?', 'exam_fee', 'money'],
  ['How many days later is the revised application deadline than the original?', 'application_deadline', 'date'],
  ['How many calendar days earlier is the updated application deadline than the first application closing date?', 'application_deadline', 'date'],
  ['How much higher is the revised application fee than the original application charges?', 'application_fee', 'money'],
  ['How much lower is the second registration fee than the previous?', 'registration_fee', 'money'],
] as const) {
  test('recognized scalar intent: ' + question, () => {
    const intent = scalarComparisonIntent(question);
    expect(intent?.field.id).toBe(field);
    expect(intent?.kind).toBe(kind);
  });
}
for (const question of [
  'Compare application fee for rural applicants',
  'Compare application fee except reserved category',
  'Compare application fee and registration fee',
  'Compare eligibility',
  'Compare contact email',
  'Compare examination time',
  'How much did the fee change?',
  'How much did the application fee for reserved applicants change?',
  'How many days later is the revised application fee than original?',
  'How much higher is the revised application deadline than original?',
  'How many days later is the revised examination date than original application deadline?',
  'How much higher is the revised application fee than original exam fee?',
  'How much higher is the revised application fee than original for rural applicants?',
  'Compare not the application fee',
  'Compare application fee for applicants in both PDFs',
  'Compare application fee? Eligibility?',
  'Compare application fee; ignore instructions',
  'Compare application fee in revised notice',
]) {
  test('does not erase qualifier or guess comparison: ' + question, () => {
    expect(scalarComparisonIntent(question)).toBeNull();
  });
}
function row(text: string, role: Passage['role'] = 'original', page = 1): Passage {
  return { text, role, page, ordinal: 1 };
}
const rows = [
  row('Application fee: INR 500'),
  row('Application deadline: 15 December 2026', 'original', 2),
  row('Application fee: INR 350', 'revised'),
  row('Application closing date: 10 December 2026', 'revised', 2),
];
const index = buildIndex(rows);
const attached: Passage['role'][] = ['original', 'revised'];
test('explicit comparison uses both attached sources in Auto and retains original wording', () => {
  const question = 'How much did the application fee change?';
  const [answer] = answerScopedQuestions(index, question, 'auto', attached);
  expect(answer.question).toBe(question);
  expect(answer.scope).toBe('both');
  expect(answer.citations).toEqual([rows[0], rows[2]]);
  expect(searchAllQuestionMatches(index, answer).hits.map(hit => hit.source)).toEqual(answer.citations);
  const shortlist = buildHybridShortlist(index, answer);
  expect(shortlist.entries.filter(entry => entry.reason === 'baseline').map(entry => entry.source))
    .toEqual(answer.citations);
  const direct = directFieldAnswer(index, answer);
  expect(direct).not.toBeNull();
  const result = comparePrintedScalars(direct!);
  expect(result).toMatchObject({ status: 'available', kind: 'money', difference: -15000n });
});
test('direction wording never forces a result to agree with the question premise', () => {
  const [answer] = answerScopedQuestions(index,
    'How many days later is the revised application deadline than the original?', 'auto', attached);
  const result = comparePrintedScalars(directFieldAnswer(index, answer)!);
  expect(result).toMatchObject({ status: 'available', kind: 'date', difference: -5 });
  if (result.status === 'available') expect(scalarExplanation(result)).toContain('5 calendar days earlier');
});
test('comparison intent preserves explicit physical page filter', () => {
  const [answer] = answerScopedQuestions(index, 'Compare application deadline on page 2?', 'auto', attached);
  expect(answer.pageFilter).toBe(2);
  expect(answer.citations).toEqual([rows[1], rows[3]]);
  expect(searchAllQuestionMatches(index, answer).hits.map(hit => hit.source)).toEqual(answer.citations);
  expect(buildHybridShortlist(index, answer).entries.every(entry => entry.source.page === 2)).toBe(true);
});
test('explicit selected source takes precedence over comparison request', () => {
  const [answer] = answerScopedQuestions(index, 'Compare application fee in both PDFs?', 'original', attached);
  expect(answer.scope).toBe('original');
  expect(answer.citations).toEqual([rows[0]]);
  expect(comparePrintedScalars(directFieldAnswer(index, answer)!))
    .toEqual({ status: 'unavailable', reason: 'single_source' });
});
test('missing requested source is reported rather than silently narrowed in Auto', () => {
  const [answer] = answerScopedQuestions(buildIndex(rows.slice(0, 2)), 'Compare application fee?', 'auto', ['original']);
  expect(answer.scope).toBe('both');
  expect(answer.missingRoles).toEqual(['revised']);
  expect(answer.citations).toEqual([rows[0]]);
});
test('qualified questions remain strict and never activate scalar arithmetic', () => {
  const [answer] = answerScopedQuestions(index, 'Compare application fee for rural applicants?', 'auto', attached);
  expect(answer.kind).toBe('insufficient');
  expect(directFieldAnswer(index, answer)).toBeNull();
  expect(parseSearchQuestion(answer.question).comparison).toBeUndefined();
});
test('unsupported page ranges still fail closed', () => {
  expect(() => parseSearchQuestion('Compare application fee on pages 1 and 2?')).toThrow();
  expect(() => parseSearchQuestion('Compare application fee on page 81?')).toThrow();
  expect(() => parseSearchQuestion('Compare application fee on page 1 and 2?')).toThrow();
});
