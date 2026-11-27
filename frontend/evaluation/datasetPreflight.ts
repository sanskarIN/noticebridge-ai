/** Offline preflight of a frozen retrieval dataset. Detect review leads,
 * not automatic contamination, legal conclusions or label truth.
 */
import { createHash } from 'node:crypto';
import { parseDataset, loadDataset, type Dataset, type DatasetArtifact, type LoadedDocument, type Split } from './retrievalDataset';
import { type Label, type RetrievalCase } from './retrievalMetrics';
import { pageCoverage, queryTerms, type Corpus, type Role } from '../src/pdfChatCore';
import { parseSearchQuestion, requestedScope } from '../src/pdfChatInsights';
import { compareNativeSketches, normalizedTokens, sketchNativeText, type NativeSketch,
  MAX_DATASET_TOKENS, MAX_SOURCE_TOKENS, MIN_SOURCE_TOKENS, MIN_OVERLAP_SAMPLE,
  SHINGLE_WORDS, SKETCH_SIZE } from './nativeTextSketch';

export const MAX_PREFLIGHT_BYTES = 16 * 1024 * 1024;
const POLICY = 'Private preflight review leads: lexical overlap and source coverage are not proof of split leakage, semantic equivalence, label correctness or official authority.';
export type PreflightInput = { manifest: string; artifacts: DatasetArtifact[] };
export type PreflightSettings = { similarityThreshold: number };
type SourceRef = { document: string; family: string; split: Split; role: Role };
export type SourceInventory = SourceRef & {
  pdf_sha256: string;
  physical_pages: number;
  processed_pages: number;
  missing_pages: number;
  limited_pages: number;
  limited: boolean;
  native_fragments: number;
  normalized_tokens: number;
  distinct_shingle_sample: number;
  sampled: boolean;
  review_eligible: boolean;
};
type SourceData = { inventory: SourceInventory; sketch: NativeSketch };
export type PairLead = {
  id: string;
  left: SourceRef;
  right: SourceRef;
  cross_split: boolean;
  kind: 'exact_normalized_sequence' | 'high_shingle_overlap';
  union_sample: number;
  shared_sample: number;
  jaccard_estimate: number | null;
  sampled: boolean;
};
type Coverage = 'not_present' | 'not_indexed' | 'no_indexed_text' | 'limited' | 'some_text';
export const caseFlags = [
  'explicit_scope_conflict',
  'empty_search_terms',
  'requested_text_unavailable',
  'negative_with_limited_coverage',
  'unindexed_with_some_text',
  'both_scope_alternative_one_role',
  'repeated_question_in_document',
  'repeated_question_different_labels',
] as const;
export type CaseFlag = typeof caseFlags[number];
export type CaseLead = {
  id: string;
  document: string;
  family: string;
  split: Split;
  kind: Label['kind'];
  flags: CaseFlag[];
  coverage: { role: Role; state: Coverage }[];
};
export type QuestionOverlap = {
  normalized_routes: number;
  cross_split_routes: number;
  development_cases_in_shared_routes: number;
  holdout_cases_in_shared_routes: number;
  repeated_routes_within_document: number;
  differing_labels_within_document: number;
};
export type PreflightReport = {
  format: 'noticebridge-retrieval-preflight';
  version: 1;
  policy: string;
  dataset: string;
  label_kind: Dataset['kind'];
  manifest_sha256: string;
  authority_verified: false;
  label_correctness_verified: false;
  release_approved: false;
  settings: { similarity_threshold: number; shingle_words: number; sketch_size: number;
    min_source_tokens: number; min_shared_sample: number };
  summary: {
    documents: number;
    families: number;
    cases: number;
    source_roles: number;
    normalized_tokens: number;
    short_or_empty_sources: number;
    same_family_pairs_skipped: number;
    short_pairs_skipped: number;
    compared_pairs: number;
    cross_split_pairs: number;
    pair_leads: number;
    cross_split_leads: number;
    exact_sequence_leads: number;
    cases_with_review_leads: number;
    case_flag_counts: Record<CaseFlag, number>;
  };
  sources: SourceInventory[];
  pair_leads: PairLead[];
  question_overlap: QuestionOverlap;
  case_leads: CaseLead[];
};
function invalid(): never { throw new Error('Invalid or oversized retrieval preflight input.'); }
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function bounded(text: string): string {
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_PREFLIGHT_BYTES) invalid();
  return text;
}
function order(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function validateSettings(settings: PreflightSettings) {
  if (!settings || Object.keys(settings).length !== 1 ||
      typeof settings.similarityThreshold !== 'number' || !Number.isFinite(settings.similarityThreshold) ||
      settings.similarityThreshold < 0.5 || settings.similarityThreshold > 1) invalid();
  return settings.similarityThreshold;
}
function sourceRef(source: SourceInventory): SourceRef {
  return { document: source.document, family: source.family, split: source.split, role: source.role };
}
function collectSources(documents: LoadedDocument[]) {
  const sources: SourceData[] = [];
  let tokens = 0;
  for (const document of [...documents].sort((a, b) => order(a.labels.id, b.labels.id))) {
    for (const role of document.snapshot.attached) {
      const corpus = document.snapshot.corpora[role], pin = document.snapshot.pins[role];
      if (!corpus || !pin) invalid();
      const sketch = sketchNativeText(corpus.passages, Math.min(MAX_SOURCE_TOKENS, MAX_DATASET_TOKENS - tokens));
      tokens += sketch.tokens;
      sources.push({ sketch, inventory: {
        document: document.labels.id, family: document.labels.family, split: document.labels.split, role,
        pdf_sha256: pin, physical_pages: corpus.pageCount, processed_pages: corpus.processedPages,
        missing_pages: corpus.missingPages.length, limited_pages: corpus.limitedPages.length, limited: corpus.limited,
        native_fragments: corpus.passages.length, normalized_tokens: sketch.tokens,
        distinct_shingle_sample: sketch.hashes.length, sampled: sketch.truncated,
        review_eligible: sketch.tokens >= MIN_SOURCE_TOKENS,
      } });
    }
  }
  return { sources, tokens };
}
function pairId(left: SourceRef, right: SourceRef): string {
  return left.document + ':' + left.role + '|' + right.document + ':' + right.role;
}
function compareSources(sources: SourceData[], threshold: number) {
  let sameFamily = 0, short = 0, compared = 0, crossSplit = 0;
  const leads: PairLead[] = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i], b = sources[j];
      if (a.inventory.family === b.inventory.family) { sameFamily++; continue; }
      if (!a.inventory.review_eligible || !b.inventory.review_eligible) { short++; continue; }
      compared++;
      const cross_split = a.inventory.split !== b.inventory.split;
      if (cross_split) crossSplit++;
      const exact = a.sketch.normalizedSha256 === b.sketch.normalizedSha256;
      const overlap = compareNativeSketches(a.sketch, b.sketch);
      if (!exact && (overlap.sharedSample < MIN_OVERLAP_SAMPLE || overlap.jaccard === null || overlap.jaccard < threshold)) continue;
      const left = sourceRef(a.inventory), right = sourceRef(b.inventory);
      leads.push({ id: pairId(left, right), left, right, cross_split,
        kind: exact ? 'exact_normalized_sequence' : 'high_shingle_overlap',
        union_sample: overlap.unionSample, shared_sample: overlap.sharedSample,
        jaccard_estimate: overlap.jaccard, sampled: overlap.sampled });
    }
  }
  return { leads, sameFamily, short, compared, crossSplit };
}
function normalizedRoute(row: RetrievalCase): string {
  // Do not output the normalized question. This is a deliberately narrow
  // text/route key; generic shared questions are expected across notices.
  return JSON.stringify([[...normalizedTokens(row.question)], row.scope, row.page ?? null]);
}
function labelKey(label: Label): string {
  if (label.kind !== 'answerable') return label.kind;
  return encode(label.evidenceSets.map(set => [...set].sort().join('|')).sort());
}
function questionGroups(documents: LoadedDocument[]) {
  const global = new Map<string, { development: number; holdout: number }>();
  const duplicateIds = new Set<string>(), conflictingIds = new Set<string>();
  let repeated = 0, differing = 0;
  for (const document of documents) {
    const local = new Map<string, RetrievalCase[]>();
    for (const row of document.labels.cases) {
      const key = normalizedRoute(row);
      const counts = global.get(key) ?? { development: 0, holdout: 0 };
      counts[document.labels.split]++;
      global.set(key, counts);
      const group = local.get(key) ?? [];
      group.push(row); local.set(key, group);
    }
    for (const group of local.values()) {
      if (group.length < 2) continue;
      repeated++;
      group.forEach(row => duplicateIds.add(row.id));
      if (new Set(group.map(row => labelKey(row.label))).size > 1) {
        differing++;
        group.forEach(row => conflictingIds.add(row.id));
      }
    }
  }
  const shared = [...global.values()].filter(row => row.development && row.holdout);
  const overlap: QuestionOverlap = {
    normalized_routes: global.size, cross_split_routes: shared.length,
    development_cases_in_shared_routes: shared.reduce((n, row) => n + row.development, 0),
    holdout_cases_in_shared_routes: shared.reduce((n, row) => n + row.holdout, 0),
    repeated_routes_within_document: repeated, differing_labels_within_document: differing,
  };
  return { overlap, duplicateIds, conflictingIds };
}
function coverage(corpus: Corpus, page: number | undefined): Coverage {
  if (page !== undefined) return pageCoverage(corpus, page);
  if (!corpus.passages.length) return 'no_indexed_text';
  if (corpus.limited || corpus.missingPages.length || corpus.limitedPages.length ||
      corpus.processedPages < corpus.pageCount) return 'limited';
  return 'some_text';
}
function caseLeads(documents: LoadedDocument[], duplicates: Set<string>, conflicts: Set<string>) {
  const leads: CaseLead[] = [];
  for (const document of [...documents].sort((a, b) => order(a.labels.id, b.labels.id))) {
    for (const row of [...document.labels.cases].sort((a, b) => order(a.id, b.id))) {
      const roles: Role[] = row.scope === 'both' ? ['original', 'revised'] : [row.scope];
      const sourceCoverage = roles.map(role => {
        const corpus = document.snapshot.corpora[role];
        if (!corpus) invalid();
        return { role, state: coverage(corpus, row.page) };
      });
      const flags: CaseFlag[] = [];
      const explicit = requestedScope(row.question);
      if (explicit && explicit !== row.scope) flags.push('explicit_scope_conflict');
      if (!queryTerms(parseSearchQuestion(row.question).content).length) flags.push('empty_search_terms');
      const unavailable = sourceCoverage.some(source => ['not_present', 'not_indexed', 'no_indexed_text'].includes(source.state) ||
        !document.snapshot.corpora[source.role]!.passages.some(passage => row.page === undefined || passage.page === row.page));
      if (unavailable) flags.push('requested_text_unavailable');
      if (row.label.kind === 'unanswerable' && sourceCoverage.some(source => source.state !== 'some_text')) {
        flags.push('negative_with_limited_coverage');
      }
      if (row.label.kind === 'unindexed' && sourceCoverage.every(source => source.state === 'some_text')) {
        flags.push('unindexed_with_some_text');
      }
      if (row.label.kind === 'answerable' && row.scope === 'both' &&
          row.label.evidenceSets.some(set => new Set(set.map(id => id.split(':')[0])).size < 2)) {
        flags.push('both_scope_alternative_one_role');
      }
      if (duplicates.has(row.id)) flags.push('repeated_question_in_document');
      if (conflicts.has(row.id)) flags.push('repeated_question_different_labels');
      if (flags.length) leads.push({ id: row.id, document: document.labels.id, family: document.labels.family,
        split: document.labels.split, kind: row.label.kind, flags, coverage: sourceCoverage });
    }
  }
  return leads;
}
export function preflightDataset(input: PreflightInput, settings: PreflightSettings) {
  const threshold = validateSettings(settings);
  const dataset = parseDataset(input.manifest);
  const loaded = loadDataset(dataset, input.artifacts);
  const { sources, tokens } = collectSources(loaded);
  const pairs = compareSources(sources, threshold);
  const questions = questionGroups(loaded);
  const cases = caseLeads(loaded, questions.duplicateIds, questions.conflictingIds);
  const flagCounts = Object.fromEntries(caseFlags.map(flag => [flag, 0])) as Record<CaseFlag, number>;
  for (const lead of cases) for (const flag of lead.flags) flagCounts[flag]++;
  const report: PreflightReport = {
    format: 'noticebridge-retrieval-preflight', version: 1, policy: POLICY, dataset: dataset.id,
    label_kind: dataset.kind, manifest_sha256: hash(input.manifest), authority_verified: false,
    label_correctness_verified: false, release_approved: false,
    settings: { similarity_threshold: threshold, shingle_words: SHINGLE_WORDS, sketch_size: SKETCH_SIZE,
      min_source_tokens: MIN_SOURCE_TOKENS, min_shared_sample: MIN_OVERLAP_SAMPLE },
    summary: {
      documents: loaded.length, families: new Set(loaded.map(row => row.labels.family)).size,
      cases: loaded.reduce((n, row) => n + row.labels.cases.length, 0), source_roles: sources.length,
      normalized_tokens: tokens, short_or_empty_sources: sources.filter(row => !row.inventory.review_eligible).length,
      same_family_pairs_skipped: pairs.sameFamily, short_pairs_skipped: pairs.short,
      compared_pairs: pairs.compared, cross_split_pairs: pairs.crossSplit, pair_leads: pairs.leads.length,
      cross_split_leads: pairs.leads.filter(row => row.cross_split).length,
      exact_sequence_leads: pairs.leads.filter(row => row.kind === 'exact_normalized_sequence').length,
      cases_with_review_leads: cases.length, case_flag_counts: flagCounts,
    },
    sources: sources.map(row => row.inventory), pair_leads: pairs.leads,
    question_overlap: questions.overlap, case_leads: cases,
  };
  return { report, text: bounded(encode(report)) };
}
export function replayPreflight(text: string, input: PreflightInput, settings: PreflightSettings) {
  bounded(text);
  const result = preflightDataset(input, settings);
  if (result.text !== text) invalid();
  return result.report;
}
