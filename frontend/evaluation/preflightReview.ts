/** Explicit human dispositions of reproducible preflight leads.
 * A completed queue is neither a proof of independent data nor approval.
 */
import { createHash } from 'node:crypto';
import { replayPreflight, type PreflightInput, type PreflightSettings } from './datasetPreflight';
import { parseStrictJson } from './strictJson';

export const MAX_REVIEW_QUEUE_BYTES = 16 * 1024 * 1024;
export const MAX_REVIEW_NOTE_LENGTH = 300;
const pairDecisions = ['pending', 'distinct_after_inspection', 'regroup_required', 'uncertain'] as const;
const caseDecisions = ['pending', 'retained_after_inspection', 'revision_required', 'uncertain'] as const;
type PairDecision = typeof pairDecisions[number];
type CaseDecision = typeof caseDecisions[number];
type Entry<D extends string> = { id: string; decision: D; note: string };
type Binding = {
  dataset: string;
  manifest_sha256: string;
  preflight_sha256: string;
  similarity_threshold: number;
};
export type PreflightQueue = Binding & {
  format: 'noticebridge-preflight-review-queue';
  version: 1;
  pairs: Entry<PairDecision>[];
  cases: Entry<CaseDecision>[];
};
export type PreflightReviewAudit = Binding & {
  format: 'noticebridge-preflight-review-audit';
  version: 1;
  queue_sha256: string;
  authority_verified: false;
  reviewer_verified: false;
  independence_verified: false;
  label_correctness_verified: false;
  release_approved: false;
  all_leads_disposed_without_changes: boolean;
  summary: {
    pair_decisions: Record<PairDecision, number>;
    case_decisions: Record<CaseDecision, number>;
    cross_split_pairs_pending_or_uncertain: number;
    cross_split_pairs_requiring_regroup: number;
    unresolved_pairs: string[];
    unresolved_cases: string[];
    pairs_requiring_regroup: string[];
    cases_requiring_revision: string[];
  };
};
function invalid(): never {
  throw new Error('Invalid, incomplete, stale, or oversized preflight review.');
}
function hash(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function encode(value: unknown): string {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') > MAX_REVIEW_QUEUE_BYTES) invalid();
  return text;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))) invalid();
  return raw;
}
function context(preflightText: string, input: PreflightInput, settings: PreflightSettings) {
  const report = replayPreflight(preflightText, input, settings);
  const binding: Binding = {
    dataset: report.dataset,
    manifest_sha256: report.manifest_sha256,
    preflight_sha256: hash(preflightText),
    similarity_threshold: settings.similarityThreshold,
  };
  return { report, binding };
}
export function preparePreflightReview(preflightText: string, input: PreflightInput, settings: PreflightSettings) {
  const { report, binding } = context(preflightText, input, settings);
  const queue: PreflightQueue = {
    format: 'noticebridge-preflight-review-queue',
    version: 1,
    ...binding,
    pairs: report.pair_leads.map(lead => ({ id: lead.id, decision: 'pending', note: '' })),
    cases: report.case_leads.map(lead => ({ id: lead.id, decision: 'pending', note: '' })),
  };
  return { queue, text: encode(queue) };
}
function entries<D extends string>(
  value: unknown,
  ids: string[],
  decisions: readonly D[],
): Entry<D>[] {
  if (!Array.isArray(value) || value.length !== ids.length) invalid();
  const expected = new Set(ids);
  if (expected.size !== ids.length) invalid();
  const found = new Map<string, Entry<D>>();
  for (const item of value) {
    const row = object(item, ['id', 'decision', 'note']);
    if (typeof row.id !== 'string' || !expected.has(row.id) || found.has(row.id) ||
        typeof row.decision !== 'string' || !decisions.includes(row.decision as D) ||
        typeof row.note !== 'string' || row.note.length > MAX_REVIEW_NOTE_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(row.note)) invalid();
    if (row.decision === 'pending' ? row.note !== '' : row.note.trim().length === 0) invalid();
    found.set(row.id, { id: row.id, decision: row.decision as D, note: row.note });
  }
  return ids.map(id => found.get(id)!);
}
function counts<D extends string>(rows: Entry<D>[], decisions: readonly D[]): Record<D, number> {
  const result = Object.fromEntries(decisions.map(decision => [decision, 0])) as Record<D, number>;
  for (const row of rows) result[row.decision]++;
  return result;
}
export function auditPreflightReview(
  queueText: string,
  preflightText: string,
  input: PreflightInput,
  settings: PreflightSettings,
) {
  const { report, binding } = context(preflightText, input, settings);
  const raw = object(parseStrictJson(queueText, MAX_REVIEW_QUEUE_BYTES), [
    'format', 'version', 'dataset', 'manifest_sha256', 'preflight_sha256',
    'similarity_threshold', 'pairs', 'cases',
  ]);
  if (raw.format !== 'noticebridge-preflight-review-queue' || raw.version !== 1 ||
      Object.entries(binding).some(([key, value]) => raw[key] !== value)) invalid();
  const pairs = entries(raw.pairs, report.pair_leads.map(lead => lead.id), pairDecisions);
  const cases = entries(raw.cases, report.case_leads.map(lead => lead.id), caseDecisions);
  const unresolvedPairs = pairs.filter(row => row.decision === 'pending' || row.decision === 'uncertain');
  const unresolvedCases = cases.filter(row => row.decision === 'pending' || row.decision === 'uncertain');
  const regroup = pairs.filter(row => row.decision === 'regroup_required');
  const revision = cases.filter(row => row.decision === 'revision_required');
  const crossSplit = new Set(report.pair_leads.filter(lead => lead.cross_split).map(lead => lead.id));
  const audit: PreflightReviewAudit = {
    format: 'noticebridge-preflight-review-audit',
    version: 1,
    ...binding,
    queue_sha256: hash(queueText),
    authority_verified: false,
    reviewer_verified: false,
    independence_verified: false,
    label_correctness_verified: false,
    release_approved: false,
    all_leads_disposed_without_changes: unresolvedPairs.length + unresolvedCases.length + regroup.length + revision.length === 0,
    summary: {
      pair_decisions: counts(pairs, pairDecisions),
      case_decisions: counts(cases, caseDecisions),
      cross_split_pairs_pending_or_uncertain: unresolvedPairs.filter(row => crossSplit.has(row.id)).length,
      cross_split_pairs_requiring_regroup: regroup.filter(row => crossSplit.has(row.id)).length,
      unresolved_pairs: unresolvedPairs.map(row => row.id),
      unresolved_cases: unresolvedCases.map(row => row.id),
      pairs_requiring_regroup: regroup.map(row => row.id),
      cases_requiring_revision: revision.map(row => row.id),
    },
  };
  return { audit, text: encode(audit) };
}
export function replayPreflightReview(
  auditText: string,
  queueText: string,
  preflightText: string,
  input: PreflightInput,
  settings: PreflightSettings,
) {
  if (Buffer.byteLength(auditText, 'utf8') > MAX_REVIEW_QUEUE_BYTES) invalid();
  const result = auditPreflightReview(queueText, preflightText, input, settings);
  if (result.text !== auditText) invalid();
  return result.audit;
}
