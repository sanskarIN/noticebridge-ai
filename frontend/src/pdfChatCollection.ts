/** Independent local document collection. Each PDF gets its own ranker,
 * corpus statistics, coverage and SHA-256 identity. Never invent a version
 * relationship or compare relevance scores across unrelated documents. */
import { answerQuestion, buildIndex, MAX_QUESTION, pageCoverage, pageScopedIndex,
  type Answer, type Corpus, type Passage, type SearchIndex } from './pdfChatCore';
import { parseSearchQuestion, planQuestions, requestedScope } from './pdfChatInsights';
import { validateNativeCorpus } from './pdfChatCorpusSnapshot';

export const MAX_COLLECTION_DOCUMENTS = 6;
export const MAX_COLLECTION_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_COLLECTION_BYTES = 24 * 1024 * 1024;
export const MAX_COLLECTION_PASSAGES = 18_000;
export const MAX_COLLECTION_CHARS = 2_000_000;
export const MAX_COLLECTION_TURNS = 24;
export const MAX_COLLECTION_PLAN_BYTES = 128 * 1024;
export const MAX_COLLECTION_REPORT_BYTES = 8 * 1024 * 1024;

const SHA = /^[a-f0-9]{64}$/;
export type CollectionId = string;
export type PreparedCollectionFile = { id: CollectionId; file: File };
export type CollectionDocument = PreparedCollectionFile & {
  corpus: Corpus;
  index: SearchIndex;
  chars: number;
};
export type CollectionExtractor = (file: File, role: 'original', signal: AbortSignal) => Promise<Corpus>;
export type CollectionStep = { question: string; documentIds: CollectionId[]; includeContext: boolean };
export type CollectionPart = {
  answer: Answer;
  coverage: 'some_text' | 'partial' | 'no_indexed_text' | 'not_present' | 'not_indexed';
};
export type CollectionResult = { documentId: CollectionId; parts: CollectionPart[] };
export type CollectionTurn = { step: CollectionStep; results: CollectionResult[] };
export type CollectionStats = { documents: number; bytes: number; passages: number; chars: number };

const messages = {
  file: 'Select a nonempty PDF up to 10 MiB.',
  crypto: 'Local SHA-256 fingerprinting is unavailable.',
  duplicate: 'These exact PDF bytes are already in the collection.',
  budget: 'The document collection processing budget would be exceeded.',
  extraction: 'Unable to admit the extracted PDF text.',
  question: 'Enter a bounded question and select at least one document. Use document selection rather than version-routing or change-comparison wording.',
  source: 'The selected document or source fragment is not attached.',
  plan: 'Invalid collection question plan or evidence report.',
  size: 'The private collection file exceeds its size budget.',
  different: 'The attached PDF fingerprints do not match the saved collection.',
} as const;
export type CollectionErrorCode = keyof typeof messages;
export class CollectionError extends Error {
  constructor(readonly code: CollectionErrorCode) { super(messages[code]); }
}
function fail(code: CollectionErrorCode): never { throw new CollectionError(code); }
function validId(id: unknown): id is CollectionId { return typeof id === 'string' && SHA.test(id); }
function validSize(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_COLLECTION_FILE_BYTES;
}
function validFile(file: File): boolean {
  return !!file && typeof file.name === 'string' && /\.pdf$/i.test(file.name) && validSize(file.size);
}
function within(stats: CollectionStats): boolean {
  return stats.documents <= MAX_COLLECTION_DOCUMENTS && stats.bytes <= MAX_COLLECTION_BYTES &&
    stats.passages <= MAX_COLLECTION_PASSAGES && stats.chars <= MAX_COLLECTION_CHARS;
}

export function collectionStats(documents: readonly CollectionDocument[]): CollectionStats {
  const seen = new Set<string>();
  const stats = { documents: documents.length, bytes: 0, passages: 0, chars: 0 };
  if (documents.length > MAX_COLLECTION_DOCUMENTS) fail('budget');
  for (const doc of documents) {
    if (!validId(doc.id) || seen.has(doc.id) || !validFile(doc.file) ||
        !Number.isSafeInteger(doc.chars) || doc.chars < 0 ||
        !Array.isArray(doc.corpus.passages) || doc.index.rows.length !== doc.corpus.passages.length) fail('source');
    seen.add(doc.id);
    stats.bytes += doc.file.size;
    stats.passages += doc.corpus.passages.length;
    stats.chars += doc.chars;
  }
  if (!within(stats)) fail('budget');
  return stats;
}

