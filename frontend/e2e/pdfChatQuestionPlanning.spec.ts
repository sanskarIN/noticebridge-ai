import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { planQuestions, answerScopedQuestions, parseSearchQuestion, resolveChatQuestion } from '../src/pdfChatInsights';
import { planStructuredQuestions, trailingQuestionRoute } from '../src/pdfChatQuestionPlanning';
import { noticeFieldIntent } from '../src/pdfChatNoticeIntent';
import { directFieldAnswer } from '../src/pdfChatDirectAnswer';
import { searchAllQuestionMatches } from '../src/pdfChatEvidenceExplorer';
import { runChatStep, replayQuestions, stepsFromTurns, serializeQuestionPlan, parseQuestionPlan } from '../src/pdfChatSession';

const supported: [string, string[]][] = [
  ['When and where is the exam?', ['Examination date', 'Examination venue']],
  ['Where and when will the examination take place?', ['Examination venue', 'Examination date']],
  ['At what time and where will document verification be held?', ['Document verification time', 'Document verification venue']],
  ['Where and at what time is the interview?', ['Interview venue', 'Interview time']],
  ['What date and time is the exam?', ['Examination date', 'Examination time']],
  ['What time and date will the interview be held?', ['Interview time', 'Interview date']],
  ['What are the date, time and venue of document verification?', ['Document verification date', 'Document verification time', 'Document verification venue']],
  ['What are the venue, date, and time for the interview?', ['Interview venue', 'Interview date', 'Interview time']],
  ['What are the application opening date, deadline and fee?', ['Application start date', 'Application deadline', 'Application fee']],
  ['Registration start date, deadline and fee?', ['Registration opening date', 'Registration deadline', 'Registration fee']],
  ['What are the correction window opening date and deadline?', ['Correction window opening date', 'Correction window deadline']],
  ['Application correction window start date and last date?', ['Correction window opening date', 'Correction window deadline']],
  ['Application start date and eligibility?', ['Application start date', 'Eligibility']],
  ['What are the application deadline and fee in both PDFs on page 2?',
    ['Application deadline in both PDFs on page 2', 'Application fee in both PDFs on page 2']],
  ['When and where is the interview on physical PDF page 2 in the revised notice?',
    ['Interview date on physical PDF page 2 in the revised notice', 'Interview venue on physical PDF page 2 in the revised notice']],
  ['What are the date and venue of the examination from the original document?',
    ['Examination date from the original document', 'Examination venue from the original document']],
  ['Registration opening date and fee in the updated notice?',
    ['Registration opening date in the updated notice', 'Registration fee in the updated notice']],
];
for (const [question, expected] of supported) {
  test('closed compound question: ' + question, () => {
    expect(planStructuredQuestions(question)).toEqual(expected);
    expect(planQuestions(question)).toEqual(expected);
    for (const part of expected) expect(planQuestions(part)).toEqual([part]);
  });
}
const unsupported = [
  'When and where is the examination for rural applicants?',
  'What are the date and time of the examination if postponed?',
  'What are the date or time of the exam?',
  'What are the date and date of the exam?',
  'What are the date, time, venue and fee of the examination?',
  'What are the date and time of the exam and interview?',
  'When and where is the exam not held?',
  'When and where is the exam on pages 2 and 3?',
  'When and where is the exam on page 2 on page 3?',
  'When and where is the exam in the original notice in the revised notice?',
  'Application opening date and start date?',
  'Application deadline and last date?',
  'Application fee and fee?',
  'Registration deadline and last date?',
  'Application deadline and interview fee?',
  'Registration deadline and eligibility?',
  'Correction window fee and deadline?',
  'Application deadline and fee for rural applicants?',
  'Application fee and deadline unless exempt?',
  'Application fee or deadline?',
  'What are the date and time of the exam on page 2 if exempt?',
  'When and where is the exam in both PDFs and revised notice?',
];
for (const question of unsupported) {
  test('does not split a qualified or ambiguous compound: ' + question, () => {
    expect(planStructuredQuestions(question)).toBeNull();
    expect(planQuestions(question)).toEqual([question]);
  });
}
test('route suffix preserves original case, ordering and physical-page wording', () => {
  expect(trailingQuestionRoute('When and where is the exam ON PHYSICAL PDF PAGE 02 in the Updated Notice?'))
    .toEqual({ subject: 'When and where is the exam', suffix: ' ON PHYSICAL PDF PAGE 02 in the Updated Notice' });
  expect(trailingQuestionRoute('Application fee? Refund policy?')).toBeNull();
  expect(trailingQuestionRoute('Application fee on page 1 on page 2?')).toBeNull();
});
test('existing explicit question boundaries retain precedence', () => {
  expect(planQuestions('When and where is the exam? Application fee?'))
    .toEqual(['When and where is the exam', 'Application fee']);
  expect(planQuestions('What are the application deadline and fee?')).toEqual(['application deadline', 'application fee']);
});
const p = (text: string, role: Passage['role'], page: number, ordinal: number): Passage => ({ text, role, page, ordinal });
const rows = [
  p('Examination date: 19 December 2026', 'original', 2, 1),
  p('Examination time: 10:00', 'original', 2, 2),
  p('Examination venue: Hall A', 'original', 2, 3),
  p('Examination date: 20 December 2026', 'revised', 2, 1),
  p('Examination time: 11:00', 'revised', 2, 2),
  p('Examination venue: Hall B', 'revised', 2, 3),
  p('Examination date: 21 December 2026', 'revised', 3, 1),
  p('Interview date: 22 December 2026', 'revised', 2, 4),
];
const index = buildIndex(rows);
test('compound events retrieve independently cited date, time and venue within the same route', () => {
  const answers = answerScopedQuestions(index,
    'What are the date, time and venue of the examination in both PDFs on page 2?', 'auto', ['original', 'revised']);
  expect(answers).toHaveLength(3);
  answers.forEach((answer, i) => {
    expect(answer.scope).toBe('both');
    expect(answer.pageFilter).toBe(2);
    expect(answer.citations).toEqual([rows[i], rows[i + 3]]);
    expect(answer.printedFields.map(field => field.citation)).toEqual([1, 2]);
    expect(directFieldAnswer(index, answer)?.sides.map(side => side.distinctValues)).toEqual([1, 1]);
    expect(searchAllQuestionMatches(index, answer).hits.map(hit => hit.source)).toEqual(answer.citations);
  });
});
test('explicit manual scope still takes precedence and missing auto roles abstain independently', () => {
  const question = 'When and where is the exam in the revised notice on page 2?';
  const manual = answerScopedQuestions(index, question, 'original', ['original', 'revised']);
  expect(manual.map(answer => answer.citations)).toEqual([[rows[0]], [rows[2]]]);
  const one = buildIndex(rows.filter(row => row.role === 'original'));
  const missing = answerScopedQuestions(one, question, 'auto', ['original']);
  expect(missing.map(answer => answer.kind)).toEqual(['insufficient', 'insufficient']);
  expect(missing.every(answer => answer.missingRoles.join() === 'revised')).toBe(true);
});
test('invalid physical route is rejected rather than searching all pages', () => {
  expect(() => answerScopedQuestions(index, 'When and where is the exam on page 81?', 'auto', ['original', 'revised'])).toThrow();
});
test('compound questions replay in the existing question plan and do not become implicit context', () => {
  const step = { input: 'When and where is the exam in both PDFs on page 2?', scope: 'auto' as const,
    includeContext: true, reuse: false };
  const turn = runChatStep(index, step, undefined, ['original', 'revised']);
  expect(turn.answers).toHaveLength(2);
  expect(turn.input).toBe(step.input);
  const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
  const wire = serializeQuestionPlan(pins, stepsFromTurns([turn]));
  expect(replayQuestions(index, parseQuestionPlan(wire, pins), ['original', 'revised'])).toEqual([turn]);
  expect(() => runChatStep(index, { ...step, input: 'What about page 3?', reuse: true }, turn, ['original','revised'])).toThrow();
  expect(() => resolveChatQuestion('On page 3?', turn.resolved, true)).toThrow();
});
const natural: [string, string][] = [
  ['How much is the application fee?', 'application_fee'],
  ['What amount must I pay to apply?', 'application_fee'],
  ['How much are the registration charges?', 'registration_fee'],
  ['What fee do we pay to register?', 'registration_fee'],
  ['How much is the examination fee?', 'exam_fee'],
  ['What is the last day to apply?', 'application_deadline'],
  ['Until when can I apply?', 'application_deadline'],
  ['By what date should we submit the application?', 'application_deadline'],
  ['What is the final day to register?', 'registration_deadline'],
  ['Until when can we register?', 'registration_deadline'],
  ['By what date must I register?', 'registration_deadline'],
  ['On what date will applications open?', 'application_start'],
  ['From what date can I apply?', 'application_start'],
  ['On what date does registration begin?', 'registration_start'],
  ['From what date can we register?', 'registration_start'],
  ['Who may apply?', 'eligibility'],
  ['What educational qualifications do I need?', 'eligibility'],
  ['When will the examination be held?', 'exam_date'],
  ['On which date is the interview?', 'interview_date'],
  ['When will document verification take place?', 'verification_date'],
  ['Which portal should I use to apply?', 'application_portal'],
  ['What is the email address of the helpdesk?', 'contact_email'],
  ['Which number can I call to reach the helpdesk?', 'contact_phone'],
  ['How will candidates be selected?', 'selection_process'],
  ['Could you please tell me the application deadline?', 'application_deadline'],
  ['Please show me the examination venue?', 'exam_venue'],
];
for (const [question, field] of natural) {
  test('natural field wording: ' + question, () => {
    expect(noticeFieldIntent(question)?.field.id).toBe(field);
    expect(parseSearchQuestion(question).noticeIntent?.field.id).toBe(field);
  });
}
for (const question of [
  'How much is the application fee for rural applicants?',
  'What amount must I pay to apply if exempt?',
  'Until when can I apply without a certificate?',
  'From what date can we register after approval?',
  'What educational qualifications do I need for the senior post?',
  'When will the examination be held for reserved applicants?',
  'Which portal should I use to apply from abroad?',
  'How will candidates be selected if scores are tied?',
  'Could you please tell me the application deadline for category B?',
  'How much should I pay?', 'When can I register?', 'What does it cost?',
]) {
  test('natural templates do not drop qualifiers: ' + question, () => {
    expect(noticeFieldIntent(question)).toBeNull();
  });
}
