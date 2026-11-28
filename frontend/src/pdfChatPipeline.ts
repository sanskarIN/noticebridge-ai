/** Independent browser validation of a chained local model result. */
import type { Answer, Passage, Role, SearchIndex } from './pdfChatCore';
import { prepareExperiment, requestHash, reviewRanking, type Experiment,
  type CandidateReview } from './pdfChatEmbeddingBridge';
import { reviewExtractive, type ExtractiveReview } from './pdfChatExtractiveBridge';
import type { SelectionExperiment } from './pdfChatSelectionBridge';
import { passageId } from './pdfChatResearch';

const FORMAT = 'noticebridge-chat-pipeline-request';
const RESULT = 'noticebridge-chat-pipeline-result';
export const MAX_PIPELINE_BYTES = 2 * 1024 * 1024;
export const MAX_PIPELINE_RESULT_BYTES = 100 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const ROLES: Role[] = ['original', 'revised'];
export type PipelineRequest = {
  text: string; embedding: Experiment; baseline: string[];
};
export type PipelineReview = {
  ranking: CandidateReview; extractive: ExtractiveReview;
  selectionCount: number;
};
function invalid(): never { throw new Error('Invalid or mismatched local pipeline result.'); }
function encode(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function preparePipeline(index: SearchIndex, answer: Answer, mode: 'full' | 'shortlist'): PipelineRequest {
  const embedding = prepareExperiment(index, answer, mode);
  const raw = JSON.parse(embedding.text);
  const baseline = [...new Set(answer.citations.map(passageId))];
  const counts: Record<Role, number> = { original: 0, revised: 0 };
  for (const id of baseline) {
    const local = embedding.allowed.get(id);
    if (!local || ++counts[local.role] > 6) invalid();
  }
  const text = encode({ format: FORMAT, version: 1, question: raw.question,
    passages: raw.passages, baseline });
  if (new TextEncoder().encode(text).length > MAX_PIPELINE_BYTES) invalid();
  return { text, embedding, baseline };
}

/** Reproduce the server's baseline-first ordering, NOT fused presentation order. */
export function pipelineSelection(request: PipelineRequest, ranks: Record<string, unknown>): SelectionExperiment {
  const allowed = new Map<string, Passage>();
  const counts: Record<Role, number> = { original: 0, revised: 0 };
  const ids = [...request.baseline];
  for (const role of ROLES) {
    const rank = ranks[role];
    if (rank !== undefined) {
      if (!Array.isArray(rank) || rank.some(id => typeof id !== 'string')) invalid();
      ids.push(...rank);
    }
  }
  const seen = new Set<string>();
  let omittedCandidates = 0;
  for (const id of ids) {
    const source = request.embedding.allowed.get(id);
    if (!source) invalid();
    if (seen.has(id)) continue;
    seen.add(id);
    if (counts[source.role] >= 12) { omittedCandidates++; continue; }
    counts[source.role]++;
    allowed.set(id, source);
  }
  if (!allowed.size || request.baseline.some(id => !allowed.has(id))) invalid();
  const question = JSON.parse(request.embedding.text).question;
  const text = encode({ format: 'noticebridge-chat-selection-request', version: 1,
    question, passages: [...allowed].map(([id, source]) => ({ id, text: source.text })) });
  return { text, allowed, baseline: request.embedding.baseline, omittedCandidates };
}
export async function reviewPipeline(text: string, request: PipelineRequest, digest: string): Promise<PipelineReview> {
  if (!text || text.length > MAX_PIPELINE_RESULT_BYTES ||
      new TextEncoder().encode(text).length > MAX_PIPELINE_RESULT_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  const raw = object(parsed);
  if (raw.format !== RESULT || raw.version !== 1 || !SHA.test(digest) ||
      raw.request_sha256 !== digest || raw.authority_verified !== false ||
      await requestHash(request.text) !== digest) invalid();
  const ranking = reviewRanking(encode(raw.ranking), request.embedding, await requestHash(request.embedding.text));
  const selected = pipelineSelection(request, object(object(raw.ranking).ranks));
  const extractive = reviewExtractive(encode(raw.extractive), selected, await requestHash(selected.text));
  if (encode({ format: RESULT, version: 1, request_sha256: digest,
    ranking: raw.ranking, extractive: raw.extractive, authority_verified: false }) !== text) invalid();
  return { ranking, extractive, selectionCount: selected.allowed.size };
}
