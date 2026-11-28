/** Collection questions are independent saved steps. Context reuse is an
 * explicit, editable draft derived only from selected historical question
 * wording; no assistant output or inferred document routing is reused. */
import { MAX_QUESTION } from './pdfChatCore';
import { planQuestions, resolveChatQuestion } from './pdfChatInsights';
import { collectionStats, normalizeCollectionStep, runCollectionStep, MAX_COLLECTION_TURNS,
  type CollectionDocument, type CollectionStep, type CollectionTurn } from './pdfChatCollection';

function invalid(): never { throw new Error('Invalid collection question or history selection.'); }
function allowed(documents: readonly CollectionDocument[]): string[] {
  collectionStats(documents);
  return documents.map(doc => doc.id);
}
function turnAt(turns: readonly CollectionTurn[], at: number): CollectionTurn {
  if (!Array.isArray(turns) || !turns.length || turns.length > MAX_COLLECTION_TURNS ||
      !Number.isSafeInteger(at) || at < 0 || at >= turns.length) invalid();
  return turns[at];
}
export function collectionHistoryParts(documents: readonly CollectionDocument[], turn: CollectionTurn): string[] {
  const step = normalizeCollectionStep(turn.step, allowed(documents));
  return planQuestions(step.question);
}
export function independentCollectionQuestion(documents: readonly CollectionDocument[], turn: CollectionTurn): CollectionStep {
  return normalizeCollectionStep(turn.step, allowed(documents));
}

/** The user must choose a particular historical part. A page-only follow-up
 * replaces the previous page constraint, while an explicit qualifier uses
 * the existing deterministic context resolver. The preview is a standalone
 * question that can be edited or discarded before submission. */
export function collectionFollowupDraft(documents: readonly CollectionDocument[], turn: CollectionTurn,
  part: number, input: string): CollectionStep {
  const step = independentCollectionQuestion(documents, turn);
  const parts = planQuestions(step.question);
  if (!Number.isSafeInteger(part) || part < 0 || part >= parts.length ||
      typeof input !== 'string' || !input.trim() || input.length > MAX_QUESTION ||
      planQuestions(input).length !== 1) invalid();
  const resolved = resolveChatQuestion(input, parts[part], true);
  if (planQuestions(resolved).length !== 1) invalid();
  return normalizeCollectionStep({ question: resolved, documentIds: step.documentIds,
    includeContext: step.includeContext }, allowed(documents));
}

/** Editing a historical turn is atomic. Never silently discard the tail,
 * and retain the exact earlier objects (including their source identities).
 * The replacement is recomputed, not patched from the prior answer. */
export function reviseCollectionHistory(documents: readonly CollectionDocument[], turns: readonly CollectionTurn[],
  at: number, replacement: CollectionStep, discardLater: boolean): CollectionTurn[] {
  turnAt(turns, at);
  if (at < turns.length - 1 && discardLater !== true) invalid();
  const next = runCollectionStep(documents, normalizeCollectionStep(replacement, allowed(documents)));
  return [...turns.slice(0, at), next];
}

/** Remove one turn without modifying other standalone questions. All later
 * turns store explicit resolved wording, not a dependency on answer text. */
export function removeCollectionTurn(turns: readonly CollectionTurn[], at: number, confirmed: boolean): CollectionTurn[] {
  turnAt(turns, at);
  if (confirmed !== true) invalid();
  return turns.filter((_, index) => index !== at);
}
