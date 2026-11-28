/** Unverified OCR is a separate channel from native collection retrieval.
 * Never admit OCR lines into the native index, citations or review notebook. */
import { collectionStats, runCollectionStep, type CollectionDocument, type CollectionTurn } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';
import { parseOcrReview, searchOcrReviews, type OcrReview } from './pdfChatOcrReview';
import { localOcrPages, requestLocalOcr } from './pdfChatLocalOcr';
import type { Passage } from './pdfChatCore';

export const MAX_COLLECTION_OCR_LINES=12000;
export const MAX_COLLECTION_OCR_CHARS=1600000;
export const OCR_COLLECTION_PAGE_SIZE=12;
export type CollectionOcrEntry={documentId:string;review:OcrReview};
export type CollectionOcrStats={documents:number;pages:number;lines:number;chars:number};
export type CollectionOcrMatch={documentId:string;source:Passage;nativeExact:boolean};
export type CollectionOcrSide={
  documentId:string;state:'review_available'|'missing_review'|'page_not_reviewed';
  matches:CollectionOcrMatch[];reviewedPages:number[];incompletePages:number[];
};
export type CollectionOcrPage={
  documentId:string;page:number;status:OcrReview['pages'][number]['status'];
  lines:{ordinal:number;text:string;nativeExact:boolean}[];
  nativeFragments:number;
};
function invalid():never{throw new Error('Invalid or mismatched collection OCR review.');}
function canonical(review:OcrReview):string{
  return JSON.stringify({format:'noticebridge-chat-ocr-review',version:1,source_sha256:review.source_sha256,
    role:review.role,page_count:review.page_count,pages:review.pages},null,2)+'\n';
}
function validated(doc:CollectionDocument,review:OcrReview):OcrReview{
  return parseOcrReview(canonical(review),{original:doc.id},{original:doc.corpus.pageCount});
}
export function parseCollectionOcr(documents:readonly CollectionDocument[],documentId:string,text:string):CollectionOcrEntry{
  const [doc]=selectedCollectionDocuments(documents,[documentId]);
  const review=parseOcrReview(text,{original:doc.id},{original:doc.corpus.pageCount});
  if(review.role!=='original')invalid();
  return {documentId,review};
}
export function collectionOcrStats(documents:readonly CollectionDocument[],entries:readonly CollectionOcrEntry[]):CollectionOcrStats{
  collectionStats(documents);
  if(!Array.isArray(entries)||entries.length>documents.length)invalid();
  const seen=new Set<string>();
  const stats={documents:entries.length,pages:0,lines:0,chars:0};
  for(const entry of entries){
    if(!entry||seen.has(entry.documentId))invalid();
    const doc=documents.find(doc=>doc.id===entry.documentId);
    if(!doc)invalid();
    const review=validated(doc,entry.review);
    if(review.role!=='original')invalid();
    seen.add(entry.documentId);
    stats.pages+=review.pages.length;
    for(const page of review.pages){
      stats.lines+=page.lines.length;
      stats.chars+=page.lines.reduce((sum,line)=>sum+line.text.length,0);
    }
  }
  if(stats.lines>MAX_COLLECTION_OCR_LINES||stats.chars>MAX_COLLECTION_OCR_CHARS)invalid();
  return stats;
}
export function replaceCollectionOcr(documents:readonly CollectionDocument[],entries:readonly CollectionOcrEntry[],
  incoming:CollectionOcrEntry):CollectionOcrEntry[]{
  const [doc]=selectedCollectionDocuments(documents,[incoming.documentId]);
  const entry={documentId:doc.id,review:validated(doc,incoming.review)};
  const next=[...entries.filter(row=>row.documentId!==entry.documentId),entry];
  collectionOcrStats(documents,next);
  return next;
}
export function removeCollectionOcr(entries:readonly CollectionOcrEntry[],documentId:string){
  return entries.filter(row=>row.documentId!==documentId);
}
export function collectionOcrPages(documents:readonly CollectionDocument[],documentId:string,selection:string){
  const [doc]=selectedCollectionDocuments(documents,[documentId]);
  return localOcrPages(selection,doc.corpus.pageCount);
}
export async function runCollectionOcr(documents:readonly CollectionDocument[],documentId:string,
  selection:string,signal:AbortSignal,consent:boolean,runner= requestLocalOcr):Promise<CollectionOcrEntry>{
  if(consent!==true)invalid();
  const [doc]=selectedCollectionDocuments(documents,[documentId]);
  const pages=collectionOcrPages(documents,documentId,selection);
  signal.throwIfAborted();
  const review=await runner(doc.file,'original',pages,doc.corpus.pageCount,{original:doc.id},signal,true);
  signal.throwIfAborted();
  const checked=validated(doc,review);
  if(checked.role!=='original'||checked.pages.map(page=>page.page).join(',')!==pages.join(','))invalid();
  return {documentId,review:checked};
}
/** Native exact equality is only an inspection hint. Never infer OCR
 * correctness or match lines across separate physical pages. */
export function collectionOcrPage(documents:readonly CollectionDocument[],entry:CollectionOcrEntry,page:number):CollectionOcrPage{
  const [doc]=selectedCollectionDocuments(documents,[entry.documentId]);
  const review=validated(doc,entry.review);
  const selected=review.pages.find(row=>row.page===page);
  if(!selected)invalid();
  const native=doc.corpus.passages.filter(row=>row.page===page);
  const text=new Set(native.map(row=>row.text));
  return {documentId:doc.id,page,status:selected.status,nativeFragments:native.length,
    lines:selected.lines.map(line=>({...line,nativeExact:text.has(line.text)}))};
}
export function collectionOcrPageList<T>(rows:readonly T[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/OCR_COLLECTION_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  return {pages,rows:rows.slice((page-1)*OCR_COLLECTION_PAGE_SIZE,page*OCR_COLLECTION_PAGE_SIZE)};
}
export function collectionOcrSearch(documents:readonly CollectionDocument[],entries:readonly CollectionOcrEntry[],
  turn:CollectionTurn,part:number):CollectionOcrSide[]{
  collectionOcrStats(documents,entries);
  if(!Number.isSafeInteger(part)||part<0)invalid();
  const fresh=runCollectionStep(documents,turn.step);
  return fresh.results.map(side=>{
    const answer=side.parts[part]?.answer;
    if(!answer)invalid();
    const entry=entries.find(row=>row.documentId===side.documentId);
    if(!entry)return {documentId:side.documentId,state:'missing_review',matches:[],reviewedPages:[],incompletePages:[]};
    const doc=documents.find(row=>row.id===side.documentId)!;
    const review=entry.review;
    const pages=review.pages.filter(row=>answer.pageFilter===undefined||row.page===answer.pageFilter);
    if(!pages.length)return {documentId:side.documentId,state:'page_not_reviewed',matches:[],reviewedPages:[],incompletePages:[]};
    const native=new Set(doc.corpus.passages.map(row=>row.page+':'+row.text));
    return {documentId:side.documentId,state:'review_available',
      matches:searchOcrReviews([review],answer).map(source=>({documentId:side.documentId,source,
        nativeExact:native.has(source.page+':'+source.text)})),
      reviewedPages:pages.map(row=>row.page),incompletePages:pages.filter(row=>row.status!=='ok').map(row=>row.page)};
  });
}
