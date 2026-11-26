/** Evaluate separately indexed notice families without mixing their term statistics.
 * Dataset labels must be independently reviewed; this program does not create labels.
 */
import { indexCorpusSnapshot, parseCorpusSnapshot, type CorpusSnapshot } from '../src/pdfChatCorpusSnapshot';
import { parseSearchQuestion, planQuestions } from '../src/pdfChatInsights';
import { runRetrievalEvaluation, summarize, validateCases, type CaseMetrics,
  type RetrievalCase, type RetrievalMode, type Label } from './retrievalMetrics';
import type { Scope } from '../src/pdfChatCore';

export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_DATASET_DOCUMENTS = 100;
export const MAX_DATASET_CASES = 5000;
export const MAX_DATASET_TOTAL_BYTES = 100 * 1024 * 1024;
const FORMAT = 'noticebridge-retrieval-labels';
const MODES: RetrievalMode[] = ['strict', 'contextual', 'all-strict'];
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const FILE = /^[a-z0-9][a-z0-9_-]{0,63}\.json$/;
export type Split = 'development' | 'holdout';
export type DocumentLabels = {
  id: string;
  family: string;
  split: Split;
  snapshot: string;
  snapshot_sha256: string;
  cases: RetrievalCase[];
};
export type Dataset = {
  id: string;
  kind: 'synthetic' | 'independently_reviewed';
  documents: DocumentLabels[];
};
export type DatasetArtifact = {
  name: string;
  text: string;
  sha256: string;
};
export type LoadedDocument = {
  labels: DocumentLabels;
  snapshot: CorpusSnapshot;
  index: ReturnType<typeof indexCorpusSnapshot>;
};
function invalid(): never { throw new Error('Invalid retrieval dataset or source binding.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length || keys.some(key =>
    !Object.prototype.hasOwnProperty.call(raw, key))) invalid();
  return raw;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid();
  return value;
}
function label(value: unknown): Label {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'answerable') {
    const raw = object(value, ['kind', 'evidenceSets']);
    if (!Array.isArray(raw.evidenceSets) || !raw.evidenceSets.length || raw.evidenceSets.length > 8) invalid();
    const sets = raw.evidenceSets.map(set => {
      if (!Array.isArray(set) || !set.length || set.length > 24 ||
          set.some(id => typeof id !== 'string' || id.length > 32)) invalid();
      return set as string[];
    });
    return { kind, evidenceSets: sets };
  }
  object(value, ['kind']);
  if (kind !== 'unanswerable' && kind !== 'unindexed' && kind !== 'ambiguous') invalid();
  return { kind };
}
function evaluationCase(value: unknown, family: string): RetrievalCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const hasPage = Object.prototype.hasOwnProperty.call(value, 'page');
  const raw = object(value, ['id', 'slices', 'question', 'scope', 'label', ...(hasPage ? ['page'] : [])]);
  if (typeof raw.question !== 'string' || !raw.question.trim() || raw.question.trim() !== raw.question ||
      raw.question.length > 400 || !Array.isArray(raw.slices) || !raw.slices.length ||
      raw.slices.length > 8 || (raw.scope !== 'original' && raw.scope !== 'revised' && raw.scope !== 'both')) invalid();
  const slices = raw.slices.map(name);
  if (new Set(slices).size !== slices.length) invalid();
  const scope: Scope = raw.scope;
  const question = raw.question;
  if (planQuestions(question).length !== 1) invalid();
  const expectedPage = parseSearchQuestion(question).page;
  if (expectedPage !== raw.page || (hasPage && (typeof raw.page !== 'number' ||
      !Number.isSafeInteger(raw.page) || raw.page < 1 || raw.page > 80))) invalid();
  return { id: name(raw.id), family, slices, question, scope,
    ...(hasPage ? { page: raw.page as number } : {}), label: label(raw.label) };
}

