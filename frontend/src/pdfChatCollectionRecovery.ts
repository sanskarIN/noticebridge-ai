/** Recovery diagnostics for exactly one collection PDF and one saved
 * question part. Diagnostics cannot supply or replace answer citations. */
import { collectionCitation, runCollectionStep, type CollectionDocument, type CollectionPart,
  type CollectionStep } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';
import { analyzeSearchRecovery, type SearchRecovery, type RecoveryLead, type SpellingSuggestion } from './pdfChatSearchRecovery';
import { parseSearchQuestion, planQuestions } from './pdfChatInsights';
import type { Passage } from './pdfChatCore';

export type CollectionRecovery = { documentId: string; question: string; recovery: SearchRecovery };
function invalid(): never { throw new Error('Invalid collection retrieval diagnostic.'); }

export function collectionRecovery(documents: readonly CollectionDocument[], documentId: string,
  part: CollectionPart): CollectionRecovery {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  if (part.answer.scope !== 'original') invalid();
  for (const citation of part.answer.citations) collectionCitation(documents, documentId, citation);
  const recovery = analyzeSearchRecovery(doc.index, part.answer);
  if (recovery.sides.length !== 1 || recovery.sides[0].role !== 'original') invalid();
  for (const lead of recovery.sides[0].leads) collectionCitation(documents, documentId, lead.source);
  return { documentId, question: part.answer.question, recovery };
}
export function collectionRecoveryLead(documents: readonly CollectionDocument[], result: CollectionRecovery,
  lead: RecoveryLead): Passage {
  if (!result.recovery.sides[0]?.leads.includes(lead)) invalid();
  return collectionCitation(documents, result.documentId, lead.source).source;
}
/** The draft is always scoped to the source whose vocabulary suggested
 * the spelling. The original physical page and search context remain. */
export function collectionRecoveryDraft(documents: readonly CollectionDocument[], result: CollectionRecovery,
  suggestion: SpellingSuggestion, includeContext: boolean): CollectionStep {
  if (!result.recovery.sides[0]?.suggestions.includes(suggestion) || typeof includeContext !== 'boolean') invalid();
  const [doc] = selectedCollectionDocuments(documents, [result.documentId]);
  const step = { question: suggestion.question, documentIds: [doc.id], includeContext };
  if (planQuestions(step.question).length !== 1 ||
      parseSearchQuestion(step.question).page !== result.recovery.page) invalid();
  const replay = runCollectionStep(documents, step);
  if (replay.results.length !== 1 || replay.results[0].documentId !== doc.id) invalid();
  return replay.step;
}
