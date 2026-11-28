/** A source-bound review queue derived from the complete saved question history.
 * A queue entry is a diagnostic, not a finding about official applicability. */
import {collectionStats,collectionCitation,MAX_COLLECTION_TURNS,type CollectionDocument,
  type CollectionTurn,type CollectionStep} from './pdfChatCollection';
import {collectionAnswerSummary,type CollectionAnswerRow} from './pdfChatCollectionAnswerSummary';
import {collectionReviewKey,type CollectionReviewEntry} from './pdfChatCollectionReview';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {requestHash} from './pdfChatEmbeddingBridge';
import type {Passage} from './pdfChatCore';

export const REVIEW_QUEUE_REASONS=['coverage','no_match','context_only','missing_field','multiple_values',
  'different_values','additional_context','omitted_matches'] as const;
export type QueueReason=typeof REVIEW_QUEUE_REASONS[number];
export const REVIEW_QUEUE_PAGE_SIZE=8;
export const MAX_REVIEW_QUEUE_BYTES=2*1024*1024;
export type ReviewQueueItem={
  key:string;turnIndex:number;partIndex:number;documentId:string;question:string;physicalPage?:number;
  reasons:QueueReason[];coverage:CollectionAnswerRow['cells'][number]['part']['coverage'];
  strictMatches:number;shownFragments:number;printedValues:number|null;
  evidence:Passage[];savedEvidence:number;manuallyReviewed:number;
};
export type ReviewQueue={items:ReviewQueueItem[];turns:number;searches:number;reasonCounts:Record<QueueReason,number>};
export type QueueFilter={reason:QueueReason|'all';documentId:string|'all';review:'all'|'unsaved'|'saved';query:string};
function invalid():never{throw new Error('Invalid or mismatched collection review queue.');}
function key(turn:number,part:number,id:string){return turn+':'+part+':'+id;}
function zeroCounts():Record<QueueReason,number>{
  return {coverage:0,no_match:0,context_only:0,missing_field:0,multiple_values:0,different_values:0,
    additional_context:0,omitted_matches:0};
}
function reviewMap(documents:readonly CollectionDocument[],reviews:readonly CollectionReviewEntry[]){
  const map=new Map<string,CollectionReviewEntry>();
  for(const entry of reviews){
    collectionCitation(documents,entry.documentId,entry.source);
    const id=collectionReviewKey(entry.documentId,entry.source);
    if(map.has(id))invalid();
    map.set(id,entry);
  }
  return map;
}
function reasonsFor(row:CollectionAnswerRow,cell:CollectionAnswerRow['cells'][number]):QueueReason[]{
  const reasons:QueueReason[]=[];
  const {answer}=cell.part;
  if(cell.part.coverage!=='some_text')reasons.push('coverage');
  if(answer.kind==='insufficient')reasons.push('no_match');
  if(answer.contextGroups.length)reasons.push('context_only');
  if(row.field&&!cell.direct?.distinctValues)reasons.push('missing_field');
  if((cell.direct?.distinctValues??0)>1)reasons.push('multiple_values');
  if(row.printedState==='different_text')reasons.push('different_values');
  if(cell.direct&&(cell.direct.otherMatchingPassages||cell.direct.nearbyPassages))reasons.push('additional_context');
  if(answer.matchedCounts.original>answer.citations.length)reasons.push('omitted_matches');
  return reasons;
}
function appendTurn(result:ReviewQueue,documents:readonly CollectionDocument[],turn:CollectionTurn,turnIndex:number,
  reviews:Map<string,CollectionReviewEntry>){
  const summary=collectionAnswerSummary(documents,turn);
  result.searches+=summary.searches;
  summary.rows.forEach((row,partIndex)=>row.cells.forEach(cell=>{
    const reasons=reasonsFor(row,cell);
    if(!reasons.length)return;
    const evidence:Passage[]=[];
    const seen=new Set<string>();
    const add=(source:Passage)=>{
      collectionCitation(documents,cell.documentId,source);
      const id=collectionReviewKey(cell.documentId,source);
      if(!seen.has(id)){seen.add(id);evidence.push(source);}
    };
    cell.part.answer.citations.forEach(add);
    for(const value of cell.direct?.values??[])for(const ref of value.sources)add(ref.source);
    for(const extra of cell.direct?.reviewPassages??[])add(extra.source);
    const annotations=[...seen].flatMap(id=>reviews.has(id)?[reviews.get(id)!]:[]);
    result.items.push({key:key(turnIndex,partIndex,cell.documentId),turnIndex,partIndex,
      documentId:cell.documentId,question:row.question,physicalPage:row.page,reasons,coverage:cell.part.coverage,
      strictMatches:cell.part.answer.matchedCounts.original,shownFragments:cell.part.answer.citations.length,
      printedValues:row.field?cell.direct?.distinctValues??0:null,evidence,savedEvidence:annotations.length,
      manuallyReviewed:annotations.filter(entry=>entry.status==='reviewed_manually').length});
    reasons.forEach(reason=>result.reasonCounts[reason]++);
  }));
}
function start(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],reviews:readonly CollectionReviewEntry[]){
  collectionStats(documents);
  if(!documents.length||!Array.isArray(turns)||turns.length>MAX_COLLECTION_TURNS)invalid();
  return {result:{items:[],turns:turns.length,searches:0,reasonCounts:zeroCounts()} as ReviewQueue,
    saved:reviewMap(documents,reviews)};
}
export function buildReviewQueue(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  reviews:readonly CollectionReviewEntry[]):ReviewQueue{
  const {result,saved}=start(documents,turns,reviews);
  turns.forEach((turn,i)=>appendTurn(result,documents,turn,i,saved));
  return result;
}
/** Yield between turns; never publish a partly processed queue. */
export async function buildReviewQueueAsync(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  reviews:readonly CollectionReviewEntry[],signal:AbortSignal,onProgress?:(done:number,total:number)=>void,
  yieldControl:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,0))){
  signal.throwIfAborted();
  const {result,saved}=start(documents,turns,reviews);
  onProgress?.(0,turns.length);
  for(let i=0;i<turns.length;i++){
    await yieldControl();signal.throwIfAborted();
    appendTurn(result,documents,turns[i],i,saved);
    onProgress?.(i+1,turns.length);signal.throwIfAborted();
  }
  signal.throwIfAborted();
  return result;
}
export function filterReviewQueue(queue:ReviewQueue,filter:QueueFilter){
  if(filter.reason!=='all'&&!REVIEW_QUEUE_REASONS.includes(filter.reason)||
      !['all','unsaved','saved'].includes(filter.review)||typeof filter.query!=='string'||filter.query.length>100)invalid();
  const query=filter.query.trim().toLowerCase();
  return queue.items.filter(item=>(filter.reason==='all'||item.reasons.includes(filter.reason))&&
    (filter.documentId==='all'||item.documentId===filter.documentId)&&
    (filter.review==='all'||(filter.review==='saved'?item.savedEvidence>0:item.savedEvidence===0))&&
    (!query||item.question.toLowerCase().includes(query)));
}
export function reviewQueuePage(rows:readonly ReviewQueueItem[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/REVIEW_QUEUE_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*REVIEW_QUEUE_PAGE_SIZE;
  return {pages,rows:rows.slice(offset,offset+REVIEW_QUEUE_PAGE_SIZE),first:rows.length?offset+1:0,
    last:Math.min(rows.length,offset+REVIEW_QUEUE_PAGE_SIZE)};
}
export function queueQuestionDraft(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  item:ReviewQueueItem):CollectionStep{
  const turn=turns[item.turnIndex];
  if(!turn||!turn.step.documentIds.includes(item.documentId)||item.key!==key(item.turnIndex,item.partIndex,item.documentId))invalid();
  const row=collectionAnswerSummary(documents,turn).rows[item.partIndex];
  if(!row||row.question!==item.question||row.page!==item.physicalPage||!row.cells.some(cell=>cell.documentId===item.documentId))invalid();
  return {question:row.question,documentIds:[item.documentId],includeContext:turn.step.includeContext};
}
export function queueSource(documents:readonly CollectionDocument[],queue:ReviewQueue,item:ReviewQueueItem,source:Passage){
  if(!queue.items.includes(item)||!item.evidence.includes(source))invalid();
  return collectionCitation(documents,item.documentId,source).source;
}
const FORMAT='noticebridge-collection-review-queue';
const POLICY='Native retrieval diagnostics only; not verified findings, obligations or official authority.';
function encode(value:unknown){
  const text=JSON.stringify(value,null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_REVIEW_QUEUE_BYTES)invalid();
  return text;
}
/** The export contains private question text and coordinates, but no notes,
 * PDF bytes or extracted quotations. The snapshot hash binds native text. */
export async function serializeReviewQueue(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  reviews:readonly CollectionReviewEntry[],consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  const queue=await buildReviewQueueAsync(documents,turns,reviews,signal);
  const snapshot_sha256=await requestHash(serializeCollectionSnapshot(documents));
  signal.throwIfAborted();
  return encode({format:FORMAT,version:1,policy:POLICY,authority_verified:false,snapshot_sha256,
    turns:turns.map(turn=>turn.step),searches:queue.searches,reason_counts:queue.reasonCounts,
    items:queue.items.map(item=>({turn_index:item.turnIndex,part_index:item.partIndex,document_id:item.documentId,
      question:item.question,physical_page:item.physicalPage??null,reasons:item.reasons,coverage:item.coverage,
      strict_matches:item.strictMatches,shown_fragments:item.shownFragments,printed_values:item.printedValues,
      saved_evidence:item.savedEvidence,manually_reviewed:item.manuallyReviewed,
      evidence:item.evidence.map(source=>({page:source.page,ordinal:source.ordinal}))}))});
}
export async function verifyReviewQueue(text:string,documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  reviews:readonly CollectionReviewEntry[],signal:AbortSignal){
  signal.throwIfAborted();
  if(!text||text.length>MAX_REVIEW_QUEUE_BYTES||new TextEncoder().encode(text).byteLength>MAX_REVIEW_QUEUE_BYTES)invalid();
  if(await serializeReviewQueue(documents,turns,reviews,true,signal)!==text)invalid();
  return buildReviewQueue(documents,turns,reviews);
}
export async function readReviewQueue(file:File,signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_REVIEW_QUEUE_BYTES)invalid();
  const bytes=await file.arrayBuffer();signal.throwIfAborted();
  if(bytes.byteLength!==file.size)invalid();
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
