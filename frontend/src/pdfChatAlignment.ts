/** Human-selected evidence groups. No automatic correspondence, policy
 * interpretation, or assertion of additions/removals. Each fragment remains
 * independent and keeps its role, physical page and native wording.
 */
import { MAX_PASSAGES, MAX_PASSAGE_CHARS, type Passage, type Role, type SearchIndex } from './pdfChatCore';
import { compareLiteralSources, changedNumericMarkers, type LiteralDiff } from './pdfChatLiteralDiff';
import { literalRanges } from './pdfChatEvidenceExplorer';
import { passageId } from './pdfChatResearch';

export const MAX_ALIGNMENT_GROUPS = 40;
export const MAX_ALIGNMENT_SIDE = 6;
export const MAX_ALIGNMENT_TITLE = 100;
export const MAX_ALIGNMENT_NOTE = 600;
export const MAX_ALIGNMENT_FILTER = 120;
export const ALIGNMENT_CANDIDATE_PAGE = 8;
export const ALIGNMENT_RESULT_PAGE = 5;
export const alignmentStatuses = ['unreviewed', 'reviewed_manually', 'needs_followup'] as const;
export type AlignmentStatus = typeof alignmentStatuses[number];
export type AlignmentGroup = {
  id: string;
  title: string;
  original: string[];
  revised: string[];
  status: AlignmentStatus;
  note: string;
};
export type AlignmentLedger = AlignmentGroup[];
export type AlignmentState = 'both_selected_same_multiset' | 'both_selected_different_multiset' |
  'original_selection_only' | 'revised_selection_only';
export const alignmentStates: readonly AlignmentState[] = [
  'both_selected_same_multiset', 'both_selected_different_multiset',
  'original_selection_only', 'revised_selection_only',
];
export type AlignmentFragment = { id: string; source: Passage; sharedGroupCount: number };
export type WordingObservation = {
  text: string;
  originalIds: string[];
  revisedIds: string[];
  identicalOccurrenceCount: number;
  originalOnlyCount: number;
  revisedOnlyCount: number;
};
export type AlignmentResult = {
  group: AlignmentGroup;
  state: AlignmentState;
  original: AlignmentFragment[];
  revised: AlignmentFragment[];
  observations: WordingObservation[];
  identicalOccurrences: number;
  originalOnlyOccurrences: number;
  revisedOnlyOccurrences: number;
  literalDiff: LiteralDiff | null;
  literalDiffStatus: 'available' | 'not_single_pair' | 'token_budget';
  changedNumeric: ReturnType<typeof changedNumericMarkers> | null;
};
export type AlignmentSummary = {
  groups: number;
  originalSelections: number;
  revisedSelections: number;
  distinctOriginal: number;
  distinctRevised: number;
  reusedFragments: number;
  states: Record<AlignmentState, number>;
  statuses: Record<AlignmentStatus, number>;
};
export type AlignmentFilter = {
  state: AlignmentState | 'all';
  status: AlignmentStatus | 'all';
  keyword: string;
};
export type CandidateFilter = { role: Role; page?: number; keyword: string; hideSelected: boolean };
const GROUP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FRAGMENT_ID = /^(original|revised):([1-9][0-9]?):([1-9][0-9]{0,5})$/;
const ROLES: readonly Role[] = ['original', 'revised'];

