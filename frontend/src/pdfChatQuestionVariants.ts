/** Paired question experiments against independent human labels.
 * The alternative wording is supplied by the user, never generated from
 * answer text. A label set is reused only after explicit equivalence consent.
 * Physical page and PDF identity must stay fixed for a comparable experiment. */
import {MAX_QUESTION,type Passage} from './pdfChatCore';
import {normalizeCollectionStep,runIndexedCollectionStep,indexedCollectionIds,indexedCollectionCitation,
  type CollectionIndexedSource,type CollectionPart,type CollectionStep} from './pdfChatCollection';
import {parseSearchQuestion,planQuestions} from './pdfChatInsights';
import {collectionEvalCaseKey,parseCollectionEvalLabels,validateCollectionEvalCase,scoreCollectionObservation,
  summarizeCollectionEvaluation,type CollectionEvalCase,type CollectionEvalObservation,type CollectionEvalMetrics} from './pdfChatCollectionEvaluation';
import {requestHash} from './pdfChatEmbeddingBridge';

export const MAX_VARIANT_CASES=24;
export const MAX_VARIANT_REPORT_BYTES=512*1024;
export const VARIANT_PAGE_SIZE=6;
export type VariantDraft={caseKey:string;question:string;includeContext:boolean;equivalenceConfirmed:boolean};
export type VariantOutcome='improved'|'regressed'|'tradeoff'|'unchanged';
export type VariantCase={
  target:CollectionEvalCase;draft:VariantDraft;
  baseline:CollectionEvalObservation;alternative:CollectionEvalObservation;
  shared:Passage[];added:Passage[];removed:Passage[];outcome:VariantOutcome;
  expectedAdded:Passage[];expectedRemoved:Passage[];
};
export type VariantEvaluation={cases:VariantCase[];baseline:CollectionEvalMetrics;alternative:CollectionEvalMetrics;
  outcomes:Record<VariantOutcome,number>;changedOrder:number;labelsSha256:string};
