/** Replay native snapshots from independently selected original PDF bytes.
 * A snapshot hash is not a claim of issuer authority. A matching PDF hash
 * and extraction are separate checks. The caller supplies the extractor
 * (the browser uses the same bounded PDF.js extractor as document chat).
 */
import { parseCorpusSnapshot, serializeCorpusSnapshot } from './pdfChatCorpusSnapshot';
import { MAX_CHECKLIST_REPORT_BYTES, verifyChecklistReport, type ChecklistReportSummary } from './pdfChatChecklistExchange';
import type { Corpus, Passage, Role } from './pdfChatCore';
import type { AttachedFiles } from './pdfChatSession';

export const MAX_REPLAY_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_REPLAY_REPORT_BYTES = 128 * 1024;
const ROLES: readonly Role[] = ['original', 'revised'];
const POLICY = 'Exact selected PDF bytes and bounded native extraction replay only; not certified transcription, issuer authenticity, or verified answer meaning.';
export type Extractor = (file: File, role: Role, signal: AbortSignal) => Promise<Corpus>;
export type SourceReplayState = 'exact_replay' | 'different_pdf_bytes' | 'different_extraction' |
  'missing_pdf' | 'unexpected_pdf' | 'extraction_failed';
export type ExtractionCounts = {
  expected_fragments: number;
  observed_fragments: number;
  identical_fragments: number;
  changed_text: number;
  changed_geometry: number;
  expected_only: number;
  observed_only: number;
};
export type CoverageComparison = {
  expected_physical_pages: number;
  observed_physical_pages: number;
  expected_processed_pages: number;
  observed_processed_pages: number;
  expected_limited: boolean;
  observed_limited: boolean;
  expected_missing_pages: number[];
  observed_missing_pages: number[];
  expected_limited_pages: number[];
  observed_limited_pages: number[];
  matches: boolean;
};
export type RoleReplay = {
  role: Role;
  state: SourceReplayState;
  expected_sha256: string | null;
  observed_sha256: string | null;
  byte_count: number | null;
  coverage: CoverageComparison | null;
  fragments: ExtractionCounts | null;
};
export type SourceReplayReport = {
  format: 'noticebridge-native-source-replay';
  version: 1;
  policy: string;
  authority_verified: false;
  extraction_completeness_verified: false;
  answer_accuracy_verified: false;
  snapshot_sha256: string;
  source_roles_match: boolean;
  all_pdf_bytes_match: boolean;
  all_native_extractions_match: boolean;
  status: 'exact_replay' | 'not_reproduced';
  sources: RoleReplay[];
  checklist: null | {
    report_sha256: string;
    snapshot_replay_matches: boolean;
    actual_pdf_replay_matches: boolean;
    summary: ChecklistReportSummary | null;
  };
};
export type SourceReplayResult = { report: SourceReplayReport; text: string };
export type ReplayProgress = { role: Role; stage: 'hashing' | 'extracting' | 'compared' };
export type SourceReplayOptions = {
  signal: AbortSignal;
  extract: Extractor;
  checklistReport?: string;
  onProgress?: (progress: ReplayProgress) => void;
};

function invalid(): never { throw new Error('Invalid native source replay input.'); }
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function bounded(text: string): string {
  if (!text || text.length > MAX_SOURCE_REPLAY_REPORT_BYTES ||
      new TextEncoder().encode(text).length > MAX_SOURCE_REPLAY_REPORT_BYTES) invalid();
  return text;
}
async function digest(bytes: BufferSource): Promise<string> {
  if (!globalThis.crypto?.subtle) return invalid();
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hashed, byte => byte.toString(16).padStart(2, '0')).join('');
}
function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function sameGeometry(a: Passage, b: Passage): boolean {
  if (!a.position || !b.position) return Boolean(a.position) === Boolean(b.position);
  return a.position.x0 === b.position.x0 && a.position.x1 === b.position.x1 &&
    a.position.y === b.position.y && a.position.height === b.position.height;
}
function identity(source: Passage): string { return source.role + ':' + source.page + ':' + source.ordinal; }

/** Compare at the same physical fragment identity, without disclosing any
 * text. Text and geometry change counts may overlap; identical is exclusive.
 * Missing and added identities are not claims about semantic changes.
 */
