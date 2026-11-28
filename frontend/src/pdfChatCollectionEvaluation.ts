/** Source-bound collection retrieval evaluation with explicit human labels.
 * Metrics describe agreement with those labels, not answer truth or document
 * completeness. No gold labels are generated from the retrieval result. */
import { MAX_QUESTION, type Passage } from './pdfChatCore';
import { collectionStats, collectionCitation, normalizeCollectionStep, runCollectionStep,
  type CollectionDocument, type CollectionTurn, type CollectionPart } from './pdfChatCollection';
import { requestHash } from './pdfChatEmbeddingBridge';
import { planQuestions, parseSearchQuestion } from './pdfChatInsights';

export const MAX_COLLECTION_EVAL_CASES=64;
export const MAX_COLLECTION_EVAL_EXPECTED=24;
export const MAX_COLLECTION_EVAL_NOTE=300;
export const MAX_COLLECTION_EVAL_BYTES=512*1024;
export const COLLECTION_EVAL_PAGE_SIZE=8;
const FORMAT='noticebridge-collection-retrieval-labels';
const POLICY='Human-labelled native retrieval targets; agreement is not answer truth, completeness or authority.';
const REPORT='noticebridge-collection-retrieval-evaluation';
export type ExpectedFragment={source:Passage};
export type CollectionEvalCase={
  documentId:string;
  question:string;
  includeContext:boolean;
  expected:ExpectedFragment[];
  label:'evidence'|'no_expected_match';
  note:string;
};
export type CollectionEvalObservation={
  target:CollectionEvalCase;
  part:CollectionPart;
  expectedCount:number;
  retrievedCount:number;
  correctCount:number;
  expectedFound:Passage[];
  expectedMissed:Passage[];
  unexpectedRetrieved:Passage[];
  precision:number|null;
  recall:number|null;
  reciprocalRank:number|null;
  outcome:'all_expected'|'some_expected'|'no_expected_retrieved'|'expected_abstention'|'unexpected_match';
};
export type CollectionEvalMetrics={
  cases:number;evidenceCases:number;abstentionCases:number;
  expectedFragments:number;retrievedFragments:number;correctFragments:number;
  microPrecision:number|null;microRecall:number|null;meanReciprocalRank:number|null;
  exactCoverageCases:number;correctAbstentions:number;unexpectedMatches:number;
  incompleteCoverageCases:number;
};
export type CollectionEvaluation={observations:CollectionEvalObservation[];metrics:CollectionEvalMetrics};
function invalid():never{throw new Error('Invalid or mismatched collection retrieval labels.');}
function text(value:unknown,max:number,allowEmpty=false):value is string{
  return typeof value==='string'&&value.length<=max&&(allowEmpty||!!value.trim())&&
    !/[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u.test(value);
}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(row,key)))invalid();
  return row;
}
function ids(documents:readonly CollectionDocument[]){
  collectionStats(documents);
  if(!documents.length)invalid();
  return documents.map(doc=>doc.id).sort();
}
function key(source:Passage){return source.page+':'+source.ordinal;}
export function collectionEvalCaseKey(target:Pick<CollectionEvalCase,'documentId'|'question'|'includeContext'>){
  return JSON.stringify([target.documentId,target.question,target.includeContext]);
}
export function collectionEvalTarget(documents:readonly CollectionDocument[],turn:CollectionTurn,
  documentId:string,part:number):Pick<CollectionEvalCase,'documentId'|'question'|'includeContext'>{
  if(!Number.isSafeInteger(part)||part<0||!turn.step.documentIds.includes(documentId))invalid();
  const fresh=runCollectionStep(documents,turn.step);
  const answer=fresh.results.find(side=>side.documentId===documentId)?.parts[part]?.answer;
  if(!answer)invalid();
  return {documentId,question:answer.question,includeContext:turn.step.includeContext};
}
export function resolveCollectionEvalFragment(documents:readonly CollectionDocument[],documentId:string,
  page:number,ordinal:number):Passage{
  if(!Number.isSafeInteger(page)||page<1||page>80||!Number.isSafeInteger(ordinal)||ordinal<1||ordinal>999999)invalid();
  const doc=documents.find(doc=>doc.id===documentId);
  const source=doc?.corpus.passages.find(row=>row.page===page&&row.ordinal===ordinal);
  if(!source)invalid();
  return collectionCitation(documents,documentId,source).source;
}
export function validateCollectionEvalCase(documents:readonly CollectionDocument[],target:CollectionEvalCase):CollectionEvalCase{
  if(!target||!text(target.question,MAX_QUESTION)||target.question.trim()!==target.question||
      typeof target.includeContext!=='boolean'||!text(target.note,MAX_COLLECTION_EVAL_NOTE,true)||
      !['evidence','no_expected_match'].includes(target.label)||!Array.isArray(target.expected)||
      target.expected.length>MAX_COLLECTION_EVAL_EXPECTED||
      (target.label==='evidence')!==Boolean(target.expected.length)||planQuestions(target.question).length!==1)invalid();
  normalizeCollectionStep({question:target.question,documentIds:[target.documentId],includeContext:target.includeContext},ids(documents));
  const page=parseSearchQuestion(target.question).page;
  const seen=new Set<string>();
  const expected=target.expected.map(row=>{
    if(!row?.source)invalid();
    const source=collectionCitation(documents,target.documentId,row.source).source;
    if(seen.has(key(source))||(page!==undefined&&source.page!==page))invalid();
    seen.add(key(source));return {source};
  }).sort((a,b)=>a.source.page-b.source.page||a.source.ordinal-b.source.ordinal);
  return {...target,expected};
}
function normalizeCases(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[]){
  if(!Array.isArray(cases)||!cases.length||cases.length>MAX_COLLECTION_EVAL_CASES)invalid();
  const seen=new Set<string>();
  return cases.map(target=>{
    const row=validateCollectionEvalCase(documents,target);
    const id=collectionEvalCaseKey(row);
    if(seen.has(id))invalid();
    seen.add(id);return row;
  });
}
export function upsertCollectionEvalCase(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[],
  target:CollectionEvalCase):CollectionEvalCase[]{
  const row=validateCollectionEvalCase(documents,target);
  const id=collectionEvalCaseKey(row);
  const at=cases.findIndex(item=>collectionEvalCaseKey(item)===id);
  const next=at<0?[...cases,row]:cases.map((item,index)=>index===at?row:item);
  return normalizeCases(documents,next);
}
export function removeCollectionEvalCase(cases:readonly CollectionEvalCase[],id:string){
  return cases.filter(row=>collectionEvalCaseKey(row)!==id);
}
function ratio(a:number,b:number){return b?a/b:null;}
export function evaluateCollectionCase(documents:readonly CollectionDocument[],input:CollectionEvalCase):CollectionEvalObservation{
  const target=validateCollectionEvalCase(documents,input);
  const turn=runCollectionStep(documents,{question:target.question,documentIds:[target.documentId],includeContext:target.includeContext});
  const part=turn.results[0].parts[0];
  return scoreCollectionObservation(target,part);
}
/** Score a recorded or live retrieval against independently authored labels.
 * This function does not authenticate the origin of recorded results. */
