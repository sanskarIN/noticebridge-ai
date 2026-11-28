/** Literal fragment overlap across independent PDFs. No semantic merging,
 * version order, inference of removals, or normalization of text content. */
import {collectionStats,collectionCitation,type CollectionDocument} from './pdfChatCollection';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {requestHash} from './pdfChatEmbeddingBridge';
import type {Passage} from './pdfChatCore';
export const OVERLAP_PAGE_SIZE=12;
export const OVERLAP_SOURCE_PAGE_SIZE=8;
export const MAX_OVERLAP_REPORT_BYTES=4*1024*1024;
export type OverlapScope={documentIds:string[];minimumLength:number;physicalPage:number|null};
export type OverlapGroup={text:string;occurrences:number;sources:{documentId:string;fragments:Passage[]}[]};
export type OverlapDocument={documentId:string;fragments:number;distinctTexts:number;sharedTexts:number;
  exclusiveTexts:number;limited:boolean;coverage:'some_text'|'partial'|'no_indexed_text'|'not_present'|'not_indexed'};
export type OverlapPair={left:string;right:string;sharedTexts:number;leftOnly:number;rightOnly:number};
export type CollectionOverlap={scope:OverlapScope;documents:OverlapDocument[];groups:OverlapGroup[];
  pairs:OverlapPair[];sharedGroups:number;exclusiveGroups:number;occurrences:number};
export type OverlapFilter={presence:'all'|'shared'|'exclusive'|'every';documentId:string|'all';query:string};
function invalid():never{throw new Error('Invalid or mismatched literal collection overlap.');}
export function normalizeOverlapScope(documents:readonly CollectionDocument[],scope:OverlapScope):OverlapScope{
  collectionStats(documents);
  if(!scope||!Array.isArray(scope.documentIds)||scope.documentIds.length<2||scope.documentIds.length>6||
      new Set(scope.documentIds).size!==scope.documentIds.length||
      scope.documentIds.some(id=>!documents.some(doc=>doc.id===id))||
      !Number.isSafeInteger(scope.minimumLength)||scope.minimumLength<1||scope.minimumLength>900||
      scope.physicalPage!==null&&(!Number.isSafeInteger(scope.physicalPage)||scope.physicalPage<1||scope.physicalPage>80))invalid();
  return {documentIds:[...scope.documentIds],minimumLength:scope.minimumLength,physicalPage:scope.physicalPage};
}
function coverage(doc:CollectionDocument,page:number|null):OverlapDocument['coverage']{
  const c=doc.corpus;
  if(page!==null){
    if(page>c.pageCount)return 'not_present';
    if(page>c.processedPages)return 'not_indexed';
    if(c.limitedPages.includes(page))return 'partial';
    return c.missingPages.includes(page)?'no_indexed_text':'some_text';
  }
  if(c.limited)return 'partial';
  if(!c.passages.length)return 'no_indexed_text';
  return c.missingPages.length?'partial':'some_text';
}
export function collectionOverlap(documents:readonly CollectionDocument[],input:OverlapScope):CollectionOverlap{
  const scope=normalizeOverlapScope(documents,input);
  const groups=new Map<string,Map<string,Passage[]>>();
  const summaries:OverlapDocument[]=[];
  let occurrences=0;
  for(const id of scope.documentIds){
    const doc=documents.find(row=>row.id===id)!;
    const distinct=new Set<string>();
    let fragments=0;
    for(const source of doc.corpus.passages){
      if(scope.physicalPage!==null&&source.page!==scope.physicalPage||source.text.length<scope.minimumLength)continue;
      // Every native physical occurrence is retained, including repetition.
      const group=groups.get(source.text)??new Map<string,Passage[]>();
      const local=group.get(id)??[];
      local.push(source);group.set(id,local);groups.set(source.text,group);
      distinct.add(source.text);fragments++;occurrences++;
    }
    const state=coverage(doc,scope.physicalPage);
    summaries.push({documentId:id,fragments,distinctTexts:distinct.size,sharedTexts:0,exclusiveTexts:0,
      limited:state!=='some_text',coverage:state});
  }
  const rows:OverlapGroup[]=[];
  const byId=new Map(summaries.map(row=>[row.documentId,row]));
  const pairs:OverlapPair[]=[];
  for(let i=0;i<scope.documentIds.length;i++)for(let j=i+1;j<scope.documentIds.length;j++){
    pairs.push({left:scope.documentIds[i],right:scope.documentIds[j],sharedTexts:0,leftOnly:0,rightOnly:0});
  }
  let sharedGroups=0,exclusiveGroups=0;
  for(const [text,group] of groups){
    const shared=group.size>1;
    if(shared)sharedGroups++;else exclusiveGroups++;
    for(const id of group.keys()){
      const summary=byId.get(id)!;
      if(shared)summary.sharedTexts++;else summary.exclusiveTexts++;
    }
    for(const pair of pairs){
      const a=group.has(pair.left),b=group.has(pair.right);
      if(a&&b)pair.sharedTexts++;else if(a)pair.leftOnly++;else if(b)pair.rightOnly++;
    }
    const sources=[...group].map(([documentId,fragments])=>({documentId,fragments}));
    rows.push({text,sources,occurrences:sources.reduce((sum,source)=>sum+source.fragments.length,0)});
  }
  // Explicit stable order by number of PDFs and then native lexical text.
  rows.sort((a,b)=>b.sources.length-a.sources.length||b.occurrences-a.occurrences||
    (a.text<b.text?-1:a.text>b.text?1:0));
  return {scope,documents:summaries,groups:rows,pairs,sharedGroups,exclusiveGroups,occurrences};
}
export function filterCollectionOverlap(result:CollectionOverlap,filter:OverlapFilter){
  if(!['all','shared','exclusive','every'].includes(filter.presence)||
    filter.documentId!=='all'&&!result.scope.documentIds.includes(filter.documentId)||
    typeof filter.query!=='string'||filter.query.length>100)invalid();
  const query=filter.query.trim().toLowerCase();
  return result.groups.filter(group=>(filter.presence==='all'||
    filter.presence==='shared'&&group.sources.length>1||filter.presence==='exclusive'&&group.sources.length===1||
    filter.presence==='every'&&group.sources.length===result.scope.documentIds.length)&&
    (filter.documentId==='all'||group.sources.some(source=>source.documentId===filter.documentId))&&
    (!query||group.text.toLowerCase().includes(query)));
}
export function overlapPage<T>(rows:readonly T[],page:number,size=OVERLAP_PAGE_SIZE){
  if(!Number.isSafeInteger(size)||size<1||size>OVERLAP_PAGE_SIZE)invalid();
  const pages=Math.max(1,Math.ceil(rows.length/size));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*size;
  return {pages,rows:rows.slice(offset,offset+size),first:rows.length?offset+1:0,last:Math.min(rows.length,offset+size)};
}
export function inspectOverlapSource(documents:readonly CollectionDocument[],result:CollectionOverlap,
  group:OverlapGroup,documentId:string,source:Passage){
  if(!result.groups.includes(group)||source.text!==group.text||
    !group.sources.find(row=>row.documentId===documentId)?.fragments.includes(source))invalid();
  return collectionCitation(documents,documentId,source).source;
}
const FORMAT='noticebridge-collection-literal-overlap';
const POLICY='Exact native fragment text overlap only; not semantic equivalence, completeness or amendment.';
function encode(value:unknown){
  const text=JSON.stringify(value,null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_OVERLAP_REPORT_BYTES)invalid();
  return text;
}
/** Only source coordinates are exported. Exact text is bound through the
 * full snapshot, rather than copied into a second private document. */
