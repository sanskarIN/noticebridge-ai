import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareAnnotations, compareEvidenceLabels, summarizeAgreement } from '../evaluation/annotationAgreement';
import { parseDataset } from '../evaluation/retrievalDataset';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import type { Corpus, Passage } from '../src/pdfChatCore';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Rural applicants' },
  { role: 'original', page: 1, ordinal: 3, text: 'Residence certificate required' },
  { role: 'original', page: 2, ordinal: 1, text: 'Examination date: 2026-12-15' },
];
const corpus: Corpus = { passages: rows, pageCount: 2, processedPages: 2, missingPages: [], limitedPages: [], limited: false };
const text = serializeCorpusSnapshot({ original: 'a'.repeat(64) }, { original: corpus });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const artifact = { name: 'notice.json', text, sha256: hash(text) };
const label = (sets: string[][]) => ({ kind: 'answerable' as const, evidenceSets: sets });
const reference = {
  format: 'noticebridge-retrieval-labels', version: 1, id: 'reviewer-a', kind: 'independently_reviewed',
  documents: [{
    id: 'notice', family: 'family-a', split: 'holdout', snapshot: artifact.name, snapshot_sha256: artifact.sha256,
    cases: [
      { id: 'fee', slices: ['printed', 'fee'], scope: 'original', question: 'Application fee?',
        label: label([['original:1:1']]) },
      { id: 'certificate', slices: ['context'], scope: 'original', question: 'Rural residence certificate?',
        label: label([['original:1:2', 'original:1:3']]) },
      { id: 'refund', slices: ['negative'], scope: 'original', question: 'Refund policy?', label: { kind: 'unanswerable' } },
      { id: 'date', slices: ['printed', 'date'], scope: 'original', page: 2, question: 'Examination date on page 2?',
        label: label([['original:2:1']]) },
    ],
  }],
};
function other(mutate: (value: any) => void = () => {}) {
  const copy = structuredClone(reference); copy.id = 'reviewer-b'; mutate(copy); return copy;
}
const right = other(value => {
  value.documents[0].cases[1].label = label([['original:1:3']]);
  value.documents[0].cases[2].label = { kind: 'ambiguous' };
});
const side = (value: unknown, file = artifact) => ({ dataset: parseDataset(JSON.stringify(value)), artifacts: [file] });
const compare = (value: unknown = right) => compareAnnotations(side(reference), side(value));

