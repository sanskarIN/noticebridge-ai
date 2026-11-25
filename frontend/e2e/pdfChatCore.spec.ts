import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, resolveQuestion, MAX_PASSAGES, type Passage } from '../src/pdfChatCore';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application deadline: 19 December 2026' },
  { role: 'original', page: 1, ordinal: 2, text: 'Application fee: Rs. 500' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12 or equivalent' },
  { role: 'original', page: 2, ordinal: 2, text: 'Required documents: photograph and identity card' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application deadline: 13 December 2026' },
  { role: 'revised', page: 1, ordinal: 2, text: 'Application fee: Rs. 350' },
  { role: 'revised', page: 2, ordinal: 1, text: 'Eligibility: Class 12 or equivalent' },
  { role: 'revised', page: 3, ordinal: 1, text: 'Interview deadline: 15 December 2026' },
];
const index = buildIndex(rows);
const queries = [
  ['What is the application deadline?', 0],
  ['What is the application last date?', 0],
  ['When is the application due?', 0],
  ['How much is the application fee?', 1],
  ['What are the application fees?', 1],
  ['Who can apply?', 2],
  ['What documents are required?', 3],
] as const;
for (const [question, row] of queries) {
  test('extractive question: ' + question, () => {
    const answer = answerQuestion(index, question, 'original');
    expect(answer.kind).toBe('passages');
    expect(answer.citations).toEqual([rows[row]]);
    expect(answer.printedFields[0]?.value).toBe(rows[row].text.split(': ')[1]);
    expect(answer.missingRoles).toEqual([]);
  });
}

for (const question of [
  'What is the application refund policy?',
  'What is the application location?',
  'What is the exam syllabus?',
  'What is the hostel accommodation fee?',
  'Is the application fee refundable?',
  'Is Class 10 sufficient for eligibility?',
  'What is the application fee in dollars?',
  'What is the application deadline in January?',
  'What is the weather forecast?',
  'What?',
  '???',
  'constructor',
]) {
  test('abstains on missing exact query evidence: ' + question, () => {
    const answer = answerQuestion(index, question, 'both');
    expect(answer.kind).toBe('insufficient');
    expect(answer.citations).toEqual([]);
    expect(answer.printedFields).toEqual([]);
    expect(answer.missingRoles).toEqual(['original', 'revised']);
  });
}

test('both scopes keep document roles and values separate', () => {
  const answer = answerQuestion(index, 'What is the application fee?', 'both');
  expect(answer.citations).toEqual([rows[1], rows[5]]);
  expect(answer.printedFields.map(field => field.value)).toEqual(['Rs. 500', 'Rs. 350']);
  expect(answer.matchedCounts).toEqual({ original: 1, revised: 1 });
});
test('a missing revised passage is not evidence of removal', () => {
  const answer = answerQuestion(index, 'What documents are required?', 'both');
  expect(answer.citations).toEqual([rows[3]]);
  expect(answer.missingRoles).toEqual(['revised']);
});
test('a scoped search does not leak the other document', () => {
  expect(answerQuestion(index, 'application deadline', 'revised').citations).toEqual([rows[4]]);
});
test('non-field matches stay quotations, not synthesized answers', () => {
  const answer = answerQuestion(index, 'Class 12', 'original');
  expect(answer.citations).toEqual([rows[2]]);
  expect(answer.printedFields).toEqual([]);
});
test('preserves competing printed dates rather than choosing one', () => {
  const answer = answerQuestion(index, 'deadline', 'revised');
  expect(answer.citations).toHaveLength(2);
  expect(answer.printedFields.map(field => field.value).sort()).toEqual([
    '13 December 2026', '15 December 2026',
  ]);
});
test('limits display but counts unique matching passages', () => {
  const many = Array.from({ length: 8 }, (_, i): Passage => ({
    role: 'original', page: i + 1, ordinal: 1, text: 'Application deadline: 13 December 2026',
  }));
  const answer = answerQuestion(buildIndex([...many, many[0]]), 'application deadline', 'original');
  expect(answer.citations).toHaveLength(4);
  expect(answer.matchedCounts.original).toBe(8);
  expect(answer.citations.map(citation => citation.page)).toEqual([1, 2, 3, 4]);
});
test('empty corpus returns no answer', () => {
  expect(answerQuestion(buildIndex([]), 'deadline', 'original').kind).toBe('insufficient');
});
test('question and corpus bounds are enforced', () => {
  expect(() => answerQuestion(index, ' ', 'both')).toThrow();
  expect(() => answerQuestion(index, 'a'.repeat(401), 'both')).toThrow();
  expect(() => buildIndex(Array(MAX_PASSAGES + 1).fill(rows[0]))).toThrow();
  expect(() => buildIndex([{ ...rows[0], text: 'x'.repeat(901) }])).toThrow();
});
test('follow-up context is explicit and bounded', () => {
  expect(resolveQuestion('What about the updated notice?', 'application fee', false))
    .toBe('What about the updated notice?');
  expect(resolveQuestion('What about the updated notice?', 'application fee', true))
    .toBe('application fee What about the updated notice?');
  expect(() => resolveQuestion('follow-up', null, true)).toThrow();
  expect(() => resolveQuestion('a'.repeat(200), 'b'.repeat(200), true)).toThrow();
});


test('notice phrase normalization works on both question and PDF text', () => {
  const source: Passage = { role: 'original', page: 1, ordinal: 1,
    text: 'Application last date: 13 December 2026' };
  const result = answerQuestion(buildIndex([source]), 'What is the application deadline?', 'original');
  expect(result.citations).toEqual([source]);
  expect(result.printedFields[0]).toEqual({ citation: 1, label: 'Application last date', value: '13 December 2026' });
});
test('how much time is not a fee question', () => {
  const source: Passage = { role: 'original', page: 1, ordinal: 1,
    text: 'Application time: 30 minutes' };
  const result = answerQuestion(buildIndex([source, rows[1]]), 'How much application time?', 'original');
  expect(result.citations).toEqual([source]);
});
test('application charges retain original printed wording', () => {
  const source: Passage = { role: 'original', page: 1, ordinal: 1, text: 'Application charges: Rs. 500' };
  const result = answerQuestion(buildIndex([source]), 'What is the application fee?', 'original');
  expect(result.citations).toEqual([source]);
  expect(result.printedFields[0]?.label).toBe('Application charges');
});
