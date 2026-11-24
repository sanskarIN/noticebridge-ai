import type { Evidence, Finding, Report, ValueChange } from './comparison';

type ReviewRestore =
  | { ids: string[] }
  | { error: 'invalid' | 'differentSources' | 'changedFindings' };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameItems<T>(
  saved: unknown, current: readonly T[], compare: (value: unknown, expected: T) => boolean,
): boolean {
  return Array.isArray(saved) && saved.length === current.length &&
    current.every((item, index) => compare(saved[index], item));
}

function sameEvidence(saved: unknown, current: Evidence | null): boolean {
  if (current === null) return saved === null;
  const source = record(saved);
  return !!source &&
    source.document_id === current.document_id &&
    source.page === current.page &&
    source.text === current.text &&
    source.extraction_method === current.extraction_method &&
    source.page_width === current.page_width &&
    source.page_height === current.page_height &&
    source.page_rotation === current.page_rotation &&
    sameItems(source.bbox, current.bbox, (value, coordinate) => value === coordinate);
}

function sameValueChange(saved: unknown, current: ValueChange): boolean {
  const change = record(saved);
  return !!change && change.kind === current.kind && change.outcome === current.outcome &&
    (['original', 'revised'] as const).every(role => {
      const value = record(change[role]);
      const expected = current[role];
      return !!value && value.raw === expected.raw && value.kind === expected.kind &&
        value.canonical === expected.canonical && value.confidence === expected.confidence;
    });
}

function sameFinding(saved: Record<string, unknown>, current: Finding): boolean {
  return saved.status === current.status &&
    saved.category === current.category &&
    saved.match_method === current.match_method &&
    sameEvidence(saved.original, current.original) &&
    sameEvidence(saved.revised, current.revised) &&
    sameItems(saved.supporting_evidence, current.supporting_evidence, sameEvidence) &&
    sameItems(saved.field_changes, current.field_changes, sameValueChange);
}

function sameDocument(value: unknown, current: Report['documents'][number]): boolean {
  const source = record(value);
  return source?.id === current.id && source.sha256 === current.sha256;
}

/** Carry review state forward only when the same finding and checklist item survive a retry. */
export function carryReviewSelections(
  previous: Report, current: Report, checked: ReadonlySet<string>,
): ReadonlySet<string> {
  const retained = new Set<string>();
  if (!checked.size || !sameItems(previous.documents, current.documents, sameDocument)) {
    return retained;
  }
  const findings = new Map(previous.findings.map(finding => [finding.id, finding]));
  const checklist = new Map(previous.checklist.map(item => [item.finding_id, item]));
  const currentChecklist = new Map(current.checklist.map(item => [item.finding_id, item]));
  for (const finding of current.findings) {
    const id = finding.id;
    if (!checked.has(id)) continue;
    const old = findings.get(id);
    const before = checklist.get(id);
    const after = currentChecklist.get(id);
    if (old && before && after && sameFinding(old, finding) &&
      old.summary_en === finding.summary_en && old.summary_hi === finding.summary_hi &&
      old.authority_verified === finding.authority_verified && old.similarity === finding.similarity &&
      before.description_en === after.description_en && before.description_hi === after.description_hi &&
      before.requires_human_verification === after.requires_human_verification) {
      retained.add(id);
    }
  }
  return retained;
}

/** Restore user selections only. The current comparison supplies all evidence and findings. */
export function restoreReviewSelections(input: unknown, report: Report): ReviewRestore {
  const saved = record(input);
  if (!saved || !Array.isArray(saved.documents) || !Array.isArray(saved.findings) ||
      !Array.isArray(saved.review) || !saved.review.every(id => typeof id === 'string')) {
    return { error: 'invalid' };
  }
  if (!sameItems(saved.documents, report.documents, sameDocument)) {
    return { error: 'differentSources' };
  }

  const ids = new Set<string>(saved.review);
  if (ids.size !== saved.review.length || ids.size > report.checklist.length) {
    return { error: 'changedFindings' };
  }
  const eligible = new Set(report.checklist.map(item => item.finding_id));
  const currentById = new Map(report.findings.filter(item => ids.has(item.id))
    .map(item => [item.id, item]));
  const verified = new Set<string>();
  for (const value of saved.findings) {
    const item = record(value);
    if (!item || typeof item.id !== 'string' || !ids.has(item.id)) continue;
    const current = currentById.get(item.id);
    if (!current || !eligible.has(item.id) || verified.has(item.id) || !sameFinding(item, current)) {
      return { error: 'changedFindings' };
    }
    verified.add(item.id);
  }
  return verified.size === ids.size ? { ids: [...ids] } : { error: 'changedFindings' };
}
