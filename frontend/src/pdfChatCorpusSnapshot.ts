/** Private native index snapshots for independent, offline retrieval evaluation.
 * The artifact records extraction output, not a certified transcription of a PDF.
 */
import { buildIndex, MAX_PASSAGES, MAX_PASSAGE_CHARS,
  type Corpus, type Passage, type Role, type TextPosition } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import type { SourcePins } from './pdfChatSession';

export const MAX_CORPUS_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const FORMAT = 'noticebridge-native-corpus-snapshot';
const POLICY = 'Private native extracted text; geometry is a layout hint; not certified PDF transcription.';
const ROLES: Role[] = ['original', 'revised'];
const SHA = /^[a-f0-9]{64}$/;
const MAX_CHARS_PER_SOURCE = 800_000;
const MAX_PHYSICAL_PAGES = 1_000_000;

export type CorpusSnapshot = {
  pins: SourcePins;
  corpora: ChatCorpora;
  passages: Passage[];
  attached: Role[];
};

function invalid(): never { throw new Error('Invalid or oversized native corpus snapshot.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(raw: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(raw).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) invalid();
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9) invalid();
  return value === 0 ? 0 : value;
}
function pageList(value: unknown, processed: number): number[] {
  if (!Array.isArray(value) || value.length > processed) invalid();
  const output = value.map(page => integer(page, 1, processed));
  if (output.some((page, i) => i > 0 && page <= output[i - 1])) invalid();
  return output;
}
function geometry(value: unknown): TextPosition {
  const raw = object(value);
  exact(raw, ['x0', 'x1', 'y', 'height']);
  const position = { x0: finite(raw.x0), x1: finite(raw.x1), y: finite(raw.y), height: finite(raw.height) };
  if (position.x1 <= position.x0 || position.height < 1) invalid();
  return position;
}
function passage(value: unknown, role: Role, processed: number): Passage {
  const raw = object(value);
  const hasPosition = Object.prototype.hasOwnProperty.call(raw, 'position');
  exact(raw, ['role', 'page', 'ordinal', 'text', ...(hasPosition ? ['position'] : [])]);
  if (raw.role !== role || typeof raw.text !== 'string' || !raw.text.trim() ||
      raw.text.trim() !== raw.text || raw.text.length > MAX_PASSAGE_CHARS) invalid();
  // UTF-8 round trip must preserve every UTF-16 unit (reject isolated surrogates).
  if (new TextDecoder().decode(new TextEncoder().encode(raw.text)) !== raw.text) invalid();
  return { role, page: integer(raw.page, 1, processed),
    ordinal: integer(raw.ordinal, 1, 999999), text: raw.text,
    ...(hasPosition ? { position: geometry(raw.position) } : {}) };
}
function source(value: unknown, role: Role): { digest: string; corpus: Corpus } {
  const raw = object(value);
  exact(raw, ['role', 'sha256', 'page_count', 'processed_pages', 'missing_pages',
    'limited_pages', 'limited', 'passages']);
  if (raw.role !== role || typeof raw.sha256 !== 'string' || !SHA.test(raw.sha256) ||
      typeof raw.limited !== 'boolean' || !Array.isArray(raw.passages) ||
      raw.passages.length > MAX_PASSAGES / 2) invalid();
  const pageCount = integer(raw.page_count, 1, MAX_PHYSICAL_PAGES);
  const processedPages = integer(raw.processed_pages, 0, Math.min(pageCount, 80));
  const missingPages = pageList(raw.missing_pages, processedPages);
  const limitedPages = pageList(raw.limited_pages, processedPages);
  if (!raw.limited && (pageCount !== processedPages || limitedPages.length)) invalid();
  const passages = raw.passages.map(value => passage(value, role, processedPages));
  let chars = 0, previousPage = 0, previousOrdinal = 0;
  const present = new Set<number>();
  for (const row of passages) {
    if (row.page < previousPage || (row.page === previousPage && row.ordinal <= previousOrdinal)) invalid();
    chars += row.text.length;
    if (chars > MAX_CHARS_PER_SOURCE) invalid();
    previousPage = row.page;
    previousOrdinal = row.ordinal;
    present.add(row.page);
  }
  const absent = Array.from({ length: processedPages }, (_, index) => index + 1)
    .filter(page => !present.has(page));
  if (absent.join(',') !== missingPages.join(',')) invalid();
  return { digest: raw.sha256, corpus: { pageCount, processedPages, missingPages,
    limitedPages, limited: raw.limited, passages } };
}
function wireSource(role: Role, sha256: string, corpus: Corpus) {
  return {
    role, sha256, page_count: corpus.pageCount, processed_pages: corpus.processedPages,
    missing_pages: [...corpus.missingPages], limited_pages: [...corpus.limitedPages],
    limited: corpus.limited,
    passages: corpus.passages.map(row => ({
      role: row.role, page: row.page, ordinal: row.ordinal, text: row.text,
      ...(row.position ? { position: { x0: row.position.x0, x1: row.position.x1,
        y: row.position.y, height: row.position.height } } : {}),
    })),
  };
}
function bound(text: string): void {
  if (!text || text.length > MAX_CORPUS_SNAPSHOT_BYTES ||
      new TextEncoder().encode(text).length > MAX_CORPUS_SNAPSHOT_BYTES) invalid();
}
function encode(pins: SourcePins, corpora: ChatCorpora): string {
  const sources = ROLES.flatMap(role => {
    const pin = pins[role], corpus = corpora[role];
    if (Boolean(pin) !== Boolean(corpus)) invalid();
    return pin && corpus ? [wireSource(role, pin, corpus)] : [];
  });
  if (!sources.length || Object.keys(pins).length !== sources.length ||
      Object.keys(corpora).length !== sources.length) invalid();
  const text = JSON.stringify({ format: FORMAT, version: 1, policy: POLICY,
    authority_verified: false, sources }, null, 2) + '\n';
  bound(text);
  return text;
}

export function serializeCorpusSnapshot(pins: SourcePins, corpora: ChatCorpora): string {
  const text = encode(pins, corpora);
  // Ensure export satisfies the same strict import contract.
  parseCorpusSnapshot(text);
  return text;
}

export function parseCorpusSnapshot(text: string): CorpusSnapshot {
  bound(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const raw = object(value);
  exact(raw, ['format', 'version', 'policy', 'authority_verified', 'sources']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY ||
      raw.authority_verified !== false || !Array.isArray(raw.sources) ||
      !raw.sources.length || raw.sources.length > 2) invalid();
  const pins: SourcePins = {}, corpora: ChatCorpora = {};
  const attached: Role[] = [], passages: Passage[] = [];
  for (const value of raw.sources) {
    const row = object(value);
    const role = row.role;
    if ((role !== 'original' && role !== 'revised') || attached.includes(role)) invalid();
    const parsed = source(row, role);
    pins[role] = parsed.digest;
    corpora[role] = parsed.corpus;
    attached.push(role);
    passages.push(...parsed.corpus.passages);
  }
  if (text !== encode(pins, corpora)) invalid();
  return { pins, corpora, attached, passages };
}

/** Rebuild rather than trusting stored token counts or search scores. */
export function indexCorpusSnapshot(snapshot: CorpusSnapshot) {
  return buildIndex(snapshot.passages);
}
