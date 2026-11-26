/** Literal two-fragment comparison. Never automatically pair clauses or infer meaning. */
import { MAX_PASSAGE_CHARS, type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { literalRanges } from './pdfChatEvidenceExplorer';
import { passageId } from './pdfChatResearch';

export const MAX_WORD_DIFF_TOKENS = 512;
export const MAX_DIFF_CANDIDATE_FILTER = 120;
export const DIFF_CANDIDATE_PAGE_SIZE = 12;
export type DiffToken = { text: string; start: number; end: number };
export type DiffSegment = DiffToken & { kind: 'same' | 'unpaired' };
export type DiffChunk = { original: DiffToken[]; revised: DiffToken[] };
export type LiteralDiff = {
  original: Passage;
  revised: Passage;
  originalSegments: DiffSegment[];
  revisedSegments: DiffSegment[];
  changes: DiffChunk[];
  sameTokens: number;
  originalTokens: number;
  revisedTokens: number;
  repeatedTokens: boolean;
  identical: boolean;
};
export type DiffCandidateFilter = { role: Role; page?: number; keyword: string };
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu;

function invalid(): never { throw new Error('Invalid literal source comparison.'); }
export function literalTokens(text: string): DiffToken[] {
  if (typeof text !== 'string' || !text.length || text.length > MAX_PASSAGE_CHARS ||
      new TextDecoder().decode(new TextEncoder().encode(text)) !== text) invalid();
  const tokens = Array.from(text.matchAll(TOKEN), match => ({
    text: match[0], start: match.index!, end: match.index! + match[0].length,
  }));
  if (tokens.length > MAX_WORD_DIFF_TOKENS) {
    throw new Error('Fragment token limit exceeded; inspect the sources independently.');
  }
  if (tokens.map(token => token.text).join('') !== text) invalid();
  return tokens;
}
function findSource(index: SearchIndex, id: string): Passage {
  const matches = index.rows.filter(row => passageId(row.passage) === id);
  if (matches.length !== 1) invalid();
  return matches[0].passage;
}
export function diffCandidates(index: SearchIndex, filter: DiffCandidateFilter): Passage[] {
  if (!['original', 'revised'].includes(filter.role) ||
      (filter.page !== undefined && (!Number.isSafeInteger(filter.page) || filter.page < 1 || filter.page > 80)) ||
      typeof filter.keyword !== 'string' || filter.keyword.length > MAX_DIFF_CANDIDATE_FILTER) invalid();
  const seen = new Set<string>();
  const keyword = filter.keyword.trim();
  const rows = index.rows.filter(row => row.passage.role === filter.role &&
    (filter.page === undefined || row.passage.page === filter.page) &&
    (!keyword || literalRanges(row.passage.text, keyword, true).length > 0)).map(row => row.passage);
  for (const source of rows) {
    const id = passageId(source);
    if (seen.has(id)) invalid();
    seen.add(id);
  }
  return rows.sort((a, b) => a.page - b.page || a.ordinal - b.ordinal);
}
export function diffCandidatePage<T>(rows: readonly T[], page: number) {
  const pages = Math.max(1, Math.ceil(rows.length / DIFF_CANDIDATE_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  const offset = (page - 1) * DIFF_CANDIDATE_PAGE_SIZE;
  return { rows: rows.slice(offset, offset + DIFF_CANDIDATE_PAGE_SIZE), pages };
}
function combine(tokens: DiffSegment[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  for (const token of tokens) {
    const last = segments.at(-1);
    if (last && last.kind === token.kind && last.end === token.start) {
      last.end = token.end; last.text += token.text;
    } else segments.push({ ...token });
  }
  return segments;
}
function repeats(tokens: DiffToken[]): boolean {
  const words = tokens.filter(token => /[\p{L}\p{N}]/u.test(token.text)).map(token => token.text);
  return new Set(words).size !== words.length;
}

/** Token-level LCS with a fixed bounded matrix. All UTF-16 source offsets
 * remain exact and all punctuation and whitespace remain visible.
 * Ties prefer the original side; repeated words may admit several
 * equally valid alignments. "Unpaired" does not mean legally deleted.
 */
export function compareLiteralSources(index: SearchIndex, originalId: string, revisedId: string): LiteralDiff {
  const original = findSource(index, originalId), revised = findSource(index, revisedId);
  if (original.role !== 'original' || revised.role !== 'revised') invalid();
  const a = literalTokens(original.text), b = literalTokens(revised.text);
  const width = b.length + 1;
  const matrix = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      matrix[i * width + j] = a[i].text === b[j].text
        ? 1 + matrix[(i + 1) * width + j + 1]
        : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    }
  }
  const oldSegments: DiffSegment[] = [], newSegments: DiffSegment[] = [];
  const changes: DiffChunk[] = [];
  let active: DiffChunk | null = null;
  let i = 0, j = 0, same = 0;
  function chunk() {
    if (!active) { active = { original: [], revised: [] }; changes.push(active); }
    return active;
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) {
      oldSegments.push({ ...a[i++], kind: 'same' });
      newSegments.push({ ...b[j++], kind: 'same' });
      same++; active = null;
    } else if (i < a.length && (j >= b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) {
      chunk().original.push(a[i]); oldSegments.push({ ...a[i++], kind: 'unpaired' });
    } else {
      chunk().revised.push(b[j]); newSegments.push({ ...b[j++], kind: 'unpaired' });
    }
  }
  return { original, revised, originalSegments: combine(oldSegments), revisedSegments: combine(newSegments),
    changes, sameTokens: same, originalTokens: a.length, revisedTokens: b.length,
    repeatedTokens: repeats(a) || repeats(b), identical: original.text === revised.text };
}

export type NumericMarker = DiffToken & { kind: 'digits' | 'currency_symbol' | 'percent' };
/** Display literal changed numeric markers only. No numeric normalization,
 * currency interpretation, unit conversion, or arithmetic on these runs.
 */
export function numericMarkers(token: DiffToken): NumericMarker[] {
  const result: NumericMarker[] = [];
  for (const match of token.text.matchAll(/[\p{N}]+|[\p{Sc}]|%/gu)) {
    const start = token.start + match.index!;
    result.push({ text: match[0], start, end: start + match[0].length,
      kind: match[0] === '%' ? 'percent' : /\p{Sc}/u.test(match[0]) ? 'currency_symbol' : 'digits' });
  }
  return result;
}
export function changedNumericMarkers(diff: LiteralDiff) {
  return {
    original: diff.changes.flatMap(chunk => chunk.original.flatMap(numericMarkers)),
    revised: diff.changes.flatMap(chunk => chunk.revised.flatMap(numericMarkers)),
  };
}

/** Exact same wording elsewhere is reported as occurrences, not automatic
 * equivalent passages. The selected pair remains the only comparison.
 */
export function exactWordingOccurrences(index: SearchIndex, source: Passage): Record<Role, number> {
  const local = findSource(index, passageId(source));
  if (local.text !== source.text) invalid();
  const count = { original: 0, revised: 0 }, seen = new Set<string>();
  for (const row of index.rows) {
    if (row.passage.text !== source.text) continue;
    const key = passageId(row.passage);
    if (seen.has(key)) invalid();
    seen.add(key); count[row.passage.role]++;
  }
  return count;
}
