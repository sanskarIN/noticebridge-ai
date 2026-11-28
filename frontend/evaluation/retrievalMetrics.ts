/** Offline, annotation-driven retrieval evaluation. No PDF text in metric output. */
import { type Passage, type Role, type Scope, type SearchIndex } from '../src/pdfChatCore';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { searchAllQuestionMatches } from '../src/pdfChatEvidenceExplorer';

export type Label =
  | { kind: 'answerable'; evidenceSets: string[][] }
  | { kind: 'unanswerable' | 'unindexed' | 'ambiguous' };
export type RetrievalCase = {
  id: string; family: string; slices: string[];
  question: string; scope: Scope; page?: number; label: Label;
};
export type RetrievalMode = 'strict' | 'contextual' | 'all-strict';
export type RetrievalObservation = {
  ids: string[]; actualScope: Scope; actualPage?: number;
};
export type CaseMetrics = {
  id: string; family: string; slices: string[]; kind: Label['kind'];
  retrieved: number; relevant: number; required: number; requiredFound: number;
  complete: boolean; abstained: boolean; reciprocalRank: number | null;
  duplicateIds: number; unknownIds: number; roleLeaks: number; pageLeaks: number;
  routingMismatch: boolean;
};

const ID = /^(original|revised):([1-9][0-9]?):([1-9][0-9]{0,5})$/;
const SAFE_LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CASES = 5000;
const MAX_SETS = 8;
const MAX_REQUIRED = 24;
const MAX_SLICES = 8;
export function identity(source: Passage): string {
  return source.role + ':' + source.page + ':' + source.ordinal;
}
function invalid(): never { throw new Error('Invalid retrieval evaluation data.'); }
function roles(scope: Scope): Role[] {
  if (scope === 'both') return ['original', 'revised'];
  if (scope === 'original' || scope === 'revised') return [scope];
  return invalid();
}
function parseId(id: string): { role: Role; page: number } | null {
  const match = ID.exec(id);
  return match && Number(match[2]) <= 80 ? { role: match[1] as Role, page: Number(match[2]) } : null;
}
function sourceSet(index: SearchIndex): Set<string> {
  const ids = new Set<string>();
  for (const row of index.rows) {
    const id = identity(row.passage);
    if (!parseId(id) || ids.has(id)) invalid();
    ids.add(id);
  }
  return ids;
}

export function validateCases(index: SearchIndex, cases: RetrievalCase[]): void {
  if (!cases.length || cases.length > MAX_CASES) invalid();
  const available = sourceSet(index);
  const caseIds = new Set<string>();
  for (const item of cases) {
    const allowedRoles = roles(item.scope);
    if (!SAFE_LABEL.test(item.id) || !SAFE_LABEL.test(item.family) || caseIds.has(item.id) ||
        !item.question.trim() || item.question.length > 400 ||
        !item.slices.length || item.slices.length > MAX_SLICES ||
        new Set(item.slices).size !== item.slices.length ||
        item.slices.some(slice => !SAFE_LABEL.test(slice)) ||
        (item.page !== undefined && (!Number.isSafeInteger(item.page) || item.page < 1 || item.page > 80))) invalid();
    caseIds.add(item.id);
    if (item.label.kind !== 'answerable') {
      if (!['unanswerable', 'unindexed', 'ambiguous'].includes(item.label.kind)) invalid();
      continue;
    }
    const sets = item.label.evidenceSets;
    if (!sets.length || sets.length > MAX_SETS) invalid();
    const uniqueSets = new Set<string>();
    for (const set of sets) {
      if (!set.length || set.length > MAX_REQUIRED || new Set(set).size !== set.length) invalid();
      const key = [...set].sort().join('|');
      if (uniqueSets.has(key)) invalid();
      uniqueSets.add(key);
      for (const id of set) {
        const source = parseId(id);
        if (!source || !available.has(id) || !allowedRoles.includes(source.role) ||
            (item.page !== undefined && item.page !== source.page)) invalid();
      }
    }
  }
}

/** Each labeled evidence set is a complete acceptable alternative. Recall
 * uses the best-covered alternative, not the union of mutually sufficient
 * alternatives. Precision uses the union of individually acceptable IDs.
 * A complete set must still be checked for material qualifiers by annotators.
 */
