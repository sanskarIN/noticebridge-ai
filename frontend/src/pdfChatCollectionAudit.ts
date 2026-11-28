/** Verify a Python structural-audit report against an exact collection
 * packet and the live native snapshot. This checks the report content,
 * never proves that an external auditor actually executed. */
import {collectionStats,type CollectionDocument} from './pdfChatCollection';
import {verifyCollectionPacket,MAX_COLLECTION_PACKET_BYTES,type VerifiedCollectionPacket} from './pdfChatCollectionPacket';
import {requestHash} from './pdfChatEmbeddingBridge';
export const MAX_COLLECTION_AUDIT_BYTES=128*1024;
const FORMAT='noticebridge-collection-packet-structural-audit';
const POLICY='Structural and source-reference consistency only; no retrieval replay.';
export type CollectionAuditCounts={
  documents:number;native_fragments:number;review_annotations:number;question_turns:number;question_parts:number;
  citations:number;printed_fields:number;context_groups:number;insufficient_parts:number;limited_parts:number;
};
export type CollectionAuditReport={
  format:typeof FORMAT;version:1;policy:typeof POLICY;authority_verified:false;answer_accuracy_verified:false;
  retrieval_replayed:false;native_extraction_replayed:false;canonical_browser_encoding_verified:false;
  packet_sha256:string;snapshot_sha256:string;snapshot_references_consistent:true;pdf_bytes_checked:boolean;
  pdf_byte_set_matches:boolean|null;missing_pdf_ids:string[];unexpected_pdf_ids:string[];
  sources:{document_id:string;pdf_bytes:number|null}[];counts:CollectionAuditCounts;
};
type WirePart={kind:string;coverage:string;citations:unknown[];context_groups:unknown[];printed_fields:unknown[]};
type WireEvidence={questions:{results:{parts:WirePart[]}[]}[]};
function invalid():never{throw new Error('Collection structural audit does not match the current packet and source set.');}
function encode(value:unknown){return JSON.stringify(value,null,2)+'\n';}
function bound(text:string,limit:number){
  if(typeof text!=='string'||!text||text.length>limit||new TextEncoder().encode(text).byteLength>limit)invalid();
}
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  return value as Record<string,unknown>;
}
function counts(verified:VerifiedCollectionPacket):CollectionAuditCounts{
  const {packet,workspace}=verified;
  const result:CollectionAuditCounts={
    documents:packet.sources.length,
    native_fragments:packet.sources.reduce((sum,source)=>sum+source.native_fragments,0),
    review_annotations:workspace.reviews.length,question_turns:workspace.turns.length,question_parts:0,
    citations:0,printed_fields:0,context_groups:0,insufficient_parts:0,limited_parts:0,
  };
  const evidence=packet.evidence_report as WireEvidence|null;
  for(const question of evidence?.questions??[])for(const side of question.results)for(const part of side.parts){
    result.question_parts++;
    result.citations+=part.citations.length;
    result.printed_fields+=part.printed_fields.length;
    result.context_groups+=part.context_groups.length;
    if(part.kind==='insufficient')result.insufficient_parts++;
    if(part.coverage!=='some_text')result.limited_parts++;
  }
  return result;
}
/** We intentionally support only reports with unchecked PDF bytes or an
 * exact complete current attachment set. Missing/unexpected historical
 * files cannot be authenticated from the current workspace. */
export async function reconstructCollectionAudit(packetText:string,documents:readonly CollectionDocument[],
  pdfBytesChecked:boolean,signal?:AbortSignal):Promise<CollectionAuditReport>{
  if(typeof pdfBytesChecked!=='boolean')invalid();
  collectionStats(documents);
  signal?.throwIfAborted();
  const verified=await verifyCollectionPacket(packetText,documents,signal);
  const packet_sha256=await requestHash(packetText);
  signal?.throwIfAborted();
  const sources=[];
  for(const source of verified.packet.sources){
    const doc=documents.find(row=>row.id===source.document_id);
    if(!doc)invalid();
    if(pdfBytesChecked){
      // Re-read the immutable local File bytes, rather than merely trusting
      // the ID carried in the in-memory document.
      const bytes=await doc.file.arrayBuffer();
      signal?.throwIfAborted();
      if(bytes.byteLength!==doc.file.size)invalid();
      const hash=await crypto.subtle.digest('SHA-256',bytes);
      signal?.throwIfAborted();
      if(Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')!==doc.id)invalid();
    }
    sources.push({document_id:source.document_id,pdf_bytes:pdfBytesChecked?doc.file.size:null});
  }
  return {
    format:FORMAT,version:1,policy:POLICY,authority_verified:false,answer_accuracy_verified:false,
    retrieval_replayed:false,native_extraction_replayed:false,canonical_browser_encoding_verified:false,
    packet_sha256,snapshot_sha256:verified.packet.snapshot_sha256,snapshot_references_consistent:true,
    pdf_bytes_checked:pdfBytesChecked,pdf_byte_set_matches:pdfBytesChecked?true:null,
    missing_pdf_ids:[],unexpected_pdf_ids:[],sources,counts:counts(verified),
  };
}
export async function verifyCollectionStructuralAudit(text:string,packetText:string,
  documents:readonly CollectionDocument[],signal?:AbortSignal):Promise<CollectionAuditReport>{
  signal?.throwIfAborted();
  bound(text,MAX_COLLECTION_AUDIT_BYTES);
  let raw:Record<string,unknown>;
  try{raw=object(JSON.parse(text));}catch{return invalid();}
  if(typeof raw.pdf_bytes_checked!=='boolean')invalid();
  const report=await reconstructCollectionAudit(packetText,documents,raw.pdf_bytes_checked,signal);
  if(encode(report)!==text)invalid();
  return report;
}
export async function readCollectionAuditArtifact(file:File,kind:'packet'|'audit',signal:AbortSignal):Promise<string>{
  const limit=kind==='packet'?MAX_COLLECTION_PACKET_BYTES:kind==='audit'?MAX_COLLECTION_AUDIT_BYTES:0;
  signal.throwIfAborted();
  if(!file.size||file.size>limit)invalid();
  const bytes=await file.arrayBuffer();
  signal.throwIfAborted();
  if(bytes.byteLength!==file.size||bytes.byteLength>limit)invalid();
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return invalid();}
  bound(text,limit);
  return text;
}
