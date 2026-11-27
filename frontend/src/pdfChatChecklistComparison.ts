/** Compare repeated runs of exactly the same independent questions.
 * Differences describe retrieval observations, never legal or policy changes.
 * Both inputs must replay independently against their own native snapshots.
 */
import { verifyChecklistReport, type VerifiedChecklist } from './pdfChatChecklistExchange';
import { parseCorpusSnapshot, type CorpusSnapshot } from './pdfChatCorpusSnapshot';
import type { ChecklistCitation, ChecklistResult, ChecklistSourceResult, ChecklistItem } from './pdfChatChecklist';
import type { Role } from './pdfChatCore';

export const MAX_CHECKLIST_COMPARISON_BYTES = 1024 * 1024;
const ROLES: Role[] = ['original', 'revised'];
const POLICY = 'Retrieval differences only; no match does not prove absence, and source pins do not verify official authority.';
export type ChecklistComparisonInput = { report: string; snapshot: string };
export type Observation = {
  state: ChecklistSourceResult['state'];
  coverage: ChecklistSourceResult['coverage'];
  strict_matches: number;
  displayed_fragments: number;
  omitted_strict_matches: number;
};
type TextDelta = {
  identical_observations: number;
  left_only_observations: number;
  right_only_observations: number;
};
export type RoleComparison = {
  role: Role;
  left: Observation;
  right: Observation;
  pdf_pin_changed: boolean;
  state_changed: boolean;
  coverage_changed: boolean;
  source_coverage_metadata_changed: boolean;
  strict_count_changed: boolean;
  omission_count_changed: boolean;
  strict_text: TextDelta;
  context_text: TextDelta;
  strict_locations: TextDelta;
  context_locations: TextDelta;
  classification: 'unchanged_observation' | 'coverage_or_source_changed' | 'retrieval_observation_changed';
};
export type QuestionComparison = {
  question_id: string;
  scope: ChecklistItem['scope'];
  physical_page: number | null;
  nearby_fallback: boolean;
  left_state: ChecklistResult['state'];
  right_state: ChecklistResult['state'];
  sources: RoleComparison[];
  changed: boolean;
};
type SourceBinding = {
  role: Role;
  left_pdf_sha256: string | null;
  right_pdf_sha256: string | null;
  left_physical_pages: number | null;
  right_physical_pages: number | null;
  left_processed_pages: number | null;
  right_processed_pages: number | null;
  left_limited: boolean | null;
  right_limited: boolean | null;
  left_missing_pages: number[] | null;
  right_missing_pages: number[] | null;
  left_limited_pages: number[] | null;
  right_limited_pages: number[] | null;
  left_indexed_fragments: number | null;
  right_indexed_fragments: number | null;
  changed: boolean;
};
type ComparisonSummary = {
  questions: number;
  unchanged_questions: number;
  changed_questions: number;
  requested_role_pairs: number;
  unchanged_role_observations: number;
  coverage_or_source_changes: number;
  retrieval_observation_changes: number;
  strict_text_left_only: number;
  strict_text_right_only: number;
  context_text_left_only: number;
  context_text_right_only: number;
};
export type ChecklistComparison = {
  format: 'noticebridge-checklist-observation-comparison';
  version: 1;
  policy: string;
  authority_verified: false;
  left: { report_sha256: string; snapshot_sha256: string };
  right: { report_sha256: string; snapshot_sha256: string };
  sources: SourceBinding[];
  questions: QuestionComparison[];
  summary: ComparisonSummary;
};
function invalid(): never { throw new Error('Checklist runs are invalid or incomparable.'); }
async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return invalid();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function bounded(text: string): string {
  if (!text || text.length > MAX_CHECKLIST_COMPARISON_BYTES ||
      new TextEncoder().encode(text).length > MAX_CHECKLIST_COMPARISON_BYTES) invalid();
  return text;
}
function sameQuestion(a: ChecklistItem, b: ChecklistItem): boolean {
  return a.id === b.id && a.question === b.question && a.scope === b.scope &&
    a.includeContext === b.includeContext;
}
function pairQuestions(left: VerifiedChecklist, right: VerifiedChecklist): [ChecklistResult, ChecklistResult][] {
  if (left.items.length !== right.items.length) invalid();
  const byId = new Map(right.results.map(row => [row.item.id, row]));
  // Exact wording and route are required. Order may differ because users
  // can rearrange checklist rows without changing the questions.
  return left.results.map(row => {
    const other = byId.get(row.item.id);
    if (!other || !sameQuestion(row.item, other.item) || row.physicalPage !== other.physicalPage) return invalid();
    return [row, other];
  });
}
function observation(source: ChecklistSourceResult): Observation {
  return {
    state: source.state, coverage: source.coverage, strict_matches: source.matchedCount,
    displayed_fragments: source.displayedCount, omitted_strict_matches: source.omittedStrictMatches,
  };
}
function multiset(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}
/** Multiplicity matters: equal text on two distinct physical locations
 * remains two observations. No fuzzy equivalence or normalization here. */