function invalid(): never { throw new Error('Invalid or oversized manual evidence alignment.'); }
function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) invalid();
  return raw;
}
function safeText(input: unknown, maximum: number, allowEmpty: boolean): string {
  if (typeof input !== 'string' || input.length > maximum || (!allowEmpty && !input) ||
      input.trim() !== input || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input) ||
      new TextDecoder().decode(new TextEncoder().encode(input)) !== input) invalid();
  return input;
}
function groupId(input: unknown): string {
  if (typeof input !== 'string' || !GROUP_ID.test(input)) invalid();
  return input;
}
function identity(input: unknown, role: Role): string {
  if (typeof input !== 'string') invalid();
  const match = FRAGMENT_ID.exec(input);
  if (!match || match[1] !== role || Number(match[2]) > 80) invalid();
  return input;
}
function sortedIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const left = a.split(':'), right = b.split(':');
    return Number(left[1]) - Number(right[1]) || Number(left[2]) - Number(right[2]);
  });
}
function selection(value: unknown, role: Role): string[] {
  if (!Array.isArray(value) || value.length > MAX_ALIGNMENT_SIDE) invalid();
  const ids = value.map(item => identity(item, role));
  if (new Set(ids).size !== ids.length) invalid();
  return sortedIds(ids);
}
export function normalizeAlignmentGroup(value: unknown): AlignmentGroup {
  const row = exact(value, ['id', 'title', 'original', 'revised', 'status', 'note']);
  const title = safeText(row.title, MAX_ALIGNMENT_TITLE, false);
  if (/[\r\n]/.test(title)) invalid();
  const original = selection(row.original, 'original'), revised = selection(row.revised, 'revised');
  if (!original.length && !revised.length) invalid();
  if (!alignmentStatuses.includes(row.status as AlignmentStatus)) invalid();
  return { id: groupId(row.id), title, original, revised, status: row.status as AlignmentStatus,
    note: safeText(row.note, MAX_ALIGNMENT_NOTE, true) };
}
export function normalizeAlignmentLedger(value: unknown, allowEmpty = false): AlignmentLedger {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > MAX_ALIGNMENT_GROUPS) invalid();
  const rows = value.map(normalizeAlignmentGroup);
  if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  return rows;
}
/** Bind only native fragments already present in the index. The whole
 * map is validated once, not once per selected source. */
export function alignmentSources(index: SearchIndex): Map<string, Passage> {
  if (!index || !Array.isArray(index.rows) || index.rows.length > MAX_PASSAGES) invalid();
  const sources = new Map<string, Passage>();
  for (const row of index.rows) {
    const source = row.passage;
    const id = identity(passageId(source), source.role);
    if (sources.has(id) || typeof source.text !== 'string' || !source.text.trim() ||
        source.text.length > MAX_PASSAGE_CHARS || source.text.trim() !== source.text) invalid();
    sources.set(id, source);
  }
  return sources;
}
function assertSelections(groups: AlignmentLedger, sources: ReadonlyMap<string, Passage>) {
  for (const group of groups) {
    for (const role of ROLES) {
      for (const id of group[role]) if (sources.get(id)?.role !== role) invalid();
    }
  }
}
export function validateAlignmentLedger(index: SearchIndex, input: unknown, allowEmpty = false): AlignmentLedger {
  const groups = normalizeAlignmentLedger(input, allowEmpty);
  assertSelections(groups, alignmentSources(index));
  return groups;
}
export function nextAlignmentId(groups: AlignmentLedger): string {
  const ids = new Set(normalizeAlignmentLedger(groups, true).map(row => row.id));
  for (let i = 1; i <= MAX_ALIGNMENT_GROUPS + 1; i++) if (!ids.has('group-' + i)) return 'group-' + i;
  return invalid();
}
export function appendAlignment(index: SearchIndex, groups: AlignmentLedger, group: AlignmentGroup): AlignmentLedger {
  return validateAlignmentLedger(index, [...groups, group]);
}
/** Selection or topic changes invalidate an old manual review. A user
 * must deliberately review the new group instead of inheriting a decision.
 * A note-only/status-only edit is a human annotation, not a retrieval input.
 */
