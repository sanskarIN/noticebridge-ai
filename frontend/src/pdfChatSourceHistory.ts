/** Source-specific navigation over the bounded, already displayed history.
 * It is a view of recorded citations, not a reranking of the collection. */
import {collectionCitation,collectionStats,MAX_COLLECTION_TURNS,normalizeCollectionStep,
  type CollectionDocument,type CollectionTurn,type CollectionStep} from './pdfChatCollection';
import {collectionReviewKey,collectionReviewCounts,MAX_COLLECTION_REVIEW_ITEMS,type CollectionReviewEntry} from './pdfChatCollectionReview';
import type {Passage} from './pdfChatCore';

export const SOURCE_HISTORY_PAGE_SIZE=8;
export type SourceHistoryUse={turn:number;part:number;rank:number;question:string;channel:'strict'|'nearby';
  printedField:boolean;physicalPage:number|null;includeContext:boolean;selectedDocuments:number};
export type SourceHistory={documentId:string;source:Passage;uses:SourceHistoryUse[];annotation:CollectionReviewEntry|null;
  distinctTurns:number;strictUses:number;nearbyUses:number};
function invalid():never{throw Error('Invalid or stale source citation history.');}
export function sourceHistory(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  reviews:readonly CollectionReviewEntry[],documentId:string,source:Passage):SourceHistory{
  collectionStats(documents);
  if(turns.length>MAX_COLLECTION_TURNS||reviews.length>MAX_COLLECTION_REVIEW_ITEMS)invalid();
  collectionReviewCounts(reviews);
  const local=collectionCitation(documents,documentId,source).source;
  const uses:SourceHistoryUse[]=[];
  for(const [turnIndex,turn] of turns.entries()){
    const side=turn.results.find(row=>row.documentId===documentId);
    if(!side)continue;
    if(!turn.step.documentIds.includes(documentId))invalid();
    for(const [partIndex,part] of side.parts.entries()){
      const answer=part.answer;
      // Equal text or coordinates in another source are never accepted.
      const rank=answer.citations.findIndex(row=>row===local)+1;
      if(!rank)continue;
      if(answer.pageFilter!==undefined&&answer.pageFilter!==source.page)invalid();
      const nearby=answer.contextGroups.some(group=>group.citations.includes(rank));
      uses.push({turn:turnIndex,part:partIndex,rank,question:answer.question,channel:nearby?'nearby':'strict',
        printedField:answer.printedFields.some(field=>field.citation===rank),physicalPage:answer.pageFilter??null,
        includeContext:turn.step.includeContext,selectedDocuments:turn.step.documentIds.length});
    }
  }
  const key=collectionReviewKey(documentId,source);
  const matching=reviews.filter(row=>collectionReviewKey(row.documentId,row.source)===key);
  if(matching.length>1||matching.some(row=>row.source!==source))invalid();
  return {documentId,source,uses,annotation:matching[0]??null,
    distinctTurns:new Set(uses.map(row=>row.turn)).size,strictUses:uses.filter(row=>row.channel==='strict').length,
    nearbyUses:uses.filter(row=>row.channel==='nearby').length};
}
export type SourceHistoryFilter='all'|'strict'|'nearby'|'printed';
export function filterSourceHistory(history:SourceHistory,filter:SourceHistoryFilter,text:string){
  if(!['all','strict','nearby','printed'].includes(filter)||typeof text!=='string'||text.length>100)invalid();
  const needle=text.trim().toLowerCase();
  return history.uses.filter(row=>(filter==='all'||(filter==='printed'?row.printedField:row.channel===filter))&&
    (!needle||row.question.toLowerCase().includes(needle)));
}
export function sourceHistoryPage(rows:readonly SourceHistoryUse[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/SOURCE_HISTORY_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*SOURCE_HISTORY_PAGE_SIZE;
  return {rows:rows.slice(offset,offset+SOURCE_HISTORY_PAGE_SIZE),pages,first:rows.length?offset+1:0,
    last:Math.min(rows.length,offset+SOURCE_HISTORY_PAGE_SIZE)};
}
export function validateSourceHistoryUse(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  history:SourceHistory,use:SourceHistoryUse){
  if(!history.uses.includes(use))invalid();
  collectionCitation(documents,history.documentId,history.source);
  const turn=turns[use.turn];
  const answer=turn?.results.find(row=>row.documentId===history.documentId)?.parts[use.part]?.answer;
  if(!answer||answer.citations[use.rank-1]!==history.source||answer.question!==use.question||
    (answer.pageFilter??null)!==use.physicalPage||turn.step.includeContext!==use.includeContext||
    turn.step.documentIds.length!==use.selectedDocuments)invalid();
  return turn;
}
/** Reuse only the explicitly selected historical part, never substitute
 * other sources or rewrite its original physical-page restriction. */
export function sourceHistoryDraft(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  history:SourceHistory,use:SourceHistoryUse,scope:'this_pdf'|'original_selection'):CollectionStep{
  const turn=validateSourceHistoryUse(documents,turns,history,use);
  if(scope!=='this_pdf'&&scope!=='original_selection')invalid();
  const step={question:use.question,documentIds:scope==='this_pdf'?[history.documentId]:[...turn.step.documentIds],
    includeContext:use.includeContext};
  return normalizeCollectionStep(step,documents.map(doc=>doc.id));
}
