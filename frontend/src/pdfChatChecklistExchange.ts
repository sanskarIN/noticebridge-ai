/** Portable, private question templates and replay-verifiable checklists.
 * Templates contain questions and routing only, never PDF fingerprints or
 * human review notes. Evidence reports explicitly contain private excerpts.
 */
import type { Passage, Role, SearchIndex } from './pdfChatCore';
import { parseCorpusSnapshot, serializeCorpusSnapshot, indexCorpusSnapshot } from './pdfChatCorpusSnapshot';
import { blankChecklistReviews, checklistCounts, checklistReviewCounts, runChecklist,
  validateChecklist, validateChecklistReviews, type ChecklistPlan, type ChecklistResult,
  type ChecklistReview } from './pdfChatChecklist';
import { passageId } from './pdfChatResearch';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import type { SourcePins } from './pdfChatSession';

export const MAX_CHECKLIST_TEMPLATE_BYTES = 96 * 1024;
export const MAX_CHECKLIST_REPORT_BYTES = 4 * 1024 * 1024;
const TEMPLATE = 'noticebridge-question-checklist-template';
const REPORT = 'noticebridge-private-question-checklist';
const TEMPLATE_POLICY = 'Questions and explicit search routing only; run against the intended local PDFs.';
const REPORT_POLICY = 'Deterministic native evidence and personal review notes; inspect the actual PDFs and official publication.';
const ROLES: Role[] = ['original', 'revised'];
const SHA = /^[a-f0-9]{64}$/;
export type ChecklistReportSummary = {
  questions: number;
  citations: number;
  contextFragments: number;
  matchedAllRoles: number;
  partialOrContext: number;
  noMatch: number;
  unavailable: number;
  reviewed: number;
  needsFollowup: number;
};
export type VerifiedChecklist = {
  items: ChecklistPlan;
  reviews: ChecklistReview[];
  results: ChecklistResult[];
  summary: ChecklistReportSummary;
};
export class ChecklistExchangeError extends Error {
  constructor(readonly code: 'invalid' | 'size' | 'mismatch' | 'consent') { super(code); }
}
function fail(code: ChecklistExchangeError['code'] = 'invalid'): never {
  throw new ChecklistExchangeError(code);
}
function bound(text: string, maximum: number): string {
  if (!text || text.length > maximum || new TextEncoder().encode(text).length > maximum) fail('size');
  return text;
}
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) fail();
  return raw;
}
function parse(text: string, maximum: number): unknown {
  bound(text, maximum);
  try { return JSON.parse(text); } catch { return fail(); }
}
async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) fail();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
export function serializeChecklistTemplate(items: ChecklistPlan, consent: boolean): string {
  if (consent !== true) fail('consent');
  return bound(encode({ format: TEMPLATE, version: 1, policy: TEMPLATE_POLICY,
    authority_verified: false, questions: validateChecklist(items) }), MAX_CHECKLIST_TEMPLATE_BYTES);
}
export function parseChecklistTemplate(text: string): ChecklistPlan {
  const raw = object(parse(text, MAX_CHECKLIST_TEMPLATE_BYTES), ['format', 'version', 'policy',
    'authority_verified', 'questions']);
  if (raw.format !== TEMPLATE || raw.version !== 1 || raw.policy !== TEMPLATE_POLICY ||
      raw.authority_verified !== false) fail();
  const items = validateChecklist(raw.questions);
  if (serializeChecklistTemplate(items, true) !== text) fail('mismatch');
  return items;
}
function quote(source: Passage) {
  return { id: passageId(source), role: source.role, physical_page: source.page,
    fragment_ordinal: source.ordinal, native_text: source.text };
}
function wireResult(result: ChecklistResult) {
  return { id: result.item.id, physical_page: result.physicalPage, state: result.state,
    sources: result.sources.map(source => ({
      role: source.role, coverage: source.coverage, state: source.state, matched_count: source.matchedCount,
      displayed_count: source.displayedCount, omitted_strict_matches: source.omittedStrictMatches,
      citations: source.citations.map(citation => ({
        ...quote(citation.source), kind: citation.kind, context_group: citation.contextGroup,
      })),
    })) };
}
function sourceCoverage(pins: SourcePins, corpora: ChatCorpora) {
  return ROLES.flatMap(role => {
    const pin = pins[role], corpus = corpora[role];
    if (Boolean(pin) !== Boolean(corpus) || (pin && !SHA.test(pin))) fail();
    return pin && corpus ? [{ role, sha256: pin, physical_pages: corpus.pageCount,
      processed_pages: corpus.processedPages, indexed_fragments: corpus.passages.length,
      missing_pages: [...corpus.missingPages], limited_pages: [...corpus.limitedPages],
      limited: corpus.limited }] : [];
  });
}
function summarize(results: ChecklistResult[], reviews: ChecklistReview[]): ChecklistReportSummary {
  const counts = checklistCounts(results), reviewCounts = checklistReviewCounts(reviews);
  const citations = results.flatMap(row => row.sources.flatMap(source => source.citations));
  return { questions: results.length, citations: citations.length,
    contextFragments: citations.filter(row => row.kind === 'context').length,
    matchedAllRoles: counts.matches_all_requested_roles, partialOrContext: counts.some_matches_or_context,
    noMatch: counts.no_matching_passages, unavailable: counts.unavailable,
    reviewed: reviewCounts.reviewed_manually, needsFollowup: reviewCounts.needs_followup };
}
async function build(snapshotText: string, items: ChecklistPlan, reviews: ChecklistReview[]) {
  const snapshot = parseCorpusSnapshot(snapshotText);
  const plan = validateChecklist(items);
  const validated = validateChecklistReviews(reviews, plan);
  const results = runChecklist(indexCorpusSnapshot(snapshot), snapshot.corpora, plan);
  const summary = summarize(results, validated);
  const text = bound(encode({ format: REPORT, version: 1, policy: REPORT_POLICY,
    authority_verified: false, snapshot_sha256: await digest(snapshotText),
    source_coverage: sourceCoverage(snapshot.pins, snapshot.corpora),
    questions: plan, reviews: validated, summary, results: results.map(wireResult),
  }), MAX_CHECKLIST_REPORT_BYTES);
  return { text, verified: { items: plan, reviews: validated, results, summary } satisfies VerifiedChecklist };
}
/** Exports are freshly reconstructed from a canonical snapshot, and the
 * currently displayed result set must be identical to that reconstruction.
 * No stale in-memory result can silently be replaced during export. */
