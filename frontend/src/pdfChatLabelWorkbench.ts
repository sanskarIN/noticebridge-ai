/** Human-authored retrieval labels. No automatic answer-derived ground truth. */
import { MAX_QUESTION, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';
import { parseSearchQuestion, planQuestions } from './pdfChatInsights';
import { literalRanges } from './pdfChatEvidenceExplorer';
import { passageId } from './pdfChatResearch';
import { serializeCorpusSnapshot } from './pdfChatCorpusSnapshot';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import type { SourcePins } from './pdfChatSession';

export const MAX_LABEL_CASES = 100;
export const MAX_LABEL_SETS = 8;
export const MAX_LABEL_SET_SIZE = 24;
export const MAX_LABEL_SLICES = 8;
export const MAX_LABEL_DRAFT_BYTES = 512 * 1024;
export const LABEL_PAGE_SIZE = 16;
const FORMAT = 'noticebridge-label-draft';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const ROLES: Role[] = ['original', 'revised'];

export type LabelKind = 'answerable' | 'unanswerable' | 'unindexed' | 'ambiguous';
export type DraftCase = {
  id: string;
  question: string;
  scope: Scope;
  page?: number;
  slices: string[];
  kind: LabelKind;
  evidenceSets: string[][];
};
export type LabelMetadata = {
  dataset: string;
  document: string;
  family: string;
  split: 'development' | 'holdout';
  snapshot: string;
};
export type LabelDraft = {
  metadata: LabelMetadata;
  cases: DraftCase[];
};
export type EvidenceFilter = { scope: Scope; page?: number; keyword: string };
export type LabelBundle = { snapshot: string; manifest: string; snapshotSha256: string };
export const labelKinds: readonly LabelKind[] = ['answerable', 'unanswerable', 'unindexed', 'ambiguous'];

function invalid(): never { throw new Error('Invalid or incomplete annotation draft.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) invalid();
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid();
  return value;
}
export function parseMetadata(value: unknown): LabelMetadata {
  const row = object(value);
  exact(row, ['dataset', 'document', 'family', 'split', 'snapshot']);
  if (row.split !== 'development' && row.split !== 'holdout') invalid();
  if (typeof row.snapshot !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(row.snapshot) ||
      row.snapshot === 'labels.json') invalid();
  return { dataset: identifier(row.dataset), document: identifier(row.document),
    family: identifier(row.family), split: row.split, snapshot: row.snapshot };
}
function roles(scope: Scope): Role[] {
  if (scope === 'both') return ROLES;
  if (scope === 'original' || scope === 'revised') return [scope];
  return invalid();
}
function validatePage(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 80) invalid();
  return value;
}
function sourceMap(index: SearchIndex): Map<string, Passage> {
  const result = new Map<string, Passage>();
  for (const row of index.rows) {
    const key = passageId(row.passage);
    if (result.has(key)) invalid();
    result.set(key, row.passage);
  }
  return result;
}
function validQuestion(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value ||
      value.length > MAX_QUESTION || planQuestions(value).length !== 1 ||
      new TextDecoder().decode(new TextEncoder().encode(value)) !== value) invalid();
  return value;
}
/** A draft may have zero evidence sets or empty sets until completed.
 * Final export rejects unfinished answerable labels.
 */