export function scoreCollectionObservation(target:CollectionEvalCase,part:CollectionPart):CollectionEvalObservation{
  const expected=target.expected.map(row=>row.source);
  const wanted=new Set(expected.map(key));
  const retrieved=part.answer.citations;
  const found=new Set(retrieved.map(key));
  const expectedFound=expected.filter(source=>found.has(key(source)));
  const expectedMissed=expected.filter(source=>!found.has(key(source)));
  const unexpectedRetrieved=retrieved.filter(source=>!wanted.has(key(source)));
  const rank=retrieved.findIndex(source=>wanted.has(key(source)));
  let outcome:CollectionEvalObservation['outcome'];
  if(!expected.length)outcome=part.answer.kind==='insufficient'?'expected_abstention':'unexpected_match';
  else if(expectedFound.length===expected.length)outcome='all_expected';
  else outcome=expectedFound.length?'some_expected':'no_expected_retrieved';
  return {target,part,expectedCount:expected.length,retrievedCount:retrieved.length,correctCount:expectedFound.length,
    expectedFound,expectedMissed,unexpectedRetrieved,precision:ratio(expectedFound.length,retrieved.length),
    recall:ratio(expectedFound.length,expected.length),
    reciprocalRank:expected.length?(rank<0?0:1/(rank+1)):null,outcome};
}
export function evaluateCollection(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[]):CollectionEvaluation{
  return summarizeCollectionEvaluation(normalizeCases(documents,cases).map(row=>evaluateCollectionCase(documents,row)));
}
export function summarizeCollectionEvaluation(observations:CollectionEvalObservation[]):CollectionEvaluation{
  const expectedFragments=observations.reduce((sum,row)=>sum+row.expectedCount,0);
  const retrievedFragments=observations.reduce((sum,row)=>sum+row.retrievedCount,0);
  const correctFragments=observations.reduce((sum,row)=>sum+row.correctCount,0);
  const evidence=observations.filter(row=>row.target.label==='evidence');
  const abstentions=observations.filter(row=>row.target.label==='no_expected_match');
  return {observations,metrics:{
    cases:observations.length,evidenceCases:evidence.length,abstentionCases:abstentions.length,
    expectedFragments,retrievedFragments,correctFragments,microPrecision:ratio(correctFragments,retrievedFragments),
    microRecall:ratio(correctFragments,expectedFragments),
    meanReciprocalRank:ratio(evidence.reduce((sum,row)=>sum+(row.reciprocalRank??0),0),evidence.length),
    exactCoverageCases:evidence.filter(row=>row.outcome==='all_expected').length,
    correctAbstentions:abstentions.filter(row=>row.outcome==='expected_abstention').length,
    unexpectedMatches:abstentions.filter(row=>row.outcome==='unexpected_match').length,
    incompleteCoverageCases:observations.filter(row=>row.part.coverage!=='some_text').length,
  }};
}
/** Yield between bounded cases so cancellation and browser input can run.
 * Never expose partial evaluation as a completed result. */
