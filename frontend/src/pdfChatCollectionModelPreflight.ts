/** Independent browser replay of the offline collection preflight report.
 * No candidate text is accepted from the report. */
import type {CollectionModelPlan} from './pdfChatCollectionModels';
import {requestHash} from './pdfChatEmbeddingBridge';

export const MAX_COLLECTION_MODEL_PREFLIGHT_BYTES=32*1024;
const FORMAT='noticebridge-collection-model-preflight';
const POLICY='Candidate inventory only; no model was invoked by preflight.';
export type PreflightPage={page:number;candidate_fragments:number};
export type PreflightRequest={
  document_id:string;
  request_sha256:string;
  request_bytes:number;
  candidate_fragments:number;
  baseline_fragments:number;
  physical_pages:PreflightPage[];
};
export type CollectionModelPreflight={
  format:typeof FORMAT;
  version:1;
  policy:typeof POLICY;
  authority_verified:false;
  manifest_sha256:string;
  mode:'full'|'shortlist';
  part:number;
  request_count:number;
  total_request_bytes:number;
  total_candidate_fragments:number;
  total_baseline_fragments:number;
  requests:PreflightRequest[];
  skipped_document_ids:string[];
};
function invalid():never{throw new Error('Invalid or mismatched collection model preflight.');}
function encode(value:unknown){return JSON.stringify(value,null,2)+'\n';}
function bound(text:string){
  if(!text||text.length>MAX_COLLECTION_MODEL_PREFLIGHT_BYTES||
      new TextEncoder().encode(text).byteLength>MAX_COLLECTION_MODEL_PREFLIGHT_BYTES)invalid();
}
export async function collectionModelPreflight(plan:CollectionModelPlan,signal?:AbortSignal):Promise<CollectionModelPreflight>{
  signal?.throwIfAborted();
  if(await requestHash(plan.manifest)!==plan.manifestDigest)invalid();
  const manifest=JSON.parse(plan.manifest);
  if(manifest.mode!=='full'&&manifest.mode!=='shortlist')invalid();
  if(!plan.requests.length||manifest.requests.length!==plan.requests.length)invalid();
  const rows:PreflightRequest[]=[];
  for(const [index,entry] of plan.requests.entries()){
    signal?.throwIfAborted();
    const bytes=new TextEncoder().encode(entry.request.text).byteLength;
    const stored=manifest.requests[index];
    if(bytes!==entry.bytes||await requestHash(entry.request.text)!==entry.digest||
        stored.request_sha256!==entry.digest||stored.document_id!==entry.documentId||stored.bytes!==bytes)invalid();
    const pages=new Map<number,number>();
    for(const source of entry.request.embedding.allowed.values()){
      if(source.role!=='original'||!Number.isSafeInteger(source.page)||source.page<1)invalid();
      pages.set(source.page,(pages.get(source.page)??0)+1);
    }
    rows.push({
      document_id:entry.documentId,
      request_sha256:entry.digest,
      request_bytes:bytes,
      candidate_fragments:entry.request.embedding.allowed.size,
      baseline_fragments:entry.request.baseline.length,
      physical_pages:[...pages].sort((a,b)=>a[0]-b[0]).map(([page,candidate_fragments])=>({page,candidate_fragments})),
    });
  }
  signal?.throwIfAborted();
  return {
    format:FORMAT,version:1,policy:POLICY,authority_verified:false,
    manifest_sha256:plan.manifestDigest,mode:manifest.mode,part:plan.part,request_count:rows.length,
    total_request_bytes:rows.reduce((sum,row)=>sum+row.request_bytes,0),
    total_candidate_fragments:rows.reduce((sum,row)=>sum+row.candidate_fragments,0),
    total_baseline_fragments:rows.reduce((sum,row)=>sum+row.baseline_fragments,0),
    requests:rows,skipped_document_ids:plan.skipped.map(row=>row.documentId),
  };
}
export async function verifyCollectionModelPreflight(text:string,plan:CollectionModelPlan,signal?:AbortSignal){
  bound(text);
  const expected=await collectionModelPreflight(plan,signal);
  // Exact canonical equality also rejects unknown fields, reordered
  // requests, duplicate JSON keys and false claims of authority.
  if(encode(expected)!==text)invalid();
  return expected;
}
export async function readCollectionModelPreflightFile(file:File,signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_COLLECTION_MODEL_PREFLIGHT_BYTES)invalid();
  const bytes=await file.arrayBuffer();
  signal.throwIfAborted();
  if(bytes.byteLength!==file.size)invalid();
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