function invalid():never{throw Error('Invalid or mismatched paired question experiment.');}
function step(documents:readonly CollectionIndexedSource[],target:CollectionEvalCase,question:string,includeContext:boolean):CollectionStep{
  if(typeof question!=='string'||question.length>MAX_QUESTION||question.trim()!==question||
    planQuestions(question).length!==1||typeof includeContext!=='boolean')invalid();
  const value=normalizeCollectionStep({question,documentIds:[target.documentId],includeContext},indexedCollectionIds(documents));
  if(parseSearchQuestion(value.question).page!==parseSearchQuestion(target.question).page)invalid();
  return value;
}
function retrieve(documents:readonly CollectionIndexedSource[],target:CollectionEvalCase,question:string,context:boolean):CollectionPart{
  const result=runIndexedCollectionStep(documents,step(documents,target,question,context));
  const parts=result.results[0]?.parts;
  if(!parts||parts.length!==1)invalid();
  return parts[0];
}
export function validateVariantDraft(documents:readonly CollectionIndexedSource[],target:CollectionEvalCase,draft:VariantDraft){
  const label=validateCollectionEvalCase(documents,target);
  if(!draft||draft.caseKey!==collectionEvalCaseKey(label)||draft.equivalenceConfirmed!==true||
    draft.question===label.question&&draft.includeContext===label.includeContext)invalid();
  const checked=step(documents,label,draft.question,draft.includeContext);
  return {label,draft:{caseKey:draft.caseKey,question:checked.question,includeContext:checked.includeContext,equivalenceConfirmed:true}};
}
function key(source:Passage){return source.page+':'+source.ordinal;}
function difference(a:readonly Passage[],b:readonly Passage[]){
  const right=new Set(b.map(key));return a.filter(source=>!right.has(key(source)));
}
function classify(a:CollectionEvalObservation,b:CollectionEvalObservation):VariantOutcome{
  // Preserve separate tradeoffs: gaining labelled evidence while returning
  // more unlabelled fragments is not automatically an improvement.
  const good=b.correctCount-a.correctCount;
  const noise=a.unexpectedRetrieved.length-b.unexpectedRetrieved.length;
  const rank=(b.reciprocalRank??0)-(a.reciprocalRank??0);
  const values=[good,noise,rank];
  const better=values.some(n=>n>0),worse=values.some(n=>n<0);
  return better&&worse?'tradeoff':better?'improved':worse?'regressed':'unchanged';
}
export function evaluateVariantCase(documents:readonly CollectionIndexedSource[],target:CollectionEvalCase,input:VariantDraft):VariantCase{
  const {label,draft}=validateVariantDraft(documents,target,input);
  const first=retrieve(documents,label,label.question,label.includeContext);
  const second=retrieve(documents,label,draft.question,draft.includeContext);
  if(first.coverage!==second.coverage)invalid();
  const baseline=scoreCollectionObservation(label,first),alternative=scoreCollectionObservation(label,second);
  for(const source of [...first.answer.citations,...second.answer.citations])indexedCollectionCitation(documents,label.documentId,source);
  const added=difference(second.answer.citations,first.answer.citations),removed=difference(first.answer.citations,second.answer.citations);
  const shared=first.answer.citations.filter(source=>!removed.includes(source));
  return {target:label,draft,baseline,alternative,shared,added,removed,outcome:classify(baseline,alternative),
    expectedAdded:difference(alternative.expectedFound,baseline.expectedFound),expectedRemoved:difference(baseline.expectedFound,alternative.expectedFound)};
}
function summarize(cases:VariantCase[],labelsSha256:string):VariantEvaluation{
  const outcomes:Record<VariantOutcome,number>={improved:0,regressed:0,tradeoff:0,unchanged:0};
  let changedOrder=0;
  for(const row of cases){
    outcomes[row.outcome]++;
    if(!row.added.length&&!row.removed.length&&
      row.baseline.part.answer.citations.map(key).join(',')!==row.alternative.part.answer.citations.map(key).join(','))changedOrder++;
  }
  return {cases,baseline:summarizeCollectionEvaluation(cases.map(row=>row.baseline)).metrics,
    alternative:summarizeCollectionEvaluation(cases.map(row=>row.alternative)).metrics,outcomes,changedOrder,labelsSha256};
}
export async function evaluateVariants(documents:readonly CollectionIndexedSource[],labelsText:string,drafts:readonly VariantDraft[],
  signal:AbortSignal,onProgress?:(done:number,total:number)=>void,yieldControl=()=>new Promise<void>(resolve=>setTimeout(resolve,0))){
  signal.throwIfAborted();
  if(!Array.isArray(drafts)||!drafts.length||drafts.length>MAX_VARIANT_CASES||new Set(drafts.map(row=>row.caseKey)).size!==drafts.length)invalid();
  const labels=await parseCollectionEvalLabels(labelsText,documents,signal);
  const byKey=new Map(labels.map(row=>[collectionEvalCaseKey(row),row]));
  const checked=drafts.map(draft=>{
    const target=byKey.get(draft.caseKey);if(!target)invalid();
    return validateVariantDraft(documents,target,draft);
  });
  const cases:VariantCase[]=[];
  onProgress?.(0,checked.length);
  for(const row of checked){
    await yieldControl();signal.throwIfAborted();
    cases.push(evaluateVariantCase(documents,row.label,row.draft));
    onProgress?.(cases.length,checked.length);signal.throwIfAborted();
  }
  const hash=await requestHash(labelsText);signal.throwIfAborted();
  return summarize(cases,hash);
}
export function variantPage<T>(rows:readonly T[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/VARIANT_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  return {pages,rows:rows.slice((page-1)*VARIANT_PAGE_SIZE,page*VARIANT_PAGE_SIZE)};
}
export function inspectVariantSource(documents:readonly CollectionIndexedSource[],result:VariantEvaluation,row:VariantCase,source:Passage){
  if(!result.cases.includes(row)||![...row.target.expected.map(item=>item.source),
    ...row.baseline.part.answer.citations,...row.alternative.part.answer.citations].includes(source))invalid();
  return indexedCollectionCitation(documents,row.target.documentId,source);
}
function coords(rows:readonly Passage[]){return rows.map(row=>({page:row.page,ordinal:row.ordinal}));}
function wireObservation(row:CollectionEvalObservation){
  return {coverage:row.part.coverage,outcome:row.outcome,retrieved:coords(row.part.answer.citations),
    expected_found:coords(row.expectedFound),expected_missed:coords(row.expectedMissed),unexpected:coords(row.unexpectedRetrieved),
    precision:row.precision,recall:row.recall,reciprocal_rank:row.reciprocalRank};
}
export function serializeVariantEvaluation(result:VariantEvaluation,consent:boolean){
  if(consent!==true||!result.cases.length||result.cases.length>MAX_VARIANT_CASES||!/^[a-f0-9]{64}$/.test(result.labelsSha256))invalid();
  const text=JSON.stringify({format:'noticebridge-collection-question-variants',version:1,
    policy:'Paired retrieval against user-supplied labels and explicitly asserted equivalent question intent.',
    authority_verified:false,equivalence_verified:false,labels_sha256:result.labelsSha256,
    metrics:{baseline:result.baseline,alternative:result.alternative},outcomes:result.outcomes,changed_order:result.changedOrder,
    cases:result.cases.map(row=>({case_key:row.draft.caseKey,alternative_question:row.draft.question,
      alternative_context:row.draft.includeContext,equivalence_confirmed:true,outcome:row.outcome,
      baseline:wireObservation(row.baseline),alternative:wireObservation(row.alternative),shared:coords(row.shared),
      added:coords(row.added),removed:coords(row.removed),expected_added:coords(row.expectedAdded),expected_removed:coords(row.expectedRemoved)}))},null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_VARIANT_REPORT_BYTES)invalid();
  return text;
}
export async function verifyVariantEvaluation(candidate:string,documents:readonly CollectionIndexedSource[],labelsText:string,signal:AbortSignal){
  if(!candidate||candidate.length>MAX_VARIANT_REPORT_BYTES||new TextEncoder().encode(candidate).byteLength>MAX_VARIANT_REPORT_BYTES)invalid();
  let raw:unknown;try{raw=JSON.parse(candidate);}catch{return invalid();}
  if(!raw||typeof raw!=='object'||!('cases' in raw)||!Array.isArray(raw.cases)||raw.cases.length>MAX_VARIANT_CASES)invalid();
  const drafts=raw.cases.map(row=>{
    if(!row||typeof row!=='object'||typeof row.case_key!=='string'||typeof row.alternative_question!=='string'||
      typeof row.alternative_context!=='boolean'||row.equivalence_confirmed!==true)invalid();
    return {caseKey:row.case_key,question:row.alternative_question,includeContext:row.alternative_context,equivalenceConfirmed:true};
  });
  const result=await evaluateVariants(documents,labelsText,drafts,signal);
  if(serializeVariantEvaluation(result,true)!==candidate)invalid();
  return result;
}
