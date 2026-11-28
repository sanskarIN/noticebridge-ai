/** Compare two explicitly selected saved retrieval parts. The result is
 * a difference in the returned evidence, not a change in the PDFs. */
import {collectionCitation,collectionStats,runCollectionStep,MAX_COLLECTION_TURNS,type CollectionDocument,type CollectionTurn,type CollectionPart} from './pdfChatCollection';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {requestHash} from './pdfChatEmbeddingBridge';
import type {Passage} from './pdfChatCore';
export const TURN_DIFF_PAGE_SIZE=8;
export const MAX_TURN_DIFF_BYTES=128*1024;
export type PartPointer={turn:number;part:number};
export type SelectedPart={pointer:PartPointer;question:string;context:boolean;page:number|null;documentIds:string[]};
export type CitationDifference={source:Passage;leftRank:number|null;rightRank:number|null;leftChannel:'strict'|'nearby'|null;
  rightChannel:'strict'|'nearby'|null;state:'shared'|'left_only'|'right_only'};
export type PartSide={coverage:CollectionPart['coverage'];strictMatches:number;displayed:number;contextGroups:number;kind:'passages'|'insufficient'};
export type DocumentTurnDiff={id:string;left:PartSide|null;right:PartSide|null;state:'both'|'left_only'|'right_only';
  rows:CitationDifference[];shared:number;leftOnly:number;rightOnly:number;rankChanges:number;channelChanges:number};
export type TurnDifference={left:SelectedPart;right:SelectedPart;documents:DocumentTurnDiff[];
  sameWording:boolean;samePhysicalPage:boolean;sameContext:boolean;sameDocumentSet:boolean;
  shared:number;leftOnly:number;rightOnly:number;rankChanges:number;channelChanges:number;commonDocuments:number};
