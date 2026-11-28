/** Coordinate-only reference index exchange; includes printed reference identifiers,
 * but never whole source lines, local filenames or evidence notes. */
import type {CollectionDocument} from './pdfChatCollection';
import {parseCollectionSnapshot,serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {referenceIndexForSources,type ReferenceOccurrence,type CollectionReferenceIndex} from './pdfChatCollectionReferences';
import {requestHash} from './pdfChatEmbeddingBridge';

export const MAX_REFERENCE_REPORT_BYTES=12*1024*1024;
const FORMAT='noticebridge-collection-reference-index';
const POLICY='Explicit native reference candidates only; not clause equivalence, completeness or authority.';
function invalid():never{throw Error('Invalid or mismatched collection reference report.');}
function bound(text:string){
  if(typeof text!=='string'||!text.length||text.length>MAX_REFERENCE_REPORT_BYTES||
    new TextEncoder().encode(text).byteLength>MAX_REFERENCE_REPORT_BYTES)invalid();
}
function coordinates(item:ReferenceOccurrence){
  return {page:item.source.page,ordinal:item.source.ordinal,start_utf16:item.range.start,end_utf16:item.range.end};
}
function wire(index:CollectionReferenceIndex,snapshotSha256:string){
  return {format:FORMAT,version:1,policy:POLICY,authority_verified:false,pdf_bytes_verified:false,
    reference_relationships_verified:false,snapshot_sha256:snapshotSha256,source_ids:index.documentIds,
    occurrence_budget_reached:index.limited,examined_fragments:index.examinedFragments,total_occurrences:index.totalOccurrences,
    document_coverage:index.documentCoverage.map(row=>({document_id:row.documentId,limited:row.limited,
      missing_pages:row.missingPages,processed_pages:row.processedPages,page_count:row.pageCount})),
    groups:index.groups.map(group=>({kind:group.reference.kind,identifier:group.reference.identifier,state:group.state,
      documents:group.documents,occurrences:group.occurrences,leading_count:group.leadingCount,inline_count:group.inlineCount,
      sides:group.sides.map(side=>({document_id:side.documentId,leading:side.leading.map(coordinates),inline:side.inline.map(coordinates)}))}))};
}
export type CollectionReferenceReport=ReturnType<typeof wire>;
export async function referenceSnapshotReport(snapshotText:string,ids:readonly string[],signal:AbortSignal){
  signal.throwIfAborted();
  const snapshot=parseCollectionSnapshot(snapshotText);
  if(!Array.isArray(ids)||!ids.length||ids.length>snapshot.sources.length||new Set(ids).size!==ids.length)invalid();
  const byId=new Map(snapshot.sources.map(row=>[row.id,row]));
  const selection=ids.map(id=>{const source=byId.get(id);if(!source)invalid();return source;});
  const index=referenceIndexForSources(selection);
  const hash=await requestHash(snapshotText);signal.throwIfAborted();
  const text=JSON.stringify(wire(index,hash),null,2)+'\n';bound(text);return text;
}
export async function exportReferenceReport(documents:readonly CollectionDocument[],ids:readonly string[],consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  return referenceSnapshotReport(serializeCollectionSnapshot(documents),ids,signal);
}
export async function verifyReferenceReport(candidate:string,snapshot:string,signal:AbortSignal):Promise<CollectionReferenceReport>{
  signal.throwIfAborted();bound(candidate);
  let raw:unknown;
  try{raw=JSON.parse(candidate);}catch{return invalid();}
  if(!raw||typeof raw!=='object'||!('source_ids' in raw)||!Array.isArray(raw.source_ids)||
    raw.source_ids.some(id=>typeof id!=='string'))invalid();
  const expected=await referenceSnapshotReport(snapshot,raw.source_ids,signal);
  if(expected!==candidate)invalid();
  return JSON.parse(expected) as CollectionReferenceReport;
}
