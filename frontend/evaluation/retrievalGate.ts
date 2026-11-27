/** Freeze a retrieval evaluation plan, replay it from exact source bytes,
 * and distinguish metric qualification from release approval.
 *
 * The operator must preregister thresholds before seeing holdout outcomes.
 * A local plan cannot establish when that occurred or certify human labels.
 */
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strictJson';
import { parseDataset, loadDataset, evaluateDataset, type Dataset, type DatasetArtifact,
  type DatasetReport, type Split } from './retrievalDataset';
import { auditReport, type AuditedReport } from './reportAudit';
import type { RetrievalMode } from './retrievalMetrics';

export const MAX_GATE_PLAN_BYTES = 128 * 1024;
export const MAX_GATE_REPORT_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const MODES: RetrievalMode[] = ['strict', 'contextual', 'all-strict'];
const METRICS = ['citationPrecision', 'citationRecall', 'completeEvidenceRate',
  'unanswerableAbstentionRate', 'inaccessibleAbstentionRate', 'ambiguousAbstentionRate',
  'meanReciprocalRank'] as const;
export type GateMetric = typeof METRICS[number];
export type GateMinimums = {
  cases: number;
  families: number;
  answerable: number;
  unanswerable: number;
  inaccessible: number;
  ambiguous: number;
};
export type RateThresholds = Partial<Record<GateMetric, number>>;
export type SliceRequirement = {
  slice: string;
  minimums: GateMinimums;
  thresholds: RateThresholds;
};
export type ModeRequirement = {
  mode: RetrievalMode;
  thresholds: RateThresholds;
  slices: SliceRequirement[];
};
export type GatePolicy = {
  id: string;
  purpose: 'development' | 'release';
  split: Split;
  minimums: GateMinimums;
  modes: ModeRequirement[];
};
type Inventory = {
  documents: number;
  families: number;
  cases: number;
  answerable: number;
  unanswerable: number;
  inaccessible: number;
  ambiguous: number;
  slices: string[];
};
type Plan = {
  format: 'noticebridge-retrieval-gate-plan';
  version: 1;
  dataset: string;
  label_kind: Dataset['kind'];
  manifest_sha256: string;
  policy: GatePolicy;
  inventory: Inventory;
  authority_verified: false;
  reviewer_identity_verified: false;
};
export type GateInput = { manifest: string; artifacts: DatasetArtifact[] };
type CountName = keyof GateMinimums;
type FailureCode = 'missing_support' | 'below_threshold' | 'undefined_metric' | 'integrity_violation';
type GateFailure = {
  code: FailureCode;
  mode: RetrievalMode | null;
  slice: string | null;
  metric: GateMetric | CountName | 'integrity_violations';
  actual: number | null;
  required: number;
};
type CountCheck = { name: CountName; actual: number; minimum: number; passed: boolean };
type RateCheck = { metric: GateMetric; actual: number | null; minimum: number; passed: boolean };
type CheckResult = {
  counts: CountCheck[];
  rates: RateCheck[];
  passed: boolean;
};
type ModeResult = {
  mode: RetrievalMode;
  global: CheckResult;
  slices: { slice: string; result: CheckResult }[];
  passed: boolean;
};
export type GateReport = {
  format: 'noticebridge-retrieval-gate-report';
  version: 1;
  plan_sha256: string;
  manifest_sha256: string;
  evaluation_sha256: string;
  dataset: string;
  label_kind: Dataset['kind'];
  purpose: GatePolicy['purpose'];
  split: Split;
  inventory: Inventory;
  authority_verified: false;
  reviewer_identity_verified: false;
  release_approved: false;
  metric_qualified: boolean;
  status: 'qualified' | 'not_qualified';
  integrity_violations: number;
  modes: ModeResult[];
  failures: GateFailure[];
  interpretation: string;
};
type GateResult = { report: GateReport; reportText: string; evaluationText: string };
const COUNT_NAMES: CountName[] = ['cases', 'families', 'answerable', 'unanswerable', 'inaccessible', 'ambiguous'];
const INTERPRETATION = 'Threshold qualification of pinned native retrieval only. Not verified answer accuracy, issuer authority, reviewer independence, or approval to release.';
function fail(): never { throw new Error('Invalid or mismatched retrieval qualification input.'); }
function sha(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  if (keys && (Object.keys(raw).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key)))) fail();
  return raw;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) fail();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) fail();
  return value;
}
function count(value: unknown, maximum = 5000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail();
  return value;
}
function rate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail();
  return value;
}
function sorted(values: Iterable<string>): string[] { return [...values].sort(); }
function minimums(value: unknown): GateMinimums {
  const row = object(value, COUNT_NAMES);
  const output = Object.fromEntries(COUNT_NAMES.map(key => [key, count(row[key], key === 'families' ? 100 : 5000)])) as GateMinimums;
  // A minimum case count cannot be lower than each required subset or the
  // sum of mutually exclusive label-kind counts.
  if (output.cases < output.families || output.cases <
      output.answerable + output.unanswerable + output.inaccessible + output.ambiguous) fail();
  return output;
}
function thresholds(value: unknown): RateThresholds {
  const row = object(value);
  const keys = Object.keys(row);
  if (!keys.length || keys.some(key => !METRICS.includes(key as GateMetric))) fail();
  return Object.fromEntries(METRICS.flatMap(key =>
    Object.prototype.hasOwnProperty.call(row, key) ? [[key, rate(row[key])]] : []));
}
/** A threshold must have an explicitly required supporting denominator.
 * Citation precision also depends on actual returned evidence, which can
 * be zero even in an otherwise sufficiently labeled cohort. */
