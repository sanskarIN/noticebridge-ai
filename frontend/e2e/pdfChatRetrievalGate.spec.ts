import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freezeGatePlan, parseGatePlan, readGatePolicy, parseGatePolicy,
  qualifyRetrieval, replayGate, type GateInput, type GatePolicy } from '../evaluation/retrievalGate';
import { auditReport } from '../evaluation/reportAudit';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import type { Corpus, Passage } from '../src/pdfChatCore';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function source(name: string, pin: string, amount: number) {
  const passages: Passage[] = [
    { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR ' + amount },
    { role: 'original', page: 1, ordinal: 2, text: 'Examination date: 2026-12-15' },
  ];
  const corpus: Corpus = { passages, pageCount: 1, processedPages: 1,
    missingPages: [], limitedPages: [], limited: false };
  const text = serializeCorpusSnapshot({ original: pin.repeat(64) }, { original: corpus });
  return { name, text, sha256: sha(text) };
}
const artifacts = [source('dev.json', 'a', 350), source('hold-a.json', 'b', 500), source('hold-b.json', 'c', 650)];
function document(i: number, split: 'development' | 'holdout') {
  const artifact = artifacts[i];
  return { id: 'doc-' + i, family: 'family-' + i, split, snapshot: artifact.name, snapshot_sha256: artifact.sha256,
    cases: [
      { id: 'fee-' + i, question: 'Application fee?', scope: 'original', slices: ['fee', 'printed'],
        label: { kind: 'answerable', evidenceSets: [['original:1:1']] } },
      { id: 'date-' + i, question: 'Examination date?', scope: 'original', slices: ['date', 'printed'],
        label: { kind: 'answerable', evidenceSets: [['original:1:2']] } },
      { id: 'negative-' + i, question: 'Refund policy?', scope: 'original', slices: ['negative'],
        label: { kind: 'unanswerable' } },
    ] };
}
const manifest = {
  format: 'noticebridge-retrieval-labels', version: 1, id: 'fixture-study', kind: 'independently_reviewed',
  documents: [document(0, 'development'), document(1, 'holdout'), document(2, 'holdout')],
};
function input(value: unknown = manifest): GateInput {
  return { manifest: encode(value), artifacts: artifacts.map(row => ({ ...row })) };
}
const minimums = { cases: 6, families: 2, answerable: 4, unanswerable: 2, inaccessible: 0, ambiguous: 0 };
const thresholds = { citationPrecision: 1, citationRecall: 1, completeEvidenceRate: 1, unanswerableAbstentionRate: 1 };
const sliceMinimums = { cases: 2, families: 2, answerable: 2, unanswerable: 0, inaccessible: 0, ambiguous: 0 };
const policy: GatePolicy = { id: 'release-gate', purpose: 'release', split: 'holdout', minimums,
  modes: [{ mode: 'strict', thresholds, slices: [{ slice: 'fee', minimums: sliceMinimums,
    thresholds: { completeEvidenceRate: 1 } }] }] };
const frozen = () => freezeGatePlan(policy, input());
function modify(change: (raw: any) => void): GatePolicy {
  const raw = structuredClone(policy); change(raw); return raw;
}

test('freeze binds exact manifest and holdout inventory without evaluating outcomes', () => {
  const plan = frozen(), parsed = parseGatePlan(plan);
  expect(parsed).toMatchObject({
    dataset: 'fixture-study', label_kind: 'independently_reviewed', manifest_sha256: sha(input().manifest),
    authority_verified: false, reviewer_identity_verified: false,
    inventory: { documents: 2, cases: 6, families: 2, answerable: 4, unanswerable: 2,
      inaccessible: 0, ambiguous: 0, slices: ['date', 'fee', 'negative', 'printed'] },
  });
  expect(plan).not.toContain('Application fee');
  expect(plan).not.toContain('INR 500');
  expect(plan).not.toContain('evaluation_sha256');
  expect(frozen()).toBe(plan);
});
test('qualification reruns real retrieval, audits the report and verifies exact replay', () => {
  const plan = frozen(), result = qualifyRetrieval(plan, input());
  expect(result.report).toMatchObject({ status: 'qualified', metric_qualified: true,
    release_approved: false, authority_verified: false, reviewer_identity_verified: false,
    integrity_violations: 0, failures: [], purpose: 'release', split: 'holdout',
    plan_sha256: sha(plan), manifest_sha256: sha(input().manifest),
    evaluation_sha256: sha(result.evaluationText) });
  expect(result.report.modes[0].global.rates.every(check => check.actual === 1 && check.passed)).toBe(true);
  expect(result.report.modes[0].slices[0].result.passed).toBe(true);
  const audit = auditReport(result.evaluationText);
  expect(audit.documents).toEqual(['doc-1', 'doc-2']);
  expect(audit.modes[0].totals.cases).toBe(6);
  expect(replayGate(result.reportText, plan, input())).toEqual(result.report);
  expect(qualifyRetrieval(plan, input()).reportText).toBe(result.reportText);
  for (const secret of ['Application fee', 'Refund policy', 'INR 500', 'Examination date']) {
    expect(result.reportText).not.toContain(secret);
    expect(result.evaluationText).not.toContain(secret);
  }
});
test('a missing required slice is explicitly unqualified and cannot pass a zero threshold', () => {
  const updated = modify(raw => raw.modes[0].slices = [{
    slice: 'missing', minimums: sliceMinimums, thresholds: { completeEvidenceRate: 0 },
  }]);
  const result = qualifyRetrieval(freezeGatePlan(updated, input()), input()).report;
  expect(result.status).toBe('not_qualified');
  expect(result.failures).toContainEqual({ code: 'undefined_metric', mode: 'strict',
    slice: 'missing', metric: 'completeEvidenceRate', actual: null, required: 0 });
  expect(result.failures).toContainEqual({ code: 'missing_support', mode: 'strict',
    slice: 'missing', metric: 'families', actual: 0, required: 2 });
});
test('insufficient family and case counts fail even with perfect observed rates', () => {
  const updated = modify(raw => { raw.minimums.families = 3; raw.minimums.cases = 9; });
  const result = qualifyRetrieval(freezeGatePlan(updated, input()), input()).report;
  expect(result.metric_qualified).toBe(false);
  expect(result.failures).toContainEqual({ code: 'missing_support', mode: 'strict', slice: null,
    metric: 'families', actual: 2, required: 3 });
  expect(result.failures).toContainEqual({ code: 'missing_support', mode: 'strict', slice: null,
    metric: 'cases', actual: 6, required: 9 });
});
test('weak retrieval fails thresholds even with all required label counts', () => {
  const raw = structuredClone(manifest);
  raw.documents[1].cases[0].label = { kind: 'answerable', evidenceSets: [['original:1:2']] };
  const altered = input(raw);
  const result = qualifyRetrieval(freezeGatePlan(policy, altered), altered).report;
  expect(result.metric_qualified).toBe(false);
  expect(result.failures.some(row => row.code === 'below_threshold' && row.metric === 'completeEvidenceRate')).toBe(true);
  expect(result.integrity_violations).toBe(0);
});
test('development checks can use synthetic fixtures but cannot masquerade as release plans', () => {
  const synthetic = input({ ...manifest, kind: 'synthetic' });
  expect(() => freezeGatePlan(policy, synthetic)).toThrow();
  const development = modify(raw => {
    raw.id = 'dev-gate'; raw.purpose = 'development'; raw.split = 'development';
    raw.minimums = { ...minimums, cases: 3, families: 1, answerable: 2, unanswerable: 1 };
    raw.modes[0].slices = [];
  });
  const plan = freezeGatePlan(development, synthetic);
  const result = qualifyRetrieval(plan, synthetic).report;
  expect(result).toMatchObject({ metric_qualified: true, purpose: 'development',
    label_kind: 'synthetic', release_approved: false });
  expect(result.inventory.cases).toBe(3);
});
test('all configured modes are checked and order is deterministic', () => {
  const updated = modify(raw => {
    raw.modes.push({ mode: 'all-strict', thresholds, slices: [] });
    raw.modes.push({ mode: 'contextual', thresholds, slices: [] });
    raw.modes.reverse();
  });
  const result = qualifyRetrieval(freezeGatePlan(updated, input()), input()).report;
  expect(result.modes.map(row => row.mode)).toEqual(['strict', 'contextual', 'all-strict']);
  expect(result.modes.every(row => row.passed)).toBe(true);
});
for (const [name, change] of [
  ['unknown purpose', (raw: any) => raw.purpose = 'approved'],
  ['release on development', (raw: any) => raw.split = 'development'],
  ['single family release', (raw: any) => raw.minimums.families = 1],
  ['unknown metric', (raw: any) => raw.modes[0].thresholds.accuracy = 1],
  ['missing release metric', (raw: any) => delete raw.modes[0].thresholds.citationPrecision],
  ['zero release threshold', (raw: any) => raw.modes[0].thresholds.citationPrecision = 0],
  ['out of range threshold', (raw: any) => raw.modes[0].thresholds.citationPrecision = 1.01],
  ['negative threshold', (raw: any) => raw.modes[0].thresholds.citationPrecision = -0.1],
  ['string threshold', (raw: any) => raw.modes[0].thresholds.citationPrecision = '1'],
  ['null threshold', (raw: any) => raw.modes[0].thresholds.citationPrecision = null],
  ['unsupported denominator', (raw: any) => raw.modes[0].thresholds.ambiguousAbstentionRate = 1],
  ['impossible support sum', (raw: any) => raw.minimums.cases = 5],
  ['fractional minimum', (raw: any) => raw.minimums.families = 2.5],
  ['negative minimum', (raw: any) => raw.minimums.inaccessible = -1],
  ['unknown count', (raw: any) => raw.minimums.documents = 2],
  ['empty modes', (raw: any) => raw.modes = []],
  ['unknown mode', (raw: any) => raw.modes[0].mode = 'generative'],
  ['duplicate modes', (raw: any) => raw.modes.push(raw.modes[0])],
  ['duplicate slices', (raw: any) => raw.modes[0].slices.push(raw.modes[0].slices[0])],
  ['invalid slice ID', (raw: any) => raw.modes[0].slices[0].slice = '../private'],
  ['empty slice support', (raw: any) => raw.modes[0].slices[0].minimums.answerable = 0],
  ['extra approval', (raw: any) => raw.release_approved = true],
] as const) {
  test('invalid frozen policy rejects ' + name, () => {
    expect(() => freezeGatePlan(modify(change), input())).toThrow();
  });
}
test('policy parser rejects duplicate members even when the final value is valid', () => {
  const text = encode(policy).replace('"purpose": "release"', '"purpose": "development", "purpose": "release"');
  expect(() => readGatePolicy(text)).toThrow();
  expect(readGatePolicy(encode(policy))).toEqual(parseGatePolicy(policy));
});
test('plan rejects mutated inventory, fingerprint, authority, canonical bytes and unsupported source changes', () => {
  const plan = frozen();
  const raw = JSON.parse(plan);
  raw.inventory.documents = 1;
  expect(() => qualifyRetrieval(encode(raw), input())).toThrow();
  const digest = JSON.parse(plan); digest.manifest_sha256 = 'd'.repeat(64);
  expect(() => qualifyRetrieval(encode(digest), input())).toThrow();
  const authority = JSON.parse(plan); authority.authority_verified = true;
  expect(() => parseGatePlan(encode(authority))).toThrow();
  expect(() => parseGatePlan(plan.trim())).toThrow();
  expect(() => qualifyRetrieval(plan, { ...input(), manifest: input().manifest + ' ' })).toThrow();
  const sourceChanged = input(); sourceChanged.artifacts[1].text += ' ';
  expect(() => qualifyRetrieval(plan, sourceChanged)).toThrow();
});
test('replay refuses changed reported metrics, failure status, digest, or whitespace', () => {
  const plan = frozen(), result = qualifyRetrieval(plan, input());
  expect(() => replayGate(result.reportText.trim(), plan, input())).toThrow();
  const changed = JSON.parse(result.reportText); changed.modes[0].global.rates[0].actual = 0;
  expect(() => replayGate(encode(changed), plan, input())).toThrow();
  changed.metric_qualified = false;
  expect(() => replayGate(encode(changed), plan, input())).toThrow();
});
test('qualification CLI freezes, scores, replays, reports failures and never replaces an existing artifact', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('gate-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/qualify.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  for (const artifact of artifacts) writeFileSync(join(root, artifact.name), artifact.text);
  const manifestPath = join(root, 'labels.json'), policyPath = join(root, 'policy.json');
  const planPath = join(root, 'plan.json'), reportPath = join(root, 'gate.json');
  writeFileSync(manifestPath, input().manifest); writeFileSync(policyPath, encode(policy));
  const cli = join(bundle, 'qualify.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000 });
  const args = (action: string, secondary: string, output: string) => [
    action, '--manifest', manifestPath, action === 'freeze' ? '--policy' : '--plan', secondary, '--output', output,
  ];
  expect(run(['--help']).status).toBe(0);
  const freeze = run(args('freeze', policyPath, planPath));
  expect(freeze.status, freeze.stderr).toBe(0);
  expect(JSON.parse(freeze.stdout)).toEqual({ frozen: true, evaluated: false, release_approved: false });
  const plan = readFileSync(planPath, 'utf8');
  expect(plan).toBe(frozen());
  expect(run(args('freeze', policyPath, planPath)).status).toBe(1);
  expect(readFileSync(planPath, 'utf8')).toBe(plan);
  const qualified = run(args('run', planPath, reportPath));
  expect(qualified.status, qualified.stderr).toBe(0);
  const report = readFileSync(reportPath, 'utf8');
  expect(report).toBe(qualifyRetrieval(plan, input()).reportText);
  expect(JSON.parse(qualified.stdout).status).toBe('qualified');
  expect(qualified.stdout).not.toContain('Application fee');
  expect(qualified.stdout).not.toContain(root);
  const verified = run(args('verify', planPath, reportPath));
  expect(verified.status, verified.stderr).toBe(0);
  expect(JSON.parse(verified.stdout).verified_replay).toBe(true);
  expect(run(args('run', planPath, reportPath)).status).toBe(1);
  expect(readFileSync(reportPath, 'utf8')).toBe(report);
  const insufficientPolicy = join(root, 'insufficient-policy.json'), insufficientPlan = join(root, 'insufficient-plan.json');
  const insufficientReport = join(root, 'insufficient-gate.json');
  writeFileSync(insufficientPolicy, encode(modify(raw => raw.minimums.cases = 99)));
  expect(run(args('freeze', insufficientPolicy, insufficientPlan)).status).toBe(0);
  const rejected = run(args('run', insufficientPlan, insufficientReport));
  expect(rejected.status, rejected.stderr).toBe(2);
  expect(JSON.parse(rejected.stdout).status).toBe('not_qualified');
  expect(existsSync(insufficientReport)).toBe(true);
  expect(run(args('verify', insufficientPlan, insufficientReport)).status).toBe(2);
  writeFileSync(reportPath, report + ' ');
  expect(run(args('verify', planPath, reportPath)).status).toBe(1);
  expect(readFileSync(reportPath, 'utf8')).toBe(report + ' ');
  writeFileSync(manifestPath, input().manifest + ' ');
  const stale = join(root, 'stale.json');
  const invalid = run(args('run', planPath, stale));
  expect(invalid.status).toBe(1);
  expect(invalid.stdout).toBe('');
  expect(invalid.stderr).not.toContain(root);
  expect(existsSync(stale)).toBe(false);
});
