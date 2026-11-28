/** Private source-bound alignment exchange. Imported observations are
 * never trusted: reconstruct them from the independently supplied native
 * snapshot and compare the entire canonical report.
 */
import type { Passage, SearchIndex } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import type { SourcePins } from './pdfChatSession';
import { parseCorpusSnapshot, serializeCorpusSnapshot, indexCorpusSnapshot, type CorpusSnapshot } from './pdfChatCorpusSnapshot';
import { analyzeAlignment, normalizeAlignmentLedger, summarizeAlignment,
  type AlignmentLedger, type AlignmentResult, type AlignmentSummary } from './pdfChatAlignment';

export const MAX_ALIGNMENT_REPORT_BYTES = 4 * 1024 * 1024;
const FORMAT = 'noticebridge-private-evidence-alignment';
const POLICY = 'Manually selected evidence groups and personal annotations only. Exact wording counts do not establish changes, absence, applicability or official authority.';
export type VerifiedAlignment = { groups: AlignmentLedger; results: AlignmentResult[]; summary: AlignmentSummary };
function invalid(): never { throw new Error('Invalid or mismatched private evidence alignment report.'); }
function bound(text: string) {
  if (!text || text.length > MAX_ALIGNMENT_REPORT_BYTES ||
      new TextEncoder().encode(text).length > MAX_ALIGNMENT_REPORT_BYTES) invalid();
  return text;
}
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
async function hash(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) invalid();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    value => value.toString(16).padStart(2, '0')).join('');
}
function sourceWire(source: Passage) {
  return { role: source.role, physical_page: source.page, fragment_ordinal: source.ordinal,
    native_text: source.text, ...(source.position ? { position: {
      x0: source.position.x0, x1: source.position.x1, y: source.position.y, height: source.position.height,
    } } : {}) };
}
function resultWire(result: AlignmentResult) {
  const side = (fragments: AlignmentResult['original']) => fragments.map(fragment => ({
    id: fragment.id, shared_group_count: fragment.sharedGroupCount, ...sourceWire(fragment.source),
  }));
  return {
    id: result.group.id, state: result.state,
    original: side(result.original), revised: side(result.revised),
    identical_occurrences: result.identicalOccurrences,
    original_only_occurrences: result.originalOnlyOccurrences,
    revised_only_occurrences: result.revisedOnlyOccurrences,
    // Text is already represented in source rows. Count groups are bound
    // by selected fragment IDs rather than duplicating every excerpt.
    observations: result.observations.map(row => ({
      original_ids: row.originalIds, revised_ids: row.revisedIds,
      identical_occurrences: row.identicalOccurrenceCount,
      original_only_occurrences: row.originalOnlyCount, revised_only_occurrences: row.revisedOnlyCount,
    })),
    literal_diff_status: result.literalDiffStatus,
    literal_diff: result.literalDiff ? {
      identical: result.literalDiff.identical, same_tokens: result.literalDiff.sameTokens,
      original_tokens: result.literalDiff.originalTokens, revised_tokens: result.literalDiff.revisedTokens,
      repeated_tokens: result.literalDiff.repeatedTokens,
      original_segments: result.literalDiff.originalSegments,
      revised_segments: result.literalDiff.revisedSegments,
      changed_numeric: result.changedNumeric,
    } : null,
  };
}
function sourceCoverage(snapshot: CorpusSnapshot) {
  if (snapshot.attached.length !== 2 || !snapshot.pins.original || !snapshot.pins.revised) invalid();
  return snapshot.attached.map(role => {
    const corpus = snapshot.corpora[role]!;
    return { role, sha256: snapshot.pins[role]!, physical_pages: corpus.pageCount,
      processed_pages: corpus.processedPages, missing_pages: [...corpus.missingPages],
      limited_pages: [...corpus.limitedPages], limited: corpus.limited };
  });
}
async function build(snapshotText: string, input: AlignmentLedger) {
  const snapshot = parseCorpusSnapshot(snapshotText);
  const source_coverage = sourceCoverage(snapshot);
  const groups = normalizeAlignmentLedger(input);
  const results = analyzeAlignment(indexCorpusSnapshot(snapshot), groups);
  const summary = summarizeAlignment(results);
  const text = bound(encode({
    format: FORMAT, version: 1, policy: POLICY, authority_verified: false,
    snapshot_sha256: await hash(snapshotText), source_coverage, groups, summary,
    results: results.map(resultWire),
  }));
  return { text, verified: { groups, results, summary } satisfies VerifiedAlignment };
}
export async function serializeAlignmentReport(index: SearchIndex, pins: SourcePins, corpora: ChatCorpora,
  groups: AlignmentLedger, displayed: AlignmentResult[], consent: boolean): Promise<string> {
  if (consent !== true) invalid();
  const actual = analyzeAlignment(index, groups);
  const built = await build(serializeCorpusSnapshot(pins, corpora), groups);
  const expected = encode(built.verified.results.map(resultWire));
  if (encode(actual.map(resultWire)) !== expected ||
      encode(displayed.map(resultWire)) !== expected ||
      encode(displayed.map(row => row.group)) !== encode(built.verified.groups)) invalid();
  return built.text;
}
export async function verifyAlignmentReport(text: string, snapshotText: string): Promise<VerifiedAlignment> {
  bound(text);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  const keys = ['format', 'version', 'policy', 'authority_verified', 'snapshot_sha256',
    'source_coverage', 'groups', 'summary', 'results'];
  if (Object.keys(raw).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key)) ||
      raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY || raw.authority_verified !== false ||
      typeof raw.snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.snapshot_sha256)) invalid();
  parseCorpusSnapshot(snapshotText);
  if (raw.snapshot_sha256 !== await hash(snapshotText)) invalid();
  const built = await build(snapshotText, normalizeAlignmentLedger(raw.groups));
  if (built.text !== text) invalid();
  return built.verified;
}
export async function verifyAttachedAlignmentReport(text: string, pins: SourcePins,
  corpora: ChatCorpora, index: SearchIndex): Promise<VerifiedAlignment> {
  const verified = await verifyAlignmentReport(text, serializeCorpusSnapshot(pins, corpora));
  if (encode(analyzeAlignment(index, verified.groups).map(resultWire)) !==
      encode(verified.results.map(resultWire))) invalid();
  return verified;
}
export async function readAlignmentFile(file: File): Promise<string> {
  if (!file.size || file.size > MAX_ALIGNMENT_REPORT_BYTES) invalid();
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_ALIGNMENT_REPORT_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return bound(text);
}