/** Check cheap file and count limits before reading or hashing a file. */
export function checkCollectionFile(documents: readonly CollectionDocument[], file: File): void {
  if (!validFile(file)) fail('file');
  const stats = collectionStats(documents);
  if (stats.documents >= MAX_COLLECTION_DOCUMENTS || stats.bytes + file.size > MAX_COLLECTION_BYTES) fail('budget');
}

export async function prepareCollectionFile(file: File, signal: AbortSignal): Promise<PreparedCollectionFile> {
  if (!validFile(file)) fail('file');
  signal.throwIfAborted();
  if (!globalThis.crypto?.subtle) fail('crypto');
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  if (bytes.byteLength !== file.size || !validSize(bytes.byteLength)) fail('file');
  // Hash and extract the same immutable byte snapshot. A filename is
  // only a local display label, never part of source identity.
  const stable = new File([bytes], file.name, { type: 'application/pdf', lastModified: file.lastModified });
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { id, file: stable };
}

/** One PDF is admitted atomically. An invalid, duplicate or over-budget
 * extraction does not change the caller's existing collection. */
export async function admitCollectionDocument(
  documents: readonly CollectionDocument[], file: File, signal: AbortSignal, extract: CollectionExtractor,
): Promise<CollectionDocument> {
  checkCollectionFile(documents, file);
  const prepared = await prepareCollectionFile(file, signal);
  if (documents.some(doc => doc.id === prepared.id)) fail('duplicate');
  let corpus: Corpus;
  try {
    const raw = await extract(prepared.file, 'original', signal);
    signal.throwIfAborted();
    corpus = validateNativeCorpus('original', prepared.id, raw);
  } catch {
    signal.throwIfAborted();
    return fail('extraction');
  }
  const chars = corpus.passages.reduce((total, row) => total + row.text.length, 0);
  const stats = collectionStats(documents);
  if (!within({ documents: stats.documents + 1, bytes: stats.bytes + prepared.file.size,
    passages: stats.passages + corpus.passages.length, chars: stats.chars + chars })) fail('budget');
  signal.throwIfAborted();
  return { ...prepared, corpus, chars, index: buildIndex(corpus.passages) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('plan');
  return value as Record<string, unknown>;
}
function exact(raw: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(raw).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))) fail('plan');
}
function sourceIds(documents: readonly CollectionDocument[]): CollectionId[] {
  collectionStats(documents);
  if (!documents.length) fail('source');
  return documents.map(doc => doc.id).sort();
}

type PreparedQuestion = { original: string; content: string; page?: number };
function prepareQuestion(question: string): PreparedQuestion[] {
  if (typeof question !== 'string' || !question || question.trim() !== question ||
      question.length > MAX_QUESTION ||
      new TextDecoder().decode(new TextEncoder().encode(question)) !== question) fail('question');
  try {
    return planQuestions(question).map(original => {
      if (requestedScope(original)) fail('question');
      const parsed = parseSearchQuestion(original);
      if (parsed.comparison) fail('question');
      return { original, content: parsed.content || '?', page: parsed.page };
    });
  } catch { return fail('question'); }
}

export function normalizeCollectionStep(value: unknown, allowed: readonly CollectionId[]): CollectionStep {
  const raw = object(value);
  exact(raw, ['question', 'documentIds', 'includeContext']);
  if (typeof raw.question !== 'string' || typeof raw.includeContext !== 'boolean' ||
      !Array.isArray(raw.documentIds) || !raw.documentIds.length ||
      raw.documentIds.length > MAX_COLLECTION_DOCUMENTS) fail('question');
  const ids: CollectionId[] = [];
  for (const id of raw.documentIds) {
    if (!validId(id) || !allowed.includes(id) || ids.includes(id)) fail('source');
    ids.push(id);
  }
  prepareQuestion(raw.question);
  return { question: raw.question, documentIds: ids, includeContext: raw.includeContext };
}

