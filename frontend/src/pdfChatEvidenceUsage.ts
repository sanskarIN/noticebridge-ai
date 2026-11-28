/** Reverse citation index over exact independently replayed question steps.
 * Frequency measures reuse in this workspace, never importance or authority. */
import {collectionCitation,collectionStats,runCollectionStep,MAX_COLLECTION_TURNS,type CollectionDocument,type CollectionTurn} from './pdfChatCollection';
import {collectionReviewKey,collectionReviewCounts,MAX_COLLECTION_REVIEW_ITEMS,type CollectionReviewEntry,type CollectionReviewStatus} from './pdfChatCollectionReview';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {requestHash} from './pdfChatEmbeddingBridge';
import type {Passage} from './pdfChatCore';

export const USAGE_PAGE_SIZE=10;
export const USAGE_LINK_PAGE_SIZE=8;
export const MAX_USAGE_BYTES=2*1024*1024;
export type EvidenceUse={turnIndex:number;partIndex:number;question:string;rank:number;physicalPage:number|null;
  channel:'strict'|'nearby';printedField:boolean};
export type EvidenceUsageRow={key:string;documentId:string;source:Passage;uses:EvidenceUse[];
  annotation:CollectionReviewEntry|null;turnCount:number;strictUses:number;nearbyUses:number};
export type UsageDocument={id:string;distinctCitations:number;citations:number;annotatedCitations:number;
  uncitedAnnotations:number;searches:number;unmatched:number};
export type EvidenceUsage={rows:EvidenceUsageRow[];documents:UsageDocument[];turns:number;searches:number;
  unmatched:number;citations:number;distinctCitations:number;reusedFragments:number;uncitedAnnotations:number};
export type UsageFilter={documentId:string|'all';usage:'all'|'reused'|'single'|'uncited';
  annotation:'all'|'unsaved'|CollectionReviewStatus;channel:'all'|'strict'|'nearby';text:string};
