/** Cross-page inspection leads. Never add these to the strict answer,
 * printed fields, model candidate protocol or saved question plan. */
import { queryTerms, type Answer, type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { parseSearchQuestion } from './pdfChatInsights';

export const MAX_CROSS_PAGE_CANDIDATES = 128;
const MAX_QUERY_TERMS = 16;

type Candidate = { passage: Passage; mask: number; matched: number };
export type PageLead = { source: Passage; matchedTerms: string[] };
export type CrossPageResult = {
  role: Role;
  leads: PageLead[];
  limited: boolean;
};

function bitCount(mask: number): number {
  let count = 0;
  while (mask) { mask &= mask - 1; count++; }
  return count;
}

function sourceOrder(a: Passage, b: Passage): number {
  return a.page - b.page || a.ordinal - b.ordinal;
}

function rank(a: Candidate, b: Candidate): number {
  return b.matched - a.matched || a.passage.text.length - b.passage.text.length ||
    sourceOrder(a.passage, b.passage);
}

function eligibleTerms(answer: Answer): string[] {
  // Never widen an explicit physical page request. A scoped search that
  // found no result cannot authorize looking outside the requested page.
  if (answer.pageFilter !== undefined) return [];
  const words = queryTerms(parseSearchQuestion(answer.question).content);
  return words.length >= 2 && words.length <= MAX_QUERY_TERMS ? words : [];
}

function missingRequestedRoles(answer: Answer): Role[] {
  const roles: Role[] = answer.scope === 'both' ? ['original', 'revised'] : [answer.scope];
  return roles.filter(role => answer.missingRoles.includes(role));
}

export function canSearchCrossPage(index: SearchIndex, answer: Answer): boolean {
  if (!eligibleTerms(answer).length) return false;
  return missingRequestedRoles(answer).some(role => {
    let page: number | undefined;
    for (const row of index.rows) {
      if (row.passage.role !== role) continue;
      if (page !== undefined && page !== row.passage.page) return true;
      page = row.passage.page;
    }
    return false;
  });
}

/** Find one bounded pair of individually incomplete lexical matches on
 * separate pages of each unanswered requested source. Each line must
 * contribute a term absent from the other; together they cover all terms.
 * There is NO inference that their conditions or referents are related.
 */
export function crossPageLeads(index: SearchIndex, answer: Answer): CrossPageResult[] {
  const words = eligibleTerms(answer);
  if (!words.length) return [];
  const all = (1 << words.length) - 1;
  const results: CrossPageResult[] = [];
  for (const role of missingRequestedRoles(answer)) {
    // Deduplicate equivalent term masks on a page. Retain the shortest
    // exact source line, then the earliest physical extraction ordinal.
    const best = new Map<string, Candidate>();
    let hasCompleteLine = false;
    for (const row of index.rows) {
      if (row.passage.role !== role) continue;
      let mask = 0;
      words.forEach((word, i) => { if (row.counts.has(word)) mask |= 1 << i; });
      if (mask === all) { hasCompleteLine = true; break; }
      if (!mask) continue;
      const candidate = { passage: row.passage, mask, matched: bitCount(mask) };
      const key = row.passage.page + ':' + mask;
      const previous = best.get(key);
      if (!previous || rank(candidate, previous) < 0) best.set(key, candidate);
    }
    // The fallback must not contradict an existing full lexical match,
    // including if a caller supplies inconsistent answer metadata.
    if (hasCompleteLine) continue;
    const ranked = [...best.values()].sort(rank);
    const limited = ranked.length > MAX_CROSS_PAGE_CANDIDATES;
    const candidates = ranked.slice(0, MAX_CROSS_PAGE_CANDIDATES);
    let pair: [Candidate, Candidate] | null = null;
    let quality = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j];
        if (a.passage.page === b.passage.page || (a.mask | b.mask) !== all) continue;
        // Both masks are strict subsets of all terms, so both necessarily
        // contribute exclusive terms. Prefer minimal overlap and text length.
        const cost = bitCount(a.mask & b.mask) * 2000 + a.passage.text.length + b.passage.text.length;
        if (cost < quality) { pair = [a, b]; quality = cost; }
      }
    }
    if (pair || limited) results.push({
      role, limited,
      leads: pair ? pair.sort((a, b) => sourceOrder(a.passage, b.passage)).map(candidate => ({
        source: candidate.passage,
        matchedTerms: words.filter((_, i) => Boolean(candidate.mask & (1 << i))),
      })) : [],
    });
  }
  return results;
}