function requireSupport(rates: RateThresholds, support: GateMinimums) {
  for (const metric of Object.keys(rates) as GateMetric[]) {
    const needed = metric === 'unanswerableAbstentionRate' ? support.unanswerable
      : metric === 'inaccessibleAbstentionRate' ? support.inaccessible
      : metric === 'ambiguousAbstentionRate' ? support.ambiguous : support.answerable;
    if (needed < 1) fail();
  }
}
function sliceRequirement(value: unknown): SliceRequirement {
  const row = object(value, ['slice', 'minimums', 'thresholds']);
  const support = minimums(row.minimums), rates = thresholds(row.thresholds);
  requireSupport(rates, support);
  if (support.cases < 1 || support.families < 1) fail();
  return { slice: name(row.slice), minimums: support, thresholds: rates };
}
function modeRequirement(value: unknown, global: GateMinimums): ModeRequirement {
  const row = object(value, ['mode', 'thresholds', 'slices']);
  if (!MODES.includes(row.mode as RetrievalMode) || !Array.isArray(row.slices) || row.slices.length > 64) fail();
  const rates = thresholds(row.thresholds);
  requireSupport(rates, global);
  const slices = row.slices.map(sliceRequirement).sort((a, b) => a.slice < b.slice ? -1 : a.slice > b.slice ? 1 : 0);
  if (new Set(slices.map(slice => slice.slice)).size !== slices.length) fail();
  return { mode: row.mode as RetrievalMode, thresholds: rates, slices };
}
/** Policy is supplied explicitly; there are no invisible default success
 * thresholds. A release plan must qualify holdout evidence retrieval and
 * negative abstention, and cover at least two families. */
