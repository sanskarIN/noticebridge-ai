/**
 * Small hand-authored regression corpus for the document QA baseline.
 * These are fictional fragments, not an independent real-world benchmark.
 * Labels specify required citation identities, not generated answer text.
 */
import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage, type Scope } from '../src/pdfChatCore';

const source: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Fictional district training scheme' },
  { role: 'original', page: 1, ordinal: 2, text: 'Application last date: 19 December 2026' },
  { role: 'original', page: 1, ordinal: 3, text: 'Application fee: Rs. 500' },
  { role: 'original', page: 1, ordinal: 4, text: 'Examination fee: Rs. 750' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12 or equivalent' },
  { role: 'original', page: 2, ordinal: 2, text: 'Applicants from rural districts' },
  { role: 'original', page: 2, ordinal: 3, text: 'must submit a residence certificate' },
  { role: 'original', page: 3, ordinal: 1, text: 'Interview date: 21 December 2026' },
  { role: 'original', page: 3, ordinal: 2, text: 'Interview venue: District training centre' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Fictional district training scheme' },
  { role: 'revised', page: 1, ordinal: 2, text: 'Application closing date: 13 December 2026' },
  { role: 'revised', page: 1, ordinal: 3, text: 'Application charges: Rs. 350' },
  { role: 'revised', page: 1, ordinal: 4, text: 'Examination fee: Rs. 750' },
  { role: 'revised', page: 2, ordinal: 1, text: 'Eligibility criteria: Class 12 or equivalent' },
  { role: 'revised', page: 2, ordinal: 2, text: 'Applicants from rural districts' },
  { role: 'revised', page: 2, ordinal: 3, text: 'must submit a residence certificate' },
  { role: 'revised', page: 3, ordinal: 1, text: 'Interview date: 22 December 2026' },
  { role: 'revised', page: 3, ordinal: 2, text: 'Interview venue: District training centre' },
  { role: 'revised', page: 4, ordinal: 1, text: 'Application deadline: 15 December 2026' },
];
const index = buildIndex(source);
const key = (row: Passage) => row.role + ':' + row.page + ':' + row.ordinal;

type Case = {
  name: string;
  question: string;
  scope: Scope;
  expected: string[];
  contextual?: boolean;
};
const cases: Case[] = [
  { name: 'asymmetric last date alias', question: 'Application deadline?', scope: 'original',
    expected: ['original:1:2'] },
  { name: 'competing updated deadlines', question: 'Application deadline?', scope: 'revised',
    expected: ['revised:1:2', 'revised:4:1'] },
  { name: 'fee alias', question: 'Application fee?', scope: 'both',
    expected: ['original:1:3', 'revised:1:3'] },
  { name: 'examination fee distinguished', question: 'Examination fee?', scope: 'both',
    expected: ['original:1:4', 'revised:1:4'] },
  { name: 'eligibility phrase', question: 'Who can apply?', scope: 'both',
    expected: ['original:2:1', 'revised:2:1'] },
  { name: 'interview venue', question: 'Interview venue?', scope: 'revised',
    expected: ['revised:3:2'] },
  { name: 'interview date', question: 'Interview date?', scope: 'original',
    expected: ['original:3:1'] },
  { name: 'split requirement', question: 'Rural residence certificate?', scope: 'original',
    expected: ['original:2:2', 'original:2:3'], contextual: true },
  { name: 'split requirement both versions', question: 'Rural residence certificate?', scope: 'both',
    expected: ['original:2:2', 'original:2:3', 'revised:2:2', 'revised:2:3'], contextual: true },
  { name: 'nonexistent refund policy', question: 'Application fee refund policy?', scope: 'both',
    expected: [] },
  { name: 'missing hostel amount', question: 'Hostel fee?', scope: 'both', expected: [] },
  { name: 'missing experience requirement', question: 'How much work experience?', scope: 'original',
    expected: [] },
  { name: 'unavailable currency', question: 'Application fee in euros?', scope: 'both', expected: [] },
  { name: 'missing interview time', question: 'Interview start time?', scope: 'revised', expected: [] },
  { name: 'no content terms', question: 'What about it?', scope: 'both', expected: [] },
];

for (const item of cases) {
  test('labeled retrieval: ' + item.name, () => {
    const answer = answerQuestion(index, item.question, item.scope, true);
    expect(answer.citations.map(key).sort()).toEqual([...item.expected].sort());
    expect(answer.kind).toBe(item.expected.length ? 'passages' : 'insufficient');
    expect(answer.contextGroups.length > 0).toBe(Boolean(item.contextual));
    if (item.contextual) expect(answer.printedFields).toEqual([]);
  });
}

function evaluate(includeContext: boolean) {
  let retrieved = 0;
  let relevantRetrieved = 0;
  let relevantTotal = 0;
  let answerable = 0;
  let answered = 0;
  let unanswerable = 0;
  let abstained = 0;
  let unsupported = 0;
  for (const item of cases) {
    const answer = answerQuestion(index, item.question, item.scope, includeContext);
    const actual = new Set(answer.citations.map(key));
    const expected = new Set(item.expected);
    const hits = [...actual].filter(id => expected.has(id)).length;
    retrieved += actual.size;
    relevantRetrieved += hits;
    relevantTotal += expected.size;
    if (expected.size) {
      answerable++;
      if (hits === expected.size) answered++;
    } else {
      unanswerable++;
      if (!actual.size) abstained++;
      else unsupported++;
    }
  }
  return {
    cases: cases.length, retrieved, relevantRetrieved, relevantTotal,
    answerable, answered, unanswerable, abstained, unsupported,
    citationPrecision: relevantRetrieved / Math.max(1, retrieved),
    citationRecall: relevantRetrieved / Math.max(1, relevantTotal),
    completeRetrievalRate: answered / Math.max(1, answerable),
    unanswerableAbstentionRate: abstained / Math.max(1, unanswerable),
  };
}

test('synthetic benchmark isolates contextual recall and abstention regressions', () => {
  const strict = evaluate(false);
  const contextual = evaluate(true);
  // Aggregate metrics supplement individual labels; never call these
  // accuracy on real notices. An actual retrieval error fails the test.
  expect(strict.answerable).toBe(9);
  expect(strict.unanswerable).toBe(6);
  expect(strict.answered).toBe(7);
  expect(contextual.answered).toBe(9);
  expect(strict.citationRecall).toBeLessThan(contextual.citationRecall);
  expect(contextual.citationPrecision).toBe(1);
  expect(contextual.citationRecall).toBe(1);
  expect(strict.unanswerableAbstentionRate).toBe(1);
  expect(contextual.unanswerableAbstentionRate).toBe(1);
  expect(contextual.unsupported).toBe(0);
  console.log(JSON.stringify({
    synthetic: true,
    caveat: 'Hand-authored regression fixtures; not real-world QA accuracy.',
    strict, contextual,
  }));
});