export function validateDraftCase(value: unknown, index: SearchIndex, attached: readonly Role[],
  complete = false): DraftCase {
  const raw = object(value);
  const hasPage = Object.prototype.hasOwnProperty.call(raw, 'page');
  exact(raw, ['id', 'question', 'scope', ...(hasPage ? ['page'] : []), 'slices', 'kind', 'evidenceSets']);
  const id = identifier(raw.id), question = validQuestion(raw.question);
  if (raw.scope !== 'original' && raw.scope !== 'revised' && raw.scope !== 'both') invalid();
  const scope = raw.scope, allowed = roles(scope);
  if (allowed.some(role => !attached.includes(role))) invalid();
  const page = validatePage(raw.page);
  if (parseSearchQuestion(question).page !== page) invalid();
  if (!Array.isArray(raw.slices) || raw.slices.length > MAX_LABEL_SLICES ||
      (complete && !raw.slices.length)) invalid();
  const slices = raw.slices.map(identifier);
  if (new Set(slices).size !== slices.length) invalid();
  if (!labelKinds.includes(raw.kind as LabelKind) || !Array.isArray(raw.evidenceSets) ||
      raw.evidenceSets.length > MAX_LABEL_SETS) invalid();
  const kind = raw.kind as LabelKind;
  if (kind !== 'answerable' && raw.evidenceSets.length) invalid();
  if (complete && kind === 'answerable' && !raw.evidenceSets.length) invalid();
  const available = sourceMap(index), seen = new Set<string>();
  const evidenceSets = raw.evidenceSets.map(value => {
    if (!Array.isArray(value) || value.length > MAX_LABEL_SET_SIZE || (complete && !value.length)) invalid();
    const result: string[] = [];
    for (const id of value) {
      if (typeof id !== 'string' || result.includes(id)) invalid();
      const source = available.get(id);
      if (!source || !allowed.includes(source.role) || (page !== undefined && source.page !== page)) invalid();
      result.push(id);
    }
    const key = [...result].sort().join('|');
    if (complete && seen.has(key)) invalid();
    seen.add(key);
    return result;
  });
  return { id, question, scope, ...(page === undefined ? {} : { page }), slices, kind, evidenceSets };
}
export function validateDraft(draft: unknown, index: SearchIndex, attached: readonly Role[], complete = false): LabelDraft {
  const raw = object(draft);
  exact(raw, ['metadata', 'cases']);
  if (!Array.isArray(raw.cases) || raw.cases.length > MAX_LABEL_CASES || (complete && !raw.cases.length)) invalid();
  const cases = raw.cases.map(value => validateDraftCase(value, index, attached, complete));
  if (new Set(cases.map(row => row.id)).size !== cases.length) invalid();
  return { metadata: parseMetadata(raw.metadata), cases };
}
export function makeDraftCase(id: string, question: string, scope: Scope, slices: string[], kind: LabelKind,
  index: SearchIndex, attached: readonly Role[]): DraftCase {
  const page = parseSearchQuestion(question).page;
  return validateDraftCase({ id, question, scope, ...(page === undefined ? {} : { page }),
    slices, kind, evidenceSets: kind === 'answerable' ? [[]] : [] }, index, attached);
}
export function setCaseKind(row: DraftCase, kind: LabelKind): DraftCase {
  if (!labelKinds.includes(kind)) invalid();
  if (row.kind === kind) return row;
  return { ...row, kind, evidenceSets: kind === 'answerable' ? [[]] : [] };
}
export function appendEvidenceSet(row: DraftCase): DraftCase {
  if (row.kind !== 'answerable' || row.evidenceSets.length >= MAX_LABEL_SETS) invalid();
  return { ...row, evidenceSets: [...row.evidenceSets, []] };
}
export function removeEvidenceSet(row: DraftCase, set: number): DraftCase {
  if (!Number.isSafeInteger(set) || set < 0 || set >= row.evidenceSets.length) invalid();
  return { ...row, evidenceSets: row.evidenceSets.filter((_, i) => i !== set) };
}
export function toggleEvidence(row: DraftCase, set: number, source: Passage,
  index: SearchIndex, attached: readonly Role[]): DraftCase {
  if (row.kind !== 'answerable' || !Number.isSafeInteger(set) || set < 0 || set >= row.evidenceSets.length) invalid();
  const key = passageId(source), local = sourceMap(index).get(key);
  if (!local || local.text !== source.text) invalid();
  const sets = row.evidenceSets.map((ids, i) => i !== set ? [...ids]
    : ids.includes(key) ? ids.filter(id => id !== key) : [...ids, key]);
  return validateDraftCase({ ...row, evidenceSets: sets }, index, attached);
}
export function saveDraftCase(draft: LabelDraft, row: DraftCase, index: SearchIndex,
  attached: readonly Role[], replaceId?: string): LabelDraft {
  if (replaceId !== undefined && !draft.cases.some(item => item.id === replaceId)) invalid();
  const cases = replaceId === undefined ? [...draft.cases, row]
    : draft.cases.map(item => item.id === replaceId ? row : item);
  return validateDraft({ ...draft, cases }, index, attached);
}
export function deleteDraftCase(draft: LabelDraft, id: string): LabelDraft {
  return { ...draft, cases: draft.cases.filter(row => row.id !== id) };
}
export function labelIsComplete(row: DraftCase, index: SearchIndex, attached: readonly Role[]): boolean {
  try { validateDraftCase(row, index, attached, true); return true; }
  catch { return false; }
}
/** Manual literal browse, deliberately not ranked by the current QA engine. */
export function annotationCandidates(index: SearchIndex, filter: EvidenceFilter): Passage[] {
  const allowed = roles(filter.scope);
  const page = validatePage(filter.page);
  if (typeof filter.keyword !== 'string' || filter.keyword.length > 120) invalid();
  const keyword = filter.keyword.trim();
  return [...sourceMap(index).values()].filter(source => allowed.includes(source.role) &&
      (page === undefined || source.page === page) &&
      (!keyword || literalRanges(source.text, keyword, true).length > 0))
    .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.page - b.page || a.ordinal - b.ordinal);
}
export function labelPage<T>(items: T[], page: number) {
  const pages = Math.max(1, Math.ceil(items.length / LABEL_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  const offset = (page - 1) * LABEL_PAGE_SIZE;
  return { pages, items: items.slice(offset, offset + LABEL_PAGE_SIZE) };
}
async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) invalid();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    value => value.toString(16).padStart(2, '0')).join('');
}
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }

