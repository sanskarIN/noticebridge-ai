import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { admitCollectionDocument, type CollectionDocument } from '../src/pdfChatCollection';
import { collectionReviewCounts, collectionReviewKey, collectionReviewPage, filterCollectionReviews,
  loadCollectionReview, MAX_COLLECTION_REVIEW_BYTES, MAX_COLLECTION_REVIEW_ITEMS,
  MAX_COLLECTION_REVIEW_NOTE, parseCollectionReview, pinCollectionEvidence, removeCollectionEvidence,
  removeDocumentReviews, serializeCollectionReview, updateCollectionEvidence, validCollectionReviewNote,
  type CollectionReviewEntry } from '../src/pdfChatCollectionReview';

async function add(docs: CollectionDocument[], bytes: string, texts: string[]) {
  return admitCollectionDocument(docs, new File([bytes], 'same.pdf'), new AbortController().signal,
    async () => ({ passages: texts.map((text, index) => ({ role: 'original' as const, page: 1, ordinal: index + 1, text })),
      pageCount: 1, processedPages: 1, missingPages: texts.length ? [] : [1], limited: false, limitedPages: [] }));
}
async function fixture() {
  const a = await add([], 'first', ['Application fee: INR 500', 'Deadline: 20 December 2026']);
  const b = await add([a], 'second', ['Application fee: INR 500', 'Eligibility: Class 12']);
  const docs = [a, b];
  let entries = pinCollectionEvidence(docs, [], a.id, a.corpus.passages[0]);
  entries = pinCollectionEvidence(docs, entries, b.id, b.corpus.passages[0]);
  return { a, b, docs, entries };
}
const key = (entry: CollectionReviewEntry) => collectionReviewKey(entry.documentId, entry.source);
test('same text and fragment location in two PDFs retain independent review identities', async () => {
  const { a, b, docs, entries } = await fixture();
  expect(entries).toHaveLength(2);
  expect(key(entries[0])).not.toBe(key(entries[1]));
  expect(pinCollectionEvidence(docs, entries, a.id, a.corpus.passages[0])).toEqual(entries);
  expect(() => pinCollectionEvidence(docs, entries, b.id, a.corpus.passages[0])).toThrow();
  expect(() => pinCollectionEvidence(docs, entries, a.id, { ...a.corpus.passages[0] })).toThrow();
});
test('edit, clear and filter independently without changing original array', async () => {
  const { a, b, entries } = await fixture();
  const changed = updateCollectionEvidence(entries, key(entries[0]), { note: 'Check payment terms', status: 'needs_followup' });
  expect(entries[0].note).toBe('');
  expect(changed[1]).toBe(entries[1]);
  expect(collectionReviewCounts(changed)).toEqual({ unreviewed: 1, needs_followup: 1, reviewed_manually: 0 });
  expect(filterCollectionReviews(changed, { documentId: a.id, status: 'needs_followup', query: ' PAYMENT ' })).toEqual([changed[0]]);
  expect(filterCollectionReviews(changed, { documentId: 'all', status: 'all', query: 'inr 500' })).toEqual(changed);
  expect(filterCollectionReviews(changed, { documentId: b.id, status: 'needs_followup', query: '' })).toEqual([]);
  expect(removeDocumentReviews(changed, a.id)).toEqual([changed[1]]);
  expect(removeCollectionEvidence(changed, key(changed[1]))).toEqual([changed[0]]);
  expect(updateCollectionEvidence(changed, key(changed[0]), { note: '' })[0].note).toBe('');
});
test('notes preserve Unicode, tabs and newlines within the explicit budget', () => {
  for (const value of ['', 'Review 😀\n\tFollow-up', 'x'.repeat(MAX_COLLECTION_REVIEW_NOTE)])
    expect(validCollectionReviewNote(value)).toBe(true);
  for (const value of [null, 0, 'x'.repeat(MAX_COLLECTION_REVIEW_NOTE + 1), '\u0000', '\u000b', '\ud800', '\u007f'])
    expect(validCollectionReviewNote(value)).toBe(false);
});
test('invalid statuses, keys and filters reject without modifying notes', async () => {
  const { entries } = await fixture();
  expect(() => updateCollectionEvidence(entries, key(entries[0]), { status: 'verified' as never })).toThrow();
  expect(() => updateCollectionEvidence(entries, 'missing', { note: 'test' })).toThrow();
  expect(() => updateCollectionEvidence(entries, key(entries[0]), { note: '\u0000' })).toThrow();
  expect(() => filterCollectionReviews(entries, { documentId: 'unknown', status: 'all', query: '' })).toThrow();
  expect(() => filterCollectionReviews(entries, { documentId: 'all', status: 'all', query: 'a'.repeat(101) })).toThrow();
});
test('maximum review count and pagination are bounded', async () => {
  const a = await add([], 'a', Array.from({ length: MAX_COLLECTION_REVIEW_ITEMS + 1 }, (_, i) => 'Text ' + i));
  let entries: CollectionReviewEntry[] = [];
  for (const source of a.corpus.passages.slice(0, MAX_COLLECTION_REVIEW_ITEMS))
    entries = pinCollectionEvidence([a], entries, a.id, source);
  expect(entries).toHaveLength(100);
  expect(() => pinCollectionEvidence([a], entries, a.id, a.corpus.passages.at(-1)!)).toThrow('limit');
  const last = collectionReviewPage(entries, 13);
  expect(last).toMatchObject({ pages: 13, first: 97, last: 100 });
  expect(last.rows).toEqual(entries.slice(96));
  expect(collectionReviewPage([], 1)).toMatchObject({ rows: [], pages: 1, first: 0, last: 0 });
  expect(() => collectionReviewPage(entries, 14)).toThrow();
});
test('private canonical review uses hashes, not automatic source text or filenames', async () => {
  const { docs, entries } = await fixture();
  const edited = updateCollectionEvidence(entries, key(entries[1]), { status: 'reviewed_manually', note: 'Personal annotation 😀' });
  const text = await serializeCollectionReview(docs, edited);
  const value = JSON.parse(text);
  expect(value.authority_verified).toBe(false);
  expect(value.entries[0].text_sha256).toBe(createHash('sha256').update(entries[0].source.text).digest('hex'));
  expect(text).not.toContain('Application fee: INR 500');
  expect(text).not.toContain('same.pdf');
  expect(text).toContain('Personal annotation');
  const restored = await parseCollectionReview(text, [...docs].reverse());
  expect(restored).toEqual(edited);
  expect(restored[1].source).toBe(entries[1].source);
  expect(await loadCollectionReview(new File([text], 'review.json'), docs)).toEqual(edited);
});
test('missing, extra, or changed attachment and changed extraction fail closed', async () => {
  const { a, b, docs, entries } = await fixture();
  const text = await serializeCollectionReview(docs, entries);
  const extra = await add(docs, 'third', []);
  const changed = await add([], 'first', ['Application fee: INR 999']);
  expect(changed.id).toBe(a.id);
  for (const other of [[a], [b], [...docs, extra], [changed, b]]) {
    await expect(parseCollectionReview(text, other)).rejects.toThrow();
  }
});
test('tampered authority, note schema, hashes, duplicates and canonical bytes reject', async () => {
  const { docs, entries } = await fixture();
  const text = await serializeCollectionReview(docs, entries);
  const value = JSON.parse(text);
  const mutations = [
    (v: any) => { v.authority_verified = true; },
    (v: any) => { v.source_ids.reverse(); },
    (v: any) => { v.entries[0].text_sha256 = 'f'.repeat(64); },
    (v: any) => { v.entries[0].status = 'verified'; },
    (v: any) => { v.entries[0].note = 'x'.repeat(501); },
    (v: any) => { v.entries[0].page = 2; },
    (v: any) => { v.entries[0].ordinal = 999; },
    (v: any) => { v.entries[0].text = 'forged quote'; },
    (v: any) => { v.entries.push(v.entries[0]); },
    (v: any) => { v.entries = []; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(value);
    mutate(copy);
    await expect(parseCollectionReview(JSON.stringify(copy, null, 2) + '\n', docs)).rejects.toThrow();
  }
  await expect(parseCollectionReview(text.trim(), docs)).rejects.toThrow();
  await expect(parseCollectionReview(text.replace('"version": 1,', '"version": 1, "version": 1,'), docs)).rejects.toThrow();
  await expect(parseCollectionReview('x'.repeat(MAX_COLLECTION_REVIEW_BYTES + 1), docs)).rejects.toThrow();
  await expect(loadCollectionReview(new File([new Uint8Array([0xff])], 'bad.json'), docs)).rejects.toThrow();
  await expect(serializeCollectionReview(docs, [])).rejects.toThrow();
});
test('pre-cancelled and late-cancelled operations do not return a restored draft', async () => {
  const { docs, entries } = await fixture();
  const text = await serializeCollectionReview(docs, entries);
  const control = new AbortController();
  control.abort();
  await expect(serializeCollectionReview(docs, entries, control.signal)).rejects.toThrow();
  await expect(parseCollectionReview(text, docs, control.signal)).rejects.toThrow();
  await expect(loadCollectionReview(new File([text], 'review.json'), docs, control.signal)).rejects.toThrow();
  const late = new AbortController();
  const operation = parseCollectionReview(text, docs, late.signal);
  late.abort();
  await expect(operation).rejects.toThrow();
});
