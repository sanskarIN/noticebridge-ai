/** Native evidence navigation. Search hits are not verified answers. */
import { MAX_PASSAGES, MAX_QUESTION, knownQuestionField, queryTerms, rankedMatches,
  type Answer, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';
import { parseSearchQuestion } from './pdfChatInsights';

export const EXPLORER_PAGE_SIZE = 12;
export const MAX_LITERAL_CHARS = 160;
export const MAX_HIGHLIGHTS = 24;
export const MAX_REFERENCES = 4;

export type ReferenceKind = 'clause' | 'section' | 'paragraph' | 'rule' | 'article' | 'annexure' | 'schedule';
export type Reference = { kind: ReferenceKind; identifier: string };
export type TextRange = { start: number; end: number };
export type ExplorerHit = {
  source: Passage;
  ranges: TextRange[];
  startsWithReference?: boolean;
};
export type ExplorerResult = {
  hits: ExplorerHit[];
  countByRole: Record<Role, number>;
};
export type SearchOptions = { scope: Scope; page?: number };

const KINDS = 'clause|section|paragraph|rule|article|annexure|schedule';
const REFERENCE_PATTERN = /\b(clause|section|paragraph|rule|article|annexure|schedule)[ \t]+([0-9]{1,4}(?:\.[0-9]{1,4}){0,5}[A-Za-z]?(?:\([A-Za-z0-9]{1,5}\)){0,4}|[A-Za-z]{1,4}(?:-[0-9]{1,4})?)(?![\p{L}\p{N}_(-]|\.[\p{L}\p{N}_.(-])/giu;
const ID_PATTERN = /^(?:[0-9]{1,4}(?:\.[0-9]{1,4}){0,5}[A-Za-z]?(?:\([A-Za-z0-9]{1,5}\)){0,4}|[A-Za-z]{1,4}(?:-[0-9]{1,4})?)$/;
const numericKind = new Set<ReferenceKind>(['clause', 'section', 'paragraph', 'rule', 'article']);

function validateOptions(options: SearchOptions): void {
  if (!['original', 'revised', 'both'].includes(options.scope) ||
      (options.page !== undefined && (!Number.isSafeInteger(options.page) ||
      options.page < 1 || options.page > 80))) throw new Error('Invalid evidence search scope.');
}
function inScope(source: Passage, options: SearchOptions): boolean {
  return (options.scope === 'both' || source.role === options.scope) &&
    (options.page === undefined || source.page === options.page);
}
function sourceOrder(a: Passage, b: Passage): number {
  return (a.role === b.role ? 0 : a.role === 'original' ? -1 : 1) ||
    a.page - b.page || a.ordinal - b.ordinal;
}
function result(hits: ExplorerHit[]): ExplorerResult {
  const countByRole = { original: 0, revised: 0 };
  for (const hit of hits) countByRole[hit.source.role]++;
  return { hits, countByRole };
}
function scopedRows(index: SearchIndex, options: SearchOptions): Passage[] {
  validateOptions(options);
  if (index.rows.length > MAX_PASSAGES) throw new Error('Evidence search budget exceeded.');
  const seen = new Set<string>();
  return index.rows.map(row => row.passage).filter(source => {
    const key = source.role + ':' + source.page + ':' + source.ordinal;
    if (!inScope(source, options) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort(sourceOrder);
}

/** ASCII case folding preserves UTF-16 offsets. All other characters
 * and spacing remain exact, with no fuzzy or locale normalization. */
function asciiFold(text: string): string {
  return text.replace(/[A-Z]/g, char => char.toLowerCase());
}
export function literalRanges(text: string, phrase: string, ignoreAsciiCase = false): TextRange[] {
  if (!phrase.trim() || phrase.length > MAX_LITERAL_CHARS) throw new Error('Invalid literal phrase.');
  const haystack = ignoreAsciiCase ? asciiFold(text) : text;
  const needle = ignoreAsciiCase ? asciiFold(phrase) : phrase;
  const ranges: TextRange[] = [];
  let from = 0;
  while (ranges.length < MAX_HIGHLIGHTS) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    const end = start + needle.length;
    ranges.push({ start, end });
    from = end;
  }
  return ranges;
}
export function searchLiteral(index: SearchIndex, options: SearchOptions,
  phrase: string, ignoreAsciiCase = false): ExplorerResult {
  literalRanges('', phrase, ignoreAsciiCase);
  return result(scopedRows(index, options).flatMap(source => {
    const ranges = literalRanges(source.text, phrase, ignoreAsciiCase);
    return ranges.length ? [{ source, ranges }] : [];
  }));
}
function validReference(ref: Reference): boolean {
  return new RegExp('^(?:' + KINDS + ')$').test(ref.kind) &&
    ID_PATTERN.test(ref.identifier) &&
    (!numericKind.has(ref.kind) || /^[0-9]/.test(ref.identifier));
}
export function referencesIn(text: string): { reference: Reference; range: TextRange }[] {
  const found: { reference: Reference; range: TextRange }[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const reference = { kind: match[1].toLowerCase() as ReferenceKind,
      identifier: asciiFold(match[2]) };
    if (!validReference(reference)) continue;
    const start = match.index ?? 0;
    found.push({ reference, range: { start, end: start + match[0].length } });
  }
  return found;
}
export function questionReferences(question: string): Reference[] {
  if (question.length > MAX_QUESTION) return [];
  const found = new Map<string, Reference>();
  for (const { reference } of referencesIn(question)) {
    found.set(reference.kind + ':' + reference.identifier, reference);
    if (found.size > MAX_REFERENCES) return [];
  }
  return [...found.values()];
}
export function parseReference(text: string): Reference {
  const trimmed = text.trim();
  if (trimmed.length > MAX_LITERAL_CHARS) throw new Error('Reference too long.');
  const found = referencesIn(trimmed);
  if (found.length !== 1 || found[0].range.start !== 0 ||
      found[0].range.end !== trimmed.length) throw new Error('Enter one reference, such as Clause 4.2(a).');
  return found[0].reference;
}
export function searchReference(index: SearchIndex, options: SearchOptions, ref: Reference): ExplorerResult {
  if (!validReference(ref)) throw new Error('Invalid reference.');
  return result(scopedRows(index, options).flatMap(source => {
    const ranges = referencesIn(source.text).filter(match =>
      match.reference.kind === ref.kind && match.reference.identifier === asciiFold(ref.identifier))
      .map(match => match.range).slice(0, MAX_HIGHLIGHTS);
    return ranges.length ? [{ source, ranges,
      startsWithReference: !source.text.slice(0, ranges[0].start).trim() }] : [];
  }));
}

/** Reproduce all strict ranked matches per source. Contextual windows
 * are deliberately not promoted to strict matches. */
export function searchAllQuestionMatches(index: SearchIndex, answer: Answer): ExplorerResult {
  const { content, page } = parseSearchQuestion(answer.question);
  if (page !== answer.pageFilter) throw new Error('Question scope mismatch.');
  validateOptions({ scope: answer.scope, page });
  const terms = queryTerms(content);
  if (!terms.length || terms.length > 16) return result([]);
  const field = knownQuestionField(terms);
  const selected = page === undefined ? index : {
    ...index, rows: index.rows.filter(row => row.passage.page === page),
  };
  const roles: Role[] = answer.scope === 'both' ? ['original', 'revised'] : [answer.scope];
  return result(roles.flatMap(role => rankedMatches(selected, terms, role, field)
    .map(source => ({ source, ranges: [] }))));
}
export function explorerPage(hits: readonly ExplorerHit[], page: number) {
  const pages = Math.max(1, Math.ceil(hits.length / EXPLORER_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error('Invalid result page.');
  const offset = (page - 1) * EXPLORER_PAGE_SIZE;
  const selected = hits.slice(offset, offset + EXPLORER_PAGE_SIZE);
  return { hits: selected, page, pages, first: selected.length ? offset + 1 : 0,
    last: offset + selected.length };
}
export type TextSegment = { text: string; match: boolean; start: number };
export function highlightedSegments(text: string, ranges: readonly TextRange[]): TextSegment[] {
  if (ranges.length > MAX_HIGHLIGHTS) throw new Error('Too many highlights.');
  const result: TextSegment[] = [];
  let previous = 0;
  for (const { start, end } of ranges) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < previous || end <= start || end > text.length) throw new Error('Invalid highlight.');
    if (start > previous) result.push({ text: text.slice(previous, start), match: false, start: previous });
    result.push({ text: text.slice(start, end), match: true, start });
    previous = end;
  }
  if (previous < text.length) result.push({ text: text.slice(previous), match: false, start: previous });
  return result;
}