export function compareExtractedFragments(expected: Corpus, observed: Corpus): ExtractionCounts {
  const left = new Map(expected.passages.map(row => [identity(row), row]));
  const right = new Map(observed.passages.map(row => [identity(row), row]));
  if (left.size !== expected.passages.length || right.size !== observed.passages.length) invalid();
  const counts: ExtractionCounts = {
    expected_fragments: left.size, observed_fragments: right.size,
    identical_fragments: 0, changed_text: 0, changed_geometry: 0, expected_only: 0, observed_only: 0,
  };
  for (const [key, a] of left) {
    const b = right.get(key);
    if (!b) { counts.expected_only++; continue; }
    const textMatches = a.text === b.text, geometryMatches = sameGeometry(a, b);
    if (!textMatches) counts.changed_text++;
    if (!geometryMatches) counts.changed_geometry++;
    if (textMatches && geometryMatches) counts.identical_fragments++;
  }
  for (const key of right.keys()) if (!left.has(key)) counts.observed_only++;
  return counts;
}
export function compareExtractionCoverage(expected: Corpus, observed: Corpus): CoverageComparison {
  return {
    expected_physical_pages: expected.pageCount, observed_physical_pages: observed.pageCount,
    expected_processed_pages: expected.processedPages, observed_processed_pages: observed.processedPages,
    expected_limited: expected.limited, observed_limited: observed.limited,
    expected_missing_pages: [...expected.missingPages], observed_missing_pages: [...observed.missingPages],
    expected_limited_pages: [...expected.limitedPages], observed_limited_pages: [...observed.limitedPages],
    matches: expected.pageCount === observed.pageCount && expected.processedPages === observed.processedPages &&
      expected.limited === observed.limited && sameNumbers(expected.missingPages, observed.missingPages) &&
      sameNumbers(expected.limitedPages, observed.limitedPages),
  };
}
function validateFiles(files: AttachedFiles) {
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
      Object.keys(files).some(key => !ROLES.includes(key as Role))) invalid();
  for (const role of ROLES) {
    const file = files[role];
    if (file === undefined) continue;
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_REPLAY_PDF_BYTES ||
        typeof file.name !== 'string' || !file.name.toLowerCase().endsWith('.pdf')) invalid();
  }
}
async function readPdfBytes(file: File, signal: AbortSignal): Promise<{ immutable: File; hash: string }> {
  signal.throwIfAborted();
  const buffer = await file.arrayBuffer();
  signal.throwIfAborted();
  if (buffer.byteLength !== file.size || buffer.byteLength > MAX_REPLAY_PDF_BYTES) invalid();
  // Fingerprint and extract the same immutable bytes, not two independent
  // reads of a disk-backed handle. The filename is never serialized.
  const immutable = new File([buffer], 'source.pdf', { type: 'application/pdf' });
  const hash = await digest(buffer);
  signal.throwIfAborted();
  return { immutable, hash };
}
function roleRecord(role: Role, expected: string | null): RoleReplay {
  return { role, state: 'missing_pdf', expected_sha256: expected,
    observed_sha256: null, byte_count: null, coverage: null, fragments: null };
}
function progress(options: SourceReplayOptions, role: Role, stage: ReplayProgress['stage']) {
  options.signal.throwIfAborted();
  options.onProgress?.({ role, stage });
  options.signal.throwIfAborted();
}
async function replayRole(role: Role, expectedPin: string | undefined, expected: Corpus | undefined,
  file: File | undefined, options: SourceReplayOptions): Promise<RoleReplay | null> {
  if (!expectedPin && !file) return null;
  const result = roleRecord(role, expectedPin ?? null);
  if (!file) return result;
  progress(options, role, 'hashing');
  const { immutable, hash } = await readPdfBytes(file, options.signal);
  result.observed_sha256 = hash;
  result.byte_count = immutable.size;
  if (!expectedPin || !expected) {
    result.state = 'unexpected_pdf';
    progress(options, role, 'compared');
    return result;
  }
  if (hash !== expectedPin) {
    result.state = 'different_pdf_bytes';
    progress(options, role, 'compared');
    return result;
  }
  progress(options, role, 'extracting');
  let observed: Corpus;
  let observedText: string;
  try {
    observed = await options.extract(immutable, role, options.signal);
    options.signal.throwIfAborted();
    // Validate extraction with the same canonical schema before computing
    // diagnostics. Reject duplicate IDs, role swaps and out-of-range pages.
    observedText = serializeCorpusSnapshot({ [role]: hash }, { [role]: observed });
  } catch {
    options.signal.throwIfAborted();
    result.state = 'extraction_failed';
    progress(options, role, 'compared');
    return result;
  }
  const expectedText = serializeCorpusSnapshot({ [role]: expectedPin }, { [role]: expected });
  result.coverage = compareExtractionCoverage(expected, observed);
  result.fragments = compareExtractedFragments(expected, observed);
  result.state = expectedText === observedText ? 'exact_replay' : 'different_extraction';
  progress(options, role, 'compared');
  return result;
}

