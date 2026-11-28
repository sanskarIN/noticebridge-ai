/** Local user-authored evidence review notebook. No model claims are imported. */
import type { Passage, Role, SearchIndex } from './pdfChatCore';
import { passageId } from './pdfChatResearch';
import type { SourcePins } from './pdfChatSession';

export const MAX_REVIEW_ITEMS = 100;
export const MAX_REVIEW_NOTE = 500;
export const MAX_REVIEW_BYTES = 256 * 1024;
const FORMAT = 'noticebridge-native-evidence-review';
const SHA = /^[0-9a-f]{64}$/;
const ROLES: Role[] = ['original', 'revised'];
const STATUSES = ['unreviewed', 'reviewed_manually', 'needs_followup'] as const;
export type ReviewStatus = typeof STATUSES[number];
export type ReviewEntry = { source: Passage; status: ReviewStatus; note: string };
export type ReviewFilter = { role: Role | 'both'; status: ReviewStatus | 'all' };

function invalid(): never { throw new Error('Invalid or mismatched local evidence review.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(record, key))) invalid();
  return record;
}
function normalizePins(value: unknown): SourcePins {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (!keys.length || keys.some(key => key !== 'original' && key !== 'revised')) invalid();
  const pins: SourcePins = {};
  for (const role of ROLES) {
    if (!Object.prototype.hasOwnProperty.call(raw, role)) continue;
    const pin = raw[role];
    if (typeof pin !== 'string' || !SHA.test(pin)) invalid();
    pins[role] = pin;
  }
  return pins;
}
function localSources(index: SearchIndex): Map<string, Passage> {
  const sources = new Map<string, Passage>();
  for (const row of index.rows) {
    const id = passageId(row.passage);
    if (sources.has(id)) invalid();
    sources.set(id, row.passage);
  }
  return sources;
}
function validNote(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_REVIEW_NOTE &&
    !/[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u.test(value);
}
function validStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && STATUSES.includes(value as ReviewStatus);
}
function nativeSource(index: SearchIndex, source: Passage): Passage {
  const id = passageId(source);
  const local = localSources(index).get(id);
  if (!local || local.text !== source.text) invalid();
  return local;
}
export function pinEvidence(index: SearchIndex, entries: readonly ReviewEntry[], source: Passage): ReviewEntry[] {
  const local = nativeSource(index, source);
  const id = passageId(local);
  if (entries.some(entry => passageId(entry.source) === id)) return [...entries];
  if (entries.length >= MAX_REVIEW_ITEMS) throw new Error('Evidence review limit reached.');
  return [...entries, { source: local, status: 'unreviewed', note: '' }];
}
export function removeEvidence(entries: readonly ReviewEntry[], id: string): ReviewEntry[] {
  return entries.filter(entry => passageId(entry.source) !== id);
}
export function updateEvidence(entries: readonly ReviewEntry[], id: string,
  change: { status?: ReviewStatus; note?: string }): ReviewEntry[] {
  if (change.status !== undefined && !validStatus(change.status)) invalid();
  if (change.note !== undefined && !validNote(change.note)) invalid();
  return entries.map(entry => passageId(entry.source) === id ? {
    ...entry, ...(change.status !== undefined ? { status: change.status } : {}),
    ...(change.note !== undefined ? { note: change.note } : {}),
  } : entry);
}
export function filterEvidence(entries: readonly ReviewEntry[], filter: ReviewFilter): ReviewEntry[] {
  return entries.filter(entry => (filter.role === 'both' || entry.source.role === filter.role) &&
    (filter.status === 'all' || entry.status === filter.status));
}
export function reviewCounts(entries: readonly ReviewEntry[]): Record<ReviewStatus, number> {
  const counts: Record<ReviewStatus, number> = { unreviewed: 0, reviewed_manually: 0, needs_followup: 0 };
  for (const entry of entries) counts[entry.status]++;
  return counts;
}
async function textHash(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Evidence review requires HTTPS or localhost.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

type WireEntry = { id: string; text_sha256: string; status: ReviewStatus; note: string };
function encode(pins: SourcePins, rows: WireEntry[]): string {
  const text = JSON.stringify({
    format: FORMAT, version: 1, sources: pins, entries: rows, authority_verified: false,
  }, null, 2) + '\n';
  if (new TextEncoder().encode(text).length > MAX_REVIEW_BYTES) invalid();
  return text;
}

/** Serialize only user notes, local identity and hashes. Source quotes
 * and PDF bytes are not written. Review flags are user annotations only.
 */
export async function serializeReview(index: SearchIndex, pins: SourcePins,
  entries: readonly ReviewEntry[]): Promise<string> {
  const sources = localSources(index);
  const normalized = normalizePins(pins);
  if (!entries.length || entries.length > MAX_REVIEW_ITEMS) invalid();
  const seen = new Set<string>();
  const rows: WireEntry[] = [];
  for (const entry of entries) {
    const id = passageId(entry.source);
    const source = sources.get(id);
    if (!source || source.text !== entry.source.text || !normalized[source.role] ||
        seen.has(id) || !validStatus(entry.status) || !validNote(entry.note)) invalid();
    seen.add(id);
    rows.push({ id, text_sha256: await textHash(source.text), status: entry.status, note: entry.note });
  }
  return encode(normalized, rows);
}

/** Import a draft only after exact PDF-byte pins and every extracted-text
 * hash match. Review flags are not independent authority verdicts.
 */
export async function parseReview(text: string, index: SearchIndex, pins: SourcePins): Promise<ReviewEntry[]> {
  if (!text || text.length > MAX_REVIEW_BYTES || new TextEncoder().encode(text).length > MAX_REVIEW_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  const raw = object(parsed, ['format', 'version', 'sources', 'entries', 'authority_verified']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.authority_verified !== false ||
      !Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > MAX_REVIEW_ITEMS) invalid();
  const supplied = normalizePins(raw.sources), current = normalizePins(pins);
  if (ROLES.some(role => supplied[role] !== current[role])) invalid();
  const sources = localSources(index);
  const seen = new Set<string>();
  const rows: WireEntry[] = [];
  const entries: ReviewEntry[] = [];
  for (const value of raw.entries) {
    const row = object(value, ['id', 'text_sha256', 'status', 'note']);
    if (typeof row.id !== 'string' || seen.has(row.id) || typeof row.text_sha256 !== 'string' ||
        !SHA.test(row.text_sha256) || !validStatus(row.status) || !validNote(row.note)) invalid();
    const source = sources.get(row.id);
    if (!source || !current[source.role] || await textHash(source.text) !== row.text_sha256) invalid();
    seen.add(row.id);
    rows.push({ id: row.id, text_sha256: row.text_sha256, status: row.status, note: row.note });
    entries.push({ source, status: row.status, note: row.note });
  }
  if (encode(supplied, rows) !== text) invalid();
  return entries;
}

export async function loadReview(file: File, index: SearchIndex, pins: SourcePins): Promise<ReviewEntry[]> {
  if (!file.size || file.size > MAX_REVIEW_BYTES) invalid();
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_REVIEW_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return parseReview(text, index, pins);
}
