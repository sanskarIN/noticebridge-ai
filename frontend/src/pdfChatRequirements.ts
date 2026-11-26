/** Explicit English requirement cues, not legal interpretation or eligibility decisions. */
import { MAX_PASSAGES, MAX_PASSAGE_CHARS, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';
import { literalRanges, type TextRange } from './pdfChatEvidenceExplorer';
import { passageId } from './pdfChatResearch';

export const MAX_REQUIREMENT_CUES = 16;
export const REQUIREMENT_PAGE_SIZE = 12;
export const REQUIREMENT_KEYWORD_LIMIT = 120;
export const requirementKinds = ['mandatory', 'prohibited', 'exception', 'permission', 'recommendation'] as const;
export type RequirementKind = typeof requirementKinds[number];
export type RequirementCue = TextRange & { kind: RequirementKind; text: string };
export type RequirementCandidate = {
  source: Passage;
  cues: RequirementCue[];
  totalCues: number;
  kinds: RequirementKind[];
};
export type RequirementIndex = {
  candidates: RequirementCandidate[];
  sourceCounts: Record<Role, number>;
};
export type RequirementOptions = {
  scope: Scope;
  page?: number;
  kind: RequirementKind | 'all';
  keyword?: string;
};
export type RequirementHit = RequirementCandidate & { exactOtherOccurrences: number | null };
export type RequirementResults = {
  hits: RequirementHit[];
  countByRole: Record<Role, number>;
  countByKind: Record<RequirementKind, number>;
  scopedCandidates: number;
  scopedFragments: number;
};

const patterns: readonly { kind: RequirementKind; pattern: RegExp }[] = [
  { kind: 'prohibited', pattern: /(?<![\p{L}\p{N}_])(?:must[ \t]+not|shall[ \t]+not|may[ \t]+not|not[ \t]+permitted|not[ \t]+allowed|prohibited|forbidden|strictly[ \t]+forbidden|do[ \t]+not)(?![\p{L}\p{N}_])/giu },
  { kind: 'exception', pattern: /(?<![\p{L}\p{N}_])(?:unless|except(?:[ \t]+for)?|subject[ \t]+to|provided[ \t]+that|only[ \t]+if|exempt(?:ed|ion|ions)?|not[ \t]+required|not[ \t]+mandatory|waiv(?:e|ed|er))(?![\p{L}\p{N}_])/giu },
  { kind: 'mandatory', pattern: /(?<![\p{L}\p{N}_])(?:must|shall|mandatory|required|compulsory|obligatory|has[ \t]+to|have[ \t]+to)(?![\p{L}\p{N}_])/giu },
  // Do not match bare "may", which may be a month or a nonoperative phrase.
  { kind: 'permission', pattern: /(?<![\p{L}\p{N}_])(?:optional|permitted|allowed|may[ \t]+(?:apply|submit|provide|pay|attend|use|choose|request|register|download))(?![\p{L}\p{N}_])/giu },
  { kind: 'recommendation', pattern: /(?<![\p{L}\p{N}_])(?:should[ \t]+not|should|recommended|advised|encouraged)(?![\p{L}\p{N}_])/giu },
];

function invalid(): never { throw new Error('Invalid requirement inspection request.'); }
function countKinds(): Record<RequirementKind, number> {
  return { mandatory: 0, prohibited: 0, exception: 0, permission: 0, recommendation: 0 };
}
function order(a: Passage, b: Passage): number {
  return (a.role === b.role ? 0 : a.role === 'original' ? -1 : 1) ||
    a.page - b.page || a.ordinal - b.ordinal;
}

/** Recognize literal marker phrases. Prefer the longest match at a
 * position to avoid presenting "must not" as a standalone "must".
 * Different non-overlapping markers in the same fragment remain visible.
 */
export function requirementCues(text: string): { cues: RequirementCue[]; total: number; kinds: RequirementKind[] } {
  if (text.length > MAX_PASSAGE_CHARS) invalid();
  const found: RequirementCue[] = [];
  for (const { kind, pattern } of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      found.push({ kind, start, end: start + match[0].length, text: match[0] });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || requirementKinds.indexOf(a.kind) - requirementKinds.indexOf(b.kind));
  const accepted: RequirementCue[] = [];
  let previousEnd = 0;
  for (const cue of found) {
    if (cue.start < previousEnd) continue;
    accepted.push(cue); previousEnd = cue.end;
  }
  return { cues: accepted.slice(0, MAX_REQUIREMENT_CUES), total: accepted.length,
    kinds: requirementKinds.filter(kind => accepted.some(cue => cue.kind === kind)) };
}

export function buildRequirementIndex(index: SearchIndex): RequirementIndex {
  if (index.rows.length > MAX_PASSAGES) invalid();
  const seen = new Set<string>();
  const sourceCounts = { original: 0, revised: 0 };
  const candidates: RequirementCandidate[] = [];
  for (const row of index.rows) {
    const source = row.passage, id = passageId(source);
    if (seen.has(id)) continue;
    seen.add(id); sourceCounts[source.role]++;
    const result = requirementCues(source.text);
    if (!result.total) continue;
    candidates.push({ source, cues: result.cues, totalCues: result.total, kinds: result.kinds });
  }
  candidates.sort((a, b) => order(a.source, b.source));
  return { candidates, sourceCounts };
}

function validate(options: RequirementOptions): void {
  if (!['original', 'revised', 'both'].includes(options.scope) ||
      (options.kind !== 'all' && !requirementKinds.includes(options.kind)) ||
      (options.page !== undefined && (!Number.isSafeInteger(options.page) ||
        options.page < 1 || options.page > 80)) ||
      (options.keyword !== undefined && (typeof options.keyword !== 'string' ||
        options.keyword.length > REQUIREMENT_KEYWORD_LIMIT))) invalid();
}
function inScope(source: Passage, options: RequirementOptions): boolean {
  return (options.scope === 'both' || source.role === options.scope) &&
    (options.page === undefined || source.page === options.page);
}

/** Return inspection candidates. No "added", "removed", "applies to you"
 * or "conflict" assertion is inferred from exact or absent wording.
 * Exact counterpart counts are calculated only when both roles are
 * explicitly requested and available, within the same physical-page scope.
 */
export function findRequirements(index: SearchIndex, requirementIndex: RequirementIndex,
  options: RequirementOptions, attached: readonly Role[]): RequirementResults {
  validate(options);
  const scoped = requirementIndex.candidates.filter(candidate => inScope(candidate.source, options));
  const scopedFragments = index.rows.filter(row => inScope(row.passage, options)).length;
  const keyword = options.keyword?.trim() ?? '';
  const countByRole = { original: 0, revised: 0 }, countByKind = countKinds();
  const both = options.scope === 'both' && attached.includes('original') && attached.includes('revised');
  const exact = new Map<string, Record<Role, number>>();
  if (both) {
    for (const candidate of scoped) {
      const counts = exact.get(candidate.source.text) ?? { original: 0, revised: 0 };
      counts[candidate.source.role]++;
      exact.set(candidate.source.text, counts);
    }
  }
  const hits: RequirementHit[] = [];
  for (const candidate of scoped) {
    if (options.kind !== 'all' && !candidate.kinds.includes(options.kind)) continue;
    if (keyword && !literalRanges(candidate.source.text, keyword, true).length) continue;
    countByRole[candidate.source.role]++;
    for (const kind of candidate.kinds) countByKind[kind]++;
    const other = candidate.source.role === 'original' ? 'revised' : 'original';
    hits.push({ ...candidate, exactOtherOccurrences: both ? exact.get(candidate.source.text)![other] : null });
  }
  return { hits, countByRole, countByKind, scopedCandidates: scoped.length, scopedFragments };
}

export function requirementPage(results: RequirementResults, page: number) {
  const pages = Math.max(1, Math.ceil(results.hits.length / REQUIREMENT_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  const offset = (page - 1) * REQUIREMENT_PAGE_SIZE;
  const hits = results.hits.slice(offset, offset + REQUIREMENT_PAGE_SIZE);
  return { hits, pages, first: hits.length ? offset + 1 : 0, last: offset + hits.length };
}

/** Recognize broad, explicit discovery questions. This does not substitute
 * for a qualified eligibility question or a request about a particular rule.
 */
export function requirementIntent(question: string): RequirementKind | 'all' | null {
  if (question.length > 400) return null;
  const clean = question.trim().replace(/\?$/, '').trim().replace(/[ \t]+/g, ' ');
  if (!clean || /[\r\n;?]/.test(clean)) return null;
  if (/^(?:(?:what are|list|show)(?: the)? (?:requirements|conditions)|what (?:must|shall) (?:i|we) do)$/i.test(clean)) return 'all';
  if (/^(?:(?:what are|list|show)(?: the)? (?:mandatory|compulsory) (?:requirements|conditions)|what is mandatory)$/i.test(clean)) return 'mandatory';
  if (/^(?:(?:what are|list|show)(?: the)? prohibitions|what is (?:prohibited|not allowed|not permitted)|what must (?:i|we) not do)$/i.test(clean)) return 'prohibited';
  if (/^(?:(?:what are|list|show)(?: the)? (?:exceptions|exemptions|waivers)|what is exempt)$/i.test(clean)) return 'exception';
  if (/^(?:(?:what are|list|show)(?: the)? (?:permissions|optional requirements)|what is (?:optional|allowed|permitted))$/i.test(clean)) return 'permission';
  if (/^(?:(?:what are|list|show)(?: the)? recommendations|what is recommended)$/i.test(clean)) return 'recommendation';
  return null;
}
