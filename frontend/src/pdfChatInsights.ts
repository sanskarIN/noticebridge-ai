import { answerQuestion, resolveQuestion, MAX_QUESTION, type Answer, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';

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

/** Reuse one explicit question only. A multi-part turn has no unique
 * referent; the user must specify which question to repeat.
 */
export function resolveChatQuestion(input: string, previous: string | null, reuse: boolean): string {
  if (!reuse) return resolveQuestion(input, previous, false);
  if (!previous || planQuestions(previous).length !== 1) {
    throw new Error('Choose a specific earlier question rather than a multi-part turn.');
  }
  if (planQuestions(input).length !== 1) {
    throw new Error('A follow-up must be one question.');
  }
  const prior = previous.replace(/[?;]+$/g, '').trim();
  // A new explicit version request supersedes a prior version phrase.
  const context = requestedScope(input) ? stripScopePhrases(prior) : prior;
  const page = parsePageFilter(input).page;
  return resolveQuestion(input, page === undefined ? context : parsePageFilter(context).content, true);
}

export type ChatScope = Scope | 'auto';

/** Recognize only explicit version phrases, never bare words such as
 * "new", "old" or "current" that might refer to the notice's subject.
 */
export function requestedScope(question: string): Scope | null {
  const old = /\b(?:original|previous|earlier|first)\s+(?:pdf|notice|document|version)\b/i.test(question);
  const revised = /\b(?:updated|revised|second)\s+(?:pdf|notice|document|version)\b/i.test(question);
  const both = /\bboth\s+(?:pdfs?|notices?|documents?|versions?)\b/i.test(question);
  return both || (old && revised) ? 'both' : old ? 'original' : revised ? 'revised' : null;
}

function stripScopePhrases(question: string): string {
  return question.replace(/\b(?:original|previous|earlier|first|updated|revised|second)\s+(?:pdf|notice|document|version)\b/gi, ' ')
    .replace(/\bboth\s+(?:pdfs?|notices?|documents?|versions?)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function effectiveScope(question: string, selection: ChatScope, attached: Role[]): Scope {
  if (selection !== 'auto') return selection;
  const explicit = requestedScope(question);
  if (explicit) return explicit;
  if (attached.includes('original') && attached.includes('revised')) return 'both';
  return attached.includes('revised') ? 'revised' : 'original';
}

/** Only explicit physical-page phrases are routing directives. Bare page
 * numbers, clause identifiers and values remain lexical query terms.
 * Reject ambiguous filters rather than silently searching another page.
 */
export function parsePageFilter(question: string): { content: string; page?: number } {
  const pattern = /\b(?:on|from|in)\s+(?:physical\s+)?(?:pdf\s+)?page\s+([0-9]+)\b/gi;
  const matches = [...question.matchAll(pattern)];
  if (!matches.length) return { content: question };
  if (matches.length !== 1) throw new Error('Choose one physical PDF page per question.');
  const match = matches[0];
  const page = Number(match[1]);
  const tail = question.slice((match.index ?? 0) + match[0].length);
  if (!Number.isSafeInteger(page) || page < 1 || page > 80 ||
      /^\s*(?:[-–—/,.]\s*\d|(?:to|through|and|or)\s+(?:page\s+)?\d)/i.test(tail)) {
    throw new Error('Choose a single physical PDF page from 1 to 80.');
  }
  const content = question.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
  return { content, page };
}

export function answerScopedQuestions(
  index: SearchIndex, question: string, selection: ChatScope, attached: Role[], includeContext = false,
): Answer[] {
  return planQuestions(question).map(part => {
    const scope = effectiveScope(part, selection, attached);
    // The existing ranker already abstains for an unavailable role. Do
    // not replace a requested but absent source with the other document.
    const { content, page } = parsePageFilter(stripScopePhrases(part));
    // Keep original corpus term statistics; restrict candidates, not ranking
    // normalization. Physical page references are not printed page labels.
    const selected = page === undefined ? index : {
      ...index, rows: index.rows.filter(row => row.passage.page === page),
    };
    const answer = answerQuestion(selected, content || '?', scope, includeContext);
    return { ...answer, question: part, ...(page === undefined ? {} : { pageFilter: page }) };
  });
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
