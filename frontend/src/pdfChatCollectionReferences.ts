/** An explicit reference index for independent native PDFs.
 * Leading references are candidates, not certified definitions; an
 * inline reference may actually point outside the selected collection. */
import {collectionCitation,type CollectionDocument} from './pdfChatCollection';
import {selectedCollectionDocuments} from './pdfChatCollectionTools';
import {referencesIn,parseReference,type Reference,type ReferenceKind,type TextRange} from './pdfChatEvidenceExplorer';
import type {Corpus,Passage} from './pdfChatCore';

export const REFERENCE_KINDS:readonly ReferenceKind[]=['clause','section','paragraph','rule','article','annexure','schedule'];
export const COLLECTION_REFERENCE_PAGE_SIZE=10;
export const COLLECTION_REFERENCE_OCCURRENCE_PAGE_SIZE=8;
export const MAX_COLLECTION_REFERENCE_OCCURRENCES=36000;
export type ReferenceOccurrence={documentId:string;source:Passage;range:TextRange;printed:string;leading:boolean};
export type ReferenceDocumentSide={documentId:string;leading:ReferenceOccurrence[];inline:ReferenceOccurrence[]};
export type ReferenceGroup={key:string;reference:Reference;sides:ReferenceDocumentSide[];occurrences:number;
  leadingCount:number;inlineCount:number;documents:number;state:'no_leading'|'single_leading'|'multiple_leading'};
export type CollectionReferenceIndex={documentIds:string[];groups:ReferenceGroup[];totalOccurrences:number;
  examinedFragments:number;limited:boolean;documentCoverage:{documentId:string;limited:boolean;missingPages:number[];processedPages:number;pageCount:number}[]};
export type ReferenceFilter={kind:ReferenceKind|'all';state:ReferenceGroup['state']|'all';documentId:string|'all';text:string;sharedOnly:boolean};
function invalid():never{throw new Error('Invalid or mismatched collection reference inspection.');}
export function referenceKey(reference:Reference){
  const parsed=parseReference(reference.kind+' '+reference.identifier);
  if(parsed.kind!==reference.kind||parsed.identifier!==reference.identifier)invalid();
  return parsed.kind+':'+parsed.identifier;
}
export function collectionReferenceIndex(documents:readonly CollectionDocument[],selection:readonly string[]):CollectionReferenceIndex{
  return referenceIndexForSources(selectedCollectionDocuments(documents,selection));
}
/** Internal diagnostic over already validated native source corpora. No fake
 * attached PDFs or indexes are created by the offline report workflow. */
