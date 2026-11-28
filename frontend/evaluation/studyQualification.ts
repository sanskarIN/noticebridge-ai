/** Reproducible study qualification from source snapshots, explicit review
 * dispositions, a frozen point policy, and family-cluster uncertainty.
 *
 * No outcome is evaluated while the plan is frozen. A passed plan is
 * descriptive evidence only; a local file does not establish chronology,
 * external validation, independence, or authorization to release.
 */
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strictJson';
import { freezeGatePlan, parseGatePlan, parseGatePolicy, qualifyRetrieval,
  type GateInput, type GatePolicy, type GateMetric } from './retrievalGate';
import { auditPreflightReview } from './preflightReview';
import { analyzeUncertainty, MIN_RESAMPLES, MAX_RESAMPLES,
  MIN_SUPPORTING_FAMILIES, type Settings, type Estimate } from './retrievalUncertainty';
import type { RetrievalMode } from './retrievalMetrics';

export const MAX_STUDY_PLAN_BYTES = 512 * 1024;
export const MAX_STUDY_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_SLICES = 12;
const POLICY = 'Descriptive native retrieval qualification; no authority, label correctness, reviewer independence, generalization, or release approval is established.';
const SHA = /^[a-f0-9]{64}$/;
const METRICS: GateMetric[] = ['citationPrecision', 'citationRecall',
  'completeEvidenceRate', 'unanswerableAbstentionRate',
  'inaccessibleAbstentionRate', 'ambiguousAbstentionRate', 'meanReciprocalRank'];

export type StudyPolicy = {
  gate: GatePolicy;
  similarity_threshold: number;
  bootstrap: Settings;
  minimum_supporting_families: number;
  require_leave_one_family_out: boolean;
};
export type StudyInput = GateInput & {
  preflightText: string;
  queueText: string;
};
type ReviewBinding = {
  preflight_sha256: string;
  review_queue_sha256: string;
  review_audit_sha256: string;
  reviewed_pair_leads: number;
  reviewed_case_leads: number;
};
export type StudyPlan = ReviewBinding & {
  format: 'noticebridge-retrieval-study-plan';
  version: 1;
  policy: StudyPolicy;
  point_gate_plan: string;
  point_gate_plan_sha256: string;
  manifest_sha256: string;
  authority_verified: false;
  reviewer_identity_verified: false;
  release_approved: false;
};
type Reason = 'no_estimate' | 'insufficient_supporting_families' |
  'interval_unavailable' | 'lower_bound_below_threshold' |
  'leave_one_family_out_undefined' | 'leave_one_family_out_below_threshold';
