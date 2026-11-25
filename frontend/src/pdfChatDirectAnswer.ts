/** Deterministic, scope-bound field answers; never a claim of verified authority. */
import { knownQuestionField, queryTerms, type Answer, type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { parsePageFilter, stripScopePhrases } from './pdfChatInsights';
import { fieldDefinitions, type FieldDefinition, type ExtractedField } from './pdfChatOverview';

export const MAX_DIRECT_VALUES = 4;
export const MAX_DIRECT_REFERENCES = 3;

export type DirectValue = { value: string; sources: ExtractedField[]; occurrences: number };
export type DirectSide = {
  role: Role;
  values: DirectValue[];
  distinctValues: number;
  otherMatchingPassages: number;
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
  const id = knownQuestionField(queryTerms(content));
  const definition = fieldDefinitions.find(field => field.id === id);
  if (!definition) return null;
  const roles: Role[] = answer.scope === 'both' ? ['original', 'revised'] : [answer.scope];
  const sides: DirectSide[] = roles.map(role => {
    const rows = index.rows.filter(row => row.passage.role === role &&
      (page === undefined || row.passage.page === page));
    const seen = new Set<string>();
    const values = new Map<string, DirectValue>();
    let otherMatchingPassages = 0;
    // Inspect every recognized printed field, not just the four highest
    // ranked fragments. A fifth conflicting value must remain visible as
    // ambiguity even if its source is not among the displayed references.
    for (const row of rows) {
      const source = row.passage;
      if (seen.has(source.page + ':' + source.ordinal)) continue;
      seen.add(source.page + ':' + source.ordinal);
      const field = row.field;
      if (!field || field.definition.id !== id) {
        if (answer.citations.some(p => p.role === role && p.page === source.page &&
            p.ordinal === source.ordinal)) otherMatchingPassages++;
        continue;
      }
      const existing = values.get(field.value);
      if (existing) {
        existing.occurrences++;
        if (existing.sources.length < MAX_DIRECT_REFERENCES) existing.sources.push(field);
      } else {
        values.set(field.value, { value: field.value, occurrences: 1, sources: [field] });
      }
    }
    return {
      role, values: [...values.values()].slice(0, MAX_DIRECT_VALUES),
      distinctValues: values.size, otherMatchingPassages,
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
