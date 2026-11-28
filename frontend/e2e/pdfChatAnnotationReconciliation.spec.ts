import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reconcileAnnotations, replayReconciliation, type ReviewInput } from '../evaluation/annotationReconciliation';
import { parseDataset, loadDataset, evaluateDataset } from '../evaluation/retrievalDataset';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import type { Passage, Corpus } from '../src/pdfChatCore';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const label = (sets: string[][]) => ({ kind: 'answerable', evidenceSets: sets });
const sourceRows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR 500' },
  { role: 'original', page: 1, ordinal: 2, text: 'Rural applicants only' },
  { role: 'original', page: 1, ordinal: 3, text: 'Residence certificate required' },
  { role: 'original', page: 2, ordinal: 1, text: 'Examination date: 2026-12-15' },
];
const corpus: Corpus = { passages: sourceRows, pageCount: 2, processedPages: 2,
  missingPages: [], limitedPages: [], limited: false };
const snapshot = serializeCorpusSnapshot({ original: 'a'.repeat(64) }, { original: corpus });
const holdoutSnapshot = serializeCorpusSnapshot({ original: 'b'.repeat(64) }, { original: corpus });
const devArtifact = { name: 'dev.json', text: snapshot, sha256: sha(snapshot) };
const holdArtifact = { name: 'hold.json', text: holdoutSnapshot, sha256: sha(holdoutSnapshot) };
const leftFixture = {
  format: 'noticebridge-retrieval-labels', version: 1, id: 'reviewer-a', kind: 'independently_reviewed',
  documents: [
    { id: 'dev', family: 'family-a', split: 'development', snapshot: devArtifact.name, snapshot_sha256: devArtifact.sha256,
      cases: [
        { id: 'fee', question: 'Application fee?', scope: 'original', slices: ['printed', 'fee'],
          label: label([['original:1:1']]) },
        { id: 'certificate', question: 'Rural residence certificate?', scope: 'original', slices: ['context'],
          label: label([['original:1:2', 'original:1:3']]) },
        { id: 'refund', question: 'Refund policy?', scope: 'original', slices: ['negative'],
          label: { kind: 'unanswerable' } },
      ] },
    { id: 'hold', family: 'family-b', split: 'holdout', snapshot: holdArtifact.name, snapshot_sha256: holdArtifact.sha256,
      cases: [
        { id: 'date', question: 'Examination date on page 2?', scope: 'original', page: 2, slices: ['date'],
          label: label([['original:2:1']]) },
        { id: 'scholarship', question: 'Scholarship policy?', scope: 'original', slices: ['negative'],
          label: { kind: 'unindexed' } },
      ] },
  ],
};
const rightFixture = structuredClone(leftFixture);
rightFixture.id = 'reviewer-b';
rightFixture.documents[0].cases[1].label = label([['original:1:3']]);
rightFixture.documents[0].cases[2].label = { kind: 'ambiguous' };
rightFixture.documents[1].cases[1].label = { kind: 'unanswerable' };
const thirdFixture = structuredClone(leftFixture);
thirdFixture.id = 'reviewer-c';
thirdFixture.documents[0].cases = thirdFixture.documents[0].cases.filter(row => row.id !== 'fee');
thirdFixture.documents[0].cases[0].label = label([['original:1:3', 'original:1:2']]);
thirdFixture.documents[0].cases[1].label = { kind: 'unindexed' };
thirdFixture.documents[1].cases = thirdFixture.documents[1].cases.filter(row => row.id === 'scholarship');
thirdFixture.documents[1].cases[0].label = { kind: 'ambiguous' };

function side(value: unknown, artifacts = [devArtifact, holdArtifact]): ReviewInput {
  return { manifest: encode(value), artifacts: artifacts.map(file => ({ ...file })) };
}
const left = side(leftFixture), right = side(rightFixture), third = side(thirdFixture);
function resolveLabels() { return reconcileAnnotations('final-review', left, right, third); }
function mutateFixture(value: unknown, change: (raw: any) => void) {
  const copy = structuredClone(value); change(copy); return side(copy);
}
function outputCases(manifest: string) {
  return parseDataset(manifest).documents.flatMap(document => document.cases);
}

