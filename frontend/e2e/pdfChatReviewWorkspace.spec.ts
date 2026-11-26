import { expect, test } from '@playwright/test';
import { buildIndex, type Passage } from '../src/pdfChatCore';
import { filterEvidence, loadReview, MAX_REVIEW_BYTES, MAX_REVIEW_ITEMS, MAX_REVIEW_NOTE,
  parseReview, pinEvidence, removeEvidence, reviewCounts, serializeReview, updateEvidence,
  type ReviewEntry } from '../src/pdfChatReviewWorkspace';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
];
const index = buildIndex(rows);
const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const base = pinEvidence(index, pinEvidence(index, [], rows[0]), rows[2]);
const entries = updateEvidence(base, 'original:1:1', { status: 'needs_followup', note: 'Check waiver — café 😀' });
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

test('pinning preserves exact local source identity, not imported text', () => {
  expect(entries[0].source).toBe(rows[0]);
  expect(pinEvidence(index, entries, rows[0])).toEqual(entries);
  expect(() => pinEvidence(index, entries, { ...rows[0], text: 'forged' })).toThrow();
  expect(() => pinEvidence(index, entries, { ...rows[0], page: 80 })).toThrow();
});
test('review status, notes and filters are independent of source text', () => {
  expect(reviewCounts(entries)).toEqual({ unreviewed: 1, reviewed_manually: 0, needs_followup: 1 });
  expect(filterEvidence(entries, { role: 'original', status: 'needs_followup' })).toEqual([entries[0]]);
  expect(filterEvidence(entries, { role: 'revised', status: 'needs_followup' })).toEqual([]);
  expect(removeEvidence(entries, 'original:1:1')).toEqual([entries[1]]);
  expect(base[0].note).toBe('');
});
test('entry budget fails closed without changing existing review', () => {
  const rows: Passage[] = Array.from({ length: MAX_REVIEW_ITEMS + 1 }, (_, i) => ({
    role: 'original', page: 1, ordinal: i + 1, text: 'Text ' + i,
  }));
  const idx = buildIndex(rows);
  const all = rows.slice(0, MAX_REVIEW_ITEMS).reduce<ReviewEntry[]>((acc, source) => pinEvidence(idx, acc, source), []);
  expect(() => pinEvidence(idx, all, rows[MAX_REVIEW_ITEMS])).toThrow();
  expect(all).toHaveLength(MAX_REVIEW_ITEMS);
});
test('private round trip restores exact local fragments and Unicode user notes', async () => {
  const text = await serializeReview(index, pins, entries);
  expect(text).not.toContain('Application fee: INR 500');
  expect(text).not.toContain('Application fee: INR 350');
  expect(text).toContain('Check waiver — café 😀');
  const restored = await parseReview(text, index, pins);
  expect(restored).toEqual(entries);
  expect(restored[0].source).toBe(rows[0]);
  expect(await serializeReview(index, pins, restored)).toBe(text);
});
test('exact source byte and extracted text binding reject stale reviews', async () => {
  const text = await serializeReview(index, pins, entries);
  await expect(parseReview(text, index, { ...pins, original: 'c'.repeat(64) })).rejects.toThrow();
  await expect(parseReview(text, index, { original: pins.original })).rejects.toThrow();
  await expect(parseReview(text, buildIndex([{ ...rows[0], text: 'Updated extraction' }, ...rows.slice(1)]), pins)).rejects.toThrow();
});
test('wire format rejects injected source text, unknown identity, invalid status and authority claims', async () => {
  const raw = JSON.parse(await serializeReview(index, pins, entries));
  for (const value of [
    { ...raw, authority_verified: true },
    { ...raw, version: true },
    { ...raw, entries: [{ ...raw.entries[0], text: 'forged' }] },
    { ...raw, entries: [{ ...raw.entries[0], id: 'original:80:1' }] },
    { ...raw, entries: [{ ...raw.entries[0], text_sha256: 'c'.repeat(64) }] },
    { ...raw, entries: [{ ...raw.entries[0], status: 'verified' }] },
    { ...raw, entries: [raw.entries[0], raw.entries[0]] },
  ]) await expect(parseReview(encode(value), index, pins)).rejects.toThrow();
});
test('canonical representation rejects duplicate fields and oversized data', async () => {
  const text = await serializeReview(index, pins, entries);
  await expect(parseReview(text.replace('"version": 1,', '"version": 1, "version": 1,'), index, pins)).rejects.toThrow();
  await expect(parseReview(text.trim(), index, pins)).rejects.toThrow();
  await expect(parseReview('x'.repeat(MAX_REVIEW_BYTES + 1), index, pins)).rejects.toThrow();
});
test('invalid note and status changes cannot mutate an entry', () => {
  for (const note of ['x'.repeat(MAX_REVIEW_NOTE + 1), '\u0000', '\ud800']) {
    expect(() => updateEvidence(entries, 'original:1:1', { note })).toThrow();
  }
  expect(entries[0].note).toBe('Check waiver — café 😀');
});
test('invalid UTF-8 file does not restore or overwrite local notes', async () => {
  const file = new File([new Uint8Array([0xff, 0xfe, 0xfd])], 'invalid.json');
  await expect(loadReview(file, index, pins)).rejects.toThrow();
  expect(entries[0].note).toBe('Check waiver — café 😀');
});
