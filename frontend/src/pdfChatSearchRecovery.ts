/** Explain bounded lexical search without broadening any authoritative
 * answer. Partial hits and spelling candidates are inspection leads only.
 * A suggestion never removes a search term, changes a numeric token, changes the
 * selected physical page, or submits a rewritten question automatically.
 */
import { MAX_PASSAGES, MAX_QUESTION, knownQuestionField, queryTerms, type Answer,
  type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { parseSearchQuestion, planQuestions, requestedScope } from './pdfChatInsights';

export const MAX_RECOVERY_TERMS = 16;
export const MAX_RECOVERY_VOCABULARY = 30000;
export const MAX_RECOVERY_LEADS = 120;
export const RECOVERY_PAGE_SIZE = 6;
export const MAX_SPELLING_SUGGESTIONS = 3;
const ROLES: Role[] = ['original', 'revised'];
const WORD = /^[a-z]{5,24}$/;
const PROTECTED = new Set(['never', 'unless', 'except', 'without', 'before', 'after',
  'above', 'below', 'under', 'until', 'cannot', 'minimum', 'maximum',
  'original', 'revised', 'updated', 'second', 'first', 'physical',
  'clause', 'section', 'article', 'paragraph', 'annexure', 'schedule']);

export type TermCoverage = {
  term: string;
  fragments: number;
  pages: number;
};
export type RecoveryLead = {
  source: Passage;
  matchedTerms: string[];
  missingTerms: string[];
  rareTermWeight: number;
};
export type SpellingSuggestion = {
  term: string;
  candidate: string;
  fragments: number;
  question: string;
};
export type RoleRecovery = {
  role: Role;
  indexedFragments: number;
  indexedPages: number;
  coverage: TermCoverage[];
  fullLexicalFragments: number;
  recognizedFieldFragments: number;
  partialFragments: number;
  partialHistogram: number[];
  partialPages: number;
  leads: RecoveryLead[];
  leadsTruncated: boolean;
  suggestions: SpellingSuggestion[];
  spellingLimited: boolean;
  state: 'no_indexed_text' | 'no_search_terms' | 'query_budget' | 'full_match_available' |
    'missing_terms' | 'terms_separated' | 'no_term_overlap';
};
export type SearchRecovery = {
  scope: Answer['scope'];
  page?: number;
  terms: string[];
  normalizedField: ReturnType<typeof knownQuestionField>;
  sides: RoleRecovery[];
};
type TermStat = { fragments: number; pages: Set<number> };
function invalid(): never { throw new Error('Invalid or mismatched search diagnostics.'); }
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function sourceOrder(a: Passage, b: Passage) { return a.page - b.page || a.ordinal - b.ordinal; }
function validPage(value: number | undefined) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= 80);
}
/** One insertion, deletion, substitution, or adjacent transposition.
 * Equality is not a spelling candidate. Numeric tokens, short terms
 * and non-ASCII tokens are deliberately excluded at the caller.
 */
export function oneSpellingEdit(a: string, b: string): boolean {
  if (!WORD.test(a) || !WORD.test(b) || a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const mismatches: number[] = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) mismatches.push(i);
      if (mismatches.length > 2) return false;
    }
    if (mismatches.length === 1) return true;
    const [i, j] = mismatches;
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let at = 0;
  while (at < short.length && short[at] === long[at]) at++;
  return short.slice(at) === long.slice(at + 1);
}
/** Replace only a single literal occurrence in the original question.
 * Reparse it and verify that the exact normalized search term set has
 * changed by that one replacement, not by a new intent expansion.
 */
