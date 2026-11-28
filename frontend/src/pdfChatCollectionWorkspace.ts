/** Atomic private collection workspace. No saved generated answers or automatic
 * document excerpts. The nested formats retain their own canonical contracts. */
import { collectionStats, collectionSteps, parseCollectionPlan, replayCollectionSteps,
  serializeCollectionPlan, type CollectionDocument, type CollectionTurn } from './pdfChatCollection';
import { parseCollectionReview, serializeCollectionReview,
  type CollectionReviewEntry } from './pdfChatCollectionReview';

export const MAX_COLLECTION_WORKSPACE_BYTES = 640 * 1024;
const FORMAT = 'noticebridge-private-collection-workspace';
const POLICY = 'Personal questions and review annotations; replay against exact attached PDF fingerprints and native text.';
export type CollectionWorkspace = { turns: CollectionTurn[]; reviews: CollectionReviewEntry[] };
function invalid(): never { throw new Error('Invalid or mismatched private collection workspace.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  return row;
}
function idsOf(documents: readonly CollectionDocument[]): string[] {
  collectionStats(documents);
  if (!documents.length) invalid();
  return documents.map(doc => doc.id).sort();
}
function bounded(text: string): void {
  if (!text || text.length > MAX_COLLECTION_WORKSPACE_BYTES ||
      new TextEncoder().encode(text).byteLength > MAX_COLLECTION_WORKSPACE_BYTES) invalid();
}
function encode(ids: string[], plan: unknown, review: unknown): string {
  const text = JSON.stringify({ format: FORMAT, version: 1, policy: POLICY,
    authority_verified: false, source_ids: ids, question_plan: plan, evidence_review: review }, null, 2) + '\n';
  bounded(text);
  return text;
}
function nested(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return JSON.stringify(value, null, 2) + '\n';
}

export async function serializeCollectionWorkspace(documents: readonly CollectionDocument[],
  workspace: CollectionWorkspace, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const ids = idsOf(documents);
  if (!workspace.turns.length && !workspace.reviews.length) invalid();
  const plan = workspace.turns.length
    ? JSON.parse(serializeCollectionPlan(documents, collectionSteps(workspace.turns))) : null;
  const review = workspace.reviews.length
    ? JSON.parse(await serializeCollectionReview(documents, workspace.reviews, signal)) : null;
  signal?.throwIfAborted();
  return encode(ids, plan, review);
}

/** Validate both subdocuments before exposing a replacement. The caller
 * must explicitly confirm; failure in either component changes nothing. */
export async function parseCollectionWorkspace(text: string, documents: readonly CollectionDocument[],
  signal?: AbortSignal): Promise<CollectionWorkspace> {
  signal?.throwIfAborted();
  bounded(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  const raw = object(parsed, ['format', 'version', 'policy', 'authority_verified', 'source_ids',
    'question_plan', 'evidence_review']);
  if (raw.format !== FORMAT || raw.version !== 1 || raw.policy !== POLICY ||
      raw.authority_verified !== false || !Array.isArray(raw.source_ids) ||
      (raw.question_plan === null && raw.evidence_review === null)) invalid();
  const ids = idsOf(documents);
  if (raw.source_ids.length !== ids.length || raw.source_ids.some((value, i) => value !== ids[i])) invalid();
  if (encode(ids, raw.question_plan, raw.evidence_review) !== text) invalid();
  const steps = raw.question_plan === null ? [] : parseCollectionPlan(nested(raw.question_plan), documents);
  const reviews = raw.evidence_review === null ? []
    : await parseCollectionReview(nested(raw.evidence_review), documents, signal);
  signal?.throwIfAborted();
  const turns = steps.length ? replayCollectionSteps(documents, steps) : [];
  signal?.throwIfAborted();
  return { turns, reviews };
}
export async function loadCollectionWorkspace(file: File, documents: readonly CollectionDocument[],
  signal?: AbortSignal): Promise<CollectionWorkspace> {
  signal?.throwIfAborted();
  if (!file.size || file.size > MAX_COLLECTION_WORKSPACE_BYTES) invalid();
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_COLLECTION_WORKSPACE_BYTES) invalid();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return parseCollectionWorkspace(text, documents, signal);
}