export type UncertaintyCheck = {
  mode: RetrievalMode;
  slice: string | null;
  metric: GateMetric;
  required: number;
  minimum_supporting_families: number;
  point: number | null;
  supporting_families: number;
  defined_resamples: number;
  undefined_resamples: number;
  interval_status: Estimate['interval_status'] | 'missing_estimate';
  lower_bound: number | null;
  upper_bound: number | null;
  leave_one_family_out: Estimate['leave_one_family_out'] | null;
  passed: boolean;
  reasons: Reason[];
};
export type StudyReport = {
  format: 'noticebridge-retrieval-study-qualification';
  version: 1;
  interpretation: string;
  plan_sha256: string;
  manifest_sha256: string;
  point_gate_plan_sha256: string;
  point_gate_report_sha256: string;
  evaluation_sha256: string;
  uncertainty_sha256: string | null;
  review: ReviewBinding;
  dataset: string;
  label_kind: 'synthetic' | 'independently_reviewed';
  purpose: GatePolicy['purpose'];
  split: GatePolicy['split'];
  bootstrap: Settings;
  authority_verified: false;
  reviewer_identity_verified: false;
  independence_verified: false;
  label_correctness_verified: false;
  release_approved: false;
  point_qualified: boolean;
  uncertainty_qualified: boolean;
  study_qualified: boolean;
  integrity_violations: number;
  uncertainty_skipped_reason: 'integrity_violation' | null;
  point_failures: ReturnType<typeof qualifyRetrieval>['report']['failures'];
  checks: UncertaintyCheck[];
};
function invalid(): never {
  throw new Error('Invalid or stale study qualification input, plan, or review.');
}
function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function bound(text: string, maximum: number): string {
  if (!text || Buffer.byteLength(text, 'utf8') > maximum) invalid();
  return text;
}
function encode(value: unknown, maximum: number): string {
  return bound(JSON.stringify(value, null, 2) + '\n', maximum);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) invalid();
  return raw;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < min || value > max) invalid();
  return value;
}
function threshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value < 0.5 || value > 1) invalid();
  return value;
}
function bootstrapSettings(value: unknown): Settings {
  const raw = object(value, ['seed', 'resamples', 'level']);
  if (raw.level !== 0.9 && raw.level !== 0.95 && raw.level !== 0.99) invalid();
  return {
    seed: integer(raw.seed, 1, 0xffffffff),
    resamples: integer(raw.resamples, MIN_RESAMPLES, MAX_RESAMPLES),
    level: raw.level,
  };
}
function requestedSlices(policy: GatePolicy): string[] {
  return [...new Set(policy.modes.flatMap(mode => mode.slices.map(slice => slice.slice)))].sort();
}
export function parseStudyPolicy(value: unknown): StudyPolicy {
  const raw = object(value, ['gate', 'similarity_threshold', 'bootstrap',
    'minimum_supporting_families', 'require_leave_one_family_out']);
  const gate = parseGatePolicy(raw.gate);
  const supporting = integer(raw.minimum_supporting_families, MIN_SUPPORTING_FAMILIES, 100);
  if (requestedSlices(gate).length > MAX_SLICES ||
      typeof raw.require_leave_one_family_out !== 'boolean') invalid();
  return {
    gate,
    similarity_threshold: threshold(raw.similarity_threshold),
    bootstrap: bootstrapSettings(raw.bootstrap),
    minimum_supporting_families: supporting,
    require_leave_one_family_out: raw.require_leave_one_family_out,
  };
}
export function readStudyPolicy(text: string): StudyPolicy {
  return parseStudyPolicy(parseStrictJson(text, MAX_STUDY_PLAN_BYTES));
}
function reviewBinding(policy: StudyPolicy, input: StudyInput): ReviewBinding {
  const review = auditPreflightReview(input.queueText, input.preflightText, input,
    { similarityThreshold: policy.similarity_threshold });
  if (!review.audit.all_leads_disposed_without_changes) invalid();
  return {
    preflight_sha256: review.audit.preflight_sha256,
    review_queue_sha256: review.audit.queue_sha256,
    review_audit_sha256: hash(review.text),
    reviewed_pair_leads: review.audit.summary.pair_decisions.distinct_after_inspection,
    reviewed_case_leads: review.audit.summary.case_decisions.retained_after_inspection,
  };
}
function planFor(policy: StudyPolicy, input: StudyInput): StudyPlan {
  // The preflight and review are replayed, not accepted as asserted flags.
  const review = reviewBinding(policy, input);
  const pointPlan = freezeGatePlan(policy.gate, input);
  return {
    format: 'noticebridge-retrieval-study-plan',
    version: 1,
    ...review,
    policy,
    point_gate_plan: pointPlan,
    point_gate_plan_sha256: hash(pointPlan),
    manifest_sha256: hash(input.manifest),
    authority_verified: false,
    reviewer_identity_verified: false,
    release_approved: false,
  };
}
export function freezeStudyPlan(policy: StudyPolicy, input: StudyInput): string {
  const text = encode(planFor(parseStudyPolicy(policy), input), MAX_STUDY_PLAN_BYTES);
  parseStudyPlan(text);
  return text;
}
export function parseStudyPlan(text: string): StudyPlan {
  const raw = object(parseStrictJson(text, MAX_STUDY_PLAN_BYTES), [
    'format', 'version', 'preflight_sha256', 'review_queue_sha256', 'review_audit_sha256',
    'reviewed_pair_leads', 'reviewed_case_leads', 'policy', 'point_gate_plan',
    'point_gate_plan_sha256', 'manifest_sha256',
    'authority_verified', 'reviewer_identity_verified', 'release_approved',
  ]);
  if (raw.format !== 'noticebridge-retrieval-study-plan' || raw.version !== 1 ||
      raw.authority_verified !== false || raw.reviewer_identity_verified !== false ||
      raw.release_approved !== false || typeof raw.point_gate_plan !== 'string') invalid();
  const policy = parseStudyPolicy(raw.policy);
  const pointPlan = parseGatePlan(raw.point_gate_plan);
  if (JSON.stringify(pointPlan.policy) !== JSON.stringify(policy.gate) ||
      pointPlan.manifest_sha256 !== raw.manifest_sha256 ||
      hash(raw.point_gate_plan) !== raw.point_gate_plan_sha256) invalid();
  const plan: StudyPlan = {
    format: 'noticebridge-retrieval-study-plan',
    version: 1,
    preflight_sha256: digest(raw.preflight_sha256),
    review_queue_sha256: digest(raw.review_queue_sha256),
    review_audit_sha256: digest(raw.review_audit_sha256),
    reviewed_pair_leads: integer(raw.reviewed_pair_leads, 0, 19900),
    reviewed_case_leads: integer(raw.reviewed_case_leads, 0, 5000),
    policy,
    point_gate_plan: raw.point_gate_plan,
    point_gate_plan_sha256: digest(raw.point_gate_plan_sha256),
    manifest_sha256: digest(raw.manifest_sha256),
    authority_verified: false,
    reviewer_identity_verified: false,
    release_approved: false,
  };
  if (encode(plan, MAX_STUDY_PLAN_BYTES) !== text) invalid();
  return plan;
}
type Requirement = {
  mode: RetrievalMode;
  slice: string | null;
  metric: GateMetric;
  threshold: number;
};
function requirements(policy: GatePolicy): Requirement[] {
  return policy.modes.flatMap(mode => {
    const cohorts = [
      { slice: null, thresholds: mode.thresholds },
      ...mode.slices.map(slice => ({ slice: slice.slice, thresholds: slice.thresholds })),
    ];
    return cohorts.flatMap(cohort => METRICS.flatMap(metric => {
      const threshold = cohort.thresholds[metric];
      return threshold === undefined ? [] :
        [{ mode: mode.mode, slice: cohort.slice, metric, threshold }];
    }));
  });
}
function uncertaintyCheck(requirement: Requirement, estimate: Estimate | undefined,
  policy: StudyPolicy): UncertaintyCheck {
  const reasons: Reason[] = [];
  if (!estimate) {
    reasons.push('no_estimate');
  } else {
    if (estimate.supporting_families < policy.minimum_supporting_families) {
      reasons.push('insufficient_supporting_families');
    }
    if (estimate.interval_status !== 'reported' || !estimate.interval) {
      reasons.push('interval_unavailable');
    } else if (estimate.interval.lower < requirement.threshold) {
      reasons.push('lower_bound_below_threshold');
    }
    if (policy.require_leave_one_family_out) {
      if (estimate.leave_one_family_out.undefined > 0 ||
          estimate.leave_one_family_out.minimum === null) {
        reasons.push('leave_one_family_out_undefined');
      } else if (estimate.leave_one_family_out.minimum < requirement.threshold) {
        reasons.push('leave_one_family_out_below_threshold');
      }
    }
  }
  return {
    mode: requirement.mode,
    slice: requirement.slice,
    metric: requirement.metric,
    required: requirement.threshold,
    minimum_supporting_families: policy.minimum_supporting_families,
    point: estimate?.point ?? null,
    supporting_families: estimate?.supporting_families ?? 0,
    defined_resamples: estimate?.defined_resamples ?? 0,
    undefined_resamples: estimate?.undefined_resamples ?? 0,
    interval_status: estimate?.interval_status ?? 'missing_estimate',
    lower_bound: estimate?.interval?.lower ?? null,
    upper_bound: estimate?.interval?.upper ?? null,
    leave_one_family_out: estimate?.leave_one_family_out ?? null,
    passed: reasons.length === 0,
    reasons,
  };
}
/** The exact same thresholds apply to point and lower-bound checks.
 * Optional leave-one-family-out checks use the same thresholds as well.
 * Missing slices and undefined bounds cannot pass a zero threshold.
 */
