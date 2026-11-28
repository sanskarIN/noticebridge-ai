import { expect, test } from '@playwright/test';
import { admitCollectionDocument, runCollectionStep, type CollectionDocument } from '../src/pdfChatCollection';
import { collectionFollowupDraft, collectionHistoryParts, independentCollectionQuestion,
  removeCollectionTurn, reviseCollectionHistory } from '../src/pdfChatCollectionHistory';

async function add(docs: CollectionDocument[], name: string, fee: string) {
  return admitCollectionDocument(docs, new File([name], name + '.pdf'), new AbortController().signal,
    async () => ({
      passages: [
        { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR ' + fee },
        { role: 'original', page: 2, ordinal: 1, text: 'Application fee: INR 250' },
        { role: 'original', page: 2, ordinal: 2, text: 'Eligibility: Class 12' },
      ],
      pageCount: 2, processedPages: 2, missingPages: [], limited: false, limitedPages: [],
    }));
}
async function fixture() {
  const a = await add([], 'a', '500');
  const b = await add([a], 'b', '350');
  const docs = [a, b];
  const steps = [
    { question: 'Application fee on page 1?', documentIds: [a.id], includeContext: false },
    { question: 'Application fee? Eligibility?', documentIds: [b.id, a.id], includeContext: true },
    { question: 'Eligibility?', documentIds: [b.id], includeContext: false },
  ];
  return { docs, a, b, steps, turns: steps.map(step => runCollectionStep(docs, step)) };
}
test('independent copy preserves document identities and does not share selection arrays', async () => {
  const { docs, turns, steps } = await fixture();
  const copy = independentCollectionQuestion(docs, turns[1]);
  expect(copy).toEqual(steps[1]);
  expect(copy.documentIds).not.toBe(turns[1].step.documentIds);
  expect(collectionHistoryParts(docs, turns[1])).toEqual(['Application fee', 'Eligibility']);
});
test('page-only follow-up replaces the prior page constraint with one bounded explicit page', async () => {
  const { docs, a, turns } = await fixture();
  const step = collectionFollowupDraft(docs, turns[0], 0, 'On page 2?');
  expect(step).toEqual({ question: 'Application fee on page 2?', documentIds: [a.id], includeContext: false });
  const answer = runCollectionStep(docs, step);
  expect(answer.results[0].parts[0].answer.citations.map(row => row.text)).toEqual(['Application fee: INR 250']);
  expect(turns[0].results[0].parts[0].answer.citations[0].text).toBe('Application fee: INR 500');
});
test('compound history requires an explicit part and does not reuse another part or newest turn', async () => {
  const { docs, a, b, turns } = await fixture();
  const step = collectionFollowupDraft(docs, turns[1], 1, 'On page 2?');
  expect(step).toEqual({ question: 'Eligibility on page 2?', documentIds: [b.id, a.id], includeContext: true });
  expect(() => collectionFollowupDraft(docs, turns[1], 2, 'On page 2?')).toThrow();
  expect(() => collectionFollowupDraft(docs, turns[1], -1, 'On page 2?')).toThrow();
  expect(() => collectionFollowupDraft(docs, turns[1], 0.5, 'On page 2?')).toThrow();
});
test('follow-up rejects routing, change comparisons, compound input and invalid page scope', async () => {
  const { docs, turns } = await fixture();
  for (const input of ['What about the revised notice?', 'On page 0?', 'On page 81?', 'On page 1 and 2?',
    'Fee? Eligibility?', '', '   ', 'x'.repeat(401)]) {
    expect(() => collectionFollowupDraft(docs, turns[0], 0, input)).toThrow();
  }
});
test('history editing recomputes only the replacement and keeps the exact prefix', async () => {
  const { docs, b, turns } = await fixture();
  const replacement = { question: 'Application fee on page 1?', documentIds: [b.id], includeContext: false };
  expect(() => reviseCollectionHistory(docs, turns, 1, replacement, false)).toThrow();
  const revised = reviseCollectionHistory(docs, turns, 1, replacement, true);
  expect(revised).toHaveLength(2);
  expect(revised[0]).toBe(turns[0]);
  expect(revised[1].results[0].parts[0].answer.citations[0].text).toBe('Application fee: INR 350');
  expect(turns).toHaveLength(3);
  expect(reviseCollectionHistory(docs, turns, 2, replacement, false)).toHaveLength(3);
});
test('invalid replacement, stale document or invalid history position cannot mutate history', async () => {
  const { docs, a, turns, steps } = await fixture();
  for (const at of [-1, 3, 0.5, NaN]) expect(() => reviseCollectionHistory(docs, turns, at, steps[0], true)).toThrow();
  expect(() => reviseCollectionHistory(docs, turns, 1, { ...steps[0], documentIds: [] }, true)).toThrow();
  expect(() => reviseCollectionHistory([a], turns, 1, steps[2], true)).toThrow();
  expect(turns[1].step).toEqual(steps[1]);
});
test('remove only the confirmed turn and retain independent standalone question objects', async () => {
  const { turns } = await fixture();
  expect(() => removeCollectionTurn(turns, 1, false)).toThrow();
  const remaining = removeCollectionTurn(turns, 1, true);
  expect(remaining).toEqual([turns[0], turns[2]]);
  expect(remaining[1]).toBe(turns[2]);
  expect(removeCollectionTurn([turns[0]], 0, true)).toEqual([]);
  expect(() => removeCollectionTurn(turns, 3, true)).toThrow();
});
