import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { buildIndex, type Corpus, type Passage } from '../src/pdfChatCore';
import { annotationCandidates, appendEvidenceSet, deleteDraftCase, exportLabelBundle, labelIsComplete,
  labelPage, makeDraftCase, parseLabelDraft, parseMetadata, readLabelDraft, removeEvidenceSet,
  saveDraftCase, serializeLabelDraft, setCaseKind, toggleEvidence, validateDraft,
  MAX_LABEL_DRAFT_BYTES, MAX_LABEL_SET_SIZE, MAX_LABEL_SETS, type LabelDraft } from '../src/pdfChatLabelWorkbench';
import { evaluateDataset, loadDataset, parseDataset } from '../evaluation/retrievalDataset';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Rural applicants' },
  { role: 'original', page: 1, ordinal: 3, text: 'Residence certificate required' },
  { role: 'original', page: 2, ordinal: 1, text: 'Application deadline: 2026-12-20' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
];
const index = buildIndex(rows);
const attached = ['original', 'revised'] as const;
const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
function corpus(role: Passage['role'], pageCount: number): Corpus {
  return { passages: rows.filter(row => row.role === role), pageCount, processedPages: pageCount,
    missingPages: [], limitedPages: [], limited: false };
}
const corpora = { original: corpus('original', 2), revised: corpus('revised', 1) };
const metadata = { dataset: 'study', document: 'notice-a', family: 'family-a',
  split: 'development' as const, snapshot: 'notice-a.json' };
const empty: LabelDraft = { metadata, cases: [] };
const newCase = () => makeDraftCase('fee', 'Application fee?', 'both', ['fee'], 'answerable', index, attached);
const filled = () => toggleEvidence(toggleEvidence(newCase(), 0, rows[0], index, attached), 0, rows[4], index, attached);
const draft = () => saveDraftCase(empty, filled(), index, attached);

