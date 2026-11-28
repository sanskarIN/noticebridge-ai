/** User-authored review annotations for an independent collection.
 * A review is not a verification of the meaning or authority of a notice. */
import type { Passage } from './pdfChatCore';
import { collectionCitation, collectionStats, type CollectionDocument, type CollectionId } from './pdfChatCollection';

export const MAX_COLLECTION_REVIEW_ITEMS = 100;
export const MAX_COLLECTION_REVIEW_NOTE = 500;
export const MAX_COLLECTION_REVIEW_BYTES = 384 * 1024;
export const COLLECTION_REVIEW_STATUSES = ['unreviewed', 'reviewed_manually', 'needs_followup'] as const;
export type CollectionReviewStatus = typeof COLLECTION_REVIEW_STATUSES[number];
export type CollectionReviewEntry = {
  documentId: CollectionId;
  source: Passage;
  status: CollectionReviewStatus;
  note: string;
};
export type CollectionReviewFilter = {
  documentId: CollectionId | 'all';
  status: CollectionReviewStatus | 'all';
  query: string;
};
const SHA = /^[0-9a-f]{64}$/;
const FORMAT = 'noticebridge-collection-native-review';
const POLICY = 'Personal review annotations bound to native source text; not a certification of accuracy or authority.';

function invalid(): never { throw new Error('Invalid or mismatched collection evidence review.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) invalid();
  return raw;
}
function isStatus(value: unknown): value is CollectionReviewStatus {
  return typeof value === 'string' && COLLECTION_REVIEW_STATUSES.includes(value as CollectionReviewStatus);
}
export function validCollectionReviewNote(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_COLLECTION_REVIEW_NOTE &&
    !/[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u.test(value);
}
function safeNumber(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
function isHash(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}
export function collectionReviewKey(documentId: CollectionId, source: Pick<Passage, 'page' | 'ordinal'>): string {
  if (!isHash(documentId) || !safeNumber(source.page, 80) || !safeNumber(source.ordinal, 999999)) invalid();
  return documentId + ':' + source.page + ':' + source.ordinal;
}
function documentIds(documents: readonly CollectionDocument[]): string[] {
  collectionStats(documents);
  if (!documents.length) invalid();
  return documents.map(doc => doc.id).sort();
}
function validateEntries(documents: readonly CollectionDocument[], entries: readonly CollectionReviewEntry[]): void {
  documentIds(documents);
  if (!Array.isArray(entries) || entries.length > MAX_COLLECTION_REVIEW_ITEMS) invalid();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || !isStatus(entry.status) || !validCollectionReviewNote(entry.note)) invalid();
    collectionCitation(documents, entry.documentId, entry.source);
    const key = collectionReviewKey(entry.documentId, entry.source);
    if (seen.has(key)) invalid();
    seen.add(key);
  }
}

/** Resolve against the actual attached source before saving. An identical
 * page, ordinal and quote in a different PDF is still a different entry. */
export function pinCollectionEvidence(documents: readonly CollectionDocument[],
  entries: readonly CollectionReviewEntry[], documentId: CollectionId, source: Passage): CollectionReviewEntry[] {
  validateEntries(documents, entries);
  const local = collectionCitation(documents, documentId, source).source;
  const key = collectionReviewKey(documentId, local);
  if (entries.some(entry => collectionReviewKey(entry.documentId, entry.source) === key)) return [...entries];
  if (entries.length >= MAX_COLLECTION_REVIEW_ITEMS) throw new Error('Collection evidence review limit reached.');
  return [...entries, { documentId, source: local, status: 'unreviewed', note: '' }];
}
export function updateCollectionEvidence(entries: readonly CollectionReviewEntry[], key: string,
  change: { status?: CollectionReviewStatus; note?: string }): CollectionReviewEntry[] {
  if (!change || (change.status !== undefined && !isStatus(change.status)) ||
      (change.note !== undefined && !validCollectionReviewNote(change.note))) invalid();
  if (!entries.some(entry => collectionReviewKey(entry.documentId, entry.source) === key)) invalid();
  return entries.map(entry => collectionReviewKey(entry.documentId, entry.source) === key ? {
    ...entry, status: change.status ?? entry.status, note: change.note ?? entry.note,
  } : entry);
}
export function removeCollectionEvidence(entries: readonly CollectionReviewEntry[], key: string): CollectionReviewEntry[] {
  return entries.filter(entry => collectionReviewKey(entry.documentId, entry.source) !== key);
}
export function removeDocumentReviews(entries: readonly CollectionReviewEntry[], id: CollectionId): CollectionReviewEntry[] {
  if (!isHash(id)) invalid();
  return entries.filter(entry => entry.documentId !== id);
}
export function collectionReviewCounts(entries: readonly CollectionReviewEntry[]) {
  const counts: Record<CollectionReviewStatus, number> = { unreviewed: 0, reviewed_manually: 0, needs_followup: 0 };
  for (const entry of entries) {
    if (!isStatus(entry.status)) invalid();
    counts[entry.status]++;
  }
  return counts;
}
export function filterCollectionReviews(entries: readonly CollectionReviewEntry[], filter: CollectionReviewFilter) {
  if (!filter || (filter.documentId !== 'all' && !isHash(filter.documentId)) ||
      (filter.status !== 'all' && !isStatus(filter.status)) ||
      typeof filter.query !== 'string' || filter.query.length > 100) invalid();
  const needle = filter.query.trim().toLowerCase();
  return entries.filter(entry =>
    (filter.documentId === 'all' || entry.documentId === filter.documentId) &&
    (filter.status === 'all' || entry.status === filter.status) &&
    (!needle || entry.source.text.toLowerCase().includes(needle) || entry.note.toLowerCase().includes(needle)));
}
export const COLLECTION_REVIEW_PAGE_SIZE = 8;
export function collectionReviewPage(entries: readonly CollectionReviewEntry[], page: number) {
  const pages = Math.max(1, Math.ceil(entries.length / COLLECTION_REVIEW_PAGE_SIZE));
  if (!safeNumber(page, pages)) invalid();
  const offset = (page - 1) * COLLECTION_REVIEW_PAGE_SIZE;
  const rows = entries.slice(offset, offset + COLLECTION_REVIEW_PAGE_SIZE);
  return { rows, pages, page, first: rows.length ? offset + 1 : 0, last: offset + rows.length };
}

async function textHash(text: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!globalThis.crypto?.subtle) throw new Error('Collection review requires local SHA-256 support.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  signal?.throwIfAborted();
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
type WireEntry = {
  document_id: string;
  page: number;
  ordinal: number;
  text_sha256: string;
  status: CollectionReviewStatus;
  note: string;
};
function bound(text: string): void {
  if (!text || text.length > MAX_COLLECTION_REVIEW_BYTES ||
      new TextEncoder().encode(text).byteLength > MAX_COLLECTION_REVIEW_BYTES) invalid();
}
function encode(ids: string[], rows: WireEntry[]): string {
  const text = JSON.stringify({
    format: FORMAT, version: 1, policy: POLICY, authority_verified: false, source_ids: ids, entries: rows,
  }, null, 2) + '\n';
  bound(text);
  return text;
}
export async function serializeCollectionReview(documents: readonly CollectionDocument[],
  entries: readonly CollectionReviewEntry[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  validateEntries(documents, entries);
  if (!entries.length) invalid();
  const ids = documentIds(documents);
  const rows: WireEntry[] = [];
  for (const entry of entries) {
    const { documentId, source, status, note } = entry;
    rows.push({ document_id: documentId, page: source.page, ordinal: source.ordinal,
      text_sha256: await textHash(source.text, signal), status, note });
  }
  signal?.throwIfAborted();
  return encode(ids, rows);
}

/** Reconstruct from the live collection, never from exported quote text.
 * Complete attachment set, canonical encoding and each quote hash must
 * match. This function does not change the current review notebook. */
export async function parseCollectionReview(text: string, documents: readonly CollectionDocument[],
  signal?: AbortSignal): Promise<CollectionReviewEntry[]> {
  signal?.throwIfAborted();
  bound(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  const raw = object(parsed, ['format', 'version', 'policy', 'authority_verified', 'source_ids', 'entries']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY ||
      raw.authority_verified !== false || !Array.isArray(raw.source_ids) ||
      !Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > MAX_COLLECTION_REVIEW_ITEMS) invalid();
  const ids = documentIds(documents);
  if (raw.source_ids.length !== ids.length || raw.source_ids.some((id, i) => id !== ids[i])) invalid();
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  const seen = new Set<string>();
  const rows: WireEntry[] = [];
  const entries: CollectionReviewEntry[] = [];
  for (const value of raw.entries) {
    signal?.throwIfAborted();
    const row = object(value, ['document_id', 'page', 'ordinal', 'text_sha256', 'status', 'note']);
    if (!isHash(row.document_id) || !safeNumber(row.page, 80) || !safeNumber(row.ordinal, 999999) ||
        !isHash(row.text_sha256) || !isStatus(row.status) || !validCollectionReviewNote(row.note)) invalid();
    const doc = byId.get(row.document_id);
    const source = doc?.corpus.passages.find(passage => passage.page === row.page && passage.ordinal === row.ordinal);
    if (!doc || !source) invalid();
    const key = collectionReviewKey(doc.id, source);
    if (seen.has(key) || await textHash(source.text, signal) !== row.text_sha256) invalid();
    seen.add(key);
    rows.push({ document_id: doc.id, page: source.page, ordinal: source.ordinal,
      text_sha256: row.text_sha256, status: row.status, note: row.note });
    entries.push({ documentId: doc.id, source, status: row.status, note: row.note });
  }
  if (encode(ids, rows) !== text) invalid();
  signal?.throwIfAborted();
  return entries;
}
export async function loadCollectionReview(file: File, documents: readonly CollectionDocument[],
  signal?: AbortSignal): Promise<CollectionReviewEntry[]> {
  signal?.throwIfAborted();
  if (!file.size || file.size > MAX_COLLECTION_REVIEW_BYTES) invalid();
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_COLLECTION_REVIEW_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return parseCollectionReview(text, documents, signal);
}
