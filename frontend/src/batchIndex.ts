/** Read local batch exports as untrusted data. No PDF engine replay occurs here. */
export const MAX_INDEX_BYTES = 128 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_PREVIEW_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_CASES = 16;
const MAX_FINDING_PREVIEW = 100;
const MAX_QUOTE = 2000;
const SHA256 = /^[0-9a-f]{64}$/;

export const statuses = [
  'confirmed_change', 'possible_change', 'contradiction', 'missing_information',
] as const;
export type Status = typeof statuses[number];
export type Counts = Record<Status, number>;
type Coverage = 'all_pages_have_text' | 'partial' | 'inconclusive';
type HashPair = { original: string; revised: string };
type Obj = Record<string, unknown>;

export const statusNames: Record<Status, string> = {
  confirmed_change: 'Matched wording changes',
  possible_change: 'Possible changes',
  contradiction: 'Conflicting dates',
  missing_information: 'Unmatched passages',
};

export const coverageNames: Record<Coverage, string> = {
  all_pages_have_text: 'Every page yielded some text',
  partial: 'Partial text coverage',
  inconclusive: 'Inconclusive extraction',
};

export type CaseSummary = {
  number: number;
  reportName: string;
  reportHash: string;
  sources: HashPair;
  counts: Counts;
  findings: number;
  reviewTasks: number;
  warnings: number;
  coverage: Coverage;
};

export type BatchIndex = {
  manifestHash: string;
  total: number;
  completed: number;
  complete: boolean;
  counts: Counts;
  cases: CaseSummary[];
};

export type Quote = { page: number; text: string };
export type FindingPreview = {
  number: number;
  status: Status;
  category: string;
  original: Quote | null;
  revised: Quote | null;
  supporting: (Quote & { role: 'original' | 'revised' })[];
};

export type ReportPreview = {
  findings: FindingPreview[];
  truncated: boolean;
  count: number;
};

export class BatchReadError extends Error {
  constructor(readonly code: 'format' | 'size' | 'hash' | 'counts' | 'crypto' | 'source') {
    super(code);
  }
}

function fail(code: BatchReadError['code'] = 'format'): never {
  throw new BatchReadError(code);
}

function object(input: unknown): Obj {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail();
  return input as Obj;
}

function exactKeys(value: Obj, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) fail();
}

function count(input: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) ||
      input < 0 || input > max) fail();
  return input;
}

function hash(input: unknown): string {
  if (typeof input !== 'string' || !SHA256.test(input)) fail();
  return input;
}

function boolean(input: unknown): boolean {
  if (typeof input !== 'boolean') fail();
  return input;
}

function status(input: unknown): Status {
  if (typeof input !== 'string' || !statuses.includes(input as Status)) fail();
  return input as Status;
}

function coverage(input: unknown): Coverage {
  if (input !== 'all_pages_have_text' && input !== 'partial' && input !== 'inconclusive') {
    fail();
  }
  return input;
}

function emptyCounts(): Counts {
  return {
    confirmed_change: 0, possible_change: 0, contradiction: 0, missing_information: 0,
  };
}

function counts(input: unknown): Counts {
  const value = object(input);
  exactKeys(value, statuses);
  const result = emptyCounts();
  for (const name of statuses) result[name] = count(value[name], 1_000_000);
  return result;
}

function equalCounts(a: Counts, b: Counts): boolean {
  return statuses.every(name => a[name] === b[name]);
}

function sum(value: Counts): number {
  return statuses.reduce((total, name) => total + value[name], 0);
}

function pair(input: unknown): HashPair {
  const value = object(input);
  exactKeys(value, ['original', 'revised']);
  return { original: hash(value.original), revised: hash(value.revised) };
}

function equalPair(a: HashPair, b: HashPair): boolean {
  return a.original === b.original && a.revised === b.revised;
}

