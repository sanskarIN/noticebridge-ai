/** Deterministic, scope-bound field answers; never a claim of verified authority. */
import { knownQuestionField, queryTerms, sameTextFlow, type Answer, type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { parsePageFilter, stripScopePhrases } from './pdfChatInsights';
import { fieldDefinitions, type FieldDefinition, type ExtractedField } from './pdfChatOverview';

export const MAX_DIRECT_VALUES = 4;
export const MAX_DIRECT_REFERENCES = 3;
export const MAX_DIRECT_REVIEW_PASSAGES = 6;

export type DirectReviewPassage = {
  source: Passage;
  reason: 'query_match' | 'nearby_line';
};

export type DirectValue = { value: string; sources: ExtractedField[]; occurrences: number };
export type DirectSide = {
  role: Role;
  values: DirectValue[];
  distinctValues: number;
  otherMatchingPassages: number;
  nearbyPassages: number;
  reviewPassages: DirectReviewPassage[];
};
export type DirectAnswer = {
  field: FieldDefinition;
  sides: DirectSide[];
  comparison: 'single_source' | 'same_text' | 'different_text' | 'multiple_values' | 'missing_value';
};

/** Only a bare, unambiguous recognized field question can activate this
 * answer path. Do not drop applicant-category, negation, time or other
 * qualifiers just to make a convenient field answer.
 */
export function directFieldAnswer(index: SearchIndex, answer: Answer): DirectAnswer | null {
  const { content, page } = parsePageFilter(stripScopePhrases(answer.question));
  if (page !== answer.pageFilter) return null;
  const words = queryTerms(content);
  const id = knownQuestionField(words);
  const definition = fieldDefinitions.find(field => field.id === id);
  if (!definition) return null;
  const roles: Role[] = answer.scope === 'both' ? ['original', 'revised'] : [answer.scope];
  const sides: DirectSide[] = roles.map(role => {
    const rows = index.rows.filter(row => row.passage.role === role &&
      (page === undefined || row.passage.page === page));
    // Work on a stable source-order copy, deduplicating physical identities.
    const bySource = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const key = directSourceKey(row.passage);
      if (!bySource.has(key)) bySource.set(key, row);
    }
    const ordered = [...bySource.values()].sort((a, b) =>
      a.passage.page - b.passage.page || a.passage.ordinal - b.passage.ordinal);
    const values = new Map<string, DirectValue>();
    const queryMatches = new Map<string, DirectReviewPassage>();
    const nearby = new Map<string, DirectReviewPassage>();
    const cited = new Set(answer.citations.map(directSourceKey));
    // Inspect every recognized printed field, not just the four highest
    // ranked fragments. A fifth conflicting value must remain visible as
    // ambiguity even if its source is not among the displayed references.
    for (const row of ordered) {
      const source = row.passage;
      const key = directSourceKey(source);
      const field = row.field;
      if (!field || field.definition.id !== id) {
        // Scan beyond the retrieval display cap. A qualifying passage may
        // rank below several exact field labels; it must not disappear.
        if (words.every(word => row.counts.has(word)) || cited.has(key)) {
          queryMatches.set(key, { source, reason: 'query_match' });
        }
        continue;
      }
      // Nearby text is inspection context, never a verified qualification.
      // Require geometry on BOTH lines; ordinal adjacency alone can span
      // unrelated columns. Never cross page, role or an extraction gap.
      if (source.position) {
        for (const delta of [-1, 1]) {
          const neighbor = bySource.get(role + ':' + source.page + ':' + (source.ordinal + delta));
          if (!neighbor || neighbor.field || !neighbor.passage.position) continue;
          const candidate = neighbor.passage;
          const inFlow = delta < 0 ? sameTextFlow(candidate, source) : sameTextFlow(source, candidate);
          if (inFlow) nearby.set(directSourceKey(candidate), { source: candidate, reason: 'nearby_line' });
        }
      }
      const existing = values.get(field.value);
      if (existing) {
        existing.occurrences++;
        if (existing.sources.length < MAX_DIRECT_REFERENCES) existing.sources.push(field);
      } else {
        values.set(field.value, { value: field.value, occurrences: 1, sources: [field] });
      }
    }
    // Give actual query matches precedence and don't count a source twice.
    for (const key of queryMatches.keys()) nearby.delete(key);
    const sourceOrder = (a: DirectReviewPassage, b: DirectReviewPassage) =>
      a.source.page - b.source.page || a.source.ordinal - b.source.ordinal;
    const reviewPassages = [
      ...[...queryMatches.values()].sort(sourceOrder),
      ...[...nearby.values()].sort(sourceOrder),
    ].slice(0, MAX_DIRECT_REVIEW_PASSAGES);
    return {
      role, values: [...values.values()].slice(0, MAX_DIRECT_VALUES),
      distinctValues: values.size, otherMatchingPassages: queryMatches.size,
      nearbyPassages: nearby.size, reviewPassages,
    };
  });
  if (sides.every(side => side.distinctValues === 0)) return null;
  const comparison = sides.some(side => side.distinctValues > 1) ? 'multiple_values'
    : sides.some(side => side.distinctValues === 0) ? 'missing_value'
    : sides.length === 1 ? 'single_source'
    : sides[0].values[0].value === sides[1].values[0].value ? 'same_text' : 'different_text';
  return { field: definition, sides, comparison };
}

/** Source identity is always based on the in-memory index, not an
 * externally supplied model claim. Labels and values are not paraphrased.
 */
export function directSourceKey(passage: Passage): string {
  return passage.role + ':' + passage.page + ':' + passage.ordinal;
}
