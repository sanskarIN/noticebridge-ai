import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { runChatStep, type ChatTurn } from '../src/pdfChatSession';
import { answerTargets, selectAnswerTarget, answerTargetLabel } from '../src/pdfChatAnswerTarget';
import { prepareExperiment, requestHash, reviewRanking } from '../src/pdfChatEmbeddingBridge';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 2, ordinal: 1, text: 'Examination date: 19 December 2026' },
  { role: 'original', page: 2, ordinal: 2, text: 'Examination venue: Hall A' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
  { role: 'revised', page: 2, ordinal: 1, text: 'Examination date: 20 December 2026' },
  { role: 'revised', page: 2, ordinal: 2, text: 'Examination venue: Hall B' },
  { role: 'revised', page: 3, ordinal: 1, text: 'Examination venue: Hall C' },
];
const index = buildIndex(rows);
const attached = ['original', 'revised'] as const;
function step(input: string, previous?: ChatTurn): ChatTurn {
  return runChatStep(index, { input, scope: 'auto', includeContext: true, reuse: false }, previous, [...attached]);
}
const first = step('Application fee in the original notice on page 1?');
const compound = step('When and where is the exam in the revised notice on page 2?', first);
const third = step('Application fee in both PDFs?', compound);
const history = [first, compound, third];

test('targets preserve exact single answers and independent compound parts', () => {
  const targets = answerTargets(history);
  expect(targets.map(target => [target.id, target.parts, target.turnIndex, target.partIndex]))
    .toEqual([['0:0',1,0,0], ['1:0',2,1,0], ['1:1',2,1,1], ['2:0',1,2,0]]);
  expect(targets[1].answer).toBe(compound.answers[0]);
  expect(targets[2].answer).toBe(compound.answers[1]);
  expect(targets[2].answer.scope).toBe('revised');
  expect(targets[2].answer.pageFilter).toBe(2);
  expect(targets[2].answer.citations).toEqual([rows[5]]);
});
test('default targets first part of latest turn and stale IDs do not silently select another answer', () => {
  const targets = answerTargets(history);
  expect(selectAnswerTarget(targets, null)?.id).toBe('2:0');
  expect(selectAnswerTarget(answerTargets(history.slice(0,2)), null)?.id).toBe('1:0');
  expect(selectAnswerTarget(targets, '1:1')?.answer).toBe(compound.answers[1]);
  expect(selectAnswerTarget(targets, '0:0')?.answer).toBe(first.answers[0]);
  expect(selectAnswerTarget(targets, '1:2')).toBeNull();
  expect(selectAnswerTarget(answerTargets([first]), '1:1')).toBeNull();
  expect(selectAnswerTarget([], null)).toBeNull();
});
test('target labels disclose turn, part, source and physical page', () => {
  const targets = answerTargets(history);
  expect(answerTargetLabel(targets[2])).toContain('Question 2, part 2 of 2');
  expect(answerTargetLabel(targets[2])).toContain('revised PDF, physical page 2');
  expect(answerTargetLabel(targets[0])).toContain('original PDF, physical page 1');
  expect(answerTargetLabel(targets[3])).toContain('both PDFs');
  const long = { ...targets[0], answer: { ...targets[0].answer, question: 'x'.repeat(400) } };
  expect(answerTargetLabel(long)).toContain('…');
  expect(answerTargetLabel(long).length).toBeLessThan(180);
});
test('selected historical and compound answer requests cannot widen their source or page', async () => {
  const targets = answerTargets(history);
  const original = prepareExperiment(index, selectAnswerTarget(targets, '0:0')!.answer);
  const revised = prepareExperiment(index, selectAnswerTarget(targets, '1:1')!.answer);
  expect(JSON.parse(original.text).passages.map((p: any) => p.id)).toEqual(['original:1:1']);
  expect(JSON.parse(revised.text).passages.map((p: any) => p.id)).toEqual(['revised:2:1','revised:2:2']);
  expect(JSON.parse(revised.text).question).toBe(compound.answers[1].question);
  const originalHash = await requestHash(original.text), revisedHash = await requestHash(revised.text);
  expect(originalHash).not.toBe(revisedHash);
  const result = {
    format: 'noticebridge-chat-embedding-result', version: 1, request_sha256: originalHash,
    model: 'fixture:latest', model_digest: 'a'.repeat(64), dimension: 2, candidate_count: 1,
    ranks: { original: ['original:1:1'] }, authority_verified: false,
  };
  const text = JSON.stringify(result, null, 2) + '\n';
  expect(reviewRanking(text, original, originalHash).candidates[0].passage).toBe(rows[0]);
  expect(() => reviewRanking(text, revised, revisedHash)).toThrow();
});
test('bounded history and answer targets reject malformed or empty turn answers', () => {
  expect(() => answerTargets(Array.from({ length: 25 }, () => first))).toThrow();
  expect(() => answerTargets([{ ...first, answers: [] }])).toThrow();
  expect(() => answerTargets([{ ...first, answers: Array.from({ length: 5 }, () => first.answers[0]) }])).toThrow();
  expect(() => answerTargets([{ ...first, answers: [{ ...first.answers[0], question: '' }] }])).toThrow();
});
