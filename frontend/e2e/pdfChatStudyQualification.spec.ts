import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serializeCorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import type { Corpus } from '../src/pdfChatCore';
import { preflightDataset } from '../evaluation/datasetPreflight';
import { preparePreflightReview } from '../evaluation/preflightReview';
import { qualifyRetrieval } from '../evaluation/retrievalGate';
import { analyzeUncertainty } from '../evaluation/retrievalUncertainty';
import { freezeStudyPlan, qualifyStudy, parseStudyPlan, replayStudy, readStudyPolicy,
  MAX_STUDY_PLAN_BYTES, MAX_STUDY_REPORT_BYTES, type StudyInput, type StudyPolicy } from '../evaluation/studyQualification';

const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function fixture(families = 6, incorrect = 0, kind = 'independently_reviewed',
  repeated = false): StudyInput {
  const artifacts: StudyInput['artifacts'] = [];
  const documents = Array.from({ length: families }, (_, i) => {
    const corpus: Corpus = {
      passages: [
        { role: 'original', page: 1, ordinal: 1, text: 'Application fee: INR ' + (500 + i) },
        { role: 'original', page: 1, ordinal: 2, text: 'Examination date: 2026-12-15' },
      ],
      pageCount: 1, processedPages: 1, missingPages: [], limitedPages: [], limited: false,
    };
    const name = 'source-' + i + '.json';
    const text = serializeCorpusSnapshot({ original: sha('pdf-fixture-' + i) }, { original: corpus });
    const digest = sha(text);
    artifacts.push({ name, text, sha256: digest });
    const cases = [
      { id: 'fee-' + i, question: 'Application fee?', scope: 'original', slices: ['fee', 'printed'],
        label: { kind: 'answerable', evidenceSets: [[i < incorrect ? 'original:1:2' : 'original:1:1']] } },
      { id: 'date-' + i, question: 'Examination date?', scope: 'original', slices: ['printed'],
        label: { kind: 'answerable', evidenceSets: [['original:1:2']] } },
      { id: 'negative-' + i, question: 'Refund policy?', scope: 'original', slices: ['negative'],
        label: { kind: 'unanswerable' } },
    ];
    if (repeated && i === 0) cases.push({
      id: 'duplicate-fee', question: 'APPLICATION FEE!', scope: 'original', slices: ['fee'],
      label: { kind: 'answerable', evidenceSets: [['original:1:1']] },
    });
    return {
      id: 'doc-' + i, family: 'family-' + i, split: 'holdout', snapshot: name,
      snapshot_sha256: digest, cases,
    };
  });
  const manifest = encode({ format: 'noticebridge-retrieval-labels', version: 1,
    id: 'study-fixture', kind, documents });
  const base = { manifest, artifacts };
  const settings = { similarityThreshold: 0.8 };
  const preflight = preflightDataset(base, settings);
  const review = preparePreflightReview(preflight.text, base, settings);
  const queue = structuredClone(review.queue);
  for (const pair of queue.pairs) {
    pair.decision = 'distinct_after_inspection';
    pair.note = 'Private reviewed pair.';
  }
  for (const row of queue.cases) {
    row.decision = 'retained_after_inspection';
    row.note = 'Private reviewed case.';
  }
  return { ...base, preflightText: preflight.text, queueText: encode(queue) };
}
function policy(rate = 1): StudyPolicy {
  return {
    gate: {
      id: 'study-policy',
      purpose: 'release',
      split: 'holdout',
      minimums: { cases: 6, families: 2, answerable: 4,
        unanswerable: 2, inaccessible: 0, ambiguous: 0 },
      modes: [{
        mode: 'strict',
        thresholds: {
          citationPrecision: rate,
          citationRecall: rate,
          completeEvidenceRate: rate,
          unanswerableAbstentionRate: rate,
        },
        slices: [{
          slice: 'fee',
          minimums: { cases: 2, families: 2, answerable: 2,
            unanswerable: 0, inaccessible: 0, ambiguous: 0 },
          thresholds: { completeEvidenceRate: rate },
        }],
      }],
    },
    similarity_threshold: 0.8,
    bootstrap: { seed: 37, resamples: 200, level: 0.95 },
    minimum_supporting_families: 5,
    require_leave_one_family_out: true,
  };
}
function mutatePolicy(edit: (value: any) => void): StudyPolicy {
  const value = policy();
  edit(value);
  return value;
}
test('freeze binds exact inputs, policy and review counts without retrieval outcomes', () => {
  const input = fixture(6, 0, 'independently_reviewed', true);
  const planText = freezeStudyPlan(policy(), input);
  const plan = parseStudyPlan(planText);
  expect(plan).toMatchObject({
    manifest_sha256: sha(input.manifest),
    preflight_sha256: sha(input.preflightText),
    review_queue_sha256: sha(input.queueText),
    reviewed_pair_leads: 0,
    reviewed_case_leads: 2,
    authority_verified: false,
    reviewer_identity_verified: false,
    release_approved: false,
  });
  expect(plan.point_gate_plan_sha256).toBe(sha(plan.point_gate_plan));
  for (const secret of ['Application fee?', 'Refund policy?', 'Private reviewed case.', 'evaluation_sha256']) {
    expect(planText).not.toContain(secret);
  }
  expect(freezeStudyPlan(policy(), input)).toBe(planText);
});
test('all gates pass on a perfect six-family fixture and components replay exactly', () => {
  const input = fixture(), planText = freezeStudyPlan(policy(), input);
  const result = qualifyStudy(planText, input), report = result.report;
  expect(report).toMatchObject({
    study_qualified: true,
    point_qualified: true,
    uncertainty_qualified: true,
    integrity_violations: 0,
    point_failures: [],
    authority_verified: false,
    reviewer_identity_verified: false,
    independence_verified: false,
    label_correctness_verified: false,
    release_approved: false,
    uncertainty_skipped_reason: null,
    plan_sha256: sha(planText),
    point_gate_report_sha256: sha(result.pointReportText),
    evaluation_sha256: sha(result.evaluationText),
    uncertainty_sha256: sha(result.uncertaintyText!),
  });
  expect(report.checks).toHaveLength(5);
  for (const check of report.checks) {
    expect(check).toMatchObject({
      passed: true,
      reasons: [],
      supporting_families: 6,
      point: 1,
      lower_bound: 1,
      upper_bound: 1,
      defined_resamples: 200,
      undefined_resamples: 0,
      leave_one_family_out: { defined: 6, undefined: 0, minimum: 1, maximum: 1 },
    });
  }
  expect(replayStudy(result.text, planText, input)).toEqual(report);
  expect(qualifyStudy(planText, input).text).toBe(result.text);
  const point = qualifyRetrieval(parseStudyPlan(planText).point_gate_plan, input);
  expect(point.reportText).toBe(result.pointReportText);
  expect(analyzeUncertainty(point.evaluationText, policy().bootstrap, ['fee']).text)
    .toBe(result.uncertaintyText);
});
test('perfect rates on two families cannot qualify a study with too little independent support', () => {
  const input = fixture(2);
  const report = qualifyStudy(freezeStudyPlan(policy(), input), input).report;
  expect(report.point_qualified).toBe(true);
  expect(report.study_qualified).toBe(false);
  expect(report.uncertainty_qualified).toBe(false);
  for (const check of report.checks) {
    expect(check.supporting_families).toBe(2);
    expect(check.point).toBe(1);
    expect(check.lower_bound).toBeNull();
    expect(check.interval_status).toBe('too_few_families');
    expect(check.reasons).toEqual(['insufficient_supporting_families', 'interval_unavailable']);
  }
});
test('family support threshold is distinct from the bootstrap reporting floor', () => {
  const input = fixture(6);
  const config = mutatePolicy(p => p.minimum_supporting_families = 7);
  const report = qualifyStudy(freezeStudyPlan(config, input), input).report;
  expect(report.point_qualified).toBe(true);
  expect(report.study_qualified).toBe(false);
  for (const check of report.checks) {
    expect(check.lower_bound).toBe(1);
    expect(check.interval_status).toBe('reported');
    expect(check.reasons).toEqual(['insufficient_supporting_families']);
  }
});
test('a passing point estimate does not excuse a low bootstrap endpoint or sensitivity failure', () => {
  const input = fixture(6, 1), config = policy(0.8);
  const report = qualifyStudy(freezeStudyPlan(config, input), input).report;
  expect(report.point_qualified).toBe(true);
  expect(report.study_qualified).toBe(false);
  const fee = report.checks.find(check => check.slice === 'fee')!;
  expect(fee.point).toBeCloseTo(5 / 6);
  expect(fee.lower_bound!).toBeLessThan(0.8);
  expect(fee.reasons).toContain('lower_bound_below_threshold');
  // Excluding a successful family leaves four successes from five.
  expect(fee.leave_one_family_out?.minimum).toBe(0.8);
  expect(fee.reasons).not.toContain('leave_one_family_out_below_threshold');
  expect(report.checks.find(check => check.metric === 'unanswerableAbstentionRate')?.passed).toBe(true);
});
test('leave-one-family-out is an explicit additional condition and does not change the resampling', () => {
  const input = fixture(6, 1), config = policy(0.81);
  const required = qualifyStudy(freezeStudyPlan(config, input), input);
  const optional = { ...config, require_leave_one_family_out: false };
  const notRequired = qualifyStudy(freezeStudyPlan(optional, input), input);
  const fee = required.report.checks.find(check => check.slice === 'fee')!;
  const relaxedFee = notRequired.report.checks.find(check => check.slice === 'fee')!;
  expect(fee.reasons).toContain('leave_one_family_out_below_threshold');
  expect(relaxedFee.reasons).not.toContain('leave_one_family_out_below_threshold');
  expect(fee.lower_bound).toBe(relaxedFee.lower_bound);
  expect(required.uncertaintyText).toBe(notRequired.uncertaintyText);
  expect(required.report.plan_sha256).not.toBe(notRequired.report.plan_sha256);
});
test('missing slices fail without preventing other valid cohorts from being reported', () => {
  const input = fixture(), config = policy();
  config.gate.modes[0].slices[0].slice = 'missing';
  const report = qualifyStudy(freezeStudyPlan(config, input), input).report;
  expect(report.study_qualified).toBe(false);
  expect(report.point_qualified).toBe(false);
  expect(report.checks.find(row => row.slice === 'missing')).toMatchObject({
    lower_bound: null, upper_bound: null, interval_status: 'missing_estimate',
    supporting_families: 0, passed: false, reasons: ['no_estimate'],
  });
  expect(report.checks.filter(row => row.slice === null).every(row => row.passed)).toBe(true);
});
test('a point support failure remains disqualifying even when all uncertainty checks pass', () => {
  const input = fixture();
  const config = mutatePolicy(p => p.gate.minimums.cases = 99);
  const report = qualifyStudy(freezeStudyPlan(config, input), input).report;
  expect(report).toMatchObject({
    point_qualified: false, uncertainty_qualified: true, study_qualified: false,
  });
  expect(report.point_failures).toContainEqual({ code: 'missing_support', mode: 'strict',
    slice: null, metric: 'cases', actual: 18, required: 99 });
});
test('review decisions requiring regrouping, revision or uncertainty prevent freezing', () => {
  const input = fixture(6, 0, 'independently_reviewed', true);
  for (const decision of ['pending', 'revision_required', 'uncertain']) {
    const queue = JSON.parse(input.queueText);
    queue.cases[0].decision = decision;
    queue.cases[0].note = decision === 'pending' ? '' : 'Needs review';
    expect(() => freezeStudyPlan(policy(), { ...input, queueText: encode(queue) })).toThrow();
  }
  expect(() => freezeStudyPlan(policy(), { ...input, preflightText: input.preflightText + ' ' })).toThrow();
  const wrongThreshold = { ...policy(), similarity_threshold: 0.9 };
  expect(() => freezeStudyPlan(wrongThreshold, input)).toThrow();
});
test('synthetic labels remain restricted to descriptive development studies', () => {
  const input = fixture(6, 0, 'synthetic');
  expect(() => freezeStudyPlan(policy(), input)).toThrow();
  const development = mutatePolicy(p => p.gate.purpose = 'development');
  const report = qualifyStudy(freezeStudyPlan(development, input), input).report;
  expect(report).toMatchObject({
    label_kind: 'synthetic',
    purpose: 'development',
    study_qualified: true,
    release_approved: false,
    label_correctness_verified: false,
  });
});
test('every configured mode and distinct slice is checked in a canonical order', () => {
  const input = fixture();
  const config = mutatePolicy(p => {
    const mode = p.gate.modes[0];
    p.gate.modes = [
      { ...structuredClone(mode), mode: 'all-strict' },
      { ...structuredClone(mode), mode: 'contextual' },
      mode,
    ];
  });
  const plan = freezeStudyPlan(config, input);
  const report = qualifyStudy(plan, input).report;
  expect(report.checks).toHaveLength(15);
  expect([...new Set(report.checks.map(row => row.mode))]).toEqual(['strict', 'contextual', 'all-strict']);
  expect(report.checks.filter(row => row.slice === 'fee')).toHaveLength(3);
  expect(report.study_qualified).toBe(true);
  config.gate.modes.reverse();
  expect(freezeStudyPlan(config, input)).toBe(plan);
});
const invalidPolicies: [string, (p: any) => void][] = [
  ['seed zero', p => p.bootstrap.seed = 0],
  ['seed fractional', p => p.bootstrap.seed = 1.5],
  ['seed too large', p => p.bootstrap.seed = 4294967296],
  ['too few resamples', p => p.bootstrap.resamples = 199],
  ['too many resamples', p => p.bootstrap.resamples = 5001],
  ['fractional resamples', p => p.bootstrap.resamples = 200.5],
  ['wrong confidence level', p => p.bootstrap.level = 0.8],
  ['string confidence level', p => p.bootstrap.level = '0.95'],
  ['unknown bootstrap field', p => p.bootstrap.extra = true],
  ['low supporting families', p => p.minimum_supporting_families = 4],
  ['high supporting families', p => p.minimum_supporting_families = 101],
  ['fractional supporting families', p => p.minimum_supporting_families = 5.5],
  ['unknown sensitivity flag', p => p.require_leave_one_family_out = 'false'],
  ['low similarity', p => p.similarity_threshold = 0.49],
  ['high similarity', p => p.similarity_threshold = 1.01],
  ['extra top-level field', p => p.release_approved = true],
  ['missing bootstrap', p => delete p.bootstrap],
  ['more than twelve distinct slices', p => {
    const old = p.gate.modes[0].slices[0];
    p.gate.modes[0].slices = Array.from({ length: 13 }, (_, i) => ({ ...old, slice: 'slice-' + i }));
  }],
];
for (const [name, change] of invalidPolicies) {
  test('study policy rejects ' + name, () => {
    expect(() => readStudyPolicy(encode(mutatePolicy(change)))).toThrow();
  });
}
test('strict policy parsing rejects duplicate members and preserves canonical policy order', () => {
  const original = encode(policy());
  expect(readStudyPolicy(original)).toEqual(policy());
  expect(() => readStudyPolicy(original.replace('"seed": 37', '"seed": 37, "seed": 37'))).toThrow();
  expect(() => readStudyPolicy('x'.repeat(MAX_STUDY_PLAN_BYTES + 1))).toThrow();
});
test('canonical plans reject altered point plans, fingerprints, authority and unknown fields', () => {
  const input = fixture(), plan = freezeStudyPlan(policy(), input);
  const changes: ((p: any) => void)[] = [
    p => p.authority_verified = true,
    p => p.release_approved = true,
    p => p.reviewer_identity_verified = true,
    p => p.point_gate_plan_sha256 = 'a'.repeat(64),
    p => p.point_gate_plan += ' ',
    p => p.manifest_sha256 = 'a'.repeat(64),
    p => p.policy.gate.id = 'different-gate',
    p => p.reviewed_case_leads = -1,
    p => p.reviewed_pair_leads = 19901,
    p => p.review_audit_sha256 = 'invalid',
    p => p.extra = true,
  ];
  for (const change of changes) {
    const raw = JSON.parse(plan);
    change(raw);
    expect(() => parseStudyPlan(encode(raw))).toThrow();
  }
  expect(() => parseStudyPlan(plan.trim())).toThrow();
  expect(() => parseStudyPlan(plan.replace('"version": 1', '"version": 1, "version": 1'))).toThrow();
});
test('a structurally valid but edited binding is caught by source replay', () => {
  const input = fixture(), plan = freezeStudyPlan(policy(), input);
  const changes: ((p: any) => void)[] = [
    p => p.preflight_sha256 = 'a'.repeat(64),
    p => p.review_queue_sha256 = 'b'.repeat(64),
    p => p.review_audit_sha256 = 'c'.repeat(64),
    p => p.reviewed_case_leads = 1,
  ];
  for (const change of changes) {
    const raw = JSON.parse(plan);
    change(raw);
    const changed = encode(raw);
    expect(() => parseStudyPlan(changed)).not.toThrow();
    expect(() => qualifyStudy(changed, input)).toThrow();
  }
  expect(() => qualifyStudy(plan, { ...input, queueText: input.queueText + ' ' })).toThrow();
  expect(() => qualifyStudy(plan, { ...input, manifest: input.manifest + ' ' })).toThrow();
  const corrupted = structuredClone(input);
  corrupted.artifacts[0].text += ' ';
  expect(() => qualifyStudy(plan, corrupted)).toThrow();
});
test('replay rejects forged success, rate, uncertainty digest and noncanonical report bytes', () => {
  const input = fixture(2), plan = freezeStudyPlan(policy(), input);
  const result = qualifyStudy(plan, input);
  const changes: ((p: any) => void)[] = [
    p => p.study_qualified = true,
    p => p.release_approved = true,
    p => p.uncertainty_sha256 = '0'.repeat(64),
    p => p.checks[0].lower_bound = 1,
    p => p.checks[0].supporting_families = 100,
    p => p.checks.pop(),
  ];
  for (const change of changes) {
    const raw = JSON.parse(result.text);
    change(raw);
    expect(() => replayStudy(encode(raw), plan, input)).toThrow();
  }
  expect(() => replayStudy(result.text.trim(), plan, input)).toThrow();
  expect(() => replayStudy('x'.repeat(MAX_STUDY_REPORT_BYTES + 1), plan, input)).toThrow();
});
test('CLI freezes, scores and verifies privately, with distinct nonqualification exit status', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('study-cli'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--ssr',
    'evaluation/qualifyStudy.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const input = fixture(6, 0, 'independently_reviewed', true);
  const manifest = join(root, 'manifest.json'), preflight = join(root, 'preflight.json');
  const queue = join(root, 'queue.json'), policyFile = join(root, 'policy.json');
  const plan = join(root, 'plan.json'), report = join(root, 'report.json');
  writeFileSync(manifest, input.manifest);
  writeFileSync(preflight, input.preflightText);
  writeFileSync(queue, input.queueText);
  writeFileSync(policyFile, encode(policy()));
  for (const artifact of input.artifacts) writeFileSync(join(root, artifact.name), artifact.text);
  const common = ['--manifest', manifest, '--preflight', preflight, '--queue', queue];
  const run = (args: string[]) => spawnSync(process.execPath, [join(bundle, 'qualifyStudy.js'), ...args],
    { timeout: 30_000, encoding: 'utf8' });
  const freeze = ['freeze', ...common, '--policy', policyFile, '--output', plan];
  const execute = ['run', ...common, '--plan', plan, '--output', report];
  const verify = ['verify', ...common, '--plan', plan, '--output', report];
  expect(run(['--help']).status).toBe(0);
  expect(run(freeze).status).toBe(0);
  expect(readFileSync(plan, 'utf8')).toBe(freezeStudyPlan(policy(), input));
  expect(run(freeze).status).toBe(1);
  const evaluated = run(execute);
  expect(evaluated.status, evaluated.stderr).toBe(0);
  expect(JSON.parse(evaluated.stdout)).toMatchObject({ study_qualified: true, release_approved: false });
  expect(run(verify).status).toBe(0);
  const original = readFileSync(report, 'utf8');
  expect(run(execute).status).toBe(1);
  expect(readFileSync(report, 'utf8')).toBe(original);
  for (const secret of [root, 'Private reviewed case.', 'Application fee?', 'INR 500']) {
    expect(evaluated.stdout + evaluated.stderr).not.toContain(secret);
  }
  const insufficient = join(root, 'insufficient-plan.json');
  const rejected = join(root, 'insufficient-report.json');
  writeFileSync(policyFile, encode(mutatePolicy(p => p.minimum_supporting_families = 10)));
  expect(run(['freeze', ...common, '--policy', policyFile, '--output', insufficient]).status).toBe(0);
  expect(run(['run', ...common, '--plan', insufficient, '--output', rejected]).status).toBe(2);
  expect(run(['verify', ...common, '--plan', insufficient, '--output', rejected]).status).toBe(2);
  expect(JSON.parse(readFileSync(rejected, 'utf8')).study_qualified).toBe(false);
  writeFileSync(queue, input.queueText + ' ');
  expect(run(verify).status).toBe(1);
  const stale = join(root, 'stale.json');
  expect(run(['run', ...common, '--plan', plan, '--output', stale]).status).toBe(1);
  expect(existsSync(stale)).toBe(false);
});
