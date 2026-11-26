import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import { parseDataset, loadDataset, evaluateDataset, MAX_MANIFEST_BYTES } from '../evaluation/retrievalDataset';
import type { Passage, Corpus } from '../src/pdfChatCore';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Rural applicants' },
  { role: 'original', page: 1, ordinal: 3, text: 'Residence certificate required' },
];
const snapshot = (pin: string, passages: Passage[] = rows) => serializeCorpusSnapshot({ original: pin.repeat(64) },
  { original: { pageCount: 1, processedPages: 1, missingPages: [], limitedPages: [],
    limited: false, passages } satisfies Corpus });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const a = snapshot('a'), b = snapshot('b', [{ ...rows[0], text: 'Application fee: INR 900' }]);
const firstCases = [
  { id: 'fee-a', slices: ['fee'], question: 'Application fee?', scope: 'original',
    label: { kind: 'answerable', evidenceSets: [['original:1:1']] } },
  { id: 'context-a', slices: ['context'], question: 'Rural residence certificate?', scope: 'original',
    label: { kind: 'answerable', evidenceSets: [['original:1:2', 'original:1:3']] } },
  { id: 'refund-a', slices: ['negative'], question: 'Refund policy?', scope: 'original',
    label: { kind: 'unanswerable' } },
];
const manifest = {
  format: 'noticebridge-retrieval-labels', version: 1, id: 'fictional', kind: 'synthetic',
  documents: [
    { id: 'doc-a', family: 'family-a', split: 'development', snapshot: 'a.json',
      snapshot_sha256: sha(a), cases: firstCases },
    { id: 'doc-b', family: 'family-b', split: 'holdout', snapshot: 'b.json',
      snapshot_sha256: sha(b), cases: [{ ...firstCases[0], id: 'fee-b' }] },
  ],
};
const artifacts = [{ name: 'a.json', text: a, sha256: sha(a) }, { name: 'b.json', text: b, sha256: sha(b) }];
const parse = (value: unknown = manifest) => parseDataset(JSON.stringify(value));
test('isolated document evaluation has explicit split, transitions and no quoted source text', () => {
  const dataset = parse(), loaded = loadDataset(dataset, artifacts);
  const dev = evaluateDataset(dataset, loaded, 'development');
  const holdout = evaluateDataset(dataset, loaded, 'holdout');
  expect(dev.documents).toEqual(['doc-a']);
  expect(holdout.documents).toEqual(['doc-b']);
  expect(dev.modes[0].totals.cases).toBe(3);
  expect(dev.modes[0].totals.complete).toBe(1);
  expect(dev.modes[1].totals.complete).toBe(2);
  expect(dev.transitions[0].gained).toEqual(['context-a']);
  expect(dev.transitions[0].lost).toEqual([]);
  expect(dev.integrity_violations).toBe(0);
  expect(holdout.modes[0].totals.complete).toBe(1);
  expect(JSON.stringify(dev)).not.toContain('Application fee');
  expect(JSON.stringify(dev)).not.toContain('Residence certificate');
  expect(JSON.stringify(dev)).not.toContain('Refund policy');
  expect(dev.authority_verified).toBe(false);
});
test('manifest declares label provenance without inferring independence', () => {
  expect(parse().kind).toBe('synthetic');
  const dataset = parse({ ...manifest, kind: 'independently_reviewed' });
  expect(evaluateDataset(dataset, loadDataset(dataset, artifacts), 'holdout').synthetic).toBe(false);
});
for (const [name, mutate] of [
  ['path traversal', (raw: any) => raw.documents[0].snapshot = '../a.json'],
  ['absolute path', (raw: any) => raw.documents[0].snapshot = '/tmp/a.json'],
  ['duplicate file', (raw: any) => raw.documents[1].snapshot = 'a.json'],
  ['duplicate document', (raw: any) => raw.documents[1].id = 'doc-a'],
  ['duplicate question id', (raw: any) => raw.documents[1].cases[0].id = 'fee-a'],
  ['family leakage', (raw: any) => raw.documents[1].family = 'family-a'],
  ['bad digest', (raw: any) => raw.documents[1].snapshot_sha256 = 'bad'],
  ['invalid split', (raw: any) => raw.documents[0].split = 'validation'],
  ['unknown label kind', (raw: any) => raw.documents[0].cases[0].label = { kind: 'maybe' }],
  ['unknown field', (raw: any) => raw.documents[0].cases[0].answer = 'invented'],
  ['page mismatch', (raw: any) => raw.documents[0].cases[0].page = 1],
  ['multi-question case', (raw: any) => raw.documents[0].cases[0].question = 'Fee? Eligibility?'],
  ['repeated slice', (raw: any) => raw.documents[0].cases[0].slices = ['fee', 'fee']],
  ['missing cases', (raw: any) => raw.documents[0].cases = []],
] as const) {
  test('manifest rejects ' + name, () => {
    const raw = structuredClone(manifest);
    mutate(raw);
    expect(() => parse(raw)).toThrow();
  });
}
test('oversized manifests are rejected before JSON parsing', () => {
  expect(() => parseDataset(' '.repeat(MAX_MANIFEST_BYTES + 1))).toThrow();
});
test('artifact digest and role-scoped labels must match the exact snapshot', () => {
  expect(() => loadDataset(parse(), [{ ...artifacts[0], sha256: 'c'.repeat(64) }, artifacts[1]])).toThrow();
  expect(() => loadDataset(parse(), [artifacts[0]])).toThrow();
  expect(() => loadDataset(parse(), [...artifacts, artifacts[0]])).toThrow();
  const bad = structuredClone(manifest);
  bad.documents[0].cases[0].label.evidenceSets = [['original:1:99']];
  expect(() => loadDataset(parse(bad), artifacts)).toThrow();
});
test('same PDF fingerprint cannot be assigned to unrelated document families', () => {
  const duplicate = snapshot('a', [{ ...rows[0], text: 'Different indexed text' }]);
  const raw = structuredClone(manifest);
  raw.documents[1].snapshot_sha256 = sha(duplicate);
  expect(() => loadDataset(parse(raw), [artifacts[0],
    { name: 'b.json', text: duplicate, sha256: sha(duplicate) }])).toThrow();
});
test('same-family versions may coexist in the same split, not in both splits', () => {
  const raw = structuredClone(manifest);
  raw.documents[1].family = 'family-a';
  raw.documents[1].split = 'development';
  const dataset = parse(raw);
  const report = evaluateDataset(dataset, loadDataset(dataset, artifacts), 'development');
  expect(report.modes[0].totals.families).toBe(1);
  expect(report.modes[0].totals.cases).toBe(4);
  expect(() => evaluateDataset(dataset, loadDataset(dataset, artifacts), 'holdout')).toThrow();
});