export function replaceAlignment(index: SearchIndex, groups: AlignmentLedger, group: AlignmentGroup): AlignmentLedger {
  const next = normalizeAlignmentGroup(group);
  const previous = groups.find(row => row.id === next.id);
  if (!previous) invalid();
  const before = normalizeAlignmentGroup(previous);
  const changed = before.title !== next.title ||
    JSON.stringify(before.original) !== JSON.stringify(next.original) ||
    JSON.stringify(before.revised) !== JSON.stringify(next.revised);
  const replacement = changed ? { ...next, status: 'unreviewed' as const, note: '' } : next;
  return validateAlignmentLedger(index, groups.map(row => row.id === next.id ? replacement : row));
}
export function updateAlignmentReview(index: SearchIndex, groups: AlignmentLedger, id: string,
  patch: Partial<Pick<AlignmentGroup, 'status' | 'note'>>): AlignmentLedger {
  if (!groups.some(row => row.id === id) || Object.keys(patch).some(key => key !== 'status' && key !== 'note')) invalid();
  return validateAlignmentLedger(index, groups.map(row => row.id === id ? { ...row, ...patch } : row));
}
export function removeAlignment(groups: AlignmentLedger, id: string): AlignmentLedger {
  const rows = normalizeAlignmentLedger(groups);
  if (!rows.some(row => row.id === id)) invalid();
  return rows.filter(row => row.id !== id);
}
export function moveAlignment(groups: AlignmentLedger, id: string, direction: -1 | 1): AlignmentLedger {
  const rows = normalizeAlignmentLedger(groups);
  if (direction !== -1 && direction !== 1) invalid();
  const at = rows.findIndex(row => row.id === id), to = at + direction;
  if (at < 0 || to < 0 || to >= rows.length) invalid();
  [rows[at], rows[to]] = [rows[to], rows[at]];
  return rows;
}
export function toggleAlignmentSource(ids: string[], id: string, role: Role): string[] {
  const current = selection(ids, role), key = identity(id, role);
  if (current.includes(key)) return current.filter(value => value !== key);
  return selection([...current, key], role);
}
function observations(original: AlignmentFragment[], revised: AlignmentFragment[]): WordingObservation[] {
  const map = new Map<string, { originalIds: string[]; revisedIds: string[] }>();
  for (const fragment of [...original, ...revised]) {
    const text = fragment.source.text;
    let row = map.get(text);
    if (!row) { row = { originalIds: [], revisedIds: [] }; map.set(text, row); }
    row[fragment.source.role === 'original' ? 'originalIds' : 'revisedIds'].push(fragment.id);
  }
  return [...map].map(([text, row]) => {
    const identicalOccurrenceCount = Math.min(row.originalIds.length, row.revisedIds.length);
    return { text, ...row, identicalOccurrenceCount,
      originalOnlyCount: row.originalIds.length - identicalOccurrenceCount,
      revisedOnlyCount: row.revisedIds.length - identicalOccurrenceCount };
  });
}
function groupState(group: AlignmentGroup, differing: number): AlignmentState {
  if (!group.original.length) return 'revised_selection_only';
  if (!group.revised.length) return 'original_selection_only';
  return differing ? 'both_selected_different_multiset' : 'both_selected_same_multiset';
}
function usage(groups: AlignmentLedger): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) for (const id of [...group.original, ...group.revised]) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}
export function analyzeAlignment(index: SearchIndex, input: AlignmentLedger): AlignmentResult[] {
  const groups = normalizeAlignmentLedger(input, true);
  const sources = alignmentSources(index);
  assertSelections(groups, sources);
  const counts = usage(groups);
  return groups.map(group => {
    const side = (role: Role) => group[role].map(id => ({ id, source: sources.get(id)!, sharedGroupCount: counts.get(id)! }));
    const original = side('original'), revised = side('revised');
    const wording = observations(original, revised);
    const identicalOccurrences = wording.reduce((n, row) => n + row.identicalOccurrenceCount, 0);
    const originalOnlyOccurrences = wording.reduce((n, row) => n + row.originalOnlyCount, 0);
    const revisedOnlyOccurrences = wording.reduce((n, row) => n + row.revisedOnlyCount, 0);
    let literalDiff: LiteralDiff | null = null;
    let literalDiffStatus: AlignmentResult['literalDiffStatus'] = 'not_single_pair';
    if (original.length === 1 && revised.length === 1) {
      // Never concatenate unrelated passages into a fictitious printed
      // quotation. Token alignment is available only for a single pair.
      try {
        literalDiff = compareLiteralSources(index, original[0].id, revised[0].id);
        literalDiffStatus = 'available';
      } catch { literalDiffStatus = 'token_budget'; }
    }
    return {
      group, original, revised, state: groupState(group, originalOnlyOccurrences + revisedOnlyOccurrences),
      observations: wording, identicalOccurrences, originalOnlyOccurrences, revisedOnlyOccurrences,
      literalDiff, literalDiffStatus, changedNumeric: literalDiff ? changedNumericMarkers(literalDiff) : null,
    };
  });
}
export function summarizeAlignment(results: AlignmentResult[]): AlignmentSummary {
  const states = Object.fromEntries(alignmentStates.map(state => [state, 0])) as AlignmentSummary['states'];
  const statuses = Object.fromEntries(alignmentStatuses.map(status => [status, 0])) as AlignmentSummary['statuses'];
  const original = new Set<string>(), revised = new Set<string>(), repeated = new Set<string>();
  let originalSelections = 0, revisedSelections = 0;
  for (const result of results) {
    states[result.state]++;
    statuses[result.group.status]++;
    originalSelections += result.original.length;
    revisedSelections += result.revised.length;
    for (const fragment of [...result.original, ...result.revised]) {
      (fragment.source.role === 'original' ? original : revised).add(fragment.id);
      if (fragment.sharedGroupCount > 1) repeated.add(fragment.id);
    }
  }
  return { groups: results.length, originalSelections, revisedSelections,
    distinctOriginal: original.size, distinctRevised: revised.size, reusedFragments: repeated.size, states, statuses };
}
export function filterAlignments(results: AlignmentResult[], filter: AlignmentFilter): AlignmentResult[] {
  if ((filter.state !== 'all' && !alignmentStates.includes(filter.state)) ||
      (filter.status !== 'all' && !alignmentStatuses.includes(filter.status)) ||
      typeof filter.keyword !== 'string' || filter.keyword.length > MAX_ALIGNMENT_FILTER) invalid();
  const keyword = filter.keyword.trim().normalize('NFKC').toLowerCase();
  return results.filter(result =>
    (filter.state === 'all' || result.state === filter.state) &&
    (filter.status === 'all' || result.group.status === filter.status) &&
    (!keyword || result.group.title.normalize('NFKC').toLowerCase().includes(keyword)));
}
export function alignmentCandidates(index: SearchIndex, filter: CandidateFilter, selected: string[]): Passage[] {
  if (!ROLES.includes(filter.role) || (filter.page !== undefined &&
      (!Number.isSafeInteger(filter.page) || filter.page < 1 || filter.page > 80)) ||
      typeof filter.keyword !== 'string' || filter.keyword.length > MAX_ALIGNMENT_FILTER ||
      typeof filter.hideSelected !== 'boolean') invalid();
  const current = new Set(selection(selected, filter.role)), keyword = filter.keyword.trim();
  return [...alignmentSources(index)].filter(([id, source]) => source.role === filter.role &&
    (filter.page === undefined || source.page === filter.page) &&
    (!filter.hideSelected || !current.has(id)) &&
    (!keyword || literalRanges(source.text, keyword, true).length > 0))
    .map(([, source]) => source).sort((a, b) => a.page - b.page || a.ordinal - b.ordinal);
}
export function alignmentPage<T>(rows: readonly T[], requested: number, size: number) {
  if (!Number.isSafeInteger(requested) || requested < 1 ||
      (size !== ALIGNMENT_CANDIDATE_PAGE && size !== ALIGNMENT_RESULT_PAGE)) invalid();
  const pages = Math.max(1, Math.ceil(rows.length / size)), page = Math.min(requested, pages);
  return { rows: rows.slice((page - 1) * size, page * size), pages, page, total: rows.length };
}