export function parseGatePolicy(value: unknown): GatePolicy {
  const row = object(value, ['id', 'purpose', 'split', 'minimums', 'modes']);
  if ((row.purpose !== 'development' && row.purpose !== 'release') ||
      (row.split !== 'development' && row.split !== 'holdout') ||
      !Array.isArray(row.modes) || !row.modes.length || row.modes.length > MODES.length) fail();
  const support = minimums(row.minimums);
  if (support.cases < 1 || support.families < 1) fail();
  const modes = row.modes.map(value => modeRequirement(value, support))
    .sort((a, b) => MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
  if (new Set(modes.map(row => row.mode)).size !== modes.length) fail();
  if (row.purpose === 'release') {
    if (row.split !== 'holdout' || support.families < 2 || support.answerable < 1 || support.unanswerable < 1) fail();
    for (const mode of modes) {
      for (const metric of ['citationPrecision', 'citationRecall', 'completeEvidenceRate', 'unanswerableAbstentionRate'] as const) {
        if (mode.thresholds[metric] === undefined || mode.thresholds[metric]! <= 0) fail();
      }
    }
  }
  return { id: name(row.id), purpose: row.purpose, split: row.split, minimums: support, modes };
}
export function readGatePolicy(text: string): GatePolicy {
  return parseGatePolicy(parseStrictJson(text, MAX_GATE_PLAN_BYTES));
}
function inventory(dataset: Dataset, split: Split): Inventory {
  const documents = dataset.documents.filter(row => row.split === split);
  const cases = documents.flatMap(row => row.cases);
  return {
    documents: documents.length, families: new Set(documents.map(row => row.family)).size,
    cases: cases.length, answerable: cases.filter(row => row.label.kind === 'answerable').length,
    unanswerable: cases.filter(row => row.label.kind === 'unanswerable').length,
    inaccessible: cases.filter(row => row.label.kind === 'unindexed').length,
    ambiguous: cases.filter(row => row.label.kind === 'ambiguous').length,
    slices: sorted(new Set(cases.flatMap(row => row.slices))),
  };
}
function readInventory(value: unknown): Inventory {
  const raw = object(value, ['documents', ...COUNT_NAMES, 'slices']);
  if (!Array.isArray(raw.slices) || raw.slices.length > 5000) fail();
  const slices = raw.slices.map(name);
  if (JSON.stringify(slices) !== JSON.stringify(sorted(new Set(slices)))) fail();
  const result = { documents: count(raw.documents, 100),
    ...Object.fromEntries(COUNT_NAMES.map(key => [key, count(raw[key], key === 'families' ? 100 : 5000)])),
    slices } as Inventory;
  if (!result.documents || !result.cases || result.documents > result.cases ||
      result.families > result.documents || result.cases !==
      result.answerable + result.unanswerable + result.inaccessible + result.ambiguous) fail();
  return result;
}
function bound(text: string, maximum: number): string {
  if (!text || Buffer.byteLength(text, 'utf8') > maximum) fail();
  return text;
}
function prepare(input: GateInput) {
  const dataset = parseDataset(input.manifest);
  const loaded = loadDataset(dataset, input.artifacts);
  return { dataset, loaded, manifestHash: sha(input.manifest) };
}
function assertPurpose(policy: GatePolicy, dataset: Dataset) {
  if (policy.purpose === 'release' && dataset.kind !== 'independently_reviewed') fail();
}
function planFor(policy: GatePolicy, dataset: Dataset, manifestHash: string): Plan {
  assertPurpose(policy, dataset);
  const cohort = inventory(dataset, policy.split);
  if (!cohort.documents || !cohort.cases) fail();
  // Freeze the plan without running retrieval or revealing outcome metrics.
  return { format: 'noticebridge-retrieval-gate-plan', version: 1,
    dataset: dataset.id, label_kind: dataset.kind, manifest_sha256: manifestHash,
    policy, inventory: cohort, authority_verified: false, reviewer_identity_verified: false };
}
export function freezeGatePlan(policy: GatePolicy, input: GateInput): string {
  const validated = parseGatePolicy(policy);
  const { dataset, manifestHash } = prepare(input);
  return bound(encode(planFor(validated, dataset, manifestHash)), MAX_GATE_PLAN_BYTES);
}
export function parseGatePlan(text: string): Plan {
  const raw = object(parseStrictJson(text, MAX_GATE_PLAN_BYTES), ['format', 'version', 'dataset',
    'label_kind', 'manifest_sha256', 'policy', 'inventory', 'authority_verified', 'reviewer_identity_verified']);
  if (raw.format !== 'noticebridge-retrieval-gate-plan' || raw.version !== 1 ||
      (raw.label_kind !== 'synthetic' && raw.label_kind !== 'independently_reviewed') ||
      raw.authority_verified !== false || raw.reviewer_identity_verified !== false) fail();
  const result: Plan = { format: raw.format, version: 1, dataset: name(raw.dataset),
    label_kind: raw.label_kind, manifest_sha256: digest(raw.manifest_sha256),
    policy: parseGatePolicy(raw.policy), inventory: readInventory(raw.inventory),
    authority_verified: false, reviewer_identity_verified: false };
  if (result.policy.purpose === 'release' && result.label_kind !== 'independently_reviewed') fail();
  if (encode(result) !== text) fail();
  return result;
}

type Totals = DatasetReport['modes'][number]['totals'];
function zeroCounts(): GateMinimums {
  return { cases: 0, families: 0, answerable: 0, unanswerable: 0, inaccessible: 0, ambiguous: 0 };
}
function actualCounts(totals: Totals | undefined): GateMinimums {
  return totals ? Object.fromEntries(COUNT_NAMES.map(key => [key, totals[key]])) as GateMinimums : zeroCounts();
}
function check(totals: Totals | undefined, support: GateMinimums, thresholds: RateThresholds,
  mode: RetrievalMode, slice: string | null, failures: GateFailure[]): CheckResult {
  const actual = actualCounts(totals);
  const counts = COUNT_NAMES.map(key => {
    const passed = actual[key] >= support[key];
    if (!passed) failures.push({ code: 'missing_support', mode, slice, metric: key, actual: actual[key], required: support[key] });
    return { name: key, actual: actual[key], minimum: support[key], passed };
  });
  const rates = METRICS.flatMap(metric => {
    const threshold = thresholds[metric];
    if (threshold === undefined) return [];
    const value = totals?.[metric] ?? null;
    const passed = value !== null && value >= threshold;
    if (!passed) failures.push({ code: value === null ? 'undefined_metric' : 'below_threshold',
      mode, slice, metric, actual: value, required: threshold });
    return [{ metric, actual: value, minimum: threshold, passed }];
  });
  return { counts, rates, passed: counts.every(row => row.passed) && rates.every(row => row.passed) };
}
function crossCheckInventory(report: AuditedReport, cohort: Inventory) {
  if (report.documents.length !== cohort.documents) fail();
  for (const mode of report.modes) {
    if (COUNT_NAMES.some(key => mode.totals[key] !== cohort[key]) ||
        JSON.stringify(mode.slices.map(row => row.slice)) !== JSON.stringify(cohort.slices)) fail();
  }
}
function expectedReport(plan: Plan, planText: string, evaluation: AuditedReport, evaluationText: string): GateReport {
  crossCheckInventory(evaluation, plan.inventory);
  const failures: GateFailure[] = [];
  if (evaluation.integrity_violations !== 0) failures.push({ code: 'integrity_violation',
    mode: null, slice: null, metric: 'integrity_violations', actual: evaluation.integrity_violations, required: 0 });
  const modes = plan.policy.modes.map(requirement => {
    const mode = evaluation.modes.find(row => row.mode === requirement.mode);
    if (!mode) fail();
    const global = check(mode.totals, plan.policy.minimums, requirement.thresholds, requirement.mode, null, failures);
    const slices = requirement.slices.map(slice => ({
      slice: slice.slice,
      result: check(mode.slices.find(row => row.slice === slice.slice), slice.minimums,
        slice.thresholds, requirement.mode, slice.slice, failures),
    }));
    return { mode: requirement.mode, global, slices, passed: global.passed && slices.every(row => row.result.passed) };
  });
  const qualified = failures.length === 0;
  return { format: 'noticebridge-retrieval-gate-report', version: 1,
    plan_sha256: sha(planText), manifest_sha256: plan.manifest_sha256,
    evaluation_sha256: sha(evaluationText), dataset: plan.dataset, label_kind: plan.label_kind,
    purpose: plan.policy.purpose, split: plan.policy.split, inventory: plan.inventory,
    authority_verified: false, reviewer_identity_verified: false, release_approved: false,
    metric_qualified: qualified, status: qualified ? 'qualified' : 'not_qualified',
    integrity_violations: evaluation.integrity_violations, modes, failures, interpretation: INTERPRETATION };
}
/** Score from the pinned corpus rather than trusting an externally supplied
 * report. The same run is structurally audited before threshold checks. */
export function qualifyRetrieval(planText: string, input: GateInput): GateResult {
  const plan = parseGatePlan(planText);
  const { dataset, loaded, manifestHash } = prepare(input);
  if (planText !== encode(planFor(plan.policy, dataset, manifestHash))) fail();
  const evaluation = evaluateDataset(dataset, loaded, plan.policy.split);
  const evaluationText = encode({ ...evaluation, manifest_sha256: manifestHash });
  const audited = auditReport(evaluationText);
  const report = expectedReport(plan, planText, audited, evaluationText);
  return { report, reportText: bound(encode(report), MAX_GATE_REPORT_BYTES), evaluationText };
}
/** Recompute from frozen sources and policy, then verify exact report bytes.
 * There is no signature or external timestamp; this is deterministic replay. */
export function replayGate(reportText: string, planText: string, input: GateInput): GateReport {
  bound(reportText, MAX_GATE_REPORT_BYTES);
  const result = qualifyRetrieval(planText, input);
  if (result.reportText !== reportText) fail();
  return result.report;
}