function delta(left: string[], right: string[]): TextDelta {
  const first = multiset(left), second = multiset(right);
  let identical = 0;
  for (const [value, count] of first) identical += Math.min(count, second.get(value) ?? 0);
  return { identical_observations: identical,
    left_only_observations: left.length - identical, right_only_observations: right.length - identical };
}
function citationKeys(source: ChecklistSourceResult, kind: ChecklistCitation['kind'], location: boolean): string[] {
  const citations = source.citations.filter(row => row.kind === kind);
  if (kind === 'strict') return citations.map(row => encode(location
    ? [row.source.page, row.source.ordinal, row.source.text] : [row.source.text]));
  // Keep nearby groups intact; a group is only an observation, not an answer.
  const groups = new Map<number, ChecklistCitation[]>();
  for (const row of citations) {
    if (row.contextGroup === null) return invalid();
    const group = groups.get(row.contextGroup) ?? [];
    group.push(row);
    groups.set(row.contextGroup, group);
  }
  return [...groups.values()].map(group => encode(group.map(row => location
    ? [row.source.page, row.source.ordinal, row.source.text] : [row.source.text])));
}
function differs(change: TextDelta): boolean {
  return change.left_only_observations > 0 || change.right_only_observations > 0;
}
/** For an all-pages query compare extraction metadata independently of
 * the coarse coverage state. A physical-page query uses the page's own
 * availability, limitation and fragment count, not other pages' coverage.
 * A different PDF hash still invalidates source identity for either route.
 */
