import { expect, test } from '@playwright/test';
import { buildIndex, knownQuestionField, queryTerms, type Passage } from '../src/pdfChatCore';
import { fieldDefinitions, buildNoticeOverview, extractKnownField } from '../src/pdfChatOverview';
import { noticeFieldIntent } from '../src/pdfChatNoticeIntent';
import { answerScopedQuestions, parseSearchQuestion } from '../src/pdfChatInsights';
import { directFieldAnswer } from '../src/pdfChatDirectAnswer';
import { searchAllQuestionMatches } from '../src/pdfChatEvidenceExplorer';
import { buildHybridShortlist } from '../src/pdfChatHybridShortlist';

const examples = [
  ['When do applications close?', 'application_deadline'],
  ['When do applications open?', 'application_start'],
  ['When does registration begin?', 'registration_start'],
  ['When does registration close?', 'registration_deadline'],
  ['When is fee payment due?', 'payment_deadline'],
  ['What is the deadline for payment?', 'payment_deadline'],
  ['When does the correction window open?', 'correction_start'],
  ['When does the application correction window end?', 'correction_deadline'],
  ['When will the admit card be released?', 'admit_card_date'],
  ['When is the hall ticket issued?', 'admit_card_date'],
  ['When will the result be declared?', 'result_date'],
  ['On what date is the examination?', 'exam_date'],
  ['What time is the exam?', 'exam_time'],
  ['At what time does the examination start?', 'exam_time'],
  ['Where will the examination take place?', 'exam_venue'],
  ['When is the interview?', 'interview_date'],
  ['What time is the interview?', 'interview_time'],
  ['Where is the interview?', 'interview_venue'],
  ['When is document verification?', 'verification_date'],
  ['What time is the document verification?', 'verification_time'],
  ['Where will document verification take place?', 'verification_venue'],
  ['What time should I report?', 'reporting_time'],
  ['Where must we report?', 'reporting_venue'],
  ['What documents should I bring?', 'documents'],
  ['Which certificates are required?', 'documents'],
  ['How do I apply?', 'application_method'],
  ['Where can I apply online?', 'application_portal'],
  ['How should I pay the fee?', 'payment_method'],
  ['What is the helpdesk email address?', 'contact_email'],
  ['What is the helpdesk phone number?', 'contact_phone'],
  ['How old must I be at least?', 'minimum_age'],
  ['What is the maximum permitted age?', 'maximum_age'],
  ['How many vacancies are available?', 'vacancy_count'],
  ['What is the selection procedure?', 'selection_process'],
  ['What are the age limits?', 'age_limit'],
] as const;

for (const [question, id] of examples) {
  test('exact notice question form: ' + question, () => {
    expect(noticeFieldIntent(question)?.field.id).toBe(id);
  });
}
for (const question of [
  'When can I apply?', 'When should I report?', 'When is the exam for staff?',
  'What documents should rural applicants bring?', 'How do I apply without paying?',
  'Where should I apply?', 'What is the fee?', 'How much is registration?',
  'When will the result be announced for reserved applicants?', 'How many vacancies are available for women?',
  'How old must I be if exempt?', 'What is the minimum or maximum age?',
  'What is the deadline for payment in January?', 'Which certificates are not required?',
  'What is the contact number for complaints?', 'Where is the interview if postponed?',
  'How do I pay the fee for a friend?', 'What time is the exam? What date?',
]) {
  test('does not discard qualifications: ' + question, () => {
    expect(noticeFieldIntent(question)).toBeNull();
  });
}
function row(text: string, role: Passage['role'] = 'original', page = 1, ordinal = 1): Passage {
  return { text, role, page, ordinal };
}
test('every canonical query resolves to its intended field without normalization collisions', () => {
  const seen = new Set<string>();
  for (const field of fieldDefinitions) {
    expect(knownQuestionField(queryTerms(field.query))).toBe(field.id);
    for (const alias of field.aliases) {
      expect(seen.has(alias)).toBe(false);
      seen.add(alias);
      const source = row(alias + ': Fictional value');
      expect(extractKnownField(source)?.definition.id).toBe(field.id);
      expect(noticeFieldIntent(alias)?.field.id).toBe(field.id);
    }
  }
});
test('date, time and venue stay distinct for each event', () => {
  const rows = [
    row('Date of document verification: 12 December 2026'),
    row('Document verification time: 10:00', 'original', 1, 2),
    row('Venue of document verification: Fictional Hall', 'original', 1, 3),
    row('Examination date: 15 December 2026', 'original', 1, 4),
  ];
  const index = buildIndex(rows);
  const questions = ['When is document verification?', 'What time is document verification?',
    'Where is document verification?', 'When is the examination?'];
  for (const [i, question] of questions.entries()) {
    const [answer] = answerScopedQuestions(index, question, 'original', ['original']);
    expect(answer.citations).toEqual([rows[i]]);
    expect(answer.question).toBe(question);
    expect(directFieldAnswer(index, answer)?.sides[0].values[0].sources[0].source).toBe(rows[i]);
    expect(searchAllQuestionMatches(index, answer).hits.map(hit => hit.source)).toEqual(answer.citations);
  }
});
test('aliases do not conflate payment deadline, fee amount and correction deadline', () => {
  const rows = [
    row('Fee payment deadline: 2026-12-15'),
    row('Application fee: INR 500', 'original', 1, 2),
    row('Application correction deadline: 2026-12-19', 'original', 1, 3),
    row('Payment method: Online only', 'original', 1, 4),
  ];
  const index = buildIndex(rows);
  const questions = ['When is payment due?', 'Application fee?', 'When does correction window close?', 'How do I pay the fee?'];
  for (const [i, question] of questions.entries()) {
    const [answer] = answerScopedQuestions(index, question, 'original', ['original']);
    expect(answer.citations).toEqual([rows[i]]);
  }
});
test('recognized question intent respects source and physical page filters', () => {
  const rows = [
    row('Hall ticket release date: 2026-12-10', 'original', 2),
    row('Admit card issue date: 2026-12-12', 'revised', 2),
    row('Admit card release date: 2026-12-14', 'revised', 3),
  ];
  const index = buildIndex(rows);
  const [answer] = answerScopedQuestions(index, 'When will the admit card be released in the revised notice on page 2?',
    'auto', ['original', 'revised']);
  expect(answer.scope).toBe('revised');
  expect(answer.pageFilter).toBe(2);
  expect(answer.citations).toEqual([rows[1]]);
  expect(buildHybridShortlist(index, answer).entries.map(entry => entry.source)).toEqual([rows[1]]);
  expect(parseSearchQuestion(answer.question).noticeIntent?.field.id).toBe('admit_card_date');
});
test('expanded overview preserves distinct original and revised labels', () => {
  const rows = [
    row('Admit card release date: 2026-12-10'),
    row('Hall ticket release date: 2026-12-12', 'revised'),
    row('Payment method: Online only', 'original', 1, 2),
    row('Fee payment mode: Offline only', 'revised', 1, 2),
  ];
  const overview = buildNoticeOverview(buildIndex(rows));
  expect(overview.map(field => field.definition.id)).toEqual(['admit_card_date', 'payment_method']);
  expect(overview.every(field => field.outcome === 'different_printed_text')).toBe(true);
  expect(overview[0].revised.values[0].citations[0].label).toBe('Hall ticket release date');
});
