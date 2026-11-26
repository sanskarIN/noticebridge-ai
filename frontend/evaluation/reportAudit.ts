/** Audit and paired comparison of offline evaluation reports.
 * Reports contain case IDs and metrics, not source text or model answers.
 * Internal consistency does not authenticate the evaluator or labels.
 */
import { summarize, type CaseMetrics, type RetrievalMode } from './retrievalMetrics';
import type { DatasetReport, Split } from './retrievalDataset';

export const MAX_EVALUATION_REPORT_BYTES = 32 * 1024 * 1024;
export const MAX_REPORT_CASES = 5000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const MODES: RetrievalMode[] = ['strict', 'contextual', 'all-strict'];
const METRICS = ['citationPrecision', 'citationRecall', 'completeEvidenceRate',
  'unanswerableAbstentionRate', 'inaccessibleAbstentionRate', 'ambiguousAbstentionRate',
  'meanReciprocalRank'] as const;
type RateMetric = typeof METRICS[number];
export type AuditedReport = DatasetReport & { manifest_sha256: string };
export type PairedCounts = { gained: number; lost: number; both: number; neither: number; cases: number };
export type RateDelta = { metric: RateMetric; before: number | null; after: number | null; delta: number | null };
export type PairedMode = {
  mode: RetrievalMode;
  cases: number;
  positiveEvidence: PairedCounts;
  negativeAbstention: PairedCounts;
  rates: RateDelta[];
  integrity: { before: number; after: number };
  familyResults: { family: string; positiveEvidence: PairedCounts; negativeAbstention: PairedCounts }[];
  changed: {
    id: string; family: string; kind: CaseMetrics['kind'];
    beforeComplete: boolean; afterComplete: boolean;
    beforeAbstained: boolean; afterAbstained: boolean;
    beforeRetrieved: number; afterRetrieved: number;
  }[];
};