function parseCase(input: unknown, number: number): CaseSummary {
  const row = object(input);
  exactKeys(row, [
    'case', 'report', 'format', 'source_fingerprints', 'status_counts', 'total_findings',
    'review_tasks', 'warning_count', 'text_coverage', 'semantic_assistance',
    'report_sha256', 'authority_verified', 'notice',
  ]);
  const reportName = 'case-' + String(number).padStart(3, '0') + '.json';
  if (row.case !== number || row.report !== reportName ||
      row.format !== 'noticebridge-local-comparison-summary' ||
      row.semantic_assistance !== 'not_requested' || row.authority_verified !== false ||
      typeof row.notice !== 'string' || row.notice.length > 500) fail();
  const findingCounts = counts(row.status_counts);
  const findings = count(row.total_findings, 1_000_000);
  const reviewTasks = count(row.review_tasks, findings);
  if (sum(findingCounts) !== findings) fail('counts');
  return {
    number, reportName, reportHash: hash(row.report_sha256),
    sources: pair(row.source_fingerprints), counts: findingCounts,
    findings, reviewTasks, warnings: count(row.warning_count, 1_000_000),
    coverage: coverage(row.text_coverage),
  };
}

export function parseIndex(input: unknown): BatchIndex {
  const index = object(input);
  exactKeys(index, [
    'format', 'version', 'manifest_sha256', 'case_count', 'completed_count',
    'complete', 'authority_verified', 'status_counts', 'cases',
  ]);
  if (index.format !== 'noticebridge-batch-index' || index.version !== 1 ||
      index.authority_verified !== false) fail();
  const total = count(index.case_count, MAX_CASES);
  const completed = count(index.completed_count, total);
  const complete = boolean(index.complete);
  if (!total || complete !== (completed === total) ||
      !Array.isArray(index.cases) || index.cases.length !== completed) fail('counts');
  const cases = index.cases.map((row, i) => parseCase(row, i + 1));
  const observed = emptyCounts();
  for (const row of cases) {
    for (const name of statuses) observed[name] += row.counts[name];
  }
  const expected = counts(index.status_counts);
  if (!equalCounts(observed, expected)) fail('counts');
  return { manifestHash: hash(index.manifest_sha256), total, completed, complete,
    counts: expected, cases };
}

async function fileBytes(file: File, limit: number): Promise<ArrayBuffer> {
  if (!file.size || file.size > limit) fail('size');
  const data = await file.arrayBuffer();
  if (data.byteLength !== file.size || !data.byteLength || data.byteLength > limit) fail('size');
  return data;
}

function decode(data: ArrayBuffer): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return JSON.parse(text) as unknown;
  } catch {
    return fail();
  }
}

async function fingerprint(data: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) fail('crypto');
  const result = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readIndex(file: File): Promise<BatchIndex> {
  return parseIndex(decode(await fileBytes(file, MAX_INDEX_BYTES)));
}

