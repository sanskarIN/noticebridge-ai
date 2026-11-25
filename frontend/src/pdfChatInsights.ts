import { answerQuestion, MAX_QUESTION, type Answer, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';

export const MAX_SUBQUESTIONS = 4;

/** Split explicit boundaries or a tightly bounded list of notice fields.
 * Never split arbitrary "and/or" conditions or alternatives.
 */
export function planQuestions(question: string): string[] {
  const clean = question.trim();
  if (!clean || clean.length > MAX_QUESTION) throw new Error('Invalid question length.');
  const parts = clean.split(/[?;]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length > MAX_SUBQUESTIONS) throw new Error('Ask at most four questions at once.');
  if (parts.length > 1) return parts;
  const fieldList = /^(?:what (?:is|are) (?:the )?)?(application )?(deadline|fee|eligibility|last date)(?:\s*,\s*(?:and )?|\s+and\s+)(deadline|fee|eligibility|last date)(?:(?:\s*,\s*(?:and )?|\s+and\s+)(deadline|fee|eligibility|last date))?\??$/i;
  const match = fieldList.exec(clean);
  if (!match) return [clean];
  const [, prefix, first, second, third] = match;
  return [first, second, third].filter((field): field is string => Boolean(field)).map(field =>
    prefix && field.toLowerCase() !== 'eligibility' ? prefix + field : field,
  );
}

export function answerQuestionSet(index: SearchIndex, question: string, scope: Scope): Answer[] {
  return planQuestions(question).map(part => answerQuestion(index, part, scope));
}

export type PrintedValueGroup = {
  label: string;
  role: Role;
  values: { value: string; citations: number[] }[];
};

function normalizedLabel(label: string): string {
  return label.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Group only identical normalized labels, not semantically similar fields.
 * Values stay verbatim: different spellings are not necessarily different facts.
 */
export function groupPrintedValues(answer: Answer): PrintedValueGroup[] {
  const groups = new Map<string, PrintedValueGroup>();
  for (const field of answer.printedFields) {
    const source = answer.citations[field.citation - 1];
    if (!source) continue;
    const key = source.role + ':' + normalizedLabel(field.label);
    let group = groups.get(key);
    if (!group) {
      group = { label: field.label, role: source.role, values: [] };
      groups.set(key, group);
    }
    const existing = group.values.find(item => item.value === field.value);
    if (existing) existing.citations.push(field.citation);
    else group.values.push({ value: field.value, citations: [field.citation] });
  }
  return [...groups.values()];
}

export type PrintedComparison = {
  label: string;
  original: PrintedValueGroup;
  revised: PrintedValueGroup;
  outcome: 'same_printed_text' | 'different_printed_text' | 'multiple_printed_values';
};

/** Textual comparison, not confirmation of a real-world amendment. */
export function comparePrintedValues(groups: PrintedValueGroup[]): PrintedComparison[] {
  const revised = new Map(groups.filter(group => group.role === 'revised')
    .map(group => [normalizedLabel(group.label), group]));
  return groups.filter(group => group.role === 'original').flatMap(original => {
    const updated = revised.get(normalizedLabel(original.label));
    if (!updated) return [];
    const outcome = original.values.length !== 1 || updated.values.length !== 1
      ? 'multiple_printed_values'
      : original.values[0].value === updated.values[0].value
        ? 'same_printed_text' : 'different_printed_text';
    return [{ label: original.label, original, revised: updated, outcome }];
  });
}

/** Adjacent indexed fragments from exactly the same source and page.
 * Ordinals are extraction order, not guaranteed visual reading order.
 */
export function nearbyPassages(index: SearchIndex, citation: Passage): Passage[] {
  return index.rows.map(row => row.passage).filter(passage =>
    passage.role === citation.role && passage.page === citation.page &&
    Math.abs(passage.ordinal - citation.ordinal) <= 2,
  ).sort((a, b) => a.ordinal - b.ordinal).slice(0, 5);
}
