/** Collection semantic experiments remain independent per document and
 * question part. No cross-PDF score fusion or generated answer is accepted. */
import { collectionCitation, runCollectionStep, type CollectionDocument, type CollectionTurn } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';
import { preparePipeline, reviewPipeline, MAX_PIPELINE_RESULT_BYTES, type PipelineRequest, type PipelineReview } from './pdfChatPipeline';
import { requestHash } from './pdfChatEmbeddingBridge';
import { requestLocalPipeline, validLocalPipelineConfig, type LocalPipelineConfig } from './pdfChatLocalPipeline';

export const MAX_COLLECTION_MODEL_REQUESTS=6;
export const MAX_COLLECTION_MODEL_BYTES=6*1024*1024;
export const MAX_COLLECTION_MODEL_RESULT_BYTES=800*1024;
const RESULT_FORMAT='noticebridge-collection-model-results';
const MANIFEST_FORMAT='noticebridge-collection-model-manifest';
const POLICY='Independent optional extractive proposals; not verified answers or official notice authority.';
export type CollectionModelRequest={
  documentId:string;part:number;request:PipelineRequest;digest:string;bytes:number;
};
export type CollectionModelPlan={
  requests:CollectionModelRequest[];
  skipped:{documentId:string;reason:'no_native_candidates'}[];
  question:string;part:number;manifest:string;manifestDigest:string;bytes:number;
};
export type CollectionModelReview={
  documentId:string;part:number;review:PipelineReview;
};
type LocalRunner=typeof requestLocalPipeline;
function invalid():never{throw new Error('Invalid or mismatched collection model experiment.');}
function encode(value:unknown){return JSON.stringify(value,null,2)+'\n';}
function size(text:string){return new TextEncoder().encode(text).byteLength;}
function bounded(text:string,maximum:number){
  if(typeof text!=='string'||!text||text.length>maximum||size(text)>maximum)invalid();
}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(row,key)))invalid();
  return row;
}
function validateReview(documents:readonly CollectionDocument[],entry:CollectionModelRequest,review:PipelineReview){
  for(const candidate of review.ranking.candidates)collectionCitation(documents,entry.documentId,candidate.passage);
  for(const span of review.extractive.proposal.spans)collectionCitation(documents,entry.documentId,span.source);
  for(const source of review.extractive.omittedBaseline)collectionCitation(documents,entry.documentId,source);
}
/** Recompute the baseline from the saved step, preserving source identities.
 * All selected requests are prepared before any private data is disclosed. */
export async function prepareCollectionModelPlan(documents:readonly CollectionDocument[],turn:CollectionTurn,
  part:number,selection:readonly string[],mode:'full'|'shortlist',signal?:AbortSignal):Promise<CollectionModelPlan>{
  signal?.throwIfAborted();
  if(!Number.isSafeInteger(part)||part<0||!['full','shortlist'].includes(mode)||
      selection.length>MAX_COLLECTION_MODEL_REQUESTS)invalid();
  const docs=selectedCollectionDocuments(documents,selection);
  if(selection.some(id=>!turn.step.documentIds.includes(id)))invalid();
  const fresh=runCollectionStep(documents,turn.step);
  const question=fresh.results[0]?.parts[part]?.answer.question;
  if(!question)invalid();
  const requests:CollectionModelRequest[]=[],skipped:CollectionModelPlan['skipped']=[];
  let bytes=0;
  for(const doc of docs){
    signal?.throwIfAborted();
    const answer=fresh.results.find(side=>side.documentId===doc.id)?.parts[part]?.answer;
    if(!answer||answer.question!==question)invalid();
    const eligible=doc.corpus.passages.some(source=>answer.pageFilter===undefined||source.page===answer.pageFilter);
    if(!eligible){skipped.push({documentId:doc.id,reason:'no_native_candidates'});continue;}
    const request=preparePipeline(doc.index,answer,mode);
    for(const source of request.embedding.allowed.values())collectionCitation(documents,doc.id,source);
    const amount=size(request.text);bytes+=amount;
    if(bytes>MAX_COLLECTION_MODEL_BYTES)invalid();
    const digest=await requestHash(request.text);
    signal?.throwIfAborted();
    requests.push({documentId:doc.id,part,request,digest,bytes:amount});
  }
  if(!requests.length)invalid();
  const manifest=encode({format:MANIFEST_FORMAT,version:1,policy:POLICY,authority_verified:false,
    question,part,mode,requests:requests.map(entry=>({document_id:entry.documentId,request_sha256:entry.digest,
      filename:'noticebridge-collection-model-'+(entry.documentId)+'.json',bytes:entry.bytes})),
    skipped:skipped.map(entry=>({document_id:entry.documentId,reason:entry.reason}))});
  const manifestDigest=await requestHash(manifest);
  signal?.throwIfAborted();
  return {requests,skipped,question,part,manifest,manifestDigest,bytes};
}
export async function reviewCollectionModelResult(documents:readonly CollectionDocument[],entry:CollectionModelRequest,
  text:string):Promise<CollectionModelReview>{
  const review=await reviewPipeline(text,entry.request,entry.digest);
  validateReview(documents,entry,review);
  return {documentId:entry.documentId,part:entry.part,review};
}
/** Portable result bundles are bound to a canonical manifest and each
 * constituent request hash. Missing, duplicate or swapped entries reject. */
