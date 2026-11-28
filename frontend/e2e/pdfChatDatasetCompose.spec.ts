import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { composeDataset } from '../evaluation/datasetCompose';
import { loadDataset, parseDataset, evaluateDataset } from '../evaluation/retrievalDataset';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function snapshot(pin: string, value: string) {
  const text = serializeCorpusSnapshot({ original: pin.repeat(64) }, { original: {
    passages: [{ role: 'original', page: 1, ordinal: 1, text: value }],
    pageCount: 1, processedPages: 1, missingPages: [], limitedPages: [], limited: false,
  } });
  return { text, sha256: hash(text) };
}
const first = { name: 'notice-a.json', ...snapshot('a', 'Application fee: INR 500') };
const second = { name: 'notice-b.json', ...snapshot('b', 'Application fee: INR 350') };
function input(name: string, suffix: string, artifact: typeof first, split: string, family = 'family-' + suffix) {
  const value = { format: 'noticebridge-retrieval-labels', version: 1, id: 'study-' + suffix,
    kind: 'synthetic', documents: [{ id: 'doc-' + suffix, family, split, snapshot: artifact.name,
      snapshot_sha256: artifact.sha256, cases: [{
        id: 'fee-' + suffix, question: 'Application fee?', slices: ['fee'], scope: 'original',
        label: { kind: 'answerable', evidenceSets: [['original:1:1']] },
      }] }],
  };
  const text = JSON.stringify(value, null, 2) + '\n';
  return { name, text, sha256: hash(text) };
}
const a = input('a.json', 'a', first, 'development');
const b = input('b.json', 'b', second, 'holdout');
function change(source: typeof a, mutate: (value: any) => void) {
  const value = JSON.parse(source.text); mutate(value);
  const text = JSON.stringify(value, null, 2) + '\n';
  return { ...source, text, sha256: hash(text) };
}
test('composition is deterministic and retains independently assigned splits and labels', () => {
  const result = composeDataset('combined', [a, b], [first, second]);
  expect(result).toEqual(composeDataset('combined', [b, a], [second, first]));
  expect(result.audit).toMatchObject({ documents: 2, cases: 2, families: 2,
    development: { documents: 1, cases: 1, families: 1 },
    holdout: { documents: 1, cases: 1, families: 1 }, authority_verified: false });
  expect(JSON.stringify(result.audit)).not.toContain('Application fee');
  const dataset = parseDataset(result.manifest);
  const loaded = loadDataset(dataset, [first, second]);
  expect(evaluateDataset(dataset, loaded, 'development').modes[0].totals.complete).toBe(1);
  expect(evaluateDataset(dataset, loaded, 'holdout').modes[0].totals.complete).toBe(1);
});
test('composition never renumbers duplicate case, document or snapshot identities', () => {
  for (const changed of [
    change(b, value => value.documents[0].id = 'doc-a'),
    change(b, value => value.documents[0].cases[0].id = 'fee-a'),
    change(b, value => value.documents[0].snapshot = first.name),
  ]) expect(() => composeDataset('combined', [a, changed], [first, second])).toThrow();
});
test('synthetic and independently reviewed labels cannot be mixed', () => {
  expect(() => composeDataset('combined', [a, change(b, value => value.kind = 'independently_reviewed')],
    [first, second])).toThrow();
});
test('same family cannot span development and holdout', () => {
  const changed = change(b, value => value.documents[0].family = 'family-a');
  expect(() => composeDataset('combined', [a, changed], [first, second])).toThrow();
  const sameSplit = change(changed, value => value.documents[0].split = 'development');
  expect(composeDataset('combined', [a, sameSplit], [first, second]).audit.development.families).toBe(1);
});
test('same PDF bytes in differently named snapshots cannot leak across families', () => {
  const reused = { name: second.name, ...snapshot('a', 'Application fee: INR 350') };
  const changed = change(b, value => value.documents[0].snapshot_sha256 = reused.sha256);
  expect(() => composeDataset('combined', [a, changed], [first, reused])).toThrow();
});
test('composition rejects missing, stale or excess snapshots and invalid evidence identity', () => {
  expect(() => composeDataset('combined', [a, b], [first])).toThrow();
  expect(() => composeDataset('combined', [a, b], [first, { ...second, sha256: 'c'.repeat(64) }])).toThrow();
  expect(() => composeDataset('combined', [a, b], [first, second, first])).toThrow();
  const changed = change(b, value => value.documents[0].cases[0].label.evidenceSets = [['original:1:99']]);
  expect(() => composeDataset('combined', [a, changed], [first, second])).toThrow();
});
test('manifest paths and digests cannot be reused or mistaken for snapshots', () => {
  for (const inputs of [
    [a, { ...b, name: a.name }],
    [a, { ...b, sha256: a.sha256 }],
    [a, { ...b, name: first.name }],
    [a, { ...b, name: '../b.json' }],
  ]) expect(() => composeDataset('combined', inputs, [first, second])).toThrow();
  expect(() => composeDataset('Bad ID', [a, b], [first, second])).toThrow();
  expect(() => composeDataset('combined', [], [])).toThrow();
});
test('composition CLI preserves existing files, rejects symlink inputs and publishes a usable manifest', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('compose-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/compose.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  for (const item of [a, b, first, second]) writeFileSync(join(root, item.name), item.text, 'utf8');
  function run(output: string, inputs = [a.name, b.name]) {
    return spawnSync(process.execPath, [join(bundle, 'compose.js'), '--directory', root,
      '--id', 'combined', '--output', output, '--inputs', ...inputs], { encoding: 'utf8', timeout: 15_000 });
  }
  const result = run('combined.json');
  expect(result.status, result.stderr).toBe(0);
  const output = readFileSync(join(root, 'combined.json'), 'utf8');
  expect(parseDataset(output).documents).toHaveLength(2);
  expect(JSON.parse(result.stdout).cases).toBe(2);
  expect(result.stdout).not.toContain('Application fee');
  expect(run('combined.json').status).toBe(1);
  expect(readFileSync(join(root, 'combined.json'), 'utf8')).toBe(output);
  expect(run(a.name).status).toBe(1);
  expect(run(first.name).status).toBe(1);
  if (process.platform !== 'win32') {
    symlinkSync(join(root, b.name), join(root, 'link.json'));
    expect(run('failed.json', [a.name, 'link.json']).status).toBe(1);
    expect(existsSync(join(root, 'failed.json'))).toBe(false);
  }
});

test('composition checks actual manifest text bytes against each claimed fingerprint', () => {
  expect(() => composeDataset('combined', [{ ...a, text: a.text + ' ' }, b], [first, second])).toThrow();
});