export async function serializeChecklistReport(index: SearchIndex, pins: SourcePins, corpora: ChatCorpora,
  items: ChecklistPlan, reviews: ChecklistReview[], displayed: ChecklistResult[], consent: boolean): Promise<string> {
  if (consent !== true) fail('consent');
  const observed = runChecklist(index, corpora, items);
  const snapshot = serializeCorpusSnapshot(pins, corpora);
  const built = await build(snapshot, items, reviews);
  const expected = encode(built.verified.results.map(wireResult));
  if (encode(displayed.map(wireResult)) !== expected || encode(observed.map(wireResult)) !== expected) fail('mismatch');
  return built.text;
}
/** Only question parameters and personal review annotations are used as
 * input. Every supplied evidence quotation, result count, coverage field,
 * source hash and identity must equal independent deterministic replay. */
export async function verifyChecklistReport(text: string, snapshotText: string): Promise<VerifiedChecklist> {
  const raw = object(parse(text, MAX_CHECKLIST_REPORT_BYTES), ['format', 'version', 'policy',
    'authority_verified', 'snapshot_sha256', 'source_coverage', 'questions', 'reviews', 'summary', 'results']);
  if (raw.format !== REPORT || raw.version !== 1 || raw.policy !== REPORT_POLICY || raw.authority_verified !== false ||
      typeof raw.snapshot_sha256 !== 'string' || !SHA.test(raw.snapshot_sha256)) fail();
  // Validate the bounded snapshot before hashing it. A report cannot choose
  // the input files, index or source roles.
  parseCorpusSnapshot(snapshotText);
  if (raw.snapshot_sha256 !== await digest(snapshotText)) fail('mismatch');
  const items = validateChecklist(raw.questions);
  const reviews = validateChecklistReviews(raw.reviews, items);
  const built = await build(snapshotText, items, reviews);
  if (built.text !== text) fail('mismatch');
  return built.verified;
}
export async function verifyAttachedChecklistReport(text: string, pins: SourcePins,
  corpora: ChatCorpora, index: SearchIndex): Promise<VerifiedChecklist> {
  const checked = await verifyChecklistReport(text, serializeCorpusSnapshot(pins, corpora));
  const observed = runChecklist(index, corpora, checked.items);
  if (encode(observed.map(wireResult)) !== encode(checked.results.map(wireResult))) fail('mismatch');
  return checked;
}
export async function readChecklistFile(file: File, kind: 'template' | 'report'): Promise<string> {
  const limit = kind === 'template' ? MAX_CHECKLIST_TEMPLATE_BYTES : MAX_CHECKLIST_REPORT_BYTES;
  if (!file.size || file.size > limit) fail('size');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size || buffer.byteLength > limit) fail('size');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { return fail(); }
  return bound(text, limit);
}
export function emptyChecklistFromTemplate(text: string) {
  const items = parseChecklistTemplate(text);
  return { items, reviews: blankChecklistReviews(items) };
}