export async function bundleCollectionModelResults(documents:readonly CollectionDocument[],plan:CollectionModelPlan,
  inputs:readonly {documentId:string;text:string}[]):Promise<string>{
  if(inputs.length!==plan.requests.length||new Set(inputs.map(input=>input.documentId)).size!==inputs.length)invalid();
  const results=[];
  for(const entry of plan.requests){
    const input=inputs.find(input=>input.documentId===entry.documentId);
    if(!input)invalid();
    await reviewCollectionModelResult(documents,entry,input.text);
    results.push({document_id:entry.documentId,request_sha256:entry.digest,result:JSON.parse(input.text)});
  }
  const text=encode({format:RESULT_FORMAT,version:1,policy:POLICY,authority_verified:false,
    manifest_sha256:plan.manifestDigest,results});
  bounded(text,MAX_COLLECTION_MODEL_RESULT_BYTES);
  return text;
}
export async function reviewCollectionModelBundle(documents:readonly CollectionDocument[],plan:CollectionModelPlan,
  text:string):Promise<CollectionModelReview[]>{
  bounded(text,MAX_COLLECTION_MODEL_RESULT_BYTES);
  let value:unknown;
  try{value=JSON.parse(text);}catch{return invalid();}
  const raw=record(value,['format','version','policy','authority_verified','manifest_sha256','results']);
  if(raw.format!==RESULT_FORMAT||raw.version!==1||raw.policy!==POLICY||raw.authority_verified!==false||
      raw.manifest_sha256!==plan.manifestDigest||!Array.isArray(raw.results)||raw.results.length!==plan.requests.length)invalid();
  const inputs: {documentId:string;text:string}[]=[];
  for(let i=0;i<plan.requests.length;i++){
    const entry=plan.requests[i];
    const row=record(raw.results[i],['document_id','request_sha256','result']);
    if(row.document_id!==entry.documentId||row.request_sha256!==entry.digest)invalid();
    inputs.push({documentId:entry.documentId,text:encode(row.result)});
  }
  if(await bundleCollectionModelResults(documents,plan,inputs)!==text)invalid();
  return Promise.all(plan.requests.map((entry,i)=>reviewCollectionModelResult(documents,entry,inputs[i].text)));
}
export async function runCollectionLocalModels(documents:readonly CollectionDocument[],plan:CollectionModelPlan,
  config:LocalPipelineConfig,signal:AbortSignal,consent:boolean,onProgress?:(done:number,total:number)=>void,
  runner:LocalRunner=requestLocalPipeline):Promise<CollectionModelReview[]>{
  if(consent!==true||!validLocalPipelineConfig(config)||!plan.requests.length||plan.requests.length>MAX_COLLECTION_MODEL_REQUESTS)invalid();
  signal.throwIfAborted();
  const snapshot={...config},out:CollectionModelReview[]=[];
  onProgress?.(0,plan.requests.length);
  for(const entry of plan.requests){
    signal.throwIfAborted();
    if(await requestHash(entry.request.text)!==entry.digest)invalid();
    signal.throwIfAborted();
    const review=await runner(entry.request,snapshot,signal,true);
    signal.throwIfAborted();
    validateReview(documents,entry,review);
    if(review.ranking.model!==snapshot.embeddingModel||review.ranking.digest!==snapshot.embeddingDigest||
       review.extractive.model!==snapshot.answerModel||review.extractive.digest!==snapshot.answerDigest)invalid();
    out.push({documentId:entry.documentId,part:entry.part,review});
    onProgress?.(out.length,plan.requests.length);
  }
  signal.throwIfAborted();
  return out;
}
export async function loadCollectionModelResultFile(file:File):Promise<string>{
  if(!file.size||file.size>MAX_PIPELINE_RESULT_BYTES)invalid();
  const bytes=await file.arrayBuffer();
  if(bytes.byteLength!==file.size||bytes.byteLength>MAX_PIPELINE_RESULT_BYTES)invalid();
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
