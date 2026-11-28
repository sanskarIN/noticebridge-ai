/** Evaluate reviewed model candidates against explicit independent labels.
 * No model is run here. Candidate ranking and extracted answer proposals
 * are separate channels, and neither certifies relevance or answer truth. */
import {collectionCitation,runCollectionStep,type CollectionDocument,type CollectionTurn,type CollectionPart} from './pdfChatCollection';
import {collectionEvalCaseKey,parseCollectionEvalLabels,scoreCollectionObservation,summarizeCollectionEvaluation,
  type CollectionEvalCase,type CollectionEvalObservation,type CollectionEvalMetrics} from './pdfChatCollectionEvaluation';
import {prepareCollectionModelPlan,type CollectionModelPlan,type CollectionModelReview} from './pdfChatCollectionModels';
import {requestHash} from './pdfChatEmbeddingBridge';
import {passageId} from './pdfChatResearch';
import type {Passage} from './pdfChatCore';
export const MODEL_EVAL_TOP_K=4;
export const MAX_MODEL_EVAL_REPORT_BYTES=256*1024;
export type ModelEvalCase={
  target:CollectionEvalCase;requestDigest:string;allowedExpected:Passage[];notAllowedExpected:Passage[];
  baseline:CollectionEvalObservation;fused:CollectionEvalObservation;proposal:CollectionEvalObservation;
  embeddingModel:string;embeddingDigest:string;answerModel:string;answerDigest:string;
  proposalStatus:'extract'|'insufficient';
};
export type ModelEvalSkipped={documentId:string;reason:'no_label'|'no_review'|'no_native_candidates'};
export type CollectionModelEvaluation={
  manifestSha256:string;labelsSha256:string;question:string;part:number;cases:ModelEvalCase[];skipped:ModelEvalSkipped[];
  baseline:CollectionEvalMetrics;fused:CollectionEvalMetrics;proposal:CollectionEvalMetrics;
  expectedFragments:number;allowedExpectedFragments:number;shortlistRecall:number|null;
  topK:number;otherLabelCases:number;
};
function invalid():never{throw Error('Invalid or mismatched collection model evaluation.');}
function uniqueSources(rows:readonly Passage[]){
  return [...new Map(rows.map(source=>[passageId(source),source])).values()];
}
function scoredPart(part:CollectionPart,citations:Passage[]):CollectionPart{
  return {coverage:part.coverage,answer:{...part.answer,kind:citations.length?'passages':'insufficient',
    citations,printedFields:[],contextGroups:[],matchedCounts:{original:citations.length,revised:0},
    missingRoles:citations.length?[]:['original']}};
}
const SHA=/^[a-f0-9]{64}$/;
function validateReview(documents:readonly CollectionDocument[],plan:CollectionModelPlan,value:CollectionModelReview){
  const entry=plan.requests.find(row=>row.documentId===value.documentId);
  if(!entry||value.part!==plan.part)invalid();
  const {ranking,extractive}=value.review;
  if(!SHA.test(ranking.digest)||!SHA.test(extractive.digest)||!ranking.model||!extractive.model||
      ranking.candidates.length>8||ranking.candidates.length!==uniqueSources(ranking.candidates.map(row=>row.passage)).length||
      !Number.isSafeInteger(value.review.selectionCount)||value.review.selectionCount<1||value.review.selectionCount>12)invalid();
  function local(source:Passage){
    if(entry!.request.embedding.allowed.get(passageId(source))!==source)invalid();
    return collectionCitation(documents,value.documentId,source).source;
  }
  for(const row of ranking.candidates)local(row.passage);
  if(!['extract','insufficient'].includes(extractive.proposal.status)||extractive.proposal.spans.length>4||
      (extractive.proposal.status==='extract')!==Boolean(extractive.proposal.spans.length))invalid();
  for(const span of extractive.proposal.spans){
    local(span.source);
    if(span.id!==passageId(span.source)||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||
      span.start<0||span.end<=span.start||span.end>span.source.text.length||
      span.source.text.slice(span.start,span.end)!==span.text)invalid();
  }
  return entry;
}
export async function evaluateCollectionModels(documents:readonly CollectionDocument[],turn:CollectionTurn,
  plan:CollectionModelPlan,reviews:readonly CollectionModelReview[],labelsText:string,signal:AbortSignal):Promise<CollectionModelEvaluation>{
  signal.throwIfAborted();
  if(!reviews.length||new Set(reviews.map(row=>row.documentId)).size!==reviews.length)invalid();
  const manifest=JSON.parse(plan.manifest);
  if(!['full','shortlist'].includes(manifest.mode))invalid();
  const reconstructed=await prepareCollectionModelPlan(documents,turn,plan.part,
    [...plan.requests.map(row=>row.documentId),...plan.skipped.map(row=>row.documentId)],manifest.mode,signal);
  if(reconstructed.manifest!==plan.manifest||reconstructed.manifestDigest!==plan.manifestDigest||
      plan.requests.some((entry,i)=>entry.request.text!==reconstructed.requests[i].request.text||
        entry.digest!==reconstructed.requests[i].digest))invalid();
  const labels=await parseCollectionEvalLabels(labelsText,documents,signal);
  const byKey=new Map(labels.map(row=>[collectionEvalCaseKey(row),row]));
  const reviewed=new Map(reviews.map(row=>{validateReview(documents,reconstructed,row);return [row.documentId,row];}));
  const fresh=runCollectionStep(documents,turn.step);
  const cases:ModelEvalCase[]=[],skipped:ModelEvalSkipped[]=reconstructed.skipped.map(row=>({...row}));
  const selectedKeys=new Set<string>();
  for(const entry of reconstructed.requests){
    signal.throwIfAborted();
    const part=fresh.results.find(row=>row.documentId===entry.documentId)?.parts[plan.part];
    if(!part)invalid();
    const key=collectionEvalCaseKey({documentId:entry.documentId,question:part.answer.question,includeContext:turn.step.includeContext});
    selectedKeys.add(key);
    const label=byKey.get(key),review=reviewed.get(entry.documentId);
    if(!label){skipped.push({documentId:entry.documentId,reason:'no_label'});continue;}
    if(!review){skipped.push({documentId:entry.documentId,reason:'no_review'});continue;}
    const expected=label.expected.map(row=>row.source);
    const allowedExpected=expected.filter(source=>entry.request.embedding.allowed.get(passageId(source))===source);
    const notAllowedExpected=expected.filter(source=>!allowedExpected.includes(source));
    const baseline=part.answer.citations.slice(0,MODEL_EVAL_TOP_K);
    const fused=review.review.ranking.candidates.slice(0,MODEL_EVAL_TOP_K).map(row=>row.passage);
    const proposal=uniqueSources(review.review.extractive.proposal.spans.map(span=>span.source));
    cases.push({target:label,requestDigest:entry.digest,allowedExpected,notAllowedExpected,
      baseline:scoreCollectionObservation(label,scoredPart(part,baseline)),
      fused:scoreCollectionObservation(label,scoredPart(part,fused)),
      proposal:scoreCollectionObservation(label,scoredPart(part,proposal)),
      embeddingModel:review.review.ranking.model,embeddingDigest:review.review.ranking.digest,
      answerModel:review.review.extractive.model,answerDigest:review.review.extractive.digest,
      proposalStatus:review.review.extractive.proposal.status});
  }
  if(!cases.length)invalid();
  const expectedFragments=cases.reduce((n,row)=>n+row.target.expected.length,0);
  const allowedExpectedFragments=cases.reduce((n,row)=>n+row.allowedExpected.length,0);
  const labelsSha256=await requestHash(labelsText);signal.throwIfAborted();
  return {manifestSha256:plan.manifestDigest,labelsSha256,question:plan.question,part:plan.part,cases,skipped,
    baseline:summarizeCollectionEvaluation(cases.map(row=>row.baseline)).metrics,
    fused:summarizeCollectionEvaluation(cases.map(row=>row.fused)).metrics,
    proposal:summarizeCollectionEvaluation(cases.map(row=>row.proposal)).metrics,
    expectedFragments,allowedExpectedFragments,shortlistRecall:expectedFragments?allowedExpectedFragments/expectedFragments:null,
    topK:MODEL_EVAL_TOP_K,otherLabelCases:labels.filter(row=>!selectedKeys.has(collectionEvalCaseKey(row))).length};
}
function coordinates(sources:readonly Passage[]){return sources.map(source=>({page:source.page,ordinal:source.ordinal}));}
function observation(row:CollectionEvalObservation){
  return {retrieved:coordinates(row.part.answer.citations),expected_found:coordinates(row.expectedFound),
    expected_missed:coordinates(row.expectedMissed),unexpected:coordinates(row.unexpectedRetrieved),
    precision:row.precision,recall:row.recall,reciprocal_rank:row.reciprocalRank,outcome:row.outcome};
}
export function serializeModelEvaluation(result:CollectionModelEvaluation,consent:boolean){
  if(consent!==true||!SHA.test(result.manifestSha256)||!SHA.test(result.labelsSha256)||!result.cases.length)invalid();
  const text=JSON.stringify({format:'noticebridge-collection-model-evaluation',version:1,
    policy:'Agreement with supplied labels only; no verified model execution, answer truth or authority.',
    authority_verified:false,model_execution_verified:false,manifest_sha256:result.manifestSha256,
    labels_sha256:result.labelsSha256,question:result.question,part:result.part,top_k:result.topK,
    expected_fragments:result.expectedFragments,allowed_expected_fragments:result.allowedExpectedFragments,
    shortlist_recall:result.shortlistRecall,other_label_cases:result.otherLabelCases,
    metrics:{baseline:result.baseline,fused_candidates:result.fused,extractive_proposal:result.proposal},
    skipped:result.skipped,cases:result.cases.map(row=>({case_key:collectionEvalCaseKey(row.target),
      request_sha256:row.requestDigest,coverage:row.baseline.part.coverage,embedding_model:row.embeddingModel,
      embedding_digest:row.embeddingDigest,answer_model:row.answerModel,answer_digest:row.answerDigest,
      proposal_status:row.proposalStatus,allowed_expected:coordinates(row.allowedExpected),
      outside_request:coordinates(row.notAllowedExpected),baseline:observation(row.baseline),
      fused_candidates:observation(row.fused),extractive_proposal:observation(row.proposal)}))},null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_MODEL_EVAL_REPORT_BYTES)invalid();
  return text;
}
export async function verifyModelEvaluation(text:string,documents:readonly CollectionDocument[],turn:CollectionTurn,
  plan:CollectionModelPlan,reviews:readonly CollectionModelReview[],labels:string,signal:AbortSignal){
  if(!text||text.length>MAX_MODEL_EVAL_REPORT_BYTES||new TextEncoder().encode(text).byteLength>MAX_MODEL_EVAL_REPORT_BYTES)invalid();
  const result=await evaluateCollectionModels(documents,turn,plan,reviews,labels,signal);
  if(serializeModelEvaluation(result,true)!==text)invalid();
  return result;
}
