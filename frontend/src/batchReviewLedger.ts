/** Human triage metadata; never modifies or certifies engine evidence. */
import type { BatchIndex, CaseSummary } from './batchIndex';
import { parseStrictJson } from './strictJson';

export const reviewStates = ['unreviewed', 'in_progress', 'follow_up', 'reviewed'] as const;
export type ReviewState = typeof reviewStates[number];
export type MarkedState = Exclude<ReviewState, 'unreviewed'>;
export type ReviewEntry = { case: number; report_sha256: string; state: MarkedState };
export type ReviewLedger = ReadonlyMap<number, ReviewEntry>;
export type ReviewSummary = Record<ReviewState, number>;

export const reviewStateNames: Record<ReviewState, string> = {
  unreviewed: 'Not marked',
  in_progress: 'Review in progress',
  follow_up: 'Needs follow-up',
  reviewed: 'Marked reviewed by user',
};

const MAX_LEDGER_BYTES = 16 * 1024;
const FORMAT = 'noticebridge-batch-review-ledger';
const POLICY = 'Human review markers only; engine replay and issuer authority are not certified.';
const SHA256 = /^[0-9a-f]{64}$/;

export class LedgerError extends Error {
  constructor(readonly code: 'invalid' | 'different' | 'size' | 'crypto') {
    super(code);
  }
}

function fail(code: LedgerError['code'] = 'invalid'): never {
  throw new LedgerError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) fail();
}

function state(value: unknown): MarkedState {
  if (value !== 'in_progress' && value !== 'follow_up' && value !== 'reviewed') fail();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail();
  return value;
}

function caseNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 16) {
    fail();
  }
  return value;
}

function requiredIndexHash(index: BatchIndex): string {
  if (!index.indexHash) fail('crypto');
  return hash(index.indexHash);
}

function validateEntry(entry: ReviewEntry, row: CaseSummary): void {
  if (entry.case !== row.number || entry.report_sha256 !== row.reportHash) fail('different');
  state(entry.state);
}

export function setReviewState(
  ledger: ReviewLedger, row: CaseSummary, value: ReviewState,
): ReviewLedger {
  const next = new Map(ledger);
  if (value === 'unreviewed') {
    next.delete(row.number);
  } else {
    next.set(row.number, { case: row.number, report_sha256: row.reportHash, state: state(value) });
  }
  return next;
}

export function reviewStateFor(ledger: ReviewLedger, row: CaseSummary): ReviewState {
  const entry = ledger.get(row.number);
  return entry?.report_sha256 === row.reportHash ? entry.state : 'unreviewed';
}

export function summarizeReviews(index: BatchIndex, ledger: ReviewLedger): ReviewSummary {
  const counts: ReviewSummary = { unreviewed: 0, in_progress: 0, follow_up: 0, reviewed: 0 };
  for (const row of index.cases) counts[reviewStateFor(ledger, row)]++;
  return counts;
}

function entries(index: BatchIndex, ledger: ReviewLedger): ReviewEntry[] {
  if (ledger.size > index.completed) fail('different');
  const result: ReviewEntry[] = [];
  for (const [number, entry] of ledger) {
    const row = index.cases.find(item => item.number === number);
    if (!row || number !== entry.case) fail('different');
    validateEntry(entry, row);
    result.push({ ...entry });
  }
  return result.sort((a, b) => a.case - b.case);
}

export function serializeLedger(index: BatchIndex, ledger: ReviewLedger): string {
  return JSON.stringify({
    format: FORMAT,
    version: 1,
    index_sha256: requiredIndexHash(index),
    manifest_sha256: index.manifestHash,
    case_count: index.total,
    completed_count: index.completed,
    authority_verified: false,
    engine_replayed: false,
    policy: POLICY,
    reviews: entries(index, ledger),
  }, null, 2) + '\n';
}

export function restoreLedger(input: unknown, index: BatchIndex): ReviewLedger {
  const raw = record(input);
  exact(raw, [
    'format', 'version', 'index_sha256', 'manifest_sha256', 'case_count',
    'completed_count', 'authority_verified', 'engine_replayed', 'policy', 'reviews',
  ]);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.authority_verified !== false ||
      raw.engine_replayed !== false || raw.policy !== POLICY) fail();
  if (hash(raw.index_sha256) !== requiredIndexHash(index) ||
      hash(raw.manifest_sha256) !== index.manifestHash ||
      raw.case_count !== index.total || raw.completed_count !== index.completed) fail('different');
  if (!Array.isArray(raw.reviews) || raw.reviews.length > index.completed) fail();
  const result = new Map<number, ReviewEntry>();
  for (const value of raw.reviews) {
    const item = record(value);
    exact(item, ['case', 'report_sha256', 'state']);
    const number = caseNumber(item.case);
    const entry = { case: number, report_sha256: hash(item.report_sha256), state: state(item.state) };
    const row = index.cases.find(item => item.number === number);
    if (!row) fail('different');
    if (result.has(number)) fail();
    validateEntry(entry, row);
    result.set(number, entry);
  }
  return result;
}

export async function readLedger(file: File, index: BatchIndex): Promise<ReviewLedger> {
  if (!file.size || file.size > MAX_LEDGER_BYTES) fail('size');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_LEDGER_BYTES) fail('size');
  let raw: unknown;
  try {
    raw = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail();
  }
  return restoreLedger(raw, index);
}

/** CSV is deliberately quote-free: identifiers, counts, fingerprints and
 * fixed review labels only. No spreadsheet formulas or user-entered strings.
 */
export function serializeLedgerCsv(index: BatchIndex, ledger: ReviewLedger): string {
  requiredIndexHash(index);
  entries(index, ledger);
  const header = [
    'case', 'report_sha256', 'original_sha256', 'revised_sha256',
    'saved_findings', 'saved_review_tasks', 'saved_warnings', 'text_coverage',
    'human_review_state', 'authority_verified', 'engine_replayed',
  ];
  const rows = index.cases.map(row => [
    row.number, row.reportHash, row.sources.original, row.sources.revised,
    row.findings, row.reviewTasks, row.warnings, row.coverage,
    reviewStateFor(ledger, row), false, false,
  ]);
  return [header, ...rows].map(row => row.map(value =>
    '"' + String(value).replaceAll('"', '""') + '"',
  ).join(',')).join('\r\n') + '\r\n';
}