export function qualifyStudy(planText: string, input: StudyInput) {
  const plan = parseStudyPlan(planText);
  const expected = planFor(plan.policy, input);
  if (encode(expected, MAX_STUDY_PLAN_BYTES) !== planText) invalid();
  const point = qualifyRetrieval(plan.point_gate_plan, input);
  const pointReport = point.report;
  const available = new Set(pointReport.inventory.slices);
  const slices = requestedSlices(plan.policy.gate).filter(slice => available.has(slice));
  const uncertainty = pointReport.integrity_violations === 0
    ? analyzeUncertainty(point.evaluationText, plan.policy.bootstrap, slices)
    : null;
  const checks = requirements(plan.policy.gate).map(requirement => {
    const cohort = requirement.slice === null ? uncertainty?.report.cohort :
      uncertainty?.report.slices.find(slice => slice.name === requirement.slice);
    const estimate = cohort?.modes.find(mode => mode.mode === requirement.mode)
      ?.metrics.find(metric => metric.metric === requirement.metric)?.estimate;
    return uncertaintyCheck(requirement, estimate, plan.policy);
  });
  const uncertaintyQualified = uncertainty !== null && checks.length > 0 &&
    checks.every(check => check.passed);
  const report: StudyReport = {
    format: 'noticebridge-retrieval-study-qualification',
    version: 1,
    interpretation: POLICY,
    plan_sha256: hash(planText),
    manifest_sha256: plan.manifest_sha256,
    point_gate_plan_sha256: plan.point_gate_plan_sha256,
    point_gate_report_sha256: hash(point.reportText),
    evaluation_sha256: pointReport.evaluation_sha256,
    uncertainty_sha256: uncertainty ? hash(uncertainty.text) : null,
    review: {
      preflight_sha256: plan.preflight_sha256,
      review_queue_sha256: plan.review_queue_sha256,
      review_audit_sha256: plan.review_audit_sha256,
      reviewed_pair_leads: plan.reviewed_pair_leads,
      reviewed_case_leads: plan.reviewed_case_leads,
    },
    dataset: pointReport.dataset,
    label_kind: pointReport.label_kind,
    purpose: pointReport.purpose,
    split: pointReport.split,
    bootstrap: plan.policy.bootstrap,
    authority_verified: false,
    reviewer_identity_verified: false,
    independence_verified: false,
    label_correctness_verified: false,
    release_approved: false,
    point_qualified: pointReport.metric_qualified,
    uncertainty_qualified: uncertaintyQualified,
    study_qualified: pointReport.metric_qualified && uncertaintyQualified,
    integrity_violations: pointReport.integrity_violations,
    uncertainty_skipped_reason: uncertainty ? null : 'integrity_violation',
    point_failures: pointReport.failures,
    checks,
  };
  return {
    report,
    text: encode(report, MAX_STUDY_REPORT_BYTES),
    pointReportText: point.reportText,
    evaluationText: point.evaluationText,
    uncertaintyText: uncertainty?.text ?? null,
  };
}
export function replayStudy(reportText: string, planText: string, input: StudyInput): StudyReport {
  bound(reportText, MAX_STUDY_REPORT_BYTES);
  const result = qualifyStudy(planText, input);
  if (result.text !== reportText) invalid();
  return result.report;
}