test('complete reconciliation preserves agreement and uses explicitly authored third labels for every disagreement', () => {
  const result = resolveLabels(), rows = outputCases(result.manifest);
  expect(rows.map(row => row.id)).toEqual(['certificate', 'fee', 'refund', 'date', 'scholarship']);
  expect(rows.find(row => row.id === 'certificate')?.label).toEqual(label([['original:1:2', 'original:1:3']]));
  expect(rows.find(row => row.id === 'fee')?.label).toEqual(label([['original:1:1']]));
  expect(rows.find(row => row.id === 'refund')?.label).toEqual({ kind: 'unindexed' });
  expect(rows.find(row => row.id === 'scholarship')?.label).toEqual({ kind: 'ambiguous' });
  expect(result.audit.cases).toBe(5);
  expect(result.audit.agreed).toBe(2);
  expect(result.audit.third_reviewed).toBe(3);
  expect(result.audit.by_split).toEqual([
    { split: 'development', cases: 3, agreed: 1, third_reviewed: 2 },
    { split: 'holdout', cases: 2, agreed: 1, third_reviewed: 1 },
  ]);
  expect(result.audit.inputs).toEqual({ left_sha256: sha(left.manifest), right_sha256: sha(right.manifest), third_sha256: sha(third.manifest) });
  expect(result.audit.manifest_sha256).toBe(sha(result.manifest));
  expect(result.audit.authority_verified).toBe(false);
  expect(result.audit.reviewer_identity_verified).toBe(false);
  expect(result.audit.resolutions.find(row => row.id === 'certificate')).toMatchObject({
    source: 'third_review', reason: 'evidence_alternative_disagreement', kind: 'answerable', alternative_count: 1,
  });
  expect(result.audit.resolutions.find(row => row.id === 'refund')).toMatchObject({
    source: 'third_review', reason: 'category_disagreement', kind: 'unindexed', alternative_count: 0,
  });
  expect(result.audit.resolutions.find(row => row.id === 'date')).toMatchObject({
    source: 'agreement', reason: 'exact_agreement', split: 'holdout',
  });
  const audit = encode(result.audit);
  for (const secret of ['Application fee', 'Residence certificate', 'Refund policy', 'Scholarship policy',
    'original:1:1', 'original:1:2', 'INR 500']) expect(audit).not.toContain(secret);
  expect(replayReconciliation(result.manifest, 'final-review', left, right, third)).toEqual(result.audit);
  // Final output is independently usable by the existing evaluator.
  const dataset = parseDataset(result.manifest), loaded = loadDataset(dataset, left.artifacts);
  const dev = evaluateDataset(dataset, loaded, 'development'), holdout = evaluateDataset(dataset, loaded, 'holdout');
  expect(dev.modes[0].totals.cases).toBe(3);
  expect(holdout.modes[0].totals.cases).toBe(2);
  expect(dev.integrity_violations).toBe(0);
  expect(holdout.integrity_violations).toBe(0);
});
test('third reviewer can choose a newly inspected valid alternative rather than copying a reviewer', () => {
  const altered = mutateFixture(thirdFixture, raw => raw.documents[0].cases[0].label =
    label([['original:1:2'], ['original:1:3']]));
  const rows = outputCases(reconcileAnnotations('final-review', left, right, altered).manifest);
  expect(rows.find(row => row.id === 'certificate')?.label).toEqual(label([['original:1:2'], ['original:1:3']]));
});
test('no third reviewer is necessary only when all complete alternative sets agree', () => {
  const identical = mutateFixture(leftFixture, raw => {
    raw.id = 'reviewer-b';
    raw.documents.reverse();
    raw.documents[1].cases.reverse();
    raw.documents[1].cases.find((row: any) => row.id === 'certificate').label.evidenceSets[0].reverse();
  });
  const result = reconcileAnnotations('final-review', left, identical);
  expect(result.audit.third_reviewed).toBe(0);
  expect(result.audit.agreed).toBe(5);
  expect(result.audit.inputs.third_sha256).toBeNull();
  expect(() => reconcileAnnotations('final-review', left, identical, third)).toThrow();
});
test('canonical manifest order is stable despite input ordering and renamed third snapshots', () => {
  const reorderedLeft = mutateFixture(leftFixture, raw => {
    raw.documents.reverse();
    for (const document of raw.documents) {
      document.cases.reverse();
      for (const row of document.cases) row.slices.reverse();
    }
  });
  const renamed = structuredClone(thirdFixture);
  renamed.documents[0].snapshot = 'renamed-dev.json';
  renamed.documents[1].snapshot = 'renamed-hold.json';
  const renamedArtifacts = [{ ...devArtifact, name: 'renamed-dev.json' }, { ...holdArtifact, name: 'renamed-hold.json' }];
  const result = reconcileAnnotations('final-review', reorderedLeft, right, side(renamed, renamedArtifacts));
  expect(result.manifest).toBe(resolveLabels().manifest);
  expect(result.audit.inputs.left_sha256).not.toBe(sha(left.manifest));
});
test('synthetic provenance cannot be promoted by reconciliation', () => {
  const synthetic = (value: unknown) => mutateFixture(value, raw => raw.kind = 'synthetic');
  const result = reconcileAnnotations('synthetic-final', synthetic(leftFixture), synthetic(rightFixture), synthetic(thirdFixture));
  expect(parseDataset(result.manifest).kind).toBe('synthetic');
  expect(result.audit.label_kind).toBe('synthetic');
});
test('missing first or second reviewer cases must be completed before adjudication', () => {
  const partial = mutateFixture(rightFixture, raw => raw.documents[0].cases.pop());
  expect(() => reconcileAnnotations('final-review', left, partial, third)).toThrow();
});
test('missing or unrelated third labels are not accepted', () => {
  expect(() => reconcileAnnotations('final-review', left, right)).toThrow();
  const missing = mutateFixture(thirdFixture, raw => raw.documents[0].cases.pop());
  expect(() => reconcileAnnotations('final-review', left, right, missing)).toThrow();
  const extra = mutateFixture(thirdFixture, raw => raw.documents[0].cases.push(leftFixture.documents[0].cases[0]));
  expect(() => reconcileAnnotations('final-review', left, right, extra)).toThrow();
  const swapped = mutateFixture(thirdFixture, raw => raw.documents[0].cases[0].id = 'fee');
  expect(() => reconcileAnnotations('final-review', left, right, swapped)).toThrow();
});
for (const [name, mutate] of [
  ['same reviewer ID', (raw: any) => raw.id = 'reviewer-a'],
  ['output identity', (raw: any) => raw.id = 'final-review'],
  ['mixed provenance', (raw: any) => raw.kind = 'synthetic'],
  ['changed question', (raw: any) => raw.documents[0].cases[0].question = 'Residence certificate?'],
  ['changed scope', (raw: any) => raw.documents[0].cases[0].scope = 'both'],
  ['changed page', (raw: any) => { raw.documents[0].cases[0].page = 1; raw.documents[0].cases[0].question += ' on page 1'; }],
  ['changed slices', (raw: any) => raw.documents[0].cases[0].slices = ['fee']],
  ['wrong document', (raw: any) => raw.documents[0].id = 'other-document'],
  ['wrong family', (raw: any) => raw.documents[0].family = 'other-family'],
  ['changed split', (raw: any) => raw.documents[0].split = 'holdout'],
  ['nonexistent evidence', (raw: any) => raw.documents[0].cases[0].label = label([['original:1:99']])],
  ['duplicate evidence', (raw: any) => raw.documents[0].cases[0].label = label([['original:1:2', 'original:1:2']])],
  ['duplicate alternatives', (raw: any) => raw.documents[0].cases[0].label = label([['original:1:2'], ['original:1:2']])],
  ['unrecognized category', (raw: any) => raw.documents[0].cases[0].label = { kind: 'verified' }],
  ['additional claim', (raw: any) => raw.documents[0].cases[0].label.answer = 'invented'],
] as const) {
  test('third label rejects ' + name, () => {
    expect(() => reconcileAnnotations('final-review', left, right, mutateFixture(thirdFixture, mutate))).toThrow();
  });
}
test('all input digests are recalculated rather than trusting claimed snapshot hashes', () => {
  const altered = serializeCorpusSnapshot({ original: 'a'.repeat(64) }, { original: {
    ...corpus, passages: sourceRows.map((row, i) => i === 0 ? { ...row, text: 'Application fee: INR 900' } : row),
  } });
  for (const index of [0, 1, 2]) {
    const inputs = [left, right, third].map(item => structuredClone(item));
    inputs[index].artifacts[0].text = altered;
    expect(() => reconcileAnnotations('final-review', inputs[0], inputs[1], inputs[2])).toThrow();
  }
});
test('third reviewer cannot use independently valid but different source bytes', () => {
  const changed = serializeCorpusSnapshot({ original: 'c'.repeat(64) }, { original: corpus });
  const raw = structuredClone(thirdFixture); raw.documents[0].snapshot_sha256 = sha(changed);
  const changedSide = side(raw, [{ ...devArtifact, text: changed, sha256: sha(changed) }, holdArtifact]);
  expect(() => reconcileAnnotations('final-review', left, right, changedSide)).toThrow();
});
test('input identity and output identity must remain distinct', () => {
  expect(() => reconcileAnnotations('reviewer-a', left, right, third)).toThrow();
  expect(() => reconcileAnnotations('reviewer-c', left, right, third)).toThrow();
  expect(() => reconcileAnnotations('../unsafe', left, right, third)).toThrow();
  expect(() => reconcileAnnotations('final-review', left, left)).toThrow();
});
test('replay rejects tampered labels, whitespace, case ordering and output ID', () => {
  const result = resolveLabels();
  expect(() => replayReconciliation(result.manifest.trim(), 'final-review', left, right, third)).toThrow();
  const raw = JSON.parse(result.manifest);
  raw.documents[0].cases[0].label = label([['original:1:3']]);
  expect(() => replayReconciliation(encode(raw), 'final-review', left, right, third)).toThrow();
  raw.documents.reverse();
  expect(() => replayReconciliation(encode(raw), 'final-review', left, right, third)).toThrow();
  expect(() => replayReconciliation(result.manifest, 'other-id', left, right, third)).toThrow();
});
test('inputs remain unchanged throughout reconciliation', () => {
  const before = [left, right, third].map(item => encode(item));
  resolveLabels();
  expect([left, right, third].map(item => encode(item))).toEqual(before);
});
test('reconciliation CLI produces a usable manifest, verifies exact replay and refuses unsafe outputs', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('reconcile-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/reconcile.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const cli = join(bundle, 'reconcile.js');
  const inputs = [left, right, third].map((input, i) => {
    const directory = join(root, 'reviewer-' + i);
    mkdirSync(directory);
    const filename = join(directory, 'labels.json');
    writeFileSync(filename, input.manifest);
    for (const file of input.artifacts) writeFileSync(join(directory, file.name), file.text);
    return filename;
  });
  const output = join(root, 'reviewer-0', 'final.json');
  const args = ['--left', inputs[0], '--right', inputs[1], '--third', inputs[2],
    '--id', 'final-review', '--output', output];
  function run(values: string[]) {
    return spawnSync(process.execPath, [cli, ...values], { encoding: 'utf8', timeout: 20_000 });
  }
  expect(run(['--help']).status).toBe(0);
  const completed = run(args);
  expect(completed.status, completed.stderr).toBe(0);
  expect(completed.stderr).toBe('');
  const text = readFileSync(output, 'utf8');
  expect(text).toBe(resolveLabels().manifest);
  expect(JSON.parse(completed.stdout)).toMatchObject({ consistent: true, verified_replay: false,
    manifest_sha256: sha(text), authority_verified: false, reviewer_identity_verified: false,
    cases: 5, agreed: 2, third_reviewed: 3 });
  expect(completed.stdout).not.toContain('Application fee');
  expect(completed.stdout).not.toContain(root);
  const replay = run([...args, '--verify']);
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout).verified_replay).toBe(true);
  const duplicate = run(args);
  expect(duplicate.status).toBe(1);
  expect(duplicate.stdout).toBe('');
  expect(readFileSync(output, 'utf8')).toBe(text);
  const elsewhere = join(root, 'outside.json');
  expect(run([...args.slice(0, -1), elsewhere]).status).toBe(1);
  expect(existsSync(elsewhere)).toBe(false);
  expect(run([...args, '--id', 'another']).status).toBe(1);
  expect(run([...args, '--verify', '--verify']).status).toBe(1);
  writeFileSync(output, text + ' ');
  expect(run([...args, '--verify']).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(text + ' ');
  writeFileSync(output, text);
  writeFileSync(join(root, 'reviewer-2', 'dev.json'), snapshot + ' ');
  const bad = run([...args, '--verify']);
  expect(bad.status).toBe(1);
  expect(bad.stdout).toBe('');
  expect(bad.stderr).not.toContain(root);
  expect(bad.stderr).not.toContain('Application fee');
  expect(readFileSync(output, 'utf8')).toBe(text);
  expect(readFileSync(inputs[0], 'utf8')).toBe(left.manifest);
  expect(readFileSync(inputs[1], 'utf8')).toBe(right.manifest);
  expect(readFileSync(inputs[2], 'utf8')).toBe(third.manifest);
});