function invalid():never{throw Error('Invalid or stale collection citation usage index.');}
type Builder={byKey:Map<string,EvidenceUsageRow>;byDocument:Map<string,UsageDocument>;result:EvidenceUsage};
function begin(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],reviews:readonly CollectionReviewEntry[]):Builder{
  collectionStats(documents);
  if(!documents.length||turns.length>MAX_COLLECTION_TURNS||reviews.length>MAX_COLLECTION_REVIEW_ITEMS)invalid();
  collectionReviewCounts(reviews);
  const byDocument=new Map(documents.map(doc=>[doc.id,{id:doc.id,distinctCitations:0,citations:0,annotatedCitations:0,
    uncitedAnnotations:0,searches:0,unmatched:0}]));
  const byKey=new Map<string,EvidenceUsageRow>();
  for(const annotation of reviews){
    const source=collectionCitation(documents,annotation.documentId,annotation.source).source;
    const key=collectionReviewKey(annotation.documentId,source);
    if(byKey.has(key))invalid();
    byKey.set(key,{key,documentId:annotation.documentId,source,annotation,uses:[],turnCount:0,strictUses:0,nearbyUses:0});
  }
  return {byKey,byDocument,result:{rows:[],documents:[],turns:turns.length,searches:0,unmatched:0,citations:0,
    distinctCitations:0,reusedFragments:0,uncitedAnnotations:0}};
}
function append(builder:Builder,documents:readonly CollectionDocument[],turn:CollectionTurn,turnIndex:number){
  const fresh=runCollectionStep(documents,turn.step);
  // Stale or modified saved answers must not be used for graph edges.
  if(JSON.stringify(fresh)!==JSON.stringify(turn))invalid();
  for(const side of fresh.results){
    const doc=builder.byDocument.get(side.documentId)!;
    for(const [partIndex,part] of side.parts.entries()){
      doc.searches++;builder.result.searches++;
      const answer=part.answer;
      if(!answer.citations.length){doc.unmatched++;builder.result.unmatched++;}
      const nearby=new Set(answer.contextGroups.flatMap(group=>group.citations));
      const printed=new Set(answer.printedFields.map(field=>field.citation));
      for(const [index,source] of answer.citations.entries()){
        collectionCitation(documents,side.documentId,source);
        const key=collectionReviewKey(side.documentId,source);
        let row=builder.byKey.get(key);
        if(!row){row={key,documentId:side.documentId,source,annotation:null,uses:[],turnCount:0,strictUses:0,nearbyUses:0};builder.byKey.set(key,row);}
        const rank=index+1,channel=nearby.has(rank)?'nearby':'strict';
        row.uses.push({turnIndex,partIndex,question:answer.question,rank,physicalPage:answer.pageFilter??null,
          channel,printedField:printed.has(rank)});
        if(channel==='nearby')row.nearbyUses++;else row.strictUses++;
        doc.citations++;builder.result.citations++;
      }
    }
  }
}
function finish(builder:Builder):EvidenceUsage{
  const {result,byKey,byDocument}=builder;
  for(const row of byKey.values()){
    row.turnCount=new Set(row.uses.map(use=>use.turnIndex)).size;
    const doc=byDocument.get(row.documentId)!;
    if(row.uses.length){
      doc.distinctCitations++;result.distinctCitations++;
      if(row.annotation)doc.annotatedCitations++;
      if(row.turnCount>1)result.reusedFragments++;
    }else{doc.uncitedAnnotations++;result.uncitedAnnotations++;}
  }
  result.rows=[...byKey.values()].sort((a,b)=>b.turnCount-a.turnCount||b.uses.length-a.uses.length||
    (a.documentId<b.documentId?-1:a.documentId>b.documentId?1:0)||a.source.page-b.source.page||a.source.ordinal-b.source.ordinal);
  result.documents=[...byDocument.values()];
  return result;
}
export function buildEvidenceUsage(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],reviews:readonly CollectionReviewEntry[]):EvidenceUsage{
  const builder=begin(documents,turns,reviews);
  turns.forEach((turn,index)=>append(builder,documents,turn,index));
  return finish(builder);
}
export async function buildEvidenceUsageAsync(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],reviews:readonly CollectionReviewEntry[],
  signal:AbortSignal,onProgress?:(done:number,total:number)=>void,yieldControl=()=>new Promise<void>(resolve=>setTimeout(resolve,0))){
  signal.throwIfAborted();
  const builder=begin(documents,turns,reviews);
  onProgress?.(0,turns.length);
  for(let i=0;i<turns.length;i++){
    await yieldControl();signal.throwIfAborted();
    append(builder,documents,turns[i],i);onProgress?.(i+1,turns.length);signal.throwIfAborted();
  }
  return finish(builder);
}
export function filterEvidenceUsage(result:EvidenceUsage,filter:UsageFilter){
  if(!filter||filter.documentId!=='all'&&!result.documents.some(doc=>doc.id===filter.documentId)||
      !['all','reused','single','uncited'].includes(filter.usage)||!['all','unsaved','unreviewed','reviewed_manually','needs_followup'].includes(filter.annotation)||
      !['all','strict','nearby'].includes(filter.channel)||typeof filter.text!=='string'||filter.text.length>100)invalid();
  const needle=filter.text.trim().toLowerCase();
  return result.rows.filter(row=>(filter.documentId==='all'||row.documentId===filter.documentId)&&
    (filter.usage==='all'||(filter.usage==='reused'?row.turnCount>1:filter.usage==='single'?row.turnCount===1:row.turnCount===0))&&
    (filter.annotation==='all'||(filter.annotation==='unsaved'?!row.annotation:row.annotation?.status===filter.annotation))&&
    (filter.channel==='all'||(filter.channel==='strict'?row.strictUses>0:row.nearbyUses>0))&&
    (!needle||row.source.text.toLowerCase().includes(needle)||row.uses.some(use=>use.question.toLowerCase().includes(needle))));
}
export function usagePage<T>(rows:readonly T[],page:number,size=USAGE_PAGE_SIZE){
  if(![USAGE_PAGE_SIZE,USAGE_LINK_PAGE_SIZE].includes(size))invalid();
  const pages=Math.max(1,Math.ceil(rows.length/size));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*size;
  return {rows:rows.slice(offset,offset+size),pages,first:rows.length?offset+1:0,last:Math.min(rows.length,offset+size)};
}
export function inspectUsageSource(documents:readonly CollectionDocument[],result:EvidenceUsage,row:EvidenceUsageRow){
  if(!result.rows.includes(row)||row.key!==collectionReviewKey(row.documentId,row.source))invalid();
  return collectionCitation(documents,row.documentId,row.source).source;
}
export function usageTurn(turns:readonly CollectionTurn[],result:EvidenceUsage,row:EvidenceUsageRow,use:EvidenceUse){
  if(!result.rows.includes(row)||!row.uses.includes(use))invalid();
  const part=turns[use.turnIndex]?.results.find(side=>side.documentId===row.documentId)?.parts[use.partIndex];
  if(!part||part.answer.question!==use.question||part.answer.citations[use.rank-1]!==row.source||
    (part.answer.pageFilter??null)!==use.physicalPage)invalid();
  return use.turnIndex;
}
function encode(value:unknown){
  const text=JSON.stringify(value,null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_USAGE_BYTES)invalid();
  return text;
}
export async function exportEvidenceUsage(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],reviews:readonly CollectionReviewEntry[],
  consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  const result=await buildEvidenceUsageAsync(documents,turns,reviews,signal);
  const snapshotSha256=await requestHash(serializeCollectionSnapshot(documents));signal.throwIfAborted();
  return encode({format:'noticebridge-collection-citation-usage',version:1,
    policy:'Native citation reuse only; not relevance, importance, completeness or authority.',
    authority_verified:false,snapshot_sha256:snapshotSha256,turns:turns.map(turn=>turn.step),
    searches:result.searches,unmatched:result.unmatched,citations:result.citations,distinct_citations:result.distinctCitations,
    reused_fragments:result.reusedFragments,uncited_annotations:result.uncitedAnnotations,documents:result.documents,
    rows:result.rows.map(row=>({document_id:row.documentId,page:row.source.page,ordinal:row.source.ordinal,
      annotation_status:row.annotation?.status??null,turn_count:row.turnCount,strict_uses:row.strictUses,nearby_uses:row.nearbyUses,
      uses:row.uses.map(use=>({turn_index:use.turnIndex,part_index:use.partIndex,rank:use.rank,
        physical_page:use.physicalPage,channel:use.channel,printed_field:use.printedField}))}))});
}
export async function verifyEvidenceUsage(candidate:string,documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],
  reviews:readonly CollectionReviewEntry[],signal:AbortSignal){
  if(!candidate||candidate.length>MAX_USAGE_BYTES||new TextEncoder().encode(candidate).byteLength>MAX_USAGE_BYTES)invalid();
  if(candidate!==await exportEvidenceUsage(documents,turns,reviews,true,signal))invalid();
  return buildEvidenceUsageAsync(documents,turns,reviews,signal);
}