/** Each role is selected independently. Wrong or extra PDFs are not sent
 * through the extractor. Missing roles remain explicit; partial matches
 * never become an overall success. Re-extraction failure is a distinct
 * outcome, not evidence that any source text is absent.
 */
export async function replayNativeSources(snapshotText: string, files: AttachedFiles,
  options: SourceReplayOptions): Promise<SourceReplayResult> {
  options.signal.throwIfAborted();
  const snapshot = parseCorpusSnapshot(snapshotText);
  validateFiles(files);
  const selected: AttachedFiles = { ...files };
  const snapshot_sha256 = await digest(new TextEncoder().encode(snapshotText));
  const sources: RoleReplay[] = [];
  for (const role of ROLES) {
    const row = await replayRole(role, snapshot.pins[role], snapshot.corpora[role], selected[role], options);
    if (row) sources.push(row);
  }
  options.signal.throwIfAborted();
  const source_roles_match = sources.every(row => row.expected_sha256 !== null && row.observed_sha256 !== null);
  const all_pdf_bytes_match = source_roles_match && sources.every(row => row.expected_sha256 === row.observed_sha256);
  const all_native_extractions_match = all_pdf_bytes_match && sources.every(row => row.state === 'exact_replay');
  let checklist: SourceReplayReport['checklist'] = null;
  if (options.checklistReport !== undefined) {
    // A checklist may independently replay against the saved snapshot even
    // if the actual PDF is missing. Do not confuse the two assurances.
    if (!options.checklistReport || options.checklistReport.length > MAX_CHECKLIST_REPORT_BYTES) invalid();
    const bytes = new TextEncoder().encode(options.checklistReport);
    if (bytes.length > MAX_CHECKLIST_REPORT_BYTES) invalid();
    const report_sha256 = await digest(bytes);
    let summary: ChecklistReportSummary | null = null;
    try { summary = (await verifyChecklistReport(options.checklistReport, snapshotText)).summary; }
    catch { /* Invalid checklist does not erase the separate PDF results. */ }
    checklist = { report_sha256, snapshot_replay_matches: summary !== null,
      actual_pdf_replay_matches: summary !== null && all_native_extractions_match, summary };
  }
  options.signal.throwIfAborted();
  const report: SourceReplayReport = {
    format: 'noticebridge-native-source-replay', version: 1, policy: POLICY,
    authority_verified: false, extraction_completeness_verified: false, answer_accuracy_verified: false,
    snapshot_sha256, source_roles_match, all_pdf_bytes_match, all_native_extractions_match,
    status: all_native_extractions_match && (!checklist || checklist.actual_pdf_replay_matches)
      ? 'exact_replay' : 'not_reproduced',
    sources, checklist,
  };
  return { report, text: bounded(encode(report)) };
}
/** Re-run checks against independently provided inputs; never accept a saved
 * success flag as evidence. The report is deterministic, not signed.
 */
export async function verifyNativeSourceReplay(candidate: string, snapshotText: string,
  files: AttachedFiles, options: SourceReplayOptions): Promise<SourceReplayResult> {
  bounded(candidate);
  const result = await replayNativeSources(snapshotText, files, options);
  if (result.text !== candidate) invalid();
  return result;
}
