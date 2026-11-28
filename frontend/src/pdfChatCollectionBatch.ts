/** Bounded independent collection question batches. No batch uses an
 * earlier generated answer as context, and no partial run is committed. */
import { MAX_QUESTION, type Passage } from './pdfChatCore';
import { collectionStats, collectionCitation, normalizeCollectionStep, runCollectionStep,
  MAX_COLLECTION_TURNS, type CollectionDocument, type CollectionStep, type CollectionTurn,
  type CollectionPart } from './pdfChatCollection';
import { planQuestions } from './pdfChatInsights';

export const MAX_BATCH_QUESTIONS = 12;
export const MAX_BATCH_TEXT = MAX_BATCH_QUESTIONS * (MAX_QUESTION + 2);
export const MAX_BATCH_SEARCHES = 144;
export const BATCH_RESULTS_PAGE_SIZE = 4;
export type BatchProgress = { completed: number; total: number };
export type BatchResult = { turns: CollectionTurn[]; searches: number };
export type BatchCell = {
  documentId: string;
  parts: CollectionPart[];
  state: 'all_matched' | 'some_matched' | 'no_match';
  limited: boolean;
  matchCount: number;
};
export type BatchRow = {
  index: number;
  question: string;
  cells: BatchCell[];
  state: 'all_matched' | 'some_matched' | 'no_match';
  limited: boolean;
};
export type BatchSummary = {
  questions: number;
  searches: number;
  matched: number;
  unmatched: number;
  limited: number;
  rows: BatchRow[];
};
export class CollectionBatchError extends Error {
  constructor(readonly code: 'input' | 'budget' | 'stale' | 'result') {
    super({
      input: 'Enter one valid collection question per line.',
      budget: 'The collection question batch exceeds the available processing or history budget.',
      stale: 'Collection documents or question history changed. Prepare the batch again.',
      result: 'The prepared batch does not match the current local collection.',
    }[code]);
  }
}
function fail(code: CollectionBatchError['code']): never { throw new CollectionBatchError(code); }
function ids(documents: readonly CollectionDocument[]) {
  collectionStats(documents);
  return documents.map(doc => doc.id);
}
function remaining(history: readonly CollectionTurn[]): number {
  if (!Array.isArray(history) || history.length > MAX_COLLECTION_TURNS) fail('budget');
  return MAX_COLLECTION_TURNS - history.length;
}
function validateSteps(documents: readonly CollectionDocument[], steps: readonly CollectionStep[], capacity: number) {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > MAX_COLLECTION_TURNS ||
      !Array.isArray(steps) || !steps.length || steps.length > MAX_BATCH_QUESTIONS || steps.length > capacity) fail('budget');
  const allowed = ids(documents);
  const clean = steps.map(step => normalizeCollectionStep(step, allowed));
  let searches = 0;
  for (const step of clean) searches += planQuestions(step.question).length * step.documentIds.length;
  if (searches > MAX_BATCH_SEARCHES) fail('budget');
  return { steps: clean, searches };
}

/** Blank lines are ignored, but duplicate or invalid questions are not
 * silently dropped. Exact selection order is preserved per question. */
export function prepareCollectionBatch(documents: readonly CollectionDocument[], text: string,
  selection: readonly string[], includeContext: boolean, capacity: number): CollectionStep[] {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_BATCH_TEXT ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(text) ||
      !Array.isArray(selection) || typeof includeContext !== 'boolean') fail('input');
  const lines = text.split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
  if (lines.some(line => line.length > MAX_QUESTION) || new Set(lines).size !== lines.length) fail('input');
  return validateSteps(documents, lines.map(question => ({
    question, documentIds: [...selection], includeContext,
  })), capacity).steps;
}

type BatchOptions = {
  signal: AbortSignal;
  onProgress?: (progress: BatchProgress) => void;
  yieldControl?: () => Promise<void>;
};
/** Yield between whole turns, never midway through the deterministic
 * retrieval engine. The browser supplies a task-queue yield so cancellation
 * and UI events can be observed. A rejected run exposes no partial result. */
