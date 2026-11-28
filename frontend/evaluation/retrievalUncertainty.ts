/** Descriptive cluster-resampled uncertainty for a frozen retrieval report.
 * Resample notice families, never individual questions. A large number of
 * correlated questions is not a large independent sample. This tool does
 * not authenticate labels, prove statistical significance or approve a release.
 */
import { createHash } from 'node:crypto';
import { auditReport, type AuditedReport } from './reportAudit';
import { type CaseMetrics, type RetrievalMode } from './retrievalMetrics';

export const MAX_UNCERTAINTY_BYTES = 2 * 1024 * 1024;
export const MIN_RESAMPLES = 200;
export const MAX_RESAMPLES = 5000;
export const MIN_SUPPORTING_FAMILIES = 5;
const MIN_DEFINED_FRACTION = 0.95;
const POLICY = 'Descriptive percentile family-cluster bootstrap and leave-one-family-out sensitivity on one audited report; not a significance test, generalization guarantee or release approval.';
const METRICS = ['citationPrecision', 'citationRecall', 'completeEvidenceRate',
  'unanswerableAbstentionRate', 'inaccessibleAbstentionRate',
  'ambiguousAbstentionRate', 'meanReciprocalRank'] as const;
export type Metric = typeof METRICS[number];
type Ratio = { numerator: number; denominator: number };
type Vector = Record<Metric, Ratio>;
export type Settings = { seed: number; resamples: number; level: 0.9 | 0.95 | 0.99 };
export type Interval = { lower: number; upper: number };
export type Estimate = {
  point: number | null;
  numerator: number;
  denominator: number;
  supporting_families: number;
  family_macro_point: number | null;
  defined_resamples: number;
  undefined_resamples: number;
  interval: Interval | null;
  interval_status: 'reported' | 'undefined_point' | 'too_few_families' | 'too_many_undefined_resamples';
  leave_one_family_out: {
    defined: number; undefined: number; minimum: number | null; maximum: number | null;
  };
};
export type DeltaEstimate = {
  baseline_point: number | null;
  candidate_point: number | null;
  delta: number | null;
  jointly_supporting_families: number;
  defined_resamples: number;
  undefined_resamples: number;
  interval: Interval | null;
  interval_status: Estimate['interval_status'];
  leave_one_family_out: Estimate['leave_one_family_out'];
};
type Cohort = {
  name: string | null;
  cases: number;
  families: number;
  modes: { mode: RetrievalMode; metrics: { metric: Metric; estimate: Estimate }[] }[];
  paired: { baseline: RetrievalMode; candidate: RetrievalMode; metrics: { metric: Metric; estimate: DeltaEstimate }[] }[];
};
export type UncertaintyReport = {
  format: 'noticebridge-retrieval-uncertainty';
  version: 1;
  policy: string;
  input_sha256: string;
  manifest_sha256: string;
  dataset: string;
  label_kind: AuditedReport['label_kind'];
  split: AuditedReport['split'];
  authority_verified: false;
  reviewer_identity_verified: false;
  release_approved: false;
  integrity_violations: number;
  settings: Settings;
  cohort: Cohort;
  slices: Cohort[];
};
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function invalid(): never { throw new Error('Invalid or incomparable retrieval uncertainty input.'); }
function sha(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function bounded(text: string) {
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_UNCERTAINTY_BYTES) invalid();
  return text;
}
function validateSettings(settings: Settings): Settings {
  if (!settings || Object.keys(settings).length !== 3 ||
      !Number.isInteger(settings.seed) || settings.seed < 1 || settings.seed > 0xffffffff ||
      !Number.isInteger(settings.resamples) || settings.resamples < MIN_RESAMPLES || settings.resamples > MAX_RESAMPLES ||
      ![0.9, 0.95, 0.99].includes(settings.level)) invalid();
  return { seed: settings.seed, resamples: settings.resamples, level: settings.level };
}
function empty(): Vector {
  return Object.fromEntries(METRICS.map(metric => [metric, { numerator: 0, denominator: 0 }])) as Vector;
}
function add(target: Vector, source: Vector, weight = 1) {
  for (const metric of METRICS) {
    target[metric].numerator += source[metric].numerator * weight;
    target[metric].denominator += source[metric].denominator * weight;
  }
}
function record(rows: CaseMetrics[]): Vector {
  const totals = empty();
  const increment = (metric: Metric, numerator: number, denominator: number) => {
    totals[metric].numerator += numerator;
    totals[metric].denominator += denominator;
  };
  for (const row of rows) {
    if (row.kind === 'answerable') {
      increment('citationPrecision', row.relevant, row.retrieved);
      increment('citationRecall', row.requiredFound, row.required);
      increment('completeEvidenceRate', Number(row.complete), 1);
      increment('meanReciprocalRank', row.reciprocalRank ?? 0, 1);
    } else if (row.kind === 'unanswerable') {
      increment('citationPrecision', 0, row.retrieved);
      increment('unanswerableAbstentionRate', Number(row.abstained), 1);
    } else if (row.kind === 'unindexed') {
      increment('inaccessibleAbstentionRate', Number(row.abstained), 1);
    } else if (row.kind === 'ambiguous') {
      increment('ambiguousAbstentionRate', Number(row.abstained), 1);
    } else invalid();
  }
  return totals;
}
function ratio(value: Ratio): number | null {
  if (!value.denominator) return null;
  return value.numerator / value.denominator;
}
function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}
function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
/** Reproducible noncryptographic PRNG. Rejection avoids modulo bias on
 * family counts. Each draw samples one whole family with replacement. */
