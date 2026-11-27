/** Portable human review packet with explicit excerpts and untrusted notes.
 * Separate from the quote-free editable notebook. Never restore chat answers
 * or claim official authenticity from a packet.
 */
import { pageCoverage, type Role, type SearchIndex } from './pdfChatCore';
import { serializeCorpusSnapshot, parseCorpusSnapshot, indexCorpusSnapshot } from './pdfChatCorpusSnapshot';
import { serializeReview, parseReview, reviewCounts, type ReviewEntry, type ReviewStatus } from './pdfChatReviewWorkspace';
import { passageId } from './pdfChatResearch';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import type { SourcePins } from './pdfChatSession';

export const MAX_PACKET_BYTES = 1024 * 1024;
export const MAX_PACKET_HTML_BYTES = 2 * 1024 * 1024;
const FORMAT = 'noticebridge-private-review-packet';
const POLICY = 'Native extraction excerpts and personal notes; verify actual PDF pages and official publication.';
const ROLES: Role[] = ['original', 'revised'];
const SHA = /^[a-f0-9]{64}$/;
const statusNames: Record<ReviewStatus, string> = {
  unreviewed: 'Not yet reviewed', reviewed_manually: 'Reviewed manually', needs_followup: 'Needs follow-up',
};
export type PacketSource = {
  role: Role;
  sha256: string;
  physical_pages: number;
  processed_pages: number;
  missing_pages: number[];
  limited_pages: number[];
  limited: boolean;
};
export type PacketEntry = {
  id: string;
  role: Role;
  physical_page: number;
  fragment_ordinal: number;
  native_text: string;
  native_text_sha256: string;
  page_coverage: ReturnType<typeof pageCoverage>;
  review_status: ReviewStatus;
  user_note: string;
};
export type EvidencePacket = {
  format: typeof FORMAT;
  version: 1;
  policy: typeof POLICY;
  authority_verified: false;
  snapshot_sha256: string;
  sources: PacketSource[];
  counts: Record<ReviewStatus, number>;
  entries: PacketEntry[];
};
export type VerifiedPacket = { packet: EvidencePacket; reviewEntries: ReviewEntry[] };
function invalid(): never { throw new Error('Invalid or mismatched evidence review packet.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  return row;
}
async function digest(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) invalid();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function bound(text: string, maximum: number) {
  if (!text || text.length > maximum || new TextEncoder().encode(text).length > maximum) invalid();
}
function sourcesFor(pins: SourcePins, corpora: ChatCorpora): PacketSource[] {
  return ROLES.flatMap(role => {
    const corpus = corpora[role], pin = pins[role];
    if (Boolean(corpus) !== Boolean(pin)) invalid();
    if (!corpus || !pin) return [];
    return [{ role, sha256: pin, physical_pages: corpus.pageCount,
      processed_pages: corpus.processedPages, missing_pages: [...corpus.missingPages],
      limited_pages: [...corpus.limitedPages], limited: corpus.limited }];
  });
}
function exactIndex(index: SearchIndex, snapshotIndex: SearchIndex) {
  const local = new Map(index.rows.map(row => [passageId(row.passage), row.passage]));
  if (local.size !== index.rows.length || local.size !== snapshotIndex.rows.length) invalid();
  for (const row of snapshotIndex.rows) {
    const source = local.get(passageId(row.passage));
    if (!source || source.text !== row.passage.text) invalid();
  }
}

/** Every exported quote is reconstructed from the canonical current
 * index. The snapshot hash binds the extraction as well as PDF bytes.
 */
export async function buildEvidencePacket(index: SearchIndex, pins: SourcePins, corpora: ChatCorpora,
  entries: readonly ReviewEntry[], consent: boolean): Promise<EvidencePacket> {
  if (consent !== true) invalid();
  const snapshotText = serializeCorpusSnapshot(pins, corpora);
  const snapshot = parseCorpusSnapshot(snapshotText);
  const snapshotIndex = indexCorpusSnapshot(snapshot);
  exactIndex(index, snapshotIndex);
  // Use the notebook's independently enforced identity, note and status
  // budgets, then reconstruct authoritative local quote bytes.
  const validated = await parseReview(await serializeReview(index, pins, entries), snapshotIndex, pins);
  const packetEntries: PacketEntry[] = [];
  for (const entry of validated) {
    const source = entry.source;
    const corpus = corpora[source.role];
    if (!corpus) invalid();
    packetEntries.push({
      id: passageId(source), role: source.role, physical_page: source.page, fragment_ordinal: source.ordinal,
      native_text: source.text, native_text_sha256: await digest(source.text),
      page_coverage: pageCoverage(corpus, source.page), review_status: entry.status, user_note: entry.note,
    });
  }
  const packet: EvidencePacket = { format: FORMAT, version: 1, policy: POLICY,
    authority_verified: false, snapshot_sha256: await digest(snapshotText),
    sources: sourcesFor(pins, corpora), counts: reviewCounts(validated), entries: packetEntries };
  bound(encode(packet), MAX_PACKET_BYTES);
  return packet;
}
export async function serializeEvidencePacket(index: SearchIndex, pins: SourcePins, corpora: ChatCorpora,
  entries: readonly ReviewEntry[], consent: boolean): Promise<string> {
  return encode(await buildEvidencePacket(index, pins, corpora, entries, consent));
}

/** Inspect a packet against an exact native corpus snapshot. All redundant
 * identities, text, counts, coverage and fingerprints are reconstructed.
 * Imported review statuses are merely authored annotations.
 */
export async function verifyEvidencePacket(text: string, snapshotText: string): Promise<VerifiedPacket> {
  bound(text, MAX_PACKET_BYTES);
  const snapshot = parseCorpusSnapshot(snapshotText);
  const index = indexCorpusSnapshot(snapshot);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const raw = object(value, ['format', 'version', 'policy', 'authority_verified', 'snapshot_sha256',
    'sources', 'counts', 'entries']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY || raw.authority_verified !== false ||
      typeof raw.snapshot_sha256 !== 'string' || !SHA.test(raw.snapshot_sha256) ||
      raw.snapshot_sha256 !== await digest(snapshotText) || !Array.isArray(raw.entries) ||
      !raw.entries.length || raw.entries.length > 100) invalid();
  const sourceMap = new Map(index.rows.map(row => [passageId(row.passage), row.passage]));
  const entries: ReviewEntry[] = [];
  for (const value of raw.entries) {
    const row = object(value, ['id', 'role', 'physical_page', 'fragment_ordinal', 'native_text',
      'native_text_sha256', 'page_coverage', 'review_status', 'user_note']);
    const source = typeof row.id === 'string' ? sourceMap.get(row.id) : undefined;
    if (!source || typeof row.user_note !== 'string' ||
        !Object.prototype.hasOwnProperty.call(statusNames, String(row.review_status))) invalid();
    entries.push({ source, status: row.review_status as ReviewStatus, note: row.user_note });
  }
  const reconstructed = await buildEvidencePacket(index, snapshot.pins, snapshot.corpora, entries, true);
  if (encode(reconstructed) !== text) invalid();
  return { packet: reconstructed, reviewEntries: entries };
}
export async function readEvidencePacket(file: File, snapshotText: string): Promise<VerifiedPacket> {
  if (!file.size || file.size > MAX_PACKET_BYTES) invalid();
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_PACKET_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return verifyEvidencePacket(text, snapshotText);
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function coverageName(value: PacketEntry['page_coverage']): string {
  if (value === 'some_text') return 'Some indexed native text';
  if (value === 'limited') return 'Partial native indexing';
  if (value === 'no_indexed_text') return 'No indexed native text';
  if (value === 'not_indexed') return 'Not indexed';
  return 'Physical page not present';
}
function listPages(value: number[]): string { return value.length ? value.join(', ') : 'None recorded'; }

/** Printable static document with no script, external resources, forms,
 * active links or markup from user notes. The JSON packet is the
 * independently checkable artifact; HTML is only its reading copy.
 */
export function renderPacketHtml(packet: EvidencePacket): string {
  const parts: string[] = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; base-uri &apos;none&apos;; form-action &apos;none&apos;">',
    '<meta name="referrer" content="no-referrer">',
    '<title>NoticeBridge AI — private evidence review packet</title>',
    '<style>',
    'body{font:16px/1.55 system-ui,sans-serif;color:#19242f;background:#fff;max-width:900px;margin:32px auto;padding:0 24px}',
    'h1,h2,h3{line-height:1.2}h1{font-size:30px}h2{font-size:22px;border-bottom:1px solid #ced8e1;padding-bottom:8px}',
    '.notice{border-left:4px solid #92621a;background:#fff9ed;padding:12px 16px}',
    '.source,.entry{border:1px solid #ced8e1;border-radius:8px;padding:16px;margin:16px 0}',
    '.muted{color:#485764;font-size:14px}code{font-size:12px;overflow-wrap:anywhere}',
    'blockquote,.note{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:12px 14px;background:#f2f5f8}',
    '.note{background:#fff;border:1px solid #ced8e1}.meta{overflow-wrap:anywhere}',
    '@media print{body{margin:0;padding:0;max-width:none;font-size:11pt}.entry,.source{break-inside:avoid}h2,h3{break-after:avoid}.notice{background:#fff}}',
    '</style></head><body>',
    '<header><h1>Private evidence review packet</h1>',
    '<p class="notice">Native extraction excerpts and personal notes only. Verify the actual PDF pages and official publication. Authority has not been verified. Review statuses are personal annotations.</p>',
    '<p class="muted">Snapshot SHA-256: <code>' + escape(packet.snapshot_sha256) + '</code></p></header>',
    '<section><h2>Source fingerprints and coverage</h2>',
  ];
  for (const source of packet.sources) {
    parts.push('<article class="source"><h3>' + (source.role === 'original' ? 'Original PDF' : 'Revised PDF') + '</h3>',
      '<p>PDF SHA-256: <code>' + escape(source.sha256) + '</code></p>',
      '<p>Physical pages processed: ' + source.processed_pages + ' / ' + source.physical_pages + '</p>',
      '<p>Pages with no indexed text: ' + escape(listPages(source.missing_pages)) + '</p>',
      '<p>Limited pages: ' + escape(listPages(source.limited_pages)) + '</p>',
      '<p>' + (source.limited ? 'Native extraction was limited.' : 'Recorded extraction limits were not reached.') +
      ' Extraction can still omit content.</p></article>');
  }
  parts.push('</section><section><h2>Review entries</h2>',
    '<p>' + packet.entries.length + ' entries · ' + packet.counts.unreviewed + ' not reviewed · ' +
      packet.counts.reviewed_manually + ' reviewed manually · ' + packet.counts.needs_followup + ' need follow-up.</p>');
  for (const [i, row] of packet.entries.entries()) {
    parts.push('<article class="entry"><h3>' + (i + 1) + '. ' + escape(row.id) + '</h3>',
      '<p class="muted">Physical page ' + row.physical_page + ' · fragment ' + row.fragment_ordinal +
      ' · ' + escape(coverageName(row.page_coverage)) + '</p>',
      '<p><strong>Native extracted text</strong></p><blockquote>' + escape(row.native_text) + '</blockquote>',
      '<p class="muted">Text SHA-256: <code>' + escape(row.native_text_sha256) + '</code></p>',
      '<p><strong>User review status:</strong> ' + escape(statusNames[row.review_status]) + '</p>',
      '<p><strong>Personal note (not source evidence)</strong></p>',
      '<div class="note">' + escape(row.user_note || 'No note recorded.') + '</div></article>');
  }
  parts.push('</section><footer><p class="muted">This HTML reading copy is not independently signed. Use the accompanying canonical JSON packet and exact native corpus snapshot for consistency verification. Keep private.</p></footer></body></html>');
  const html = parts.join('\n') + '\n';
  bound(html, MAX_PACKET_HTML_BYTES);
  return html;
}
