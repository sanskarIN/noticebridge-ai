/** Portable, consent-bound paired experiment plans. No retrieval results
 * or private label notes are serialized. Labels remain a separate input. */
import {indexedCollectionIds,type CollectionIndexedSource} from './pdfChatCollection';
import {collectionEvalCaseKey,parseCollectionEvalLabels} from './pdfChatCollectionEvaluation';
import {MAX_VARIANT_CASES,validateVariantDraft,evaluateVariants,serializeVariantEvaluation,type VariantDraft} from './pdfChatQuestionVariants';
import {requestHash} from './pdfChatEmbeddingBridge';
export const MAX_VARIANT_PLAN_BYTES=128*1024;
const FORMAT='noticebridge-collection-question-variant-plan';
const POLICY='User-confirmed equivalent information need; no automatic rewriting or equivalence verification.';
function invalid():never{throw Error('Invalid or mismatched paired experiment plan.');}
function bounded(text:string){
  if(!text||text.length>MAX_VARIANT_PLAN_BYTES||new TextEncoder().encode(text).byteLength>MAX_VARIANT_PLAN_BYTES)invalid();
  return text;
}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))invalid();
  return row;
}
async function normalized(documents:readonly CollectionIndexedSource[],labelsText:string,drafts:readonly VariantDraft[],signal:AbortSignal){
  signal.throwIfAborted();
  if(!Array.isArray(drafts)||!drafts.length||drafts.length>MAX_VARIANT_CASES||
    new Set(drafts.map(row=>row.caseKey)).size!==drafts.length)invalid();
  const labels=await parseCollectionEvalLabels(labelsText,documents,signal);
  const byKey=new Map(labels.map(row=>[collectionEvalCaseKey(row),row]));
  return drafts.map(draft=>{
    const target=byKey.get(draft.caseKey);if(!target)invalid();
    return validateVariantDraft(documents,target,draft).draft;
  });
}
export async function serializeVariantPlan(documents:readonly CollectionIndexedSource[],labelsText:string,drafts:readonly VariantDraft[],
  consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  const rows=await normalized(documents,labelsText,drafts,signal);
  const labelsSha256=await requestHash(labelsText);signal.throwIfAborted();
  return bounded(JSON.stringify({format:FORMAT,version:1,policy:POLICY,authority_verified:false,equivalence_verified:false,
    labels_sha256:labelsSha256,source_ids:indexedCollectionIds(documents),cases:rows.map(row=>({
      case_key:row.caseKey,alternative_question:row.question,alternative_context:row.includeContext,equivalence_confirmed:true,
    }))},null,2)+'\n');
}
export async function parseVariantPlan(text:string,documents:readonly CollectionIndexedSource[],labelsText:string,signal:AbortSignal){
  signal.throwIfAborted();
  let value:unknown;try{value=JSON.parse(bounded(text));}catch{return invalid();}
  const row=record(value,['format','version','policy','authority_verified','equivalence_verified','labels_sha256','source_ids','cases']);
  if(row.format!==FORMAT||row.version!==1||row.policy!==POLICY||row.authority_verified!==false||row.equivalence_verified!==false||
    row.labels_sha256!==await requestHash(labelsText)||!Array.isArray(row.cases)||!row.cases.length||row.cases.length>MAX_VARIANT_CASES)invalid();
  signal.throwIfAborted();
  const ids=indexedCollectionIds(documents);
  if(!Array.isArray(row.source_ids)||row.source_ids.length!==ids.length||row.source_ids.some((id,index)=>id!==ids[index]))invalid();
  const drafts:VariantDraft[]=row.cases.map(raw=>{
    const entry=record(raw,['case_key','alternative_question','alternative_context','equivalence_confirmed']);
    if(typeof entry.case_key!=='string'||typeof entry.alternative_question!=='string'||typeof entry.alternative_context!=='boolean'||
      entry.equivalence_confirmed!==true)invalid();
    return {caseKey:entry.case_key,question:entry.alternative_question,includeContext:entry.alternative_context,equivalenceConfirmed:true};
  });
  if(await serializeVariantPlan(documents,labelsText,drafts,true,signal)!==text)invalid();
  return drafts;
}
export async function loadVariantPlan(file:File,documents:readonly CollectionIndexedSource[],labelsText:string,signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_VARIANT_PLAN_BYTES)invalid();
  const buffer=await file.arrayBuffer();signal.throwIfAborted();
  if(buffer.byteLength!==file.size)invalid();
  return parseVariantPlan(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer),documents,labelsText,signal);
}
export async function runVariantPlan(text:string,documents:readonly CollectionIndexedSource[],labelsText:string,signal:AbortSignal){
  const drafts=await parseVariantPlan(text,documents,labelsText,signal);
  const result=await evaluateVariants(documents,labelsText,drafts,signal);
  return {result,text:serializeVariantEvaluation(result,true)};
}
