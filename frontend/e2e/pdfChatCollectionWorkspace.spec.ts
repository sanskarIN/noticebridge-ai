import { expect, test } from '@playwright/test';
import { admitCollectionDocument, runCollectionStep, type CollectionDocument } from '../src/pdfChatCollection';
import { collectionReviewKey, pinCollectionEvidence, updateCollectionEvidence } from '../src/pdfChatCollectionReview';
import { loadCollectionWorkspace, parseCollectionWorkspace, serializeCollectionWorkspace,
  MAX_COLLECTION_WORKSPACE_BYTES } from '../src/pdfChatCollectionWorkspace';

async function add(docs: CollectionDocument[], bytes: string, text: string) {
  return admitCollectionDocument(docs, new File([bytes], 'private.pdf'), new AbortController().signal,
    async () => ({ passages: [{ role: 'original', page: 1, ordinal: 1, text }],
      pageCount: 1, processedPages: 1, missingPages: [], limited: false, limitedPages: [] }));
}
async function fixture() {
  const a = await add([], 'a', 'Application fee: INR 500');
  const b = await add([a], 'b', 'Application fee: INR 350');
  const docs = [a, b];
  const turns = [runCollectionStep(docs, { question: 'Application fee?', documentIds: [a.id, b.id], includeContext: false })];
  const reviews = updateCollectionEvidence(pinCollectionEvidence(docs, [], a.id, a.corpus.passages[0]),
    collectionReviewKey(a.id, a.corpus.passages[0]), { note: 'Private follow-up', status: 'needs_followup' });
  return { docs, a, b, turns, reviews };
}
test('workspace recomputes questions and resolves local review objects atomically', async () => {
  const { docs, turns, reviews } = await fixture();
  const text = await serializeCollectionWorkspace(docs, { turns, reviews });
  expect(text).toContain('Private follow-up');
  expect(text).not.toContain('INR 500');
  expect(text).not.toContain('private.pdf');
  expect(text).not.toContain('citations');
  const restored = await parseCollectionWorkspace(text, [...docs].reverse());
  expect(restored).toEqual({ turns, reviews });
  expect(restored.reviews[0].source).toBe(reviews[0].source);
  expect(restored.turns[0].results[0].parts[0].answer.citations[0]).toBe(reviews[0].source);
  expect(await loadCollectionWorkspace(new File([text], 'workspace.json'), docs)).toEqual(restored);
});
test('questions-only and reviews-only workspaces are valid but empty workspaces are rejected', async () => {
  const { docs, turns, reviews } = await fixture();
  for (const workspace of [{ turns, reviews: [] }, { turns: [], reviews }]) {
    expect(await parseCollectionWorkspace(await serializeCollectionWorkspace(docs, workspace), docs)).toEqual(workspace);
  }
  await expect(serializeCollectionWorkspace(docs, { turns: [], reviews: [] })).rejects.toThrow();
});
test('changed extraction invalidates review even when question replay would still succeed', async () => {
  const { docs, b, turns, reviews } = await fixture();
  const changed = await add([], 'a', 'Application fee: INR 999');
  const text = await serializeCollectionWorkspace(docs, { turns, reviews });
  await expect(parseCollectionWorkspace(text, [changed, b])).rejects.toThrow();
  const questionOnly = await serializeCollectionWorkspace(docs, { turns, reviews: [] });
  const result = await parseCollectionWorkspace(questionOnly, [changed, b]);
  expect(result.turns[0].results[0].parts[0].answer.citations[0].text).toBe('Application fee: INR 999');
});
test('workspace rejects altered outer and nested source identities and forged answer data', async () => {
  const { docs, turns, reviews } = await fixture();
  const text = await serializeCollectionWorkspace(docs, { turns, reviews });
  const value = JSON.parse(text);
  const mutate = [
    (v: any) => { v.authority_verified = true; },
    (v: any) => { v.source_ids.reverse(); },
    (v: any) => { v.question_plan.source_ids.reverse(); },
    (v: any) => { v.evidence_review.source_ids.reverse(); },
    (v: any) => { v.question_plan.questions[0].answer = 'forged'; },
    (v: any) => { v.evidence_review.entries[0].text_sha256 = 'f'.repeat(64); },
    (v: any) => { v.evidence_review.entries[0].status = 'verified'; },
    (v: any) => { v.evidence_review.authority_verified = true; },
    (v: any) => { v.question_plan = []; },
    (v: any) => { v.question_plan = null; v.evidence_review = null; },
  ];
  for (const edit of mutate) {
    const copy = structuredClone(value); edit(copy);
    await expect(parseCollectionWorkspace(JSON.stringify(copy, null, 2) + '\n', docs)).rejects.toThrow();
  }
  await expect(parseCollectionWorkspace(text.replace('"version": 1,', '"version": 1, "version": 1,'), docs)).rejects.toThrow();
  await expect(parseCollectionWorkspace(text.trim(), docs)).rejects.toThrow();
  await expect(parseCollectionWorkspace(text, docs.slice(1))).rejects.toThrow();
  await expect(parseCollectionWorkspace('x'.repeat(MAX_COLLECTION_WORKSPACE_BYTES + 1), docs)).rejects.toThrow();
  await expect(loadCollectionWorkspace(new File([new Uint8Array([0xff])], 'invalid.json'), docs)).rejects.toThrow();
});
test('workspace cancellation never exposes a partial replacement', async () => {
  const { docs, turns, reviews } = await fixture();
  const text = await serializeCollectionWorkspace(docs, { turns, reviews });
  const stopped = new AbortController(); stopped.abort();
  await expect(serializeCollectionWorkspace(docs, { turns, reviews }, stopped.signal)).rejects.toThrow();
  await expect(loadCollectionWorkspace(new File([text], 'workspace.json'), docs, stopped.signal)).rejects.toThrow();
  const active = new AbortController();
  const task = parseCollectionWorkspace(text, docs, active.signal);
  active.abort();
  await expect(task).rejects.toThrow();
});