function relativePdf(input: unknown): void {
  if (typeof input !== 'string' || !input || input.length > 240 ||
      !input.toLowerCase().endsWith('.pdf') || /[\\:\x00-\x1f]/.test(input) ||
      input.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail();
}

export async function checkManifest(file: File, index: BatchIndex): Promise<void> {
  const data = await fileBytes(file, MAX_MANIFEST_BYTES);
  if (await fingerprint(data) !== index.manifestHash) fail('hash');
  const value = object(decode(data));
  exactKeys(value, ['version', 'cases']);
  if (value.version !== 1 || !Array.isArray(value.cases) || value.cases.length !== index.total) {
    fail();
  }
  const seen = new Set<string>();
  value.cases.forEach((item, i) => {
    const entry = object(item);
    exactKeys(entry, ['original', 'revised', 'original_sha256', 'revised_sha256']);
    relativePdf(entry.original);
    relativePdf(entry.revised);
    const sources = { original: hash(entry.original_sha256), revised: hash(entry.revised_sha256) };
    const key = sources.original + sources.revised;
    if (seen.has(key)) fail();
    seen.add(key);
    if (i < index.completed && !equalPair(sources, index.cases[i].sources)) fail('source');
  });
}

function quote(input: unknown, role: 'original' | 'revised'): Quote | null {
  if (input === null) return null;
  const value = object(input);
  if (value.document_id !== role || value.extraction_method !== 'native' ||
      typeof value.text !== 'string' || !value.text.trim()) fail();
  const page = count(value.page, 80);
  if (!page) fail();
  const text = value.text.length > MAX_QUOTE ? value.text.slice(0, MAX_QUOTE) + '…' : value.text;
  return { page, text };
}

function checkSourceDocuments(input: unknown, expected: HashPair): void {
  if (!Array.isArray(input) || input.length !== 2) fail('source');
  const [old, revised] = input.map(object);
  if (old.id !== 'original' || revised.id !== 'revised' ||
      old.sha256 !== expected.original || revised.sha256 !== expected.revised) fail('source');
  for (const document of [old, revised]) {
    if (document.ocr_page_count !== 0 || !Array.isArray(document.ocr_override_pages) ||
        document.ocr_override_pages.length !== 0 ||
        !Array.isArray(document.ocr_pages) || document.ocr_pages.length !== 0) fail('source');
  }
}

/** Cross-check selected report bytes and derived counters against a saved index.
 * This is not full engine-schema validation or independent source verification.
 */
export async function inspectReport(file: File, row: CaseSummary): Promise<ReportPreview> {
  const data = await fileBytes(file, MAX_PREVIEW_REPORT_BYTES);
  if (await fingerprint(data) !== row.reportHash) fail('hash');
  const report = object(decode(data));
  if (report.automatic_ocr !== false || report.semantic_assistance !== 'not_requested' ||
      report.text_coverage !== row.coverage) fail();
  checkSourceDocuments(report.documents, row.sources);
  if (!Array.isArray(report.findings) || !Array.isArray(report.checklist) ||
      !Array.isArray(report.warnings) || report.findings.length !== row.findings ||
      report.warnings.length !== row.warnings) fail('counts');
  const observed = emptyCounts();
  const ids = new Set<string>();
  const findings: FindingPreview[] = [];
  report.findings.forEach((input, i) => {
    const item = object(input);
    const kind = status(item.status);
    observed[kind]++;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 200 ||
        ids.has(item.id) || item.authority_verified !== false ||
        (item.match_method !== 'deterministic' && item.match_method !== 'explicit_amendment') ||
        !['deadline', 'eligibility', 'fee', 'time', 'instruction', 'general'].includes(
          typeof item.category === 'string' ? item.category : '',
        )) fail();
    ids.add(item.id);
    const original = quote(item.original, 'original');
    const revised = quote(item.revised, 'revised');
    if (!Array.isArray(item.supporting_evidence) || item.supporting_evidence.length > 2) fail();
    const supporting = item.supporting_evidence.map(input => {
      const evidence = object(input);
      const role = evidence.document_id;
      if (role !== 'original' && role !== 'revised') fail();
      const parsed = quote(evidence, role);
      if (!parsed) fail();
      return { ...parsed, role };
    });
    if (kind === 'contradiction') {
      if (original || revised || supporting.length !== 2 ||
          supporting[0].role !== supporting[1].role ||
          supporting[0].page !== supporting[1].page) fail();
    } else if ((!original && !revised) || supporting.length) fail();
    if (i < MAX_FINDING_PREVIEW) findings.push({
      number: i + 1, status: kind, category: item.category as string,
      original, revised, supporting,
    });
  });
  if (!equalCounts(observed, row.counts)) fail('counts');
  const checklistIds = new Set<string>();
  let tasks = 0;
  for (const input of report.checklist) {
    const item = object(input);
    if (typeof item.finding_id !== 'string' || !ids.has(item.finding_id) ||
        checklistIds.has(item.finding_id)) fail();
    checklistIds.add(item.finding_id);
    if (boolean(item.requires_human_verification)) tasks++;
  }
  if (tasks !== row.reviewTasks || !report.warnings.every(item => typeof item === 'string')) {
    fail('counts');
  }
  return { findings, truncated: row.findings > MAX_FINDING_PREVIEW, count: row.findings };
}