export async function runCollectionBatch(documents: readonly CollectionDocument[],
  steps: readonly CollectionStep[], capacity: number, options: BatchOptions): Promise<BatchResult> {
  options.signal.throwIfAborted();
  const clean = validateSteps(documents, steps, capacity);
  const turns: CollectionTurn[] = [];
  options.onProgress?.({ completed: 0, total: clean.steps.length });
  for (const step of clean.steps) {
    await (options.yieldControl?.() ?? Promise.resolve());
    options.signal.throwIfAborted();
    turns.push(runCollectionStep(documents, step));
    options.onProgress?.({ completed: turns.length, total: clean.steps.length });
  }
  options.signal.throwIfAborted();
  return { turns, searches: clean.searches };
}
function state(matched: number, total: number): BatchCell['state'] {
  return !matched ? 'no_match' : matched === total ? 'all_matched' : 'some_matched';
}
export function summarizeCollectionBatch(result: BatchResult): BatchSummary {
  let matched = 0, unmatched = 0, limited = 0, searches = 0;
  const rows = result.turns.map((turn, index): BatchRow => {
    let rowMatched = 0, rowTotal = 0;
    const cells = turn.results.map(side => {
      const count = side.parts.filter(part => part.answer.kind !== 'insufficient').length;
      const incomplete = side.parts.filter(part => part.coverage !== 'some_text').length;
      matched += count; unmatched += side.parts.length - count; limited += incomplete; searches += side.parts.length;
      rowMatched += count; rowTotal += side.parts.length;
      return { documentId: side.documentId, parts: side.parts, state: state(count, side.parts.length),
        limited: incomplete > 0, matchCount: count };
    });
    return { index, question: turn.step.question, cells, state: state(rowMatched, rowTotal),
      limited: cells.some(cell => cell.limited) };
  });
  if (searches !== result.searches) fail('result');
  return { questions: rows.length, searches, matched, unmatched, limited, rows };
}
export function batchPage(rows: readonly BatchRow[], page: number) {
  const pages = Math.max(1, Math.ceil(rows.length / BATCH_RESULTS_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) fail('input');
  return { pages, rows: rows.slice((page - 1) * BATCH_RESULTS_PAGE_SIZE, page * BATCH_RESULTS_PAGE_SIZE) };
}
export type BatchStage = {
  documents: readonly CollectionDocument[];
  history: readonly CollectionTurn[];
  result: BatchResult;
};
/** Commit only a result produced from the exact current collection and
 * history. Verify all citations and step/result structure before applying. */
export function appendCollectionBatch(documents: readonly CollectionDocument[], history: readonly CollectionTurn[],
  stage: BatchStage): CollectionTurn[] {
  if (stage.documents !== documents || stage.history !== history) fail('stale');
  const clean = validateSteps(documents, stage.result.turns.map(turn => turn.step), remaining(history));
  if (clean.searches !== stage.result.searches) fail('result');
  const recomputed = clean.steps.map(step => runCollectionStep(documents, step));
  for (let i = 0; i < recomputed.length; i++) {
    const observed = stage.result.turns[i];
    if (JSON.stringify(observed) !== JSON.stringify(recomputed[i])) fail('result');
    for (const side of observed.results) {
      for (const part of side.parts) {
        for (const citation of part.answer.citations) collectionCitation(documents, side.documentId, citation);
      }
    }
  }
  return [...history, ...recomputed];
}
export function batchCitation(documents: readonly CollectionDocument[], cell: BatchCell,
  part: number, citation: number): Passage {
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(citation) || part < 0 || citation < 0) fail('result');
  const source = cell.parts[part]?.answer.citations[citation];
  if (!source) fail('result');
  return collectionCitation(documents, cell.documentId, source).source;
}