function coverageMetadata(snapshot: CorpusSnapshot, role: Role, page: number | null): string {
  const corpus = snapshot.corpora[role];
  if (!corpus) return encode(null);
  if (page !== null) {
    return encode({
      present: page <= corpus.pageCount,
      indexed: page <= corpus.processedPages,
      missing: corpus.missingPages.includes(page),
      limited: corpus.limitedPages.includes(page),
      fragments: corpus.passages.filter(row => row.page === page).length,
    });
  }
  return encode({
    physical_pages: corpus.pageCount,
    processed_pages: corpus.processedPages,
    missing_pages: corpus.missingPages,
    limited_pages: corpus.limitedPages,
    limited: corpus.limited,
    fragments: corpus.passages.length,
  });
}
function compareRole(left: ChecklistSourceResult, right: ChecklistSourceResult,
  leftSnapshot: CorpusSnapshot, rightSnapshot: CorpusSnapshot, page: number | null): RoleComparison {
  if (left.role !== right.role) return invalid();
  const role = left.role;
  const pdf_pin_changed = leftSnapshot.pins[role] !== rightSnapshot.pins[role];
  const state_changed = left.state !== right.state;
  const coverage_changed = left.coverage !== right.coverage;
  const source_coverage_metadata_changed = coverageMetadata(leftSnapshot, role, page) !==
    coverageMetadata(rightSnapshot, role, page);
  const strict_count_changed = left.matchedCount !== right.matchedCount;
  const omission_count_changed = left.omittedStrictMatches !== right.omittedStrictMatches;
  const strict_text = delta(citationKeys(left, 'strict', false), citationKeys(right, 'strict', false));
  const context_text = delta(citationKeys(left, 'context', false), citationKeys(right, 'context', false));
  const strict_locations = delta(citationKeys(left, 'strict', true), citationKeys(right, 'strict', true));
  const context_locations = delta(citationKeys(left, 'context', true), citationKeys(right, 'context', true));
  const classification = pdf_pin_changed || coverage_changed || source_coverage_metadata_changed ? 'coverage_or_source_changed'
    : state_changed || strict_count_changed || omission_count_changed || differs(strict_text) ||
      differs(context_text) || differs(strict_locations) || differs(context_locations)
      ? 'retrieval_observation_changed' : 'unchanged_observation';
  return { role, left: observation(left), right: observation(right), pdf_pin_changed, state_changed,
    coverage_changed, source_coverage_metadata_changed, strict_count_changed, omission_count_changed, strict_text, context_text,
    strict_locations, context_locations, classification };
}
function compareQuestion(left: ChecklistResult, right: ChecklistResult,
  leftSnapshot: CorpusSnapshot, rightSnapshot: CorpusSnapshot): QuestionComparison {
  if (left.sources.length !== right.sources.length) return invalid();
  const sources = left.sources.map(source => {
    const other = right.sources.find(row => row.role === source.role);
    if (!other) return invalid();
    return compareRole(source, other, leftSnapshot, rightSnapshot, left.physicalPage);
  });
  return { question_id: left.item.id, scope: left.item.scope, physical_page: left.physicalPage,
    nearby_fallback: left.item.includeContext, left_state: left.state, right_state: right.state,
    sources, changed: left.state !== right.state || sources.some(row => row.classification !== 'unchanged_observation') };
}
function bindings(left: CorpusSnapshot, right: CorpusSnapshot): SourceBinding[] {
  return ROLES.flatMap(role => {
    const a = left.corpora[role], b = right.corpora[role];
    if (!a && !b) return [];
    return [{
      role, left_pdf_sha256: left.pins[role] ?? null, right_pdf_sha256: right.pins[role] ?? null,
      left_physical_pages: a?.pageCount ?? null, right_physical_pages: b?.pageCount ?? null,
      left_processed_pages: a?.processedPages ?? null, right_processed_pages: b?.processedPages ?? null,
      left_limited: a?.limited ?? null, right_limited: b?.limited ?? null,
      left_missing_pages: a ? [...a.missingPages] : null, right_missing_pages: b ? [...b.missingPages] : null,
      left_limited_pages: a ? [...a.limitedPages] : null, right_limited_pages: b ? [...b.limitedPages] : null,
      left_indexed_fragments: a?.passages.length ?? null, right_indexed_fragments: b?.passages.length ?? null,
      changed: left.pins[role] !== right.pins[role] ||
        encode(a ?? null) !== encode(b ?? null),
    }];
  });
}
function summarize(questions: QuestionComparison[]): ComparisonSummary {
  const sources = questions.flatMap(row => row.sources);
  const changed = questions.filter(row => row.changed).length;
  return {
    questions: questions.length, unchanged_questions: questions.length - changed, changed_questions: changed,
    requested_role_pairs: sources.length,
    unchanged_role_observations: sources.filter(row => row.classification === 'unchanged_observation').length,
    coverage_or_source_changes: sources.filter(row => row.classification === 'coverage_or_source_changed').length,
    retrieval_observation_changes: sources.filter(row => row.classification === 'retrieval_observation_changed').length,
    strict_text_left_only: sources.reduce((sum, row) => sum + row.strict_text.left_only_observations, 0),
    strict_text_right_only: sources.reduce((sum, row) => sum + row.strict_text.right_only_observations, 0),
    context_text_left_only: sources.reduce((sum, row) => sum + row.context_text.left_only_observations, 0),
    context_text_right_only: sources.reduce((sum, row) => sum + row.context_text.right_only_observations, 0),
  };
}
/** No raw question wording, source excerpts, or personal review notes are
 * written to the comparison artifact. The question IDs are user-selected;
 * the artifact itself should still be treated as private.
 */
export async function compareChecklistRuns(left: ChecklistComparisonInput,
  right: ChecklistComparisonInput): Promise<{ text: string; comparison: ChecklistComparison }> {
  const a = await verifyChecklistReport(left.report, left.snapshot);
  const b = await verifyChecklistReport(right.report, right.snapshot);
  const leftSnapshot = parseCorpusSnapshot(left.snapshot);
  const rightSnapshot = parseCorpusSnapshot(right.snapshot);
  const questions = pairQuestions(a, b).map(([first, second]) =>
    compareQuestion(first, second, leftSnapshot, rightSnapshot));
  const comparison: ChecklistComparison = {
    format: 'noticebridge-checklist-observation-comparison', version: 1, policy: POLICY,
    authority_verified: false,
    left: { report_sha256: await digest(left.report), snapshot_sha256: await digest(left.snapshot) },
    right: { report_sha256: await digest(right.report), snapshot_sha256: await digest(right.snapshot) },
    sources: bindings(leftSnapshot, rightSnapshot),
    questions, summary: summarize(questions),
  };
  return { comparison, text: bounded(encode(comparison)) };
}
export async function replayChecklistComparison(text: string, left: ChecklistComparisonInput,
  right: ChecklistComparisonInput): Promise<ChecklistComparison> {
  bounded(text);
  const result = await compareChecklistRuns(left, right);
  if (text !== result.text) return invalid();
  return result.comparison;
}