export async function evaluateCollectionAsync(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[],
  signal:AbortSignal,onProgress?:(completed:number,total:number)=>void,
  yieldControl:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,0))):Promise<CollectionEvaluation>{
  signal.throwIfAborted();
  const targets=normalizeCases(documents,cases);
  const observations:CollectionEvalObservation[]=[];
  onProgress?.(0,targets.length);
  for(const target of targets){
    await yieldControl();
    signal.throwIfAborted();
    observations.push(evaluateCollectionCase(documents,target));
    onProgress?.(observations.length,targets.length);
    signal.throwIfAborted();
  }
  return summarizeCollectionEvaluation(observations);
}
export function collectionEvalPage<T>(rows:readonly T[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/COLLECTION_EVAL_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  return {pages,rows:rows.slice((page-1)*COLLECTION_EVAL_PAGE_SIZE,page*COLLECTION_EVAL_PAGE_SIZE)};
}
function encode(value:unknown){
  const text=JSON.stringify(value,null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_COLLECTION_EVAL_BYTES)invalid();
  return text;
}
function decode(text:string){
  if(!text||text.length>MAX_COLLECTION_EVAL_BYTES||new TextEncoder().encode(text).byteLength>MAX_COLLECTION_EVAL_BYTES)invalid();
  try{return JSON.parse(text) as unknown;}catch{return invalid();}
}
async function wireCases(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[],signal?:AbortSignal){
  const rows=[];
  for(const target of normalizeCases(documents,cases)){
    signal?.throwIfAborted();
    const expected=[];
    for(const {source} of target.expected){
      signal?.throwIfAborted();
      expected.push({page:source.page,ordinal:source.ordinal,text_sha256:await requestHash(source.text)});
    }
    rows.push({document_id:target.documentId,question:target.question,include_context:target.includeContext,
      label:target.label,note:target.note,expected});
  }
  signal?.throwIfAborted();
  return rows;
}
export async function serializeCollectionEvalLabels(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[],signal?:AbortSignal){
  signal?.throwIfAborted();
  return encode({format:FORMAT,version:1,policy:POLICY,authority_verified:false,source_ids:ids(documents),
    cases:await wireCases(documents,cases,signal)});
}
export async function parseCollectionEvalLabels(textValue:string,documents:readonly CollectionDocument[],signal?:AbortSignal){
  signal?.throwIfAborted();
  const raw=object(decode(textValue),['format','version','policy','authority_verified','source_ids','cases']);
  const current=ids(documents);
  if(raw.format!==FORMAT||raw.version!==1||raw.policy!==POLICY||raw.authority_verified!==false||
      !Array.isArray(raw.source_ids)||raw.source_ids.length!==current.length||
      raw.source_ids.some((value,i)=>value!==current[i])||!Array.isArray(raw.cases)||
      !raw.cases.length||raw.cases.length>MAX_COLLECTION_EVAL_CASES)invalid();
  const cases:CollectionEvalCase[]=[];
  for(const value of raw.cases){
    signal?.throwIfAborted();
    const row=object(value,['document_id','question','include_context','label','note','expected']);
    if(typeof row.document_id!=='string'||typeof row.question!=='string'||typeof row.include_context!=='boolean'||
        (row.label!=='evidence'&&row.label!=='no_expected_match')||typeof row.note!=='string'||
        !Array.isArray(row.expected)||row.expected.length>MAX_COLLECTION_EVAL_EXPECTED)invalid();
    const expected:ExpectedFragment[]=[];
    for(const value of row.expected){
      const fragment=object(value,['page','ordinal','text_sha256']);
      if(typeof fragment.page!=='number'||typeof fragment.ordinal!=='number'||typeof fragment.text_sha256!=='string')invalid();
      const source=resolveCollectionEvalFragment(documents,row.document_id,fragment.page,fragment.ordinal);
      if(await requestHash(source.text)!==fragment.text_sha256)invalid();
      expected.push({source});
    }
    cases.push({documentId:row.document_id,question:row.question,includeContext:row.include_context,
      label:row.label,note:row.note,expected});
  }
  if(await serializeCollectionEvalLabels(documents,cases,signal)!==textValue)invalid();
  return normalizeCases(documents,cases);
}
export async function serializeCollectionEvalReport(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[],signal?:AbortSignal){
  const labels=await serializeCollectionEvalLabels(documents,cases,signal);
  const evaluated=evaluateCollection(documents,cases);
  const labelDigest=await requestHash(labels);
  signal?.throwIfAborted();
  return encode({format:REPORT,version:1,policy:POLICY,authority_verified:false,labels_sha256:labelDigest,
    metrics:evaluated.metrics,observations:evaluated.observations.map(row=>({
      case_key:collectionEvalCaseKey(row.target),coverage:row.part.coverage,outcome:row.outcome,
      expected_count:row.expectedCount,retrieved_count:row.retrievedCount,correct_count:row.correctCount,
      retrieved:row.part.answer.citations.map(source=>({page:source.page,ordinal:source.ordinal})),
      precision:row.precision,recall:row.recall,reciprocal_rank:row.reciprocalRank,
    }))});
}
export async function verifyCollectionEvalReport(report:string,documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[],signal?:AbortSignal){
  decode(report);
  if(await serializeCollectionEvalReport(documents,cases,signal)!==report)invalid();
  return evaluateCollection(documents,cases).metrics;
}
export async function readCollectionEvalFile(file:File,signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_COLLECTION_EVAL_BYTES)invalid();
  const bytes=await file.arrayBuffer();signal.throwIfAborted();
  if(bytes.byteLength!==file.size||bytes.byteLength>MAX_COLLECTION_EVAL_BYTES)invalid();
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