export async function serializeCollectionOverlap(documents:readonly CollectionDocument[],scope:OverlapScope,
  consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  signal.throwIfAborted();
  const result=collectionOverlap(documents,scope);
  const snapshot_sha256=await requestHash(serializeCollectionSnapshot(documents));
  signal.throwIfAborted();
  return encode({format:FORMAT,version:1,policy:POLICY,authority_verified:false,snapshot_sha256,
    scope:result.scope,documents:result.documents,pairs:result.pairs,shared_groups:result.sharedGroups,
    exclusive_groups:result.exclusiveGroups,occurrences:result.occurrences,
    groups:result.groups.map(group=>({occurrences:group.occurrences,sources:group.sources.map(source=>({
      document_id:source.documentId,fragments:source.fragments.map(row=>({page:row.page,ordinal:row.ordinal})),
    }))}))});
}
export async function verifyCollectionOverlap(text:string,documents:readonly CollectionDocument[],signal:AbortSignal){
  signal.throwIfAborted();
  if(!text||text.length>MAX_OVERLAP_REPORT_BYTES||new TextEncoder().encode(text).byteLength>MAX_OVERLAP_REPORT_BYTES)invalid();
  let value:unknown;try{value=JSON.parse(text);}catch{return invalid();}
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const raw=value as Record<string,unknown>;
  const scope=normalizeOverlapScope(documents,raw.scope as OverlapScope);
  if(await serializeCollectionOverlap(documents,scope,true,signal)!==text)invalid();
  return collectionOverlap(documents,scope);
}
export async function readOverlapFile(file:File,signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_OVERLAP_REPORT_BYTES)invalid();
  const data=await file.arrayBuffer();signal.throwIfAborted();
  if(data.byteLength!==file.size)invalid();
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
}