/** The saved draft binds to the exact serialized extraction, not only
 * the PDF fingerprint. Changing text, geometry or coverage invalidates it.
 */
export async function serializeLabelDraft(draft: LabelDraft, index: SearchIndex,
  pins: SourcePins, corpora: ChatCorpora): Promise<string> {
  const attached = ROLES.filter(role => corpora[role]);
  const validated = validateDraft(draft, index, attached);
  const snapshot = serializeCorpusSnapshot(pins, corpora);
  const text = encode({ format: FORMAT, version: 1, snapshot_sha256: await digest(snapshot),
    draft: validated, authority_verified: false });
  if (new TextEncoder().encode(text).length > MAX_LABEL_DRAFT_BYTES) invalid();
  return text;
}
export async function parseLabelDraft(text: string, index: SearchIndex, pins: SourcePins,
  corpora: ChatCorpora): Promise<LabelDraft> {
  if (!text || text.length > MAX_LABEL_DRAFT_BYTES ||
      new TextEncoder().encode(text).length > MAX_LABEL_DRAFT_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const raw = object(value);
  exact(raw, ['format', 'version', 'snapshot_sha256', 'draft', 'authority_verified']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.authority_verified !== false ||
      typeof raw.snapshot_sha256 !== 'string' || !SHA.test(raw.snapshot_sha256)) invalid();
  const draft = validateDraft(raw.draft, index, ROLES.filter(role => corpora[role]));
  if (await serializeLabelDraft(draft, index, pins, corpora) !== text) invalid();
  return draft;
}
export async function readLabelDraft(file: File, index: SearchIndex, pins: SourcePins,
  corpora: ChatCorpora): Promise<LabelDraft> {
  if (!file.size || file.size > MAX_LABEL_DRAFT_BYTES) invalid();
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_LABEL_DRAFT_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return parseLabelDraft(text, index, pins, corpora);
}
/** Human declaration is explicit, not inferred by this program.
 * No source text is added to labels; the paired snapshot remains private.
 */
export async function exportLabelBundle(draft: LabelDraft, index: SearchIndex, pins: SourcePins,
  corpora: ChatCorpora, declaration: 'synthetic' | 'independently_reviewed', consent: boolean): Promise<LabelBundle> {
  if (consent !== true || !['synthetic', 'independently_reviewed'].includes(declaration)) invalid();
  const validated = validateDraft(draft, index, ROLES.filter(role => corpora[role]), true);
  const snapshot = serializeCorpusSnapshot(pins, corpora);
  const snapshotSha256 = await digest(snapshot), meta = validated.metadata;
  const manifest = encode({
    format: 'noticebridge-retrieval-labels', version: 1, id: meta.dataset, kind: declaration,
    documents: [{
      id: meta.document, family: meta.family, split: meta.split, snapshot: meta.snapshot,
      snapshot_sha256: snapshotSha256,
      cases: validated.cases.map(row => ({
        id: row.id, slices: row.slices, question: row.question, scope: row.scope,
        ...(row.page === undefined ? {} : { page: row.page }),
        label: row.kind === 'answerable' ? { kind: row.kind, evidenceSets: row.evidenceSets } : { kind: row.kind },
      })),
    }],
  });
  return { snapshot, manifest, snapshotSha256 };
}