function coverage(corpus: Corpus, page?: number): CollectionPart['coverage'] {
  if (page !== undefined) {
    const state = pageCoverage(corpus, page);
    return state === 'limited' ? 'partial' : state;
  }
  if (corpus.limited) return 'partial';
  if (!corpus.passages.length) return 'no_indexed_text';
  return corpus.missingPages.length ? 'partial' : 'some_text';
}

export function runCollectionStep(documents: readonly CollectionDocument[], step: CollectionStep): CollectionTurn {
  const clean = normalizeCollectionStep(step, sourceIds(documents));
  const questions = prepareQuestion(clean.question);
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  const results = clean.documentIds.map(documentId => {
    const doc = byId.get(documentId);
    if (!doc) fail('source');
    const parts = questions.map(question => {
      const index = question.page === undefined ? doc.index : pageScopedIndex(doc.index, question.page);
      const answer = answerQuestion(index, question.content, 'original', clean.includeContext);
      return { answer: { ...answer, question: question.original,
        ...(question.page === undefined ? {} : { pageFilter: question.page }) },
        coverage: coverage(doc.corpus, question.page) };
    });
    return { documentId, parts };
  });
  return { step: clean, results };
}

function validatedSteps(documents: readonly CollectionDocument[], steps: readonly CollectionStep[]): CollectionStep[] {
  const ids = sourceIds(documents);
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_COLLECTION_TURNS) fail('size');
  return steps.map(step => normalizeCollectionStep(step, ids));
}

export function replayCollectionSteps(documents: readonly CollectionDocument[],
  steps: readonly CollectionStep[]): CollectionTurn[] {
  return validatedSteps(documents, steps).map(step => runCollectionStep(documents, step));
}

export function collectionSteps(turns: readonly CollectionTurn[]): CollectionStep[] {
  return turns.map(turn => ({ question: turn.step.question, documentIds: [...turn.step.documentIds],
    includeContext: turn.step.includeContext }));
}

/** Resolve a citation from the named PDF only. Matching page numbers in
 * other PDFs never supply a source. Return the actual attached file. */
export function collectionCitation(documents: readonly CollectionDocument[], documentId: CollectionId,
  citation: Passage): { file: File; source: Passage } {
  const doc = documents.find(candidate => candidate.id === documentId);
  if (!doc || !citation || citation.role !== 'original') fail('source');
  const source = doc.corpus.passages.find(row => row.page === citation.page && row.ordinal === citation.ordinal);
  if (!source || source !== citation) fail('source');
  return { file: doc.file, source };
}

const PLAN_FORMAT = 'noticebridge-collection-question-plan';
const PLAN_POLICY = 'Questions and selected PDF fingerprints only; recompute from attached source bytes.';
const REPORT_FORMAT = 'noticebridge-collection-evidence-report';
const REPORT_POLICY = 'Native extracted evidence only; exact replay does not verify meaning, completeness, applicability or official authority.';

function encode(value: unknown, limit: number): string {
  const text = JSON.stringify(value, null, 2) + '\n';
  checkText(text, limit);
  return text;
}
function checkText(text: string, limit: number): void {
  if (typeof text !== 'string' || !text || text.length > limit ||
      new TextEncoder().encode(text).byteLength > limit) fail('size');
}
function decode(text: string, limit: number): Record<string, unknown> {
  checkText(text, limit);
  try { return object(JSON.parse(text)); } catch { return fail('plan'); }
}
function assertSourceSet(value: unknown, documents: readonly CollectionDocument[]): void {
  if (!Array.isArray(value) || !value.length || value.length > MAX_COLLECTION_DOCUMENTS ||
      value.some(id => !validId(id)) || new Set(value).size !== value.length ||
      value.some((id, i) => i > 0 && value[i - 1] >= id)) fail('plan');
  if (value.join(',') !== sourceIds(documents).join(',')) fail('different');
}
function wirePlan(documents: readonly CollectionDocument[], steps: readonly CollectionStep[]) {
  return { format: PLAN_FORMAT, version: 1, policy: PLAN_POLICY,
    source_ids: sourceIds(documents), questions: validatedSteps(documents, steps) };
}