function generator(seed: number) {
  let state = seed >>> 0;
  return (size: number) => {
    if (!Number.isSafeInteger(size) || size < 1 || size > 5000) invalid();
    // Xorshift32 visits the nonzero 32-bit states. Subtract one to use a
    // uniform integer range of 0 .. 2^32-2.
    const span = 0xffffffff, limit = span - span % size;
    for (;;) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const value = state - 1;
      if (value < limit) return value % size;
    }
  };
}
function quantile(sorted: number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function intervalFor(values: number[], point: number | null, support: number, settings: Settings) {
  const status: Estimate['interval_status'] = point === null ? 'undefined_point'
    : support < MIN_SUPPORTING_FAMILIES ? 'too_few_families'
    : values.length < Math.ceil(settings.resamples * MIN_DEFINED_FRACTION) ? 'too_many_undefined_resamples'
    : 'reported';
  const sorted = [...values].sort((a, b) => a - b);
  const alpha = (1 - settings.level) / 2;
  return {
    defined_resamples: values.length,
    undefined_resamples: settings.resamples - values.length,
    interval: status === 'reported' ? { lower: quantile(sorted, alpha), upper: quantile(sorted, 1 - alpha) } : null,
    interval_status: status,
  };
}
function leaveOut(values: (number | null)[]): Estimate['leave_one_family_out'] {
  const defined = values.filter((value): value is number => value !== null);
  return {
    defined: defined.length, undefined: values.length - defined.length,
    minimum: defined.length ? Math.min(...defined) : null, maximum: defined.length ? Math.max(...defined) : null,
  };
}
function sumClusters(clusters: Vector[], weights?: number[]): Vector {
  const total = empty();
  clusters.forEach((cluster, i) => add(total, cluster, weights?.[i] ?? 1));
  return total;
}
function excluded(clusters: Vector[]): Vector[] {
  // Rebuild sums instead of subtracting floating-point reciprocal ranks.
  // This avoids tiny negative numerical artifacts in zero-support cohorts.
  return clusters.map((_, omitted) => sumClusters(clusters, clusters.map((__, i) => Number(i !== omitted))));
}
type Samples = Record<Metric, number[]>;
function samples(): Samples {
  return Object.fromEntries(METRICS.map(metric => [metric, []])) as Samples;
}
function append(target: number[], value: number | null) {
  if (value !== null) {
    if (!Number.isFinite(value)) invalid();
    target.push(value);
  }
}
function cohort(report: AuditedReport, slice: string | null, settings: Settings): Cohort {
  const rows = report.modes.map(mode => mode.cases.filter(row => slice === null || row.slices.includes(slice)));
  if (!rows[0].length) invalid();
  const families = [...new Set(rows[0].map(row => row.family))].sort();
  if (families.length > 100 || families.length > report.documents.length) invalid();
  const index = new Map(families.map((family, i) => [family, i]));
  // Aggregate each family once per mode; bootstrap cost depends on family
  // count, not the total number of correlated questions.
  const clusters = rows.map(modeRows => {
    const byFamily: CaseMetrics[][] = families.map(() => []);
    for (const row of modeRows) {
      const i = index.get(row.family);
      if (i === undefined) invalid();
      byFamily[i].push(row);
    }
    if (byFamily.some(group => !group.length)) invalid();
    return byFamily.map(record);
  });
  const totals = clusters.map(values => sumClusters(values));
  const omissions = clusters.map(excluded);
  const estimates = clusters.map(() => samples());
  const differences = clusters.slice(1).map(() => samples());
  const draw = generator(settings.seed);
  for (let iteration = 0; iteration < settings.resamples; iteration++) {
    const weights = families.map(() => 0);
    for (let i = 0; i < families.length; i++) weights[draw(families.length)]++;
    // Use identical family weights for every mode and every metric.
    // Paired differences do not mix independently resampled cohorts.
    const selected = clusters.map(mode => sumClusters(mode, weights));
    for (const metric of METRICS) {
      const baseline = ratio(selected[0][metric]);
      selected.forEach((value, i) => {
        const observed = ratio(value[metric]);
        append(estimates[i][metric], observed);
        if (i) append(differences[i - 1][metric], delta(baseline, observed));
      });
    }
  }
  const modes = report.modes.map((mode, i) => ({
    mode: mode.mode, metrics: METRICS.map(metric => {
      const value = totals[i][metric], point = ratio(value);
      const familyValues = clusters[i].flatMap(cluster => {
        const observed = ratio(cluster[metric]);
        return observed === null ? [] : [observed];
      });
      const estimate: Estimate = {
        point, numerator: value.numerator, denominator: value.denominator,
        supporting_families: familyValues.length, family_macro_point: mean(familyValues),
        ...intervalFor(estimates[i][metric], point, familyValues.length, settings),
        leave_one_family_out: leaveOut(omissions[i].map(value => ratio(value[metric]))),
      };
      return { metric, estimate };
    }),
  }));
  const paired = report.modes.slice(1).map((mode, at) => {
    const i = at + 1;
    return { baseline: report.modes[0].mode, candidate: mode.mode, metrics: METRICS.map(metric => {
      const baseline_point = ratio(totals[0][metric]), candidate_point = ratio(totals[i][metric]);
      const point = delta(baseline_point, candidate_point);
      const support = clusters[0].filter((cluster, j) =>
        cluster[metric].denominator > 0 && clusters[i][j][metric].denominator > 0).length;
      const estimate: DeltaEstimate = {
        baseline_point, candidate_point, delta: point, jointly_supporting_families: support,
        ...intervalFor(differences[at][metric], point, support, settings),
        leave_one_family_out: leaveOut(omissions[0].map((value, j) =>
          delta(ratio(value[metric]), ratio(omissions[i][j][metric])))),
      };
      return { metric, estimate };
    }) };
  });
  return { name: slice, cases: rows[0].length, families: families.length, modes, paired };
}
/** Explicitly requested slices only, with an upper bound on analysis cost.
 * Undefined metrics and insufficient cluster support remain explicit.
 */
export function analyzeUncertainty(reportText: string, settings: Settings, slices: string[] = []) {
  const validated = validateSettings(settings);
  if (!Array.isArray(slices) || slices.length > 12 || new Set(slices).size !== slices.length ||
      slices.some(slice => typeof slice !== 'string' || !ID.test(slice))) invalid();
  const report = auditReport(reportText);
  // A validly structured report with source/routing integrity violations
  // cannot qualify as a meaningful uncertainty input.
  if (report.integrity_violations) invalid();
  const available = new Set(report.modes[0].slices.map(slice => slice.slice));
  if (slices.some(slice => !available.has(slice))) invalid();
  const result: UncertaintyReport = {
    format: 'noticebridge-retrieval-uncertainty', version: 1, policy: POLICY,
    input_sha256: sha(reportText), manifest_sha256: report.manifest_sha256,
    dataset: report.dataset, label_kind: report.label_kind, split: report.split,
    authority_verified: false, reviewer_identity_verified: false, release_approved: false,
    integrity_violations: report.integrity_violations, settings: validated,
    cohort: cohort(report, null, validated),
    slices: [...slices].sort().map(slice => cohort(report, slice, validated)),
  };
  return { report: result, text: bounded(encode(result)) };
}
export function replayUncertainty(candidate: string, reportText: string, settings: Settings, slices: string[] = []) {
  bounded(candidate);
  const result = analyzeUncertainty(reportText, settings, slices);
  if (candidate !== result.text) invalid();
  return result.report;
}