export function scoreCase(item: RetrievalCase, observation: RetrievalObservation,
  available: ReadonlySet<string>): CaseMetrics {
  const allowedRoles = roles(item.scope);
  const seen = new Set<string>();
  const eligible = new Set<string>();
  let duplicateIds = 0, unknownIds = 0, roleLeaks = 0, pageLeaks = 0;
  for (const id of observation.ids) {
    if (seen.has(id)) { duplicateIds++; continue; }
    seen.add(id);
    const parsed = parseId(id);
    if (!parsed || !available.has(id)) { unknownIds++; continue; }
    if (!allowedRoles.includes(parsed.role)) roleLeaks++;
    if (item.page !== undefined && parsed.page !== item.page) pageLeaks++;
    if (allowedRoles.includes(parsed.role) && (item.page === undefined || parsed.page === item.page)) {
      eligible.add(id);
    }
  }
  const routingMismatch = observation.actualScope !== item.scope || observation.actualPage !== item.page;
  let relevant = 0, required = 0, requiredFound = 0, complete = false;
  let reciprocalRank: number | null = null;
  if (item.label.kind === 'answerable') {
    const union = new Set(item.label.evidenceSets.flat());
    relevant = [...eligible].filter(id => union.has(id)).length;
    const ranked = observation.ids.findIndex(id => eligible.has(id) && union.has(id));
    reciprocalRank = ranked < 0 ? 0 : 1 / (ranked + 1);
    const alternatives = item.label.evidenceSets.map(ids => ({
      required: ids.length, found: ids.filter(id => eligible.has(id)).length,
    })).sort((a, b) => b.found / b.required - a.found / a.required ||
      b.found - a.found || a.required - b.required);
    required = alternatives[0].required;
    requiredFound = alternatives[0].found;
    complete = required === requiredFound;
  }
  return {
    id: item.id, family: item.family, slices: [...item.slices], kind: item.label.kind,
    retrieved: seen.size, relevant, required, requiredFound, complete,
    abstained: observation.ids.length === 0, reciprocalRank,
    duplicateIds, unknownIds, roleLeaks, pageLeaks, routingMismatch,
  };
}

const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
export function summarize(rows: CaseMetrics[]) {
  const positives = rows.filter(row => row.kind === 'answerable');
  const negatives = rows.filter(row => row.kind === 'unanswerable');
  const inaccessible = rows.filter(row => row.kind === 'unindexed');
  const ambiguous = rows.filter(row => row.kind === 'ambiguous');
  const sum = (items: CaseMetrics[], key: 'retrieved' | 'relevant' | 'required' | 'requiredFound' |
    'duplicateIds' | 'unknownIds' | 'roleLeaks' | 'pageLeaks') =>
    items.reduce((total, row) => total + row[key], 0);
  const relevant = sum(positives, 'relevant');
  const judgedRetrieved = sum(positives, 'retrieved') + sum(negatives, 'retrieved');
  const required = sum(positives, 'required');
  const requiredFound = sum(positives, 'requiredFound');
  const complete = positives.filter(row => row.complete).length;
  const abstained = negatives.filter(row => row.abstained).length;
  return {
    cases: rows.length, families: new Set(rows.map(row => row.family)).size,
    answerable: positives.length, unanswerable: negatives.length,
    inaccessible: inaccessible.length, ambiguous: ambiguous.length,
    relevant, judgedRetrieved, required, requiredFound, complete, abstained,
    citationPrecision: ratio(relevant, judgedRetrieved),
    citationRecall: ratio(requiredFound, required),
    completeEvidenceRate: ratio(complete, positives.length),
    unanswerableAbstentionRate: ratio(abstained, negatives.length),
    inaccessibleAbstentionRate: ratio(inaccessible.filter(row => row.abstained).length, inaccessible.length),
    ambiguousAbstentionRate: ratio(ambiguous.filter(row => row.abstained).length, ambiguous.length),
    meanReciprocalRank: ratio(positives.reduce((n, row) => n + (row.reciprocalRank ?? 0), 0), positives.length),
    duplicateIds: sum(rows, 'duplicateIds'), unknownIds: sum(rows, 'unknownIds'),
    roleLeaks: sum(rows, 'roleLeaks'), pageLeaks: sum(rows, 'pageLeaks'),
    routingMismatches: rows.filter(row => row.routingMismatch).length,
  };
}

export function runRetrievalEvaluation(index: SearchIndex, cases: RetrievalCase[],
  mode: RetrievalMode, attached: Role[]) {
  validateCases(index, cases);
  if (!['strict', 'contextual', 'all-strict'].includes(mode) || !attached.length ||
      new Set(attached).size !== attached.length || attached.some(role => !['original', 'revised'].includes(role))) invalid();
  const available = sourceSet(index);
  const rows = cases.map(item => {
    const answers = answerScopedQuestions(index, item.question, item.scope, attached, mode === 'contextual');
    if (answers.length !== 1) invalid();
    const answer = answers[0];
    const passages = mode === 'all-strict' ? searchAllQuestionMatches(index, answer).hits.map(hit => hit.source)
      : answer.citations;
    return scoreCase(item, { ids: passages.map(identity), actualScope: answer.scope,
      actualPage: answer.pageFilter }, available);
  });
  const slices = [...new Set(rows.flatMap(row => row.slices))].sort();
  const families = [...new Set(rows.map(row => row.family))].sort();
  // Labels, counts and anonymized case IDs only. Never output source or question text.
  return {
    mode, totals: summarize(rows),
    slices: slices.map(slice => ({ slice, ...summarize(rows.filter(row => row.slices.includes(slice))) })),
    families: families.map(family => ({ family, ...summarize(rows.filter(row => row.family === family)) })),
    cases: rows,
  };
}