test('identical evidence alternatives ignore order of sets and identities', () => {
  const result = compareEvidenceLabels(label([['a', 'b'], ['c']]), label([['c'], ['b', 'a']]));
  expect(result).toEqual({ exactAlternatives: true, leftAlternatives: 2, rightAlternatives: 2,
    commonAlternatives: 2, unionJaccard: 1, leftBestCoverage: 1, rightBestCoverage: 1,
    leftOnlyIds: [], rightOnlyIds: [] });
});
test('equal union is not the same as identical complete evidence alternatives', () => {
  const result = compareEvidenceLabels(label([['a', 'b']]), label([['a'], ['b']]));
  expect(result.unionJaccard).toBe(1);
  expect(result.exactAlternatives).toBe(false);
  expect(result.commonAlternatives).toBe(0);
  expect(result.leftBestCoverage).toBe(0.5);
  expect(result.rightBestCoverage).toBe(1);
});
test('different evidence sets preserve directional coverage and explicit unique source identities', () => {
  const result = compareEvidenceLabels(label([['a', 'b']]), label([['b', 'c', 'd']]));
  expect(result.unionJaccard).toBe(0.25);
  expect(result.leftBestCoverage).toBe(0.5);
  expect(result.rightBestCoverage).toBeCloseTo(1 / 3);
  expect(result.leftOnlyIds).toEqual(['a']);
  expect(result.rightOnlyIds).toEqual(['c', 'd']);
});
test('invalid alternatives never produce misleading agreement', () => {
  expect(() => compareEvidenceLabels(label([]), label([['a']]))).toThrow();
  expect(() => compareEvidenceLabels(label([[]]), label([['a']]))).toThrow();
  expect(() => compareEvidenceLabels(label([['a', 'a']]), label([['a']]))).toThrow();
  expect(() => compareEvidenceLabels(label([['a', 'b'], ['b', 'a']]), label([['a']]))).toThrow();
});
test('paired annotation report distinguishes category and complete-evidence disagreements', () => {
  const report = compare();
  expect(report.summary.pairedCases).toBe(4);
  expect(report.summary.sameKind).toBe(3);
  expect(report.summary.kindAgreement).toBe(0.75);
  expect(report.summary.expectedChanceAgreement).toBe(9 / 16);
  expect(report.summary.cohenKappa).toBeCloseTo(3 / 7);
  expect(report.summary.confusion.unanswerable.ambiguous).toBe(1);
  expect(report.summary.bothAnswerable).toBe(3);
  expect(report.summary.exactAlternativeMatches).toBe(2);
  expect(report.summary.exactAlternativeAgreement).toBeCloseTo(2 / 3);
  expect(report.summary.meanUnionJaccard).toBeCloseTo(5 / 6);
  expect(report.summary.needsAdjudication).toBe(2);
  expect(report.paired.filter(row => row.needsAdjudication).map(row => row.id)).toEqual(['certificate', 'refund']);
  expect(report.paired.find(row => row.id === 'certificate')?.evidence?.leftOnlyIds).toEqual(['original:1:2']);
  expect(report.authority_verified).toBe(false);
  expect(report.completePairing).toBe(true);
  expect(JSON.stringify(report)).not.toContain('Application fee');
  expect(JSON.stringify(report)).not.toContain('Refund policy');
});
test('empty denominators and degenerate category agreement remain null where undefined', () => {
  const empty = summarizeAgreement([]);
  expect(empty.kindAgreement).toBeNull();
  expect(empty.cohenKappa).toBeNull();
  expect(empty.exactAlternativeAgreement).toBeNull();
  const report = compare(reference);
  expect(report.summary.kindAgreement).toBe(1);
  expect(report.summary.cohenKappa).toBe(1);
  const only = other(value => value.documents[0].cases = value.documents[0].cases.filter((row: any) => row.id === 'fee'));
  const result = compareAnnotations(side(only), side(only));
  expect(result.summary.kindAgreement).toBe(1);
  expect(result.summary.expectedChanceAgreement).toBe(1);
  expect(result.summary.cohenKappa).toBeNull();
});
test('unpaired cases are reported separately and not assigned negative labels', () => {
  const partial = other(value => {
    value.documents[0].cases = value.documents[0].cases.filter((row: any) => row.id !== 'refund');
    value.documents[0].cases.push({ id: 'missing-left', slices: ['negative'], scope: 'original',
      question: 'Scholarship policy?', label: { kind: 'unanswerable' } });
  });
  const report = compare(partial);
  expect(report.completePairing).toBe(false);
  expect(report.summary.pairedCases).toBe(3);
  expect(report.unpaired).toEqual([
    { id: 'missing-left', document: 'notice', family: 'family-a', split: 'holdout', side: 'right' },
    { id: 'refund', document: 'notice', family: 'family-a', split: 'holdout', side: 'left' },
  ]);
});
test('slice order is irrelevant but changed slice membership is incomparable', () => {
  expect(compare(other(value => value.documents[0].cases[0].slices.reverse())).summary.sameKind).toBe(4);
  expect(() => compare(other(value => value.documents[0].cases[0].slices = ['different']))).toThrow();
});
for (const [name, mutate] of [
  ['question text', (value: any) => value.documents[0].cases[0].question = 'Registration fee?'],
  ['family', (value: any) => value.documents[0].family = 'family-b'],
  ['split', (value: any) => value.documents[0].split = 'development'],
  ['document identity', (value: any) => value.documents[0].id = 'other'],
  ['label provenance', (value: any) => value.kind = 'synthetic'],
  ['source identity', (value: any) => value.documents[0].cases[0].label.evidenceSets = [['original:1:99']]],
  ['page metadata', (value: any) => { value.documents[0].cases[3].page = 1;
    value.documents[0].cases[3].question = 'Examination date on page 1?';
    value.documents[0].cases[3].label.evidenceSets = [['original:1:1']]; }],
] as const) {
  test('annotation comparison rejects changed ' + name, () => expect(() => compare(other(mutate))).toThrow());
}
test('different snapshot filenames can bind the same bytes, but changed extraction cannot', () => {
  const renamed = { ...artifact, name: 'renamed.json' };
  const valid = other(value => value.documents[0].snapshot = renamed.name);
  expect(compareAnnotations(side(reference), side(valid, renamed)).summary.sameKind).toBe(4);
  const changedText = serializeCorpusSnapshot({ original: 'b'.repeat(64) }, { original: corpus });
  const changed = { ...artifact, text: changedText, sha256: hash(changedText) };
  const invalid = other(value => value.documents[0].snapshot_sha256 = changed.sha256);
  expect(() => compareAnnotations(side(reference), side(invalid, changed))).toThrow();
});
test('no paired cases does not produce an agreement result', () => {
  const value = other(raw => raw.documents[0].cases.forEach((row: any) => row.id += '-other'));
  expect(() => compare(value)).toThrow();
});
test('agreement summaries retain separate holdout, family and overlapping slice denominators', () => {
  const report = compare();
  expect(report.splits.find(row => row.split === 'development')?.summary.pairedCases).toBe(0);
  expect(report.splits.find(row => row.split === 'holdout')?.summary.pairedCases).toBe(4);
  expect(report.families[0].summary.needsAdjudication).toBe(2);
  expect(report.slices.find(row => row.slice === 'printed')?.summary.pairedCases).toBe(2);
  expect(report.slices.find(row => row.slice === 'context')?.summary.needsAdjudication).toBe(1);
});
test('agreement CLI validates both independent source snapshots and publishes only anonymous results', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('agreement-cli'), bundle = join(root, 'bundle');
  const leftDir = join(root, 'left'), rightDir = join(root, 'right');
  mkdirSync(leftDir, { recursive: true }); mkdirSync(rightDir, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/agree.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const leftFile = join(leftDir, 'labels.json'), rightFile = join(rightDir, 'labels.json');
  const leftText = JSON.stringify(reference), rightText = JSON.stringify(right);
  writeFileSync(leftFile, leftText); writeFileSync(rightFile, rightText);
  writeFileSync(join(leftDir, artifact.name), text); writeFileSync(join(rightDir, artifact.name), text);
  function run(output: string) {
    return spawnSync(process.execPath, [join(bundle, 'agree.js'), '--left', leftFile, '--right', rightFile,
      '--output', output], { encoding: 'utf8', timeout: 15_000 });
  }
  const output = join(root, 'agreement.json'), result = run(output);
  expect(result.status, result.stderr).toBe(0);
  const saved = readFileSync(output, 'utf8'), value = JSON.parse(saved);
  expect(value.left_manifest_sha256).toBe(hash(leftText));
  expect(value.right_manifest_sha256).toBe(hash(rightText));
  expect(value.summary.needsAdjudication).toBe(2);
  expect(result.stdout).not.toContain('Application fee');
  expect(saved).not.toContain('Residence certificate');
  expect(run(output).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(saved);
  writeFileSync(join(rightDir, artifact.name), '{}');
  expect(run(join(root, 'rejected.json')).status).toBe(1);
  expect(existsSync(join(root, 'rejected.json'))).toBe(false);
});