function correctedQuestion(answer: Answer, words: string[], from: string, to: string): string | null {
  if (!WORD.test(from) || !WORD.test(to) || PROTECTED.has(from) || PROTECTED.has(to) || words.includes(to)) return null;
  const matches = [...answer.question.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)]
    .filter(match => match[0].toLowerCase() === from);
  if (matches.length !== 1) return null;
  const match = matches[0], start = match.index!;
  const text = answer.question.slice(0, start) + to + answer.question.slice(start + match[0].length);
  if (text.length > MAX_QUESTION || requestedScope(text) !== requestedScope(answer.question)) return null;
  try {
    if (planQuestions(text).length !== 1) return null;
    const parsed = parseSearchQuestion(text);
    if (parsed.page !== answer.pageFilter) return null;
    const expected = words.map(word => word === from ? to : word).sort(order);
    if (JSON.stringify(queryTerms(parsed.content).sort(order)) !== JSON.stringify(expected)) return null;
  } catch { return null; }
  return text;
}
function spellingSuggestions(answer: Answer, words: string[], coverage: TermCoverage[],
  vocabulary: Map<string, number>, limited: boolean): SpellingSuggestion[] {
  // Do not search an arbitrary retained prefix of the vocabulary: that
  // would make suggestions depend on which fragments arrived first.
  if (limited) return [];
  const result: SpellingSuggestion[] = [];
  for (const { term, fragments } of coverage) {
    if (fragments || !WORD.test(term) || PROTECTED.has(term)) continue;
    const candidates: SpellingSuggestion[] = [];
    for (const [candidate, count] of vocabulary) {
      if (!oneSpellingEdit(term, candidate)) continue;
      const question = correctedQuestion(answer, words, term, candidate);
      if (question) candidates.push({ term, candidate, fragments: count, question });
    }
    candidates.sort((a, b) => b.fragments - a.fragments || order(a.candidate, b.candidate));
    result.push(...candidates.slice(0, MAX_SPELLING_SUGGESTIONS));
  }
  return result;
}
function side(index: SearchIndex, answer: Answer, role: Role, words: string[],
  field: ReturnType<typeof knownQuestionField>): RoleRecovery {
  const rows = index.rows.filter(row => row.passage.role === role &&
    (answer.pageFilter === undefined || row.passage.page === answer.pageFilter));
  const pages = new Set<number>(), seen = new Set<string>();
  const stats = words.map((): TermStat => ({ fragments: 0, pages: new Set<number>() }));
  const vocabulary = new Map<string, number>();
  const histogram = Array.from({ length: Math.min(words.length, MAX_RECOVERY_TERMS) + 1 }, () => 0);
  let spellingLimited = false, fullLexicalFragments = 0, recognizedFieldFragments = 0;
  const partial: { source: Passage; matched: number[] }[] = [];
  const partialPages = new Set<number>();
  const usable = words.length > 0 && words.length <= MAX_RECOVERY_TERMS;
  for (const row of rows) {
    const source = row.passage;
    const key = source.page + ':' + source.ordinal;
    if (seen.has(key)) invalid();
    seen.add(key); pages.add(source.page);
    if (!usable) continue;
    const matched: number[] = [];
    words.forEach((word, i) => {
      if (row.counts.has(word)) {
        matched.push(i);
        stats[i].fragments++;
        stats[i].pages.add(source.page);
      }
    });
    histogram[matched.length]++;
    const recognized = field !== null && row.field?.definition.id === field;
    if (recognized) recognizedFieldFragments++;
    if (matched.length === words.length) fullLexicalFragments++;
    else if (matched.length && !recognized) {
      partial.push({ source, matched });
      partialPages.add(source.page);
    }
    if (!spellingLimited) for (const term of row.counts.keys()) {
      if (!WORD.test(term)) continue;
      if (!vocabulary.has(term) && vocabulary.size >= MAX_RECOVERY_VOCABULARY) {
        spellingLimited = true;
        vocabulary.clear();
        break;
      }
      vocabulary.set(term, (vocabulary.get(term) ?? 0) + 1);
    }
  }
  const coverage = usable ? words.map((term, i) => ({
    term, fragments: stats[i].fragments, pages: stats[i].pages.size,
  })) : [];
  // Count missing/partial terms across all eligible physical identities,
  // then sort by coverage before local rarity. No probability is shown.
  const weights = stats.map(stat => Math.log(1 + (rows.length - stat.fragments + 0.5) / (stat.fragments + 0.5)));
  const ranked: RecoveryLead[] = partial.map(({ source, matched }) => ({
    source,
    matchedTerms: matched.map(i => words[i]),
    missingTerms: words.filter((_, i) => !matched.includes(i)),
    rareTermWeight: matched.reduce((sum, i) => sum + weights[i], 0),
  })).sort((a, b) => b.matchedTerms.length - a.matchedTerms.length ||
    b.rareTermWeight - a.rareTermWeight || sourceOrder(a.source, b.source));
  const state: RoleRecovery['state'] = !rows.length ? 'no_indexed_text' :
    !words.length ? 'no_search_terms' : !usable ? 'query_budget' :
    fullLexicalFragments || recognizedFieldFragments ? 'full_match_available' :
    coverage.every(term => !term.fragments) ? 'no_term_overlap' :
    coverage.some(term => !term.fragments) ? 'missing_terms' : 'terms_separated';
  return {
    role, indexedFragments: rows.length, indexedPages: pages.size,
    coverage, fullLexicalFragments, recognizedFieldFragments,
    partialFragments: ranked.length, partialHistogram: histogram,
    partialPages: partialPages.size,
    leads: ranked.slice(0, MAX_RECOVERY_LEADS),
    leadsTruncated: ranked.length > MAX_RECOVERY_LEADS,
    suggestions: usable && state !== 'full_match_available'
      ? spellingSuggestions(answer, words, coverage, vocabulary, spellingLimited) : [],
    spellingLimited, state,
  };
}
export function analyzeSearchRecovery(index: SearchIndex, answer: Answer): SearchRecovery {
  if (!['original', 'revised', 'both'].includes(answer.scope) ||
      !validPage(answer.pageFilter) || !Array.isArray(index.rows) || index.rows.length > MAX_PASSAGES ||
      !answer.question.trim() || answer.question.length > MAX_QUESTION ||
      planQuestions(answer.question).length !== 1) invalid();
  const parsed = parseSearchQuestion(answer.question);
  if (parsed.page !== answer.pageFilter) invalid();
  const words = queryTerms(parsed.content);
  const field = knownQuestionField(words);
  return {
    scope: answer.scope, ...(parsed.page === undefined ? {} : { page: parsed.page }),
    terms: words, normalizedField: field,
    sides: (answer.scope === 'both' ? ROLES : [answer.scope]).map(role => side(index, answer, role, words, field)),
  };
}
export function recoveryPage(leads: readonly RecoveryLead[], page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || leads.length > MAX_RECOVERY_LEADS) invalid();
  const pages = Math.max(1, Math.ceil(leads.length / RECOVERY_PAGE_SIZE));
  const current = Math.min(page, pages);
  return { page: current, pages, leads: leads.slice((current - 1) * RECOVERY_PAGE_SIZE, current * RECOVERY_PAGE_SIZE) };
}