function invalid():never{throw Error('Invalid or mismatched saved question comparison.');}
function equalPointer(a:PartPointer,b:PartPointer){return a.turn===b.turn&&a.part===b.part;}
function select(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],pointer:PartPointer){
  if(!pointer||!Number.isSafeInteger(pointer.turn)||!Number.isSafeInteger(pointer.part)||pointer.turn<0||
     pointer.part<0||pointer.turn>=turns.length)invalid();
  const current=turns[pointer.turn],fresh=runCollectionStep(documents,current.step);
  if(JSON.stringify(fresh)!==JSON.stringify(current))invalid();
  const first=fresh.results[0]?.parts[pointer.part];
  if(!first)invalid();
  const byId=new Map<string,CollectionPart>();
  for(const side of fresh.results){
    const part=side.parts[pointer.part];
    if(!part||part.answer.question!==first.answer.question||part.answer.pageFilter!==first.answer.pageFilter)invalid();
    byId.set(side.documentId,part);
  }
  const selected:SelectedPart={pointer:{...pointer},question:first.answer.question,context:current.step.includeContext,
    page:first.answer.pageFilter??null,documentIds:[...current.step.documentIds]};
  return {selected,byId};
}
function summary(part:CollectionPart|undefined):PartSide|null{
  if(!part)return null;
  return {coverage:part.coverage,strictMatches:part.answer.matchedCounts.original,displayed:part.answer.citations.length,
    contextGroups:part.answer.contextGroups.length,kind:part.answer.kind};
}
function channel(part:CollectionPart,rank:number):'strict'|'nearby'{
  return part.answer.contextGroups.some(group=>group.citations.includes(rank))?'nearby':'strict';
}
function sourceKey(source:Passage){return source.page+':'+source.ordinal;}
function compareDocument(documents:readonly CollectionDocument[],id:string,left:CollectionPart|undefined,right:CollectionPart|undefined):DocumentTurnDiff{
  if(!left&&!right)invalid();
  const byKey=new Map<string,CitationDifference>();
  for(const [index,source] of (left?.answer.citations??[]).entries()){
    collectionCitation(documents,id,source);
    const key=sourceKey(source);
    if(byKey.has(key))invalid();
    byKey.set(key,{source,leftRank:index+1,rightRank:null,leftChannel:channel(left!,index+1),rightChannel:null,state:'left_only'});
  }
  for(const [index,source] of (right?.answer.citations??[]).entries()){
    collectionCitation(documents,id,source);
    const key=sourceKey(source),old=byKey.get(key),rank=index+1;
    if(old){
      if(old.source!==source||old.rightRank!==null)invalid();
      old.rightRank=rank;old.rightChannel=channel(right!,rank);old.state='shared';
    }else byKey.set(key,{source,leftRank:null,rightRank:rank,leftChannel:null,rightChannel:channel(right!,rank),state:'right_only'});
  }
  const rows=[...byKey.values()];
  const shared=rows.filter(row=>row.state==='shared');
  return {id,left:summary(left),right:summary(right),state:left&&right?'both':left?'left_only':'right_only',rows,
    shared:shared.length,leftOnly:rows.filter(row=>row.state==='left_only').length,rightOnly:rows.filter(row=>row.state==='right_only').length,
    rankChanges:shared.filter(row=>row.leftRank!==row.rightRank).length,channelChanges:shared.filter(row=>row.leftChannel!==row.rightChannel).length};
}
export function compareSavedParts(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],left:PartPointer,right:PartPointer):TurnDifference{
  collectionStats(documents);
  if(!turns.length||turns.length>MAX_COLLECTION_TURNS||equalPointer(left,right))invalid();
  const a=select(documents,turns,left),b=select(documents,turns,right);
  const ids=[...new Set([...a.selected.documentIds,...b.selected.documentIds])];
  const rows=ids.map(id=>compareDocument(documents,id,a.byId.get(id),b.byId.get(id)));
  // Count changes only in comparable source scopes. A PDF searched on
  // just one side is not evidence of a gained/lost match in that PDF.
  const common=rows.filter(row=>row.state==='both');
  return {left:a.selected,right:b.selected,documents:rows,sameWording:a.selected.question===b.selected.question,
    samePhysicalPage:a.selected.page===b.selected.page,sameContext:a.selected.context===b.selected.context,
    sameDocumentSet:common.length===rows.length,commonDocuments:common.length,
    shared:common.reduce((n,row)=>n+row.shared,0),leftOnly:common.reduce((n,row)=>n+row.leftOnly,0),
    rightOnly:common.reduce((n,row)=>n+row.rightOnly,0),rankChanges:common.reduce((n,row)=>n+row.rankChanges,0),
    channelChanges:common.reduce((n,row)=>n+row.channelChanges,0)};
}
export type TurnDiffFilter='all'|'shared'|'left_only'|'right_only'|'rank_changed'|'channel_changed';
export function filterTurnDiff(row:DocumentTurnDiff,filter:TurnDiffFilter){
  if(!['all','shared','left_only','right_only','rank_changed','channel_changed'].includes(filter))invalid();
  return row.rows.filter(item=>filter==='all'||item.state===filter||
    filter==='rank_changed'&&item.state==='shared'&&item.leftRank!==item.rightRank||
    filter==='channel_changed'&&item.state==='shared'&&item.leftChannel!==item.rightChannel);
}
export function turnDiffPage(rows:readonly CitationDifference[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/TURN_DIFF_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  return {pages,rows:rows.slice((page-1)*TURN_DIFF_PAGE_SIZE,page*TURN_DIFF_PAGE_SIZE)};
}
export function inspectTurnDiff(documents:readonly CollectionDocument[],result:TurnDifference,row:DocumentTurnDiff,item:CitationDifference){
  if(!result.documents.includes(row)||!row.rows.includes(item))invalid();
  return collectionCitation(documents,row.id,item.source).source;
}
function wire(result:TurnDifference,snapshot:string,turns:readonly CollectionTurn[]){
  return {format:'noticebridge-collection-question-part-difference',version:1,
    policy:'Comparison of displayed native retrieval only; not notice changes, relevance or authority.',
    authority_verified:false,snapshot_sha256:snapshot,
    left:{...result.left,step:turns[result.left.pointer.turn].step},right:{...result.right,step:turns[result.right.pointer.turn].step},
    same_wording:result.sameWording,same_physical_page:result.samePhysicalPage,same_context:result.sameContext,
    same_document_set:result.sameDocumentSet,common_documents:result.commonDocuments,shared:result.shared,
    left_only:result.leftOnly,right_only:result.rightOnly,rank_changes:result.rankChanges,channel_changes:result.channelChanges,
    documents:result.documents.map(row=>({id:row.id,left:row.left,right:row.right,state:row.state,
      shared:row.shared,left_only:row.leftOnly,right_only:row.rightOnly,rank_changes:row.rankChanges,channel_changes:row.channelChanges,
      rows:row.rows.map(item=>({page:item.source.page,ordinal:item.source.ordinal,left_rank:item.leftRank,right_rank:item.rightRank,
        left_channel:item.leftChannel,right_channel:item.rightChannel,state:item.state}))}))};
}
export async function exportTurnDifference(documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],left:PartPointer,right:PartPointer,
  consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  signal.throwIfAborted();
  const result=compareSavedParts(documents,turns,left,right);
  const digest=await requestHash(serializeCollectionSnapshot(documents));signal.throwIfAborted();
  const text=JSON.stringify(wire(result,digest,turns),null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_TURN_DIFF_BYTES)invalid();
  return text;
}
export async function verifyTurnDifference(candidate:string,documents:readonly CollectionDocument[],turns:readonly CollectionTurn[],signal:AbortSignal){
  if(!candidate||candidate.length>MAX_TURN_DIFF_BYTES||new TextEncoder().encode(candidate).byteLength>MAX_TURN_DIFF_BYTES)invalid();
  let value:unknown;try{value=JSON.parse(candidate);}catch{return invalid();}
  if(!value||typeof value!=='object'||!('left' in value)||!('right' in value))invalid();
  function pointer(side:unknown):PartPointer{
    if(!side||typeof side!=='object'||!('pointer' in side)||!side.pointer||typeof side.pointer!=='object'||
      !('turn' in side.pointer)||!('part' in side.pointer)||typeof side.pointer.turn!=='number'||typeof side.pointer.part!=='number')invalid();
    return {turn:side.pointer.turn,part:side.pointer.part};
  }
  const left=pointer(value.left),right=pointer(value.right);
  if(await exportTurnDifference(documents,turns,left,right,true,signal)!==candidate)invalid();
  return compareSavedParts(documents,turns,left,right);
}
