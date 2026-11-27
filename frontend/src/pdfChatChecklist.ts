/** Bounded, reusable question checklists. Every row is an independent
 * retrieval query; no chat context, automatic inference or model calls.
 * The result distinguishes matching fragments, context leads, missing
 * sources and extraction coverage from human-authored review decisions.
 */
import { MAX_QUESTION, pageCoverage, queryTerms, type Answer, type Corpus,
  type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';
import { answerScopedQuestions, parseSearchQuestion, planQuestions, requestedScope } from './pdfChatInsights';
import { fieldDefinitions, type FieldId } from './pdfChatOverview';
import { passageId } from './pdfChatResearch';
import type { ChatCorpora } from './pdfChatEvidenceReport';

export const MAX_CHECKLIST_ITEMS = 40;
export const MAX_CHECKLIST_NOTE = 400;
export const CHECKLIST_PAGE_SIZE = 6;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROLES: Role[] = ['original', 'revised'];
const SCOPES: Scope[] = ['original', 'revised', 'both'];

export type ChecklistItem = {
  id: string;
  question: string;
  scope: Scope;
  includeContext: boolean;
};
export type ChecklistPlan = ChecklistItem[];
export type ChecklistReviewStatus = 'unreviewed' | 'reviewed_manually' | 'needs_followup';
export const checklistReviewStatuses: readonly ChecklistReviewStatus[] = [
  'unreviewed', 'reviewed_manually', 'needs_followup',
];
export type ChecklistReview = { id: string; status: ChecklistReviewStatus; note: string };
export type ChecklistCoverage = 'unattached' | 'not_present' | 'not_indexed' |
  'no_indexed_text' | 'limited' | 'some_text';
export type SourceMatchState = 'source_unattached' | 'page_not_present' |
  'page_not_indexed' | 'no_indexed_text' | 'no_matching_passage' |
  'context_leads' | 'matching_passages';
export type ChecklistResultState = 'matches_all_requested_roles' |
  'some_matches_or_context' | 'no_matching_passages' | 'unavailable';
export const checklistResultStates: readonly ChecklistResultState[] = [
  'matches_all_requested_roles', 'some_matches_or_context', 'no_matching_passages', 'unavailable',
];
export type ChecklistCitation = { source: Passage; kind: 'strict' | 'context'; contextGroup: number | null };
export type ChecklistSourceResult = {
  role: Role;
  coverage: ChecklistCoverage;
  state: SourceMatchState;
  matchedCount: number;
  displayedCount: number;
  omittedStrictMatches: number;
  citations: ChecklistCitation[];
};
export type ChecklistResult = {
  item: ChecklistItem;
  physicalPage: number | null;
  state: ChecklistResultState;
  sources: ChecklistSourceResult[];
};
export type ChecklistCounts = Record<ChecklistResultState, number>;
export type ChecklistReviewCounts = Record<ChecklistReviewStatus, number>;
export type ChecklistFilter = {
  state: ChecklistResultState | 'all';
  review: ChecklistReviewStatus | 'all';
  keyword: string;
};
export type ChecklistPage = {
  rows: ChecklistResult[];
  page: number;
  pages: number;
  total: number;
};
export type ChecklistPreset = {
  id: string;
  title: string;
  description: string;
  fields: readonly FieldId[];
};
export const checklistPresets: readonly ChecklistPreset[] = [
  { id: 'application', title: 'Application and eligibility',
    description: 'Opening, closing, fees, eligibility, required documents and submission details.',
    fields: ['application_start', 'application_deadline', 'application_fee', 'eligibility',
      'minimum_age', 'maximum_age', 'documents', 'application_method', 'application_portal'] },
  { id: 'registration', title: 'Registration and payments',
    description: 'Registration window, fee, payment details and correction window.',
    fields: ['registration_start', 'registration_deadline', 'registration_fee', 'payment_deadline',
      'payment_method', 'correction_start', 'correction_deadline'] },
  { id: 'examination', title: 'Examination logistics',
    description: 'Admit card, date, time, venue, reporting and result publication.',
    fields: ['admit_card_date', 'exam_date', 'exam_time', 'exam_venue',
      'reporting_time', 'reporting_venue', 'result_date'] },
  { id: 'selection', title: 'Interview and document verification',
    description: 'Selection process, interview, document verification and helpdesk fields.',
    fields: ['selection_process', 'interview_date', 'interview_time', 'interview_venue',
      'verification_date', 'verification_time', 'verification_venue', 'documents',
      'contact_email', 'contact_phone'] },
  { id: 'quick', title: 'Essential notice review',
    description: 'A compact starting list for the most common consequential fields.',
    fields: ['application_deadline', 'application_fee', 'eligibility', 'documents',
      'exam_date', 'contact_email'] },
];

function invalid(): never { throw new Error('Invalid or oversized question checklist.'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  return row;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid();
  return value;
}
function unicodeText(value: unknown, max: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || value.length > max || value.trim() !== value ||
      (!allowEmpty && !value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
      new TextDecoder().decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
function scopeOf(value: unknown): Scope {
  if (typeof value !== 'string' || !SCOPES.includes(value as Scope)) invalid();
  return value as Scope;
}
export function checklistItem(value: unknown): ChecklistItem {
  const raw = exact(value, ['id', 'question', 'scope', 'includeContext']);
  const question = unicodeText(raw.question, MAX_QUESTION, false);
  const scope = scopeOf(raw.scope);
  if (typeof raw.includeContext !== 'boolean' || planQuestions(question).length !== 1 ||
      /[\r\n]/.test(question)) invalid();
  // A frozen checklist has explicit routing, unlike conversational auto
  // scope. Reject conflicting wording instead of hiding the conflict.
  const wording = requestedScope(question);
  if (wording && wording !== scope) invalid();
  const parsed = parseSearchQuestion(question);
  if (!queryTerms(parsed.content).length) invalid();
  return { id: identifier(raw.id), question, scope, includeContext: raw.includeContext };
}
export function validateChecklist(value: unknown, allowEmpty = false): ChecklistPlan {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > MAX_CHECKLIST_ITEMS) invalid();
  const items = value.map(checklistItem);
  const ids = new Set<string>(), duplicateQueries = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) invalid();
    ids.add(item.id);
    // Preserve distinct scopes, context policies and physical page routes.
    // Exact duplicate human questions are an accidental redundant query.
    const key = JSON.stringify([item.scope, item.includeContext, item.question.normalize('NFKC')
      .toLowerCase().replace(/\s+/g, ' ').replace(/\?$/, '').trim()]);
    if (duplicateQueries.has(key)) invalid();
    duplicateQueries.add(key);
  }
  return items;
}
export function appendChecklist(items: ChecklistPlan, item: ChecklistItem): ChecklistPlan {
  return validateChecklist([...items, item]);
}
export function replaceChecklistItem(items: ChecklistPlan, id: string, item: ChecklistItem): ChecklistPlan {
  if (id !== item.id || !items.some(row => row.id === id)) invalid();
  return validateChecklist(items.map(row => row.id === id ? item : row));
}
export function removeChecklistItem(items: ChecklistPlan, id: string): ChecklistPlan {
  if (!items.some(row => row.id === id)) invalid();
  return validateChecklist(items.filter(row => row.id !== id), true);
}
export function moveChecklistItem(items: ChecklistPlan, id: string, direction: -1 | 1): ChecklistPlan {
  const valid = validateChecklist(items);
  if (direction !== -1 && direction !== 1) invalid();
  const at = valid.findIndex(row => row.id === id);
  if (at < 0 || at + direction < 0 || at + direction >= valid.length) invalid();
  const next = [...valid];
  [next[at], next[at + direction]] = [next[at + direction], next[at]];
  return next;
}
export function nextChecklistId(items: ChecklistPlan): string {
  const existing = new Set(items.map(item => item.id));
  for (let i = 1; i <= MAX_CHECKLIST_ITEMS + 1; i++) {
    if (!existing.has('question-' + i)) return 'question-' + i;
  }
  return invalid();
}
export function addChecklistPreset(items: ChecklistPlan, presetId: string, scope: Scope,
  includeContext: boolean): { items: ChecklistPlan; added: number; skipped: number } {
  const preset = checklistPresets.find(row => row.id === presetId);
  if (!preset || typeof includeContext !== 'boolean') invalid();
  const normalizedScope = scopeOf(scope);
  let next = validateChecklist(items, true), added = 0, skipped = 0;
  for (const fieldId of preset.fields) {
    const field = fieldDefinitions.find(row => row.id === fieldId);
    if (!field) invalid();
    const question = field.query + '?';
    const already = next.some(row => row.scope === normalizedScope && row.includeContext === includeContext &&
      row.question.normalize('NFKC').toLowerCase().replace(/\?$/, '').trim() === field.query.toLowerCase());
    if (already) { skipped++; continue; }
    // Do not partially install an over-budget preset. All changes are local
    // until the complete result has passed validation.
    next = appendChecklist(next, { id: nextChecklistId(next), question,
      scope: normalizedScope, includeContext });
    added++;
  }
  return { items: next, added, skipped };
}
function rolesFor(scope: Scope): Role[] { return scope === 'both' ? [...ROLES] : [scope]; }
function coverageOf(corpus: Corpus | undefined, page: number | null): ChecklistCoverage {
  if (!corpus) return 'unattached';
  if (page !== null) return pageCoverage(corpus, page);
  if (!corpus.passages.length) return corpus.limited ? 'limited' : 'no_indexed_text';
  if (corpus.limited || corpus.missingPages.length || corpus.limitedPages.length ||
      corpus.processedPages !== corpus.pageCount) return 'limited';
  return 'some_text';
}
function citationGroups(answer: Answer): Map<number, number> {
  const result = new Map<number, number>();
  answer.contextGroups.forEach((group, i) => {
    if (group.citations.length < 2 || group.citations.length > 3) invalid();
    for (const number of group.citations) {
      const source = answer.citations[number - 1];
      if (!source || source.role !== group.role || source.page !== group.page || result.has(number)) invalid();
      result.set(number, i + 1);
    }
  });
  return result;
}
function sourceResult(role: Role, corpus: Corpus | undefined, page: number | null,
  answer: Answer, groups: Map<number, number>): ChecklistSourceResult {
  const coverage = coverageOf(corpus, page);
  const citations = answer.citations.flatMap((source, i): ChecklistCitation[] => {
    if (source.role !== role) return [];
    if (!corpus || (page !== null && source.page !== page)) invalid();
    const group = groups.get(i + 1);
    return [{ source, kind: group === undefined ? 'strict' : 'context', contextGroup: group ?? null }];
  });
  const matchedCount = answer.matchedCounts[role];
  const strict = citations.filter(row => row.kind === 'strict').length;
  if (!Number.isSafeInteger(matchedCount) || matchedCount < strict || strict > 4 ||
      (strict > 0 && citations.length !== strict) ||
      (matchedCount > 0 && strict !== Math.min(matchedCount, 4))) invalid();
  let state: SourceMatchState;
  if (coverage === 'unattached') state = 'source_unattached';
  else if (coverage === 'not_present') state = 'page_not_present';
  else if (coverage === 'not_indexed') state = 'page_not_indexed';
  else if (coverage === 'no_indexed_text' || !corpus?.passages.length ||
      (page !== null && !corpus.passages.some(row => row.page === page))) state = 'no_indexed_text';
  else if (strict > 0) state = 'matching_passages';
  else if (citations.length > 0) state = 'context_leads';
  else state = 'no_matching_passage';
  if ((state !== 'matching_passages' && state !== 'context_leads') && citations.length) invalid();
  return { role, coverage, state, matchedCount, displayedCount: citations.length,
    omittedStrictMatches: matchedCount - strict, citations };
}
function resultState(sources: ChecklistSourceResult[]): ChecklistResultState {
  if (sources.every(row => row.state === 'matching_passages')) return 'matches_all_requested_roles';
  if (sources.some(row => row.state === 'matching_passages' || row.state === 'context_leads')) return 'some_matches_or_context';
  if (sources.some(row => row.state === 'no_matching_passage')) return 'no_matching_passages';
  return 'unavailable';
}
/** Compare the actual indexed fragments with the corpora supplied for
 * coverage. This prevents a caller from searching one index while attaching
 * another corpus's page information. The index is rebuilt for file replay. */
function validateIndex(index: SearchIndex, corpora: ChatCorpora) {
  const expected = new Map<string, Passage>();
  for (const role of ROLES) {
    for (const source of corpora[role]?.passages ?? []) {
      const id = passageId(source);
      if (source.role !== role || expected.has(id)) invalid();
      expected.set(id, source);
    }
  }
  if (!Object.keys(corpora).length || Object.keys(corpora).some(role => !ROLES.includes(role as Role)) ||
      expected.size !== index.rows.length) invalid();
  for (const row of index.rows) {
    const expectedSource = expected.get(passageId(row.passage));
    if (!expectedSource || expectedSource.text !== row.passage.text ||
        JSON.stringify(expectedSource.position ?? null) !== JSON.stringify(row.passage.position ?? null)) invalid();
    expected.delete(passageId(row.passage));
  }
  if (expected.size) invalid();
}
export function runChecklist(index: SearchIndex, corpora: ChatCorpora, items: ChecklistPlan): ChecklistResult[] {
  const plan = validateChecklist(items);
  validateIndex(index, corpora);
  const attached = ROLES.filter(role => Boolean(corpora[role]));
  if (!attached.length) invalid();
  return plan.map(item => {
    const answers = answerScopedQuestions(index, item.question, item.scope, attached, item.includeContext);
    if (answers.length !== 1) invalid();
    const answer = answers[0], page = answer.pageFilter ?? null;
    if (answer.scope !== item.scope || (parseSearchQuestion(item.question).page ?? null) !== page) invalid();
    const groups = citationGroups(answer);
    const roles = rolesFor(item.scope);
    if (answer.citations.some(source => !roles.includes(source.role))) invalid();
    const sources = roles.map(role => sourceResult(role, corpora[role], page, answer, groups));
    return { item, physicalPage: page, state: resultState(sources), sources };
  });
}
export function checklistCounts(results: ChecklistResult[]): ChecklistCounts {
  const counts: ChecklistCounts = { matches_all_requested_roles: 0, some_matches_or_context: 0,
    no_matching_passages: 0, unavailable: 0 };
  for (const row of results) counts[row.state]++;
  return counts;
}
export function blankChecklistReviews(items: ChecklistPlan): ChecklistReview[] {
  return validateChecklist(items, true).map(row => ({ id: row.id, status: 'unreviewed', note: '' }));
}
export function validateChecklistReviews(value: unknown, items: ChecklistPlan): ChecklistReview[] {
  const plan = validateChecklist(items, true);
  if (!Array.isArray(value) || value.length !== plan.length) invalid();
  const byId = new Map<string, ChecklistReview>();
  for (const valueRow of value) {
    const raw = exact(valueRow, ['id', 'status', 'note']);
    const id = identifier(raw.id), status = raw.status as ChecklistReviewStatus;
    if (byId.has(id) || !checklistReviewStatuses.includes(status)) invalid();
    byId.set(id, { id, status, note: unicodeText(raw.note, MAX_CHECKLIST_NOTE, true) });
  }
  return plan.map(row => {
    const review = byId.get(row.id);
    if (!review) invalid();
    return review;
  });
}
export function updateChecklistReview(items: ChecklistPlan, reviews: ChecklistReview[],
  id: string, patch: Partial<Pick<ChecklistReview, 'status' | 'note'>>): ChecklistReview[] {
  const valid = validateChecklistReviews(reviews, items);
  if (!valid.some(row => row.id === id) || Object.keys(patch).some(key => key !== 'status' && key !== 'note')) invalid();
  return validateChecklistReviews(valid.map(row => row.id === id ? { ...row, ...patch } : row), items);
}
export function checklistReviewCounts(reviews: ChecklistReview[]): ChecklistReviewCounts {
  const counts: ChecklistReviewCounts = { unreviewed: 0, reviewed_manually: 0, needs_followup: 0 };
  for (const row of reviews) counts[row.status]++;
  return counts;
}
/** Preserve a personal review only if that exact question and its routing
 * settings are unchanged. Removed or edited queries cannot inherit an old
 * review decision. Reordering rows is harmless. Source replacement is
 * handled by remounting the source-bound workspace. */
export function carryChecklistReviews(before: ChecklistPlan, reviews: ChecklistReview[],
  after: ChecklistPlan): ChecklistReview[] {
  const previous = validateChecklist(before, true), next = validateChecklist(after, true);
  const validated = validateChecklistReviews(reviews, previous);
  const oldItems = new Map(previous.map(item => [item.id, item]));
  const oldReviews = new Map(validated.map(review => [review.id, review]));
  return next.map(item => {
    const old = oldItems.get(item.id);
    return old && JSON.stringify(old) === JSON.stringify(item) ? oldReviews.get(item.id)!
      : { id: item.id, status: 'unreviewed', note: '' };
  });
}
export function filterChecklist(results: ChecklistResult[], reviews: ChecklistReview[],
  filter: ChecklistFilter): ChecklistResult[] {
  const byId = new Map(reviews.map(row => [row.id, row]));
  const keyword = filter.keyword.normalize('NFKC').toLowerCase().trim();
  if (keyword.length > MAX_QUESTION) invalid();
  return results.filter(row => {
    if (filter.state !== 'all' && row.state !== filter.state) return false;
    if (filter.review !== 'all' && byId.get(row.item.id)?.status !== filter.review) return false;
    if (keyword && !row.item.question.normalize('NFKC').toLowerCase().includes(keyword)) return false;
    return true;
  });
}
export function checklistPage(rows: ChecklistResult[], requested: number): ChecklistPage {
  if (!Number.isSafeInteger(requested) || requested < 1) invalid();
  const pages = Math.max(1, Math.ceil(rows.length / CHECKLIST_PAGE_SIZE));
  const page = Math.min(requested, pages);
  return { rows: rows.slice((page - 1) * CHECKLIST_PAGE_SIZE, page * CHECKLIST_PAGE_SIZE),
    page, pages, total: rows.length };
}