export function parseDataset(text: string): Dataset {
  if (!text || text.length > MAX_MANIFEST_BYTES || new TextEncoder().encode(text).length > MAX_MANIFEST_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const raw = object(value, ['format', 'version', 'id', 'kind', 'documents']);
  if (raw.format !== FORMAT || raw.version !== 1 ||
      (raw.kind !== 'synthetic' && raw.kind !== 'independently_reviewed') ||
      !Array.isArray(raw.documents) || !raw.documents.length || raw.documents.length > MAX_DATASET_DOCUMENTS) invalid();
  const ids = new Set<string>(), cases = new Set<string>(), files = new Set<string>();
  const families = new Map<string, Split>();
  let totalCases = 0;
  const documents: DocumentLabels[] = raw.documents.map(value => {
    const item = object(value, ['id', 'family', 'split', 'snapshot', 'snapshot_sha256', 'cases']);
    const id = name(item.id), family = name(item.family);
    if (ids.has(id) || (item.split !== 'development' && item.split !== 'holdout') ||
        typeof item.snapshot !== 'string' || !FILE.test(item.snapshot) || files.has(item.snapshot) ||
        typeof item.snapshot_sha256 !== 'string' || !SHA.test(item.snapshot_sha256) ||
        !Array.isArray(item.cases) || !item.cases.length) invalid();
    const split = item.split;
    if (families.has(family) && families.get(family) !== split) invalid();
    families.set(family, split); ids.add(id); files.add(item.snapshot);
    totalCases += item.cases.length;
    if (totalCases > MAX_DATASET_CASES) invalid();
    const rows = item.cases.map(value => evaluationCase(value, family));
    for (const row of rows) {
      if (cases.has(row.id)) invalid();
      cases.add(row.id);
    }
    return { id, family, split, snapshot: item.snapshot, snapshot_sha256: item.snapshot_sha256, cases: rows };
  });
  return { id: name(raw.id), kind: raw.kind, documents };
}

export function loadDataset(dataset: Dataset, artifacts: DatasetArtifact[]): LoadedDocument[] {
  const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]));
  if (byName.size !== artifacts.length || artifacts.length !== dataset.documents.length) invalid();
  const sourceFamilies = new Map<string, string>();
  let totalBytes = 0;
  return dataset.documents.map(labels => {
    const artifact = byName.get(labels.snapshot);
    if (!artifact || artifact.sha256 !== labels.snapshot_sha256) invalid();
    totalBytes += new TextEncoder().encode(artifact.text).length;
    if (totalBytes > MAX_DATASET_TOTAL_BYTES) invalid();
    const snapshot = parseCorpusSnapshot(artifact.text);
    for (const digest of Object.values(snapshot.pins)) {
      if (!digest) invalid();
      const family = sourceFamilies.get(digest);
      if (family !== undefined && family !== labels.family) invalid();
      sourceFamilies.set(digest, labels.family);
    }
    const index = indexCorpusSnapshot(snapshot);
    for (const item of labels.cases) {
      const requiredRoles = item.scope === 'both' ? ['original', 'revised'] : [item.scope];
      if (requiredRoles.some(role => !snapshot.attached.includes(role as 'original' | 'revised'))) invalid();
    }
    validateCases(index, labels.cases);
    return { labels, snapshot, index };
  });
}

function aggregate(rows: CaseMetrics[]) {
  const slices = [...new Set(rows.flatMap(row => row.slices))].sort();
  const families = [...new Set(rows.map(row => row.family))].sort();
  return { totals: summarize(rows),
    slices: slices.map(slice => ({ slice, ...summarize(rows.filter(row => row.slices.includes(slice))) })),
    families: families.map(family => ({ family, ...summarize(rows.filter(row => row.family === family)) })),
    cases: rows,
  };
}

export function evaluateDataset(dataset: Dataset, documents: LoadedDocument[], split: Split) {
  if (split !== 'development' && split !== 'holdout') invalid();
  const selected = documents.filter(document => document.labels.split === split);
  if (!selected.length) invalid();
  // Build and score each document independently; never retrieve across unrelated notices.
  const modes = MODES.map(mode => {
    const rows = selected.flatMap(document =>
      runRetrievalEvaluation(document.index, document.labels.cases, mode, document.snapshot.attached).cases);
    return { mode, ...aggregate(rows) };
  });
  const strict = modes[0], contextual = modes[1], all = modes[2];
  const byCase = new Map(strict.cases.map(row => [row.id, row]));
  const transitions = [contextual, all].map(candidate => {
    const gained: string[] = [], lost: string[] = [], abstentionRegressions: string[] = [];
    for (const row of candidate.cases) {
      const baseline = byCase.get(row.id)!;
      if (row.complete && !baseline.complete) gained.push(row.id);
      if (!row.complete && baseline.complete) lost.push(row.id);
      if (baseline.kind === 'unanswerable' && baseline.abstained && !row.abstained) {
        abstentionRegressions.push(row.id);
      }
    }
    return { mode: candidate.mode, gained, lost, abstentionRegressions };
  });
  const leaks = modes.reduce((sum, mode) => sum + mode.totals.roleLeaks + mode.totals.pageLeaks +
    mode.totals.unknownIds + mode.totals.duplicateIds + mode.totals.routingMismatches, 0);
  return { format: 'noticebridge-retrieval-evaluation', version: 1, dataset: dataset.id,
    label_kind: dataset.kind, split, documents: selected.map(item => item.labels.id),
    synthetic: dataset.kind === 'synthetic', authority_verified: false,
    integrity_violations: leaks, modes, transitions,
  };
}
export type DatasetReport = ReturnType<typeof evaluateDataset>;