function invalid(): never { throw new Error('Invalid, inconsistent or incomparable retrieval report.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) invalid();
  return raw;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid();
  return value;
}
function identifiers(value: unknown, max: number, min = 1): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
  const result = value.map(identifier);
  if (new Set(result).size !== result.length) invalid();
  return result;
}
function integer(value: unknown, max = 12000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function rate(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}
/** Structural equality independent of object member order. Never normalize
 * arbitrary keys or accept additional fields in the report schema. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    return Object.keys(x).length === Object.keys(y).length &&
      Object.keys(x).every(key => Object.prototype.hasOwnProperty.call(y, key) && equal(x[key], y[key]));
  }
  return false;
}
function parseCase(value: unknown): CaseMetrics {
  const raw = object(value, ['id', 'family', 'slices', 'kind', 'retrieved', 'relevant', 'required',
    'requiredFound', 'complete', 'abstained', 'reciprocalRank', 'duplicateIds', 'unknownIds',
    'roleLeaks', 'pageLeaks', 'routingMismatch']);
  const kind = raw.kind;
  if (kind !== 'answerable' && kind !== 'unanswerable' && kind !== 'unindexed' && kind !== 'ambiguous') invalid();
  const row: CaseMetrics = {
    id: identifier(raw.id), family: identifier(raw.family), slices: identifiers(raw.slices, 8), kind,
    retrieved: integer(raw.retrieved), relevant: integer(raw.relevant), required: integer(raw.required, 24),
    requiredFound: integer(raw.requiredFound, 24), complete: bool(raw.complete), abstained: bool(raw.abstained),
    reciprocalRank: rate(raw.reciprocalRank), duplicateIds: integer(raw.duplicateIds),
    unknownIds: integer(raw.unknownIds), roleLeaks: integer(raw.roleLeaks), pageLeaks: integer(raw.pageLeaks),
    routingMismatch: bool(raw.routingMismatch),
  };
  if (row.abstained !== (row.retrieved === 0 && row.duplicateIds === 0) ||
      row.unknownIds > row.retrieved || row.roleLeaks > row.retrieved - row.unknownIds ||
      row.pageLeaks > row.retrieved - row.unknownIds ||
      row.relevant > row.retrieved - row.unknownIds ||
      row.requiredFound > row.required || row.requiredFound > row.relevant) invalid();
  if (kind === 'answerable') {
    if (!row.required || row.complete !== (row.required === row.requiredFound) || row.reciprocalRank === null ||
        (row.relevant === 0) !== (row.reciprocalRank === 0)) invalid();
    if (row.reciprocalRank > 0) {
      const rank = 1 / row.reciprocalRank;
      if (Math.abs(rank - Math.round(rank)) > 1e-8 ||
          rank > row.retrieved + row.duplicateIds + 1e-8) invalid();
    }
  } else if (row.relevant || row.required || row.requiredFound || row.complete || row.reciprocalRank !== null) invalid();
  return row;
}

function identity(row: CaseMetrics) { return { id: row.id, family: row.family, slices: row.slices, kind: row.kind }; }
function integrity(rows: CaseMetrics[]): number {
  return rows.reduce((total, row) => total + row.duplicateIds + row.unknownIds + row.roleLeaks +
    row.pageLeaks + Number(row.routingMismatch), 0);
}
function expectedMode(mode: RetrievalMode, rows: CaseMetrics[]) {
  const slices = [...new Set(rows.flatMap(row => row.slices))].sort();
  const families = [...new Set(rows.map(row => row.family))].sort();
  return {
    mode, totals: summarize(rows),
    slices: slices.map(slice => ({ slice, ...summarize(rows.filter(row => row.slices.includes(slice))) })),
    families: families.map(family => ({ family, ...summarize(rows.filter(row => row.family === family)) })),
    cases: rows,
  };
}
function expectedTransitions(modes: ReturnType<typeof expectedMode>[]) {
  const baseline = new Map(modes[0].cases.map(row => [row.id, row]));
  return modes.slice(1).map(candidate => {
    const gained: string[] = [], lost: string[] = [], abstentionRegressions: string[] = [];
    for (const row of candidate.cases) {
      const old = baseline.get(row.id);
      if (!old || !equal(identity(old), identity(row))) invalid();
      if (row.complete && !old.complete) gained.push(row.id);
      if (!row.complete && old.complete) lost.push(row.id);
      if (old.kind === 'unanswerable' && old.abstained && !row.abstained) abstentionRegressions.push(row.id);
    }
    return { mode: candidate.mode, gained, lost, abstentionRegressions };
  });
}
/** Recompute every aggregate, slice, family, transition and integrity
 * counter from the supplied case records. No metric can be trusted merely
 * because a JSON file says it was calculated. The manifest hash is a
 * comparison binding, not a cryptographic signature of the report.
 */
export function auditReport(text: string): AuditedReport {
  if (!text || text.length > MAX_EVALUATION_REPORT_BYTES ||
      new TextEncoder().encode(text).length > MAX_EVALUATION_REPORT_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const raw = object(value, ['format', 'version', 'dataset', 'label_kind', 'split', 'documents',
    'synthetic', 'authority_verified', 'integrity_violations', 'modes', 'transitions', 'manifest_sha256']);
  if (raw.format !== 'noticebridge-retrieval-evaluation' || raw.version !== 1 ||
      raw.authority_verified !== false || (raw.label_kind !== 'synthetic' && raw.label_kind !== 'independently_reviewed') ||
      raw.synthetic !== (raw.label_kind === 'synthetic') ||
      (raw.split !== 'development' && raw.split !== 'holdout') ||
      typeof raw.manifest_sha256 !== 'string' || !SHA.test(raw.manifest_sha256) ||
      !Array.isArray(raw.modes) || raw.modes.length !== MODES.length) invalid();
  const dataset = identifier(raw.dataset), documents = identifiers(raw.documents, 100);
  const modes = raw.modes.map((value, i) => {
    const item = object(value, ['mode', 'totals', 'slices', 'families', 'cases']);
    if (item.mode !== MODES[i] || !Array.isArray(item.cases) || !item.cases.length ||
        item.cases.length > MAX_REPORT_CASES) invalid();
    const rows = item.cases.map(parseCase);
    if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
    const expected = expectedMode(MODES[i], rows);
    if (!equal(item, expected)) invalid();
    return expected;
  });
  const baseline = modes[0].cases.map(identity);
  if (modes.some(mode => !equal(mode.cases.map(identity), baseline))) invalid();
  const transitions = expectedTransitions(modes);
  if (!equal(raw.transitions, transitions)) invalid();
  const violations = modes.reduce((total, mode) => total + integrity(mode.cases), 0);
  if (raw.integrity_violations !== violations) invalid();
  return { format: 'noticebridge-retrieval-evaluation', version: 1, dataset, label_kind: raw.label_kind,
    split: raw.split, documents, synthetic: raw.synthetic as boolean, authority_verified: false,
    integrity_violations: violations, modes, transitions, manifest_sha256: raw.manifest_sha256 };
}
function pairCount(before: CaseMetrics[], after: CaseMetrics[], predicate: (row: CaseMetrics) => boolean,
  kind: CaseMetrics['kind']): PairedCounts {
  const result = { gained: 0, lost: 0, both: 0, neither: 0, cases: 0 };
  const current = new Map(after.map(row => [row.id, row]));
  for (const row of before) {
    if (row.kind !== kind) continue;
    const other = current.get(row.id);
    if (!other) invalid();
    const a = predicate(row), b = predicate(other);
    if (a && b) result.both++;
    else if (a) result.lost++;
    else if (b) result.gained++;
    else result.neither++;
    result.cases++;
  }
  return result;
}
function positives(before: CaseMetrics[], after: CaseMetrics[]) {
  return pairCount(before, after, row => row.complete, 'answerable');
}
function negatives(before: CaseMetrics[], after: CaseMetrics[]) {
  return pairCount(before, after, row => row.abstained, 'unanswerable');
}
function rateDelta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

/** Same pinned manifest, same split, same label identities, same case
 * families/slices. No unpaired averages across different datasets.
 * Return descriptive paired gains/losses; do not claim significance.
 */
export function compareReports(before: AuditedReport, after: AuditedReport) {
  if (before.manifest_sha256 !== after.manifest_sha256 || before.dataset !== after.dataset ||
      before.label_kind !== after.label_kind || before.split !== after.split ||
      !equal(before.documents, after.documents)) invalid();
  const modes: PairedMode[] = MODES.map((mode, i) => {
    const old = before.modes[i], next = after.modes[i];
    if (old.mode !== mode || next.mode !== mode ||
        !equal(old.cases.map(identity), next.cases.map(identity))) invalid();
    const byId = new Map(next.cases.map(row => [row.id, row]));
    const changed = old.cases.flatMap(row => {
      const other = byId.get(row.id)!;
      if (equal(row, other)) return [];
      return [{ id: row.id, family: row.family, kind: row.kind,
        beforeComplete: row.complete, afterComplete: other.complete,
        beforeAbstained: row.abstained, afterAbstained: other.abstained,
        beforeRetrieved: row.retrieved, afterRetrieved: other.retrieved }];
    });
    const families = [...new Set(old.cases.map(row => row.family))].sort();
    return { mode, cases: old.cases.length,
      positiveEvidence: positives(old.cases, next.cases),
      negativeAbstention: negatives(old.cases, next.cases),
      rates: METRICS.map(metric => ({ metric, before: old.totals[metric], after: next.totals[metric],
        delta: rateDelta(old.totals[metric], next.totals[metric]) })),
      integrity: { before: integrity(old.cases), after: integrity(next.cases) },
      familyResults: families.map(family => {
        const a = old.cases.filter(row => row.family === family), b = next.cases.filter(row => row.family === family);
        return { family, positiveEvidence: positives(a, b), negativeAbstention: negatives(a, b) };
      }),
      changed,
    };
  });
  return { format: 'noticebridge-retrieval-report-comparison', version: 1,
    dataset: before.dataset, label_kind: before.label_kind, split: before.split,
    manifest_sha256: before.manifest_sha256, authority_verified: false,
    interpretation: 'Descriptive paired results only; not statistical significance or verified answer accuracy.',
    modes, integrity_regression: after.integrity_violations > before.integrity_violations,
  };
}