test('author labels manually; all required fragments are retained in an alternative', () => {
  const row = filled();
  expect(row.evidenceSets).toEqual([['original:1:1', 'revised:1:1']]);
  expect(labelIsComplete(row, index, attached)).toBe(true);
  expect(newCase().evidenceSets).toEqual([[]]);
  expect(labelIsComplete(newCase(), index, attached)).toBe(false);
});
test('case creation derives explicit physical page from question without widening scope', () => {
  const row = makeDraftCase('date', 'Application deadline on page 2?', 'original',
    ['date'], 'answerable', index, attached);
  expect(row.page).toBe(2);
  expect(() => toggleEvidence(row, 0, rows[0], index, attached)).toThrow();
  expect(() => toggleEvidence(row, 0, rows[4], index, attached)).toThrow();
  expect(toggleEvidence(row, 0, rows[3], index, attached).evidenceSets).toEqual([['original:2:1']]);
});
test('unknown or forged source identity never becomes labeled evidence', () => {
  expect(() => toggleEvidence(newCase(), 0, { ...rows[0], text: 'forged' }, index, attached)).toThrow();
  expect(() => toggleEvidence(newCase(), 0, { ...rows[0], ordinal: 99 }, index, attached)).toThrow();
});
test('alternative sets are independent and duplicate complete sets are rejected', () => {
  let row = appendEvidenceSet(filled());
  row = toggleEvidence(toggleEvidence(row, 1, rows[4], index, attached), 1, rows[0], index, attached);
  expect(labelIsComplete(row, index, attached)).toBe(false);
  row = removeEvidenceSet(row, 1);
  expect(labelIsComplete(row, index, attached)).toBe(true);
  expect(removeEvidenceSet(row, 0).evidenceSets).toEqual([]);
});
test('non-answerable kinds deliberately clear native evidence sets', () => {
  for (const kind of ['unanswerable', 'unindexed', 'ambiguous'] as const) {
    const row = setCaseKind(filled(), kind);
    expect(row.evidenceSets).toEqual([]);
    expect(labelIsComplete(row, index, attached)).toBe(true);
    expect(() => toggleEvidence(row, 0, rows[0], index, attached)).toThrow();
    expect(setCaseKind(row, 'answerable').evidenceSets).toEqual([[]]);
  }
});
test('bounded sets and fragments cannot overflow', () => {
  let row = newCase();
  for (let i = 1; i < MAX_LABEL_SETS; i++) row = appendEvidenceSet(row);
  expect(() => appendEvidenceSet(row)).toThrow();
  const rows: Passage[] = Array.from({ length: MAX_LABEL_SET_SIZE + 1 }, (_, i) =>
    ({ role: 'original', page: 1, ordinal: i + 1, text: 'Fragment ' + i }));
  const index = buildIndex(rows);
  let large = makeDraftCase('large', 'What is printed?', 'original', ['test'], 'answerable', index, ['original']);
  for (const source of rows.slice(0, MAX_LABEL_SET_SIZE)) large = toggleEvidence(large, 0, source, index, ['original']);
  expect(() => toggleEvidence(large, 0, rows.at(-1)!, index, ['original'])).toThrow();
});
test('annotation candidates are literal, physically ordered, and scoped independently of ranking', () => {
  expect(annotationCandidates(index, { scope: 'both', keyword: 'FEE' })).toEqual([rows[0], rows[4]]);
  expect(annotationCandidates(index, { scope: 'original', page: 2, keyword: '' })).toEqual([rows[3]]);
  expect(annotationCandidates(index, { scope: 'both', keyword: 'fee.*' })).toEqual([]);
  expect(labelPage(rows, 1).items).toEqual(rows);
  expect(() => labelPage(rows, 2)).toThrow();
});
test('case edits are immutable and duplicate IDs fail', () => {
  const saved = draft();
  expect(() => saveDraftCase(saved, filled(), index, attached)).toThrow();
  expect(deleteDraftCase(saved, 'fee').cases).toEqual([]);
  expect(saved.cases).toHaveLength(1);
  const changed = saveDraftCase(saved, setCaseKind(filled(), 'ambiguous'), index, attached, 'fee');
  expect(changed.cases[0].kind).toBe('ambiguous');
  expect(saved.cases[0].kind).toBe('answerable');
});
for (const change of [
  { dataset: 'Bad ID' }, { snapshot: '../a.json' }, { snapshot: 'labels.json' }, { split: 'validation' },
]) {
  test('rejects invalid metadata ' + JSON.stringify(change), () => expect(() => parseMetadata({ ...metadata, ...change })).toThrow());
}
test('rejects multiple questions, missing roles, invalid slices and page mismatch', () => {
  expect(() => makeDraftCase('test', 'Fee? Eligibility?', 'original', ['x'], 'answerable', index, attached)).toThrow();
  expect(() => makeDraftCase('test', 'Fee?', 'both', ['x'], 'answerable', index, ['original'])).toThrow();
  expect(() => makeDraftCase('test', 'Fee?', 'original', ['x', 'x'], 'answerable', index, attached)).toThrow();
  expect(() => validateDraft({ ...empty, cases: [{ ...newCase(), page: 2 }] }, index, attached)).toThrow();
});
test('private draft binds exact extraction and supports incomplete labels', async () => {
  const partial = saveDraftCase(empty, newCase(), index, attached);
  const text = await serializeLabelDraft(partial, index, pins, corpora);
  expect(text).not.toContain(rows[0].text);
  expect(await parseLabelDraft(text, index, pins, corpora)).toEqual(partial);
  await expect(parseLabelDraft(text, index, { ...pins, original: 'c'.repeat(64) }, corpora)).rejects.toThrow();
  await expect(parseLabelDraft(text, index, pins, { ...corpora, original: { ...corpora.original,
    limited: true, limitedPages: [1] } })).rejects.toThrow();
});
test('draft rejects forged metadata, duplicates, noncanonical bytes and invalid UTF-8', async () => {
  const text = await serializeLabelDraft(draft(), index, pins, corpora);
  for (const bad of [text.trim(), text.replace('"version": 1,', '"version": 1, "version": 1,'),
    text.replace('"authority_verified": false', '"authority_verified": true'), 'x'.repeat(MAX_LABEL_DRAFT_BYTES + 1)]) {
    await expect(parseLabelDraft(bad, index, pins, corpora)).rejects.toThrow();
  }
  await expect(readLabelDraft(new File([new Uint8Array([0xff])], 'invalid.json'), index, pins, corpora)).rejects.toThrow();
});
test('exported pair is compatible with the actual offline dataset runner', async () => {
  const result = await exportLabelBundle(draft(), index, pins, corpora, 'synthetic', true);
  expect(result.snapshotSha256).toBe(createHash('sha256').update(result.snapshot).digest('hex'));
  expect(result.manifest).not.toContain(rows[0].text);
  const dataset = parseDataset(result.manifest);
  const report = evaluateDataset(dataset, loadDataset(dataset, [{ name: metadata.snapshot,
    sha256: result.snapshotSha256, text: result.snapshot }]), 'development');
  expect(report.modes[0].totals.complete).toBe(1);
  expect(report.integrity_violations).toBe(0);
  expect(report.label_kind).toBe('synthetic');
});
test('incomplete labels and absent consent prevent final export', async () => {
  await expect(exportLabelBundle(draft(), index, pins, corpora, 'synthetic', false)).rejects.toThrow();
  await expect(exportLabelBundle(saveDraftCase(empty, newCase(), index, attached), index, pins, corpora, 'synthetic', true)).rejects.toThrow();
});