export function serializeCollectionPlan(documents: readonly CollectionDocument[], steps: readonly CollectionStep[]): string {
  return encode(wirePlan(documents, steps), MAX_COLLECTION_PLAN_BYTES);
}
export function parseCollectionPlan(text: string, documents: readonly CollectionDocument[]): CollectionStep[] {
  const raw = decode(text, MAX_COLLECTION_PLAN_BYTES);
  exact(raw, ['format', 'version', 'policy', 'source_ids', 'questions']);
  if (raw.format !== PLAN_FORMAT || raw.version !== 1 || raw.policy !== PLAN_POLICY ||
      !Array.isArray(raw.questions)) fail('plan');
  assertSourceSet(raw.source_ids, documents);
  const steps = raw.questions.map(value => normalizeCollectionStep(value, sourceIds(documents)));
  if (text !== serializeCollectionPlan(documents, steps)) fail('plan');
  return steps;
}

async function fileText(file: File, limit: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!file.size || file.size > limit) fail('size');
  const data = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (data.byteLength !== file.size || data.byteLength > limit) fail('size');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { return fail('plan'); }
}
export async function loadCollectionPlan(file: File, documents: readonly CollectionDocument[], signal?: AbortSignal) {
  const text = await fileText(file, MAX_COLLECTION_PLAN_BYTES, signal);
  signal?.throwIfAborted();
  return parseCollectionPlan(text, documents);
}

function wirePart(part: CollectionPart) {
  const { answer } = part;
  return {
    question: answer.question, physical_page: answer.pageFilter ?? null,
    kind: answer.kind, coverage: part.coverage, strict_match_count: answer.matchedCounts.original,
    citations: answer.citations.map(row => ({ page: row.page, ordinal: row.ordinal, text: row.text })),
    context_groups: answer.contextGroups.map(group => ({ page: group.page, citations: [...group.citations] })),
    printed_fields: answer.printedFields.map(field => ({ citation: field.citation, label: field.label, value: field.value })),
  };
}
function wireReport(documents: readonly CollectionDocument[], steps: readonly CollectionStep[]) {
  // Always recompute; never serialize an imported or cached answer object.
  const turns = replayCollectionSteps(documents, steps);
  return {
    format: REPORT_FORMAT, version: 1, policy: REPORT_POLICY, authority_verified: false,
    source_ids: sourceIds(documents),
    questions: turns.map(turn => ({
      step: turn.step,
      results: turn.results.map(result => ({ document_id: result.documentId, parts: result.parts.map(wirePart) })),
    })),
  };
}
export function serializeCollectionEvidence(documents: readonly CollectionDocument[],
  steps: readonly CollectionStep[]): string {
  return encode(wireReport(documents, steps), MAX_COLLECTION_REPORT_BYTES);
}

/** Verify exact canonical replay, not correctness of the source's claims.
 * The report never supplies answers to the current conversation. */
export function verifyCollectionEvidence(text: string, documents: readonly CollectionDocument[]) {
  const raw = decode(text, MAX_COLLECTION_REPORT_BYTES);
  exact(raw, ['format', 'version', 'policy', 'authority_verified', 'source_ids', 'questions']);
  if (raw.format !== REPORT_FORMAT || raw.version !== 1 || raw.policy !== REPORT_POLICY ||
      raw.authority_verified !== false || !Array.isArray(raw.questions) ||
      !raw.questions.length || raw.questions.length > MAX_COLLECTION_TURNS) fail('plan');
  assertSourceSet(raw.source_ids, documents);
  const steps = raw.questions.map(value => {
    const row = object(value);
    exact(row, ['step', 'results']);
    return normalizeCollectionStep(row.step, sourceIds(documents));
  });
  if (text !== serializeCollectionEvidence(documents, steps)) fail('plan');
  return { questions: steps.length, documents: documents.length, authorityVerified: false as const };
}

export async function loadCollectionEvidence(file: File, documents: readonly CollectionDocument[], signal?: AbortSignal) {
  const text = await fileText(file, MAX_COLLECTION_REPORT_BYTES, signal);
  signal?.throwIfAborted();
  return verifyCollectionEvidence(text, documents);
}
