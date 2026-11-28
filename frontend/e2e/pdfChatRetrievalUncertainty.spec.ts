import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { summarize, type CaseMetrics, type RetrievalMode } from '../evaluation/retrievalMetrics';
import { auditReport } from '../evaluation/reportAudit';
import { analyzeUncertainty, replayUncertainty, MIN_RESAMPLES, MAX_RESAMPLES,
  MAX_UNCERTAINTY_BYTES, type Settings, type Metric } from '../evaluation/retrievalUncertainty';

const modes: RetrievalMode[] = ['strict', 'contextual', 'all-strict'];
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const settings: Settings = { seed: 123456, resamples: 400, level: 0.95 };
function row(family: number, id: string, kind: CaseMetrics['kind'], success: boolean,
  slices = ['shared']): CaseMetrics {
  const positive = kind === 'answerable';
  return { id: 'case-' + family + '-' + id, family: 'family-' + family, slices, kind,
    retrieved: positive ? Number(success) : Number(!success),
    relevant: positive ? Number(success) : 0, required: positive ? 1 : 0,
    requiredFound: positive ? Number(success) : 0, complete: positive && success,
    abstained: positive ? !success : success, reciprocalRank: positive ? Number(success) : null,
    duplicateIds: 0, unknownIds: 0, roleLeaks: 0, pageLeaks: 0, routingMismatch: false };
}
function cohort(families = 6, imbalanced = false): CaseMetrics[][] {
  return modes.map((_, mode) => {
    const rows: CaseMetrics[] = [];
    for (let i = 0; i < families; i++) {
      const positives = imbalanced && i === 0 ? 30 : 1;
      for (let j = 0; j < positives; j++) {
        rows.push(row(i, 'positive-' + j, 'answerable', mode === 0 ? i === 0 : mode === 1 || i < 3,
          i < 2 ? ['shared', 'rare'] : ['shared']));
      }
      rows.push(row(i, 'negative', 'unanswerable', mode === 0 || i !== 0));
      if (i === 0) rows.push(row(i, 'inaccessible', 'unindexed', true));
    }
    return rows;
  });
}
function fixture(rows = cohort(), overrides: Record<string, unknown> = {}) {
  const computed = rows.map((cases, i) => ({
    mode: modes[i], totals: summarize(cases),
    slices: [...new Set(cases.flatMap(row => row.slices))].sort().map(slice =>
      ({ slice, ...summarize(cases.filter(row => row.slices.includes(slice))) })),
    families: [...new Set(cases.map(row => row.family))].sort().map(family =>
      ({ family, ...summarize(cases.filter(row => row.family === family)) })), cases,
  }));
  const transitions = computed.slice(1).map(mode => {
    const gained: string[] = [], lost: string[] = [], abstentionRegressions: string[] = [];
    mode.cases.forEach((row, i) => {
      const prior = computed[0].cases[i];
      if (row.complete && !prior.complete) gained.push(row.id);
      if (!row.complete && prior.complete) lost.push(row.id);
      if (row.kind === 'unanswerable' && prior.abstained && !row.abstained) abstentionRegressions.push(row.id);
    });
    return { mode: mode.mode, gained, lost, abstentionRegressions };
  });
  const violations = rows.flat().reduce((n, row) => n + row.roleLeaks + row.pageLeaks +
    row.unknownIds + row.duplicateIds + Number(row.routingMismatch), 0);
  return encode({ format: 'noticebridge-retrieval-evaluation', version: 1, dataset: 'fixture-study',
    label_kind: 'synthetic', split: 'holdout', documents: computed[0].families.map((_, i) => 'document-' + i),
    synthetic: true, authority_verified: false, integrity_violations: violations, modes: computed,
    transitions, manifest_sha256: 'a'.repeat(64), ...overrides });
}
function estimate(text: string, mode: number, metric: Metric, options = settings) {
  return analyzeUncertainty(text, options).report.cohort.modes[mode].metrics.find(row => row.metric === metric)!.estimate;
}
test('uncertainty exactly binds the audited report and reports the same pooled rates', () => {
  const text = fixture(), audited = auditReport(text);
  const result = analyzeUncertainty(text, settings, ['shared', 'rare']);
  expect(result.report).toMatchObject({ input_sha256: sha(text), authority_verified: false,
    reviewer_identity_verified: false, release_approved: false, label_kind: 'synthetic',
    cohort: { cases: 13, families: 6 }, settings });
  expect(result.report.slices.map(slice => slice.name)).toEqual(['rare', 'shared']);
  result.report.cohort.modes.forEach((mode, i) => mode.metrics.forEach(({ metric, estimate }) => {
    const point = audited.modes[i].totals[metric];
    if (point === null) expect(estimate.point).toBeNull();
    else expect(estimate.point).toBeCloseTo(point, 12);
    expect(estimate.defined_resamples + estimate.undefined_resamples).toBe(settings.resamples);
  }));
  expect(result.text).not.toContain('case-0-positive-0');
  expect(result.text).not.toContain('family-0');
  expect(replayUncertainty(result.text, text, settings, ['rare', 'shared'])).toEqual(result.report);
});
test('unequal family sizes separate pooled performance from the equal-family mean', () => {
  const text = fixture(cohort(6, true));
  const metric = estimate(text, 0, 'completeEvidenceRate');
  expect(metric.numerator).toBe(30);
  expect(metric.denominator).toBe(35);
  expect(metric.point).toBeCloseTo(30 / 35);
  expect(metric.family_macro_point).toBeCloseTo(1 / 6);
  expect(metric.supporting_families).toBe(6);
  expect(metric.interval_status).toBe('reported');
  expect(metric.interval?.lower).toBeGreaterThanOrEqual(0);
  expect(metric.interval?.upper).toBeLessThanOrEqual(1);
  expect(metric.leave_one_family_out).toMatchObject({ defined: 6, undefined: 0, minimum: 0 });
  expect(metric.leave_one_family_out.maximum).toBeCloseTo(30 / 34);
});
test('one perfect family with many questions is not enough independent support', () => {
  const metric = estimate(fixture(cohort(1, true)), 0, 'completeEvidenceRate');
  expect(metric.denominator).toBe(30);
  expect(metric.point).toBe(1);
  expect(metric.supporting_families).toBe(1);
  expect(metric.interval).toBeNull();
  expect(metric.interval_status).toBe('too_few_families');
  expect(metric.leave_one_family_out).toEqual({ defined: 0, undefined: 1, minimum: null, maximum: null });
});
test('undefined denominators are not represented as zero', () => {
  const text = fixture();
  const ambiguous = estimate(text, 0, 'ambiguousAbstentionRate');
  expect(ambiguous).toMatchObject({ point: null, denominator: 0, supporting_families: 0,
    interval: null, interval_status: 'undefined_point', defined_resamples: 0,
    undefined_resamples: settings.resamples, family_macro_point: null });
  const inaccessible = estimate(text, 0, 'inaccessibleAbstentionRate');
  expect(inaccessible).toMatchObject({ point: 1, supporting_families: 1,
    interval: null, interval_status: 'too_few_families' });
  expect(inaccessible.undefined_resamples).toBeGreaterThan(0);
  expect(inaccessible.leave_one_family_out).toMatchObject({ defined: 5, undefined: 1, minimum: 1, maximum: 1 });
});
test('equal mode predictions have exactly zero paired deltas for every defined draw', () => {
  const cases = cohort()[0];
  const report = analyzeUncertainty(fixture([cases, structuredClone(cases), structuredClone(cases)]), settings).report;
  for (const paired of report.cohort.paired) {
    const complete = paired.metrics.find(row => row.metric === 'completeEvidenceRate')!.estimate;
    expect(complete).toMatchObject({ delta: 0, jointly_supporting_families: 6,
      interval: { lower: 0, upper: 0 }, leave_one_family_out: { minimum: 0, maximum: 0 } });
  }
});
test('paired gains retain the same family resampling and support both positive and negative changes', () => {
  const result = analyzeUncertainty(fixture(), settings).report;
  const candidate = result.cohort.paired[0];
  const positive = candidate.metrics.find(row => row.metric === 'completeEvidenceRate')!.estimate;
  const negative = candidate.metrics.find(row => row.metric === 'unanswerableAbstentionRate')!.estimate;
  expect(positive.delta).toBeCloseTo(5 / 6);
  expect(positive.interval?.lower).toBeGreaterThanOrEqual(0);
  expect(negative.delta).toBeCloseTo(-1 / 6);
  expect(negative.interval?.upper).toBeLessThanOrEqual(0);
  expect(positive.leave_one_family_out.minimum).toBeCloseTo(4 / 5);
  expect(positive.leave_one_family_out.maximum).toBe(1);
});
test('slices resample their own families, with explicit small-cohort suppression', () => {
  const result = analyzeUncertainty(fixture(), settings, ['rare']).report;
  const rare = result.slices[0];
  expect(rare).toMatchObject({ name: 'rare', cases: 2, families: 2 });
  expect(rare.modes[0].metrics.find(row => row.metric === 'completeEvidenceRate')!.estimate)
    .toMatchObject({ point: 0.5, interval_status: 'too_few_families', interval: null });
  expect(rare.modes[0].metrics.find(row => row.metric === 'unanswerableAbstentionRate')!.estimate.point).toBeNull();
});
test('seed and level are reproducible and larger interval levels use nested quantiles', () => {
  const input = fixture(cohort(6, true));
  const low = estimate(input, 0, 'completeEvidenceRate', { ...settings, level: 0.9 });
  const high = estimate(input, 0, 'completeEvidenceRate', { ...settings, level: 0.99 });
  expect(high.interval!.lower).toBeLessThanOrEqual(low.interval!.lower);
  expect(high.interval!.upper).toBeGreaterThanOrEqual(low.interval!.upper);
  expect(analyzeUncertainty(input, settings).text).toBe(analyzeUncertainty(input, settings).text);
  expect(analyzeUncertainty(input, { ...settings, seed: 42 }).text).not.toBe(analyzeUncertainty(input, settings).text);
});
test('rejects integrity violations even when the supplied report is structurally consistent', () => {
  const cases = cohort();
  cases[0][0].routingMismatch = true;
  const text = fixture(cases);
  expect(auditReport(text).integrity_violations).toBe(1);
  expect(() => analyzeUncertainty(text, settings)).toThrow();
});
for (const patch of [
  { seed: 0 }, { seed: -1 }, { seed: 4294967296 }, { seed: 1.5 },
  { resamples: MIN_RESAMPLES - 1 }, { resamples: MAX_RESAMPLES + 1 },
  { resamples: 200.5 }, { level: 0.8 }, { level: NaN }, { unexpected: true },
]) {
  test('invalid uncertainty setting ' + JSON.stringify(patch), () => {
    expect(() => analyzeUncertainty(fixture(), { ...settings, ...patch } as Settings)).toThrow();
  });
}
test('rejects unknown slices, repeated slices, malformed reports, and impossible family counts', () => {
  const text = fixture();
  for (const slices of [['missing'], ['shared', 'shared'], ['../bad'], Array.from({ length: 13 }, (_, i) => 'x-' + i)]) {
    expect(() => analyzeUncertainty(text, settings, slices)).toThrow();
  }
  expect(() => analyzeUncertainty(fixture(cohort(), { documents: ['single'] }), settings)).toThrow();
  expect(() => analyzeUncertainty(text.replace('"authority_verified": false', '"authority_verified": true'), settings)).toThrow();
  expect(() => analyzeUncertainty(text.replace('"version": 1', '"version": 0, "version": 1'), settings)).toThrow();
});
test('replay refuses changed inputs, settings, output claims and oversized artifacts', () => {
  const input = fixture(), result = analyzeUncertainty(input, settings, ['rare']);
  expect(() => replayUncertainty(result.text.trim(), input, settings, ['rare'])).toThrow();
  expect(() => replayUncertainty(result.text, input + ' ', settings, ['rare'])).toThrow();
  expect(() => replayUncertainty(result.text, input, { ...settings, seed: 8 }, ['rare'])).toThrow();
  expect(() => replayUncertainty(result.text, input, settings)).toThrow();
  expect(() => replayUncertainty(result.text.replace('"release_approved": false', '"release_approved": true'),
    input, settings, ['rare'])).toThrow();
  expect(() => replayUncertainty('x'.repeat(MAX_UNCERTAINTY_BYTES + 1), input, settings)).toThrow();
});
test('CLI validates settings, writes exclusively, and replays without disclosing case IDs or paths', ({}, info) => {
  test.setTimeout(120_000);
  const root = info.outputPath('uncertainty'), bundle = join(root, 'bundle');
  mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build',
    '--ssr', 'evaluation/uncertainty.ts', '--outDir', bundle], { timeout: 60_000, stdio: 'pipe' });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}\n');
  const input = join(root, 'evaluation.json'), output = join(root, 'uncertainty.json');
  const text = fixture();
  writeFileSync(input, text);
  const args = ['--report', input, '--output', output, '--seed', String(settings.seed),
    '--resamples', String(settings.resamples), '--level', '0.95', '--slice', 'rare'];
  const run = (values: string[]) => spawnSync(process.execPath, [join(bundle, 'uncertainty.js'), ...values],
    { timeout: 30_000, encoding: 'utf8' });
  expect(run(['--help']).status).toBe(0);
  const created = run(args);
  expect(created.status, created.stderr).toBe(0);
  const expected = analyzeUncertainty(text, settings, ['rare']);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
  expect(JSON.parse(created.stdout)).toMatchObject({ consistent: true, verified_replay: false,
    authority_verified: false, release_approved: false, families: 6, cases: 13, slices: 1, resamples: 400 });
  for (const secret of [root, 'case-0-positive-0', 'family-0']) {
    expect(created.stdout + created.stderr).not.toContain(secret);
  }
  const replay = run([...args, '--verify']);
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout).verified_replay).toBe(true);
  expect(run(args).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
  expect(run([...args, '--verify', '--verify']).status).toBe(1);
  expect(run([...args, '--seed', '2']).status).toBe(1);
  const invalid = join(root, 'invalid.json');
  const changed = [...args]; changed[changed.indexOf('--output') + 1] = invalid;
  expect(run([...changed, '--slice', 'missing']).status).toBe(1);
  expect(existsSync(invalid)).toBe(false);
  writeFileSync(input, text + ' ');
  expect(run([...args, '--verify']).status).toBe(1);
  expect(readFileSync(output, 'utf8')).toBe(expected.text);
});