export function referenceIndexForSources(selected:readonly {id:string;corpus:Corpus}[]):CollectionReferenceIndex{
  const groups=new Map<string,{reference:Reference;byDocument:Map<string,ReferenceDocumentSide>}>();
  let totalOccurrences=0,examinedFragments=0,limited=false;
  outer:for(const doc of selected){
    for(const source of doc.corpus.passages){
      examinedFragments++;
      const found=referencesIn(source.text);
      for(const {reference,range} of found){
        if(totalOccurrences===MAX_COLLECTION_REFERENCE_OCCURRENCES){limited=true;break outer;}
        const key=referenceKey(reference);
        let group=groups.get(key);
        if(!group){group={reference,byDocument:new Map()};groups.set(key,group);}
        let side=group.byDocument.get(doc.id);
        if(!side){side={documentId:doc.id,leading:[],inline:[]};group.byDocument.set(doc.id,side);}
        const leading=!source.text.slice(0,range.start).trim();
        const item={documentId:doc.id,source,range,printed:source.text.slice(range.start,range.end),leading};
        (leading?side.leading:side.inline).push(item);totalOccurrences++;
      }
    }
  }
  const rows:ReferenceGroup[]=[...groups].map(([key,group])=>{
    const sides=[...group.byDocument.values()];
    const leadingCount=sides.reduce((n,side)=>n+side.leading.length,0);
    const inlineCount=sides.reduce((n,side)=>n+side.inline.length,0);
    return {key,reference:group.reference,sides,occurrences:leadingCount+inlineCount,leadingCount,inlineCount,
      documents:sides.length,state:leadingCount===0?'no_leading':leadingCount===1?'single_leading':'multiple_leading'};
  });
  rows.sort((a,b)=>REFERENCE_KINDS.indexOf(a.reference.kind)-REFERENCE_KINDS.indexOf(b.reference.kind)||
    (a.reference.identifier<b.reference.identifier?-1:a.reference.identifier>b.reference.identifier?1:0));
  const documentCoverage=selected.map(doc=>({documentId:doc.id,limited:doc.corpus.limited,
    missingPages:[...doc.corpus.missingPages],processedPages:doc.corpus.processedPages,pageCount:doc.corpus.pageCount}));
  return {documentIds:selected.map(doc=>doc.id),groups:rows,totalOccurrences,examinedFragments,limited,documentCoverage};
}
export function filterReferenceIndex(index:CollectionReferenceIndex,filter:ReferenceFilter){
  if(!filter||filter.kind!=='all'&&!REFERENCE_KINDS.includes(filter.kind)||
      !['all','no_leading','single_leading','multiple_leading'].includes(filter.state)||
      filter.documentId!=='all'&&!index.documentIds.includes(filter.documentId)||
      typeof filter.text!=='string'||filter.text.length>100||typeof filter.sharedOnly!=='boolean')invalid();
  const needle=filter.text.trim().toLowerCase();
  return index.groups.filter(group=>(filter.kind==='all'||group.reference.kind===filter.kind)&&
    (filter.state==='all'||group.state===filter.state)&&(!filter.sharedOnly||group.documents>1)&&
    (filter.documentId==='all'||group.sides.some(side=>side.documentId===filter.documentId))&&
    (!needle||(group.reference.kind+' '+group.reference.identifier).includes(needle)));
}
export function referenceIndexPage<T>(rows:readonly T[],page:number,size=COLLECTION_REFERENCE_PAGE_SIZE){
  if(![COLLECTION_REFERENCE_PAGE_SIZE,COLLECTION_REFERENCE_OCCURRENCE_PAGE_SIZE].includes(size))invalid();
  const pages=Math.max(1,Math.ceil(rows.length/size));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*size;
  return {rows:rows.slice(offset,offset+size),pages,first:rows.length?offset+1:0,last:Math.min(rows.length,offset+size)};
}
export function inspectReferenceOccurrence(documents:readonly CollectionDocument[],index:CollectionReferenceIndex,
  group:ReferenceGroup,item:ReferenceOccurrence){
  if(!index.groups.includes(group)||!group.sides.some(side=>side.documentId===item.documentId&&
    (item.leading?side.leading:side.inline).includes(item)))invalid();
  const source=collectionCitation(documents,item.documentId,item.source).source;
  const match=referencesIn(source.text).find(found=>referenceKey(found.reference)===group.key&&
    found.range.start===item.range.start&&found.range.end===item.range.end);
  if(!match||item.printed!==source.text.slice(item.range.start,item.range.end)||
      item.leading!==!source.text.slice(0,item.range.start).trim())invalid();
  return source;
}
export type ReferenceTrail={reference:Reference;printed:string;source:Passage;documentId:string;group:ReferenceGroup;
  sameDocument:ReferenceOccurrence[];otherDocuments:ReferenceOccurrence[]};
export function referenceTrails(documents:readonly CollectionDocument[],index:CollectionReferenceIndex,documentId:string,
  source:Passage):ReferenceTrail[]{
  if(!index.documentIds.includes(documentId))invalid();
  collectionCitation(documents,documentId,source);
  const seen=new Set<string>();
  return referencesIn(source.text).flatMap(({reference,range})=>{
    const key=referenceKey(reference);
    if(seen.has(key))return [];
    seen.add(key);
    const group=index.groups.find(row=>row.key===key);
    // A budget-truncated inventory is not allowed to fabricate a group.
    if(!group)return [];
    const candidates=group.sides.flatMap(side=>[...side.leading,...side.inline])
      .filter(item=>item.documentId!==documentId||item.source!==source);
    const order=(a:ReferenceOccurrence,b:ReferenceOccurrence)=>Number(b.leading)-Number(a.leading)||
      a.source.page-b.source.page||a.source.ordinal-b.source.ordinal||a.range.start-b.range.start;
    return [{reference,printed:source.text.slice(range.start,range.end),source,documentId,group,
      sameDocument:candidates.filter(item=>item.documentId===documentId).sort(order),
      otherDocuments:candidates.filter(item=>item.documentId!==documentId)}];
  });
}
