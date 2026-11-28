/** Bounded, explicit lexical shortlist for the optional local dense ranker.
 * Partial matches are candidates, not answers. No native citation is replaced.
 */
import { knownQuestionField, queryTerms, rankedMatches, type Answer, type IndexedPassage,
  type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { parseSearchQuestion } from './pdfChatInsights';
import { allowedPassages, passageId } from './pdfChatResearch';

export const MAX_SHORTLIST = 512;
export const MIN_SHORTLIST = 16;
const ROLES: Role[] = ['original', 'revised'];
export type CandidateReason = 'baseline' | 'strict' | 'partial' | 'page_sample';
export type ShortlistEntry = { source: Passage; reason: CandidateReason };
export type ShortlistCoverage = {
  role: Role; eligible: number; selected: number; strict: number; strictSelected: number;
  eligiblePages: number; selectedPages: number; reasons: Record<CandidateReason, number>;
};
export type Shortlist = { entries: ShortlistEntry[]; coverage: ShortlistCoverage[] };

function invalid(): never { throw new Error('Invalid shortlist scope or budget.'); }
function sourceOrder(a: Passage, b: Passage): number {
  return a.page - b.page || a.ordinal - b.ordinal;
}
function quotas(counts: Record<Role, number>, budget: number): Record<Role, number> {
  const output = { original: 0, revised: 0 };
  // Round-robin allocation prevents a large PDF from consuming the other
  // role's slots; unused capacity is donated to the other role.
  let remaining = budget;
  while (remaining) {
    let progress = false;
    for (const role of ROLES) {
      if (remaining && output[role] < counts[role]) {
        output[role]++; remaining--; progress = true;
      }
    }
    if (!progress) break;
  }
  return output;
}
function partialScore(index: SearchIndex, row: IndexedPassage, words: string[]) {
  let score = 0, matched = 0;
  for (const word of words) {
    const tf = row.counts.get(word) ?? 0;
    if (!tf) continue;
    matched++;
    const df = index.df.get(word) ?? 0;
    const idf = Math.log(1 + (index.corpusSize - df + 0.5) / (df + 0.5));
    score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * row.length / index.average));
  }
  return { score, matched };
}

export function buildHybridShortlist(index: SearchIndex, answer: Answer, budget = MAX_SHORTLIST): Shortlist {
  if (!Number.isSafeInteger(budget) || budget < MIN_SHORTLIST || budget > MAX_SHORTLIST) invalid();
  const roles = answer.scope === 'both' ? ROLES : [answer.scope];
  const { content, page } = parseSearchQuestion(answer.question);
  if (page !== answer.pageFilter) invalid();
  const allowed = allowedPassages(index.rows.map(row => row.passage), roles, page);
  if (!allowed.size) invalid();
  const words = queryTerms(content);
  if (!words.length || words.length > 16) invalid();
  const counts: Record<Role, number> = { original: 0, revised: 0 };
  for (const source of allowed.values()) counts[source.role]++;
  const allocation = quotas(counts, budget);
  const selectedIndex = { ...index, rows: index.rows.filter(row => allowed.has(passageId(row.passage))) };
  const entries: ShortlistEntry[] = [];
  const coverage: ShortlistCoverage[] = [];
  const baseline = new Map<string, Passage>();
  for (const source of answer.citations) {
    const id = passageId(source), local = allowed.get(id);
    if (!local || local.text !== source.text) invalid();
    baseline.set(id, local);
  }
  for (const role of roles) {
    const candidates = selectedIndex.rows.filter(row => row.passage.role === role);
    const cap = allocation[role];
    const chosen = new Map<string, ShortlistEntry>();
    const add = (source: Passage, reason: CandidateReason) => {
      const id = passageId(source);
      if (chosen.size < cap && !chosen.has(id)) chosen.set(id, { source, reason });
    };
    for (const source of baseline.values()) if (source.role === role) add(source, 'baseline');
    if ([...baseline.values()].some(source => source.role === role && !chosen.has(passageId(source)))) invalid();
    const strict = rankedMatches(selectedIndex, words, role, knownQuestionField(words));
    // Reserve a quarter of non-baseline capacity for page-diverse samples.
    // Strict matches have priority in the other slots. The reserved samples
    // can still be strict if that is the only text on an uncovered page.
    const reserve = Math.floor((cap - chosen.size) / 4);
    const lexicalCap = cap - reserve;
    for (const source of strict) {
      if (chosen.size >= lexicalCap) break;
      add(source, 'strict');
    }
    const partial = candidates.map(row => ({ source: row.passage, ...partialScore(index, row, words) }))
      .filter(row => row.matched > 0).sort((a, b) => b.matched - a.matched ||
        b.score - a.score || sourceOrder(a.source, b.source));
    for (const row of partial) {
      if (chosen.size >= lexicalCap) break;
      add(row.source, 'partial');
    }
    const byPage = new Map<number, Passage[]>();
    for (const row of candidates) {
      const group = byPage.get(row.passage.page) ?? [];
      group.push(row.passage);
      byPage.set(row.passage.page, group);
    }
    const groups = [...byPage].sort(([a], [b]) => a - b).map(([pageNumber, sources]) => ({
      pageNumber, sources: sources.sort(sourceOrder),
    }));
    // Prefer pages that are not yet represented. Then fill round-robin in
    // physical order without ever inventing page identity or relevance.
    const represented = new Set([...chosen.values()].map(entry => entry.source.page));
    for (const group of groups) {
      if (!represented.has(group.pageNumber)) add(group.sources[0], 'page_sample');
      if (chosen.size >= cap) break;
    }
    for (let offset = 0; chosen.size < cap; offset++) {
      let progress = false;
      for (const group of groups) {
        const source = group.sources[offset];
        if (source) { progress = true; add(source, 'page_sample'); }
        if (chosen.size >= cap) break;
      }
      if (!progress) break;
    }
    const reasons: ShortlistCoverage['reasons'] = { baseline: 0, strict: 0, partial: 0, page_sample: 0 };
    for (const entry of chosen.values()) reasons[entry.reason]++;
    coverage.push({ role, eligible: candidates.length, selected: chosen.size, strict: strict.length,
      strictSelected: strict.filter(source => chosen.has(passageId(source))).length,
      eligiblePages: groups.length, selectedPages: new Set([...chosen.values()].map(entry => entry.source.page)).size,
      reasons });
    entries.push(...chosen.values());
  }
  return { entries, coverage };
}
