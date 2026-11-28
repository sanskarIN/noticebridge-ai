/** Snapshot-bound regression measurements.
 *
 * An imported historical run is an untrusted observation, not a signed
 * attestation. We verify its input identities and reconstruct all scores
 * from the recorded source coordinates, never from supplied score claims.
 * Only the candidate run is freshly executed by this client.
 */
import type {Passage} from './pdfChatCore';
import type {CollectionDocument,CollectionPart} from './pdfChatCollection';
import {runCollectionStep,collectionCitation} from './pdfChatCollection';
import {requestHash} from './pdfChatEmbeddingBridge';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {
  serializeCollectionEvalLabels,resolveCollectionEvalFragment,collectionEvalCaseKey,
  evaluateCollectionAsync,scoreCollectionObservation,summarizeCollectionEvaluation,
  type CollectionEvalCase,type CollectionEvalObservation,type CollectionEvalMetrics,
  type CollectionEvaluation,
} from './pdfChatCollectionEvaluation';

export const MAX_REGRESSION_RUN_BYTES=512*1024;
export const MAX_REGRESSION_CASES=64;
export const MAX_RECORDED_CITATIONS=64;
const FORMAT='noticebridge-collection-retrieval-run';
const POLICY='Recorded native retrieval coordinates and human labels; historical execution is not authenticated.';
const SHA=/^[a-f0-9]{64}$/;
type Coordinate={page:number;ordinal:number};
type ObservationWire={
  case_key:string;
  coverage:CollectionPart['coverage'];
  retrieved:Coordinate[];
};
type RunWire={
  format:typeof FORMAT;
  version:1;
  policy:typeof POLICY;
  authority_verified:false;
  snapshot_sha256:string;
  labels_sha256:string;
  observations:ObservationWire[];
};
export type RegressionRun={
  snapshotSha256:string;
  labelsSha256:string;
  evaluation:CollectionEvaluation;
};
export type RegressionMetricName=
  'microPrecision'|'microRecall'|'meanReciprocalRank'|'exactCoverageCases'|
  'correctAbstentions'|'unexpectedMatches'|'incompleteCoverageCases';
export type RegressionMetric={
  name:RegressionMetricName;
  baseline:number|null;
  current:number|null;
  delta:number|null;
  direction:'higher'|'lower';
};
export type RegressionChange='improved'|'regressed'|'mixed'|'unchanged'|'different_retrieval';
export type RegressionCase={
  key:string;
  target:CollectionEvalCase;
  baseline:CollectionEvalObservation;
  current:CollectionEvalObservation;
  added:Passage[];
  removed:Passage[];
  gainedExpected:Passage[];
  lostExpected:Passage[];
  orderChanged:boolean;
  change:RegressionChange;
};
export type RegressionComparison={
  baseline:RegressionRun;
  current:RegressionRun;
  metrics:RegressionMetric[];
  cases:RegressionCase[];
  counts:Record<RegressionChange,number>;
};
function invalid():never{throw new Error('Invalid or mismatched collection regression run.');}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(row,key)))invalid();
  return row;
}
function bounded(text:string){
  if(typeof text!=='string'||!text||text.length>MAX_REGRESSION_RUN_BYTES||
      new TextEncoder().encode(text).byteLength>MAX_REGRESSION_RUN_BYTES)invalid();
}
function encode(value:RunWire){
  const text=JSON.stringify(value,null,2)+'\n';bounded(text);return text;
}
function decode(text:string):unknown{
  bounded(text);
  try{return JSON.parse(text);}catch{return invalid();}
}
function coordinate(source:Passage):Coordinate{
  return {page:source.page,ordinal:source.ordinal};
}
function key(source:Coordinate){return source.page+':'+source.ordinal;}
function equalOrder(a:readonly Passage[],b:readonly Passage[]){
  return a.length===b.length&&a.every((row,i)=>key(row)===key(b[i]));
}
async function identities(documents:readonly CollectionDocument[],cases:readonly CollectionEvalCase[],signal:AbortSignal){
  signal.throwIfAborted();
  const labels=await serializeCollectionEvalLabels(documents,cases,signal);
  const labelsSha256=await requestHash(labels);
  signal.throwIfAborted();
  const snapshotSha256=await requestHash(serializeCollectionSnapshot(documents));
  signal.throwIfAborted();
  return {snapshotSha256,labelsSha256};
}
export function serializeCollectionRegressionRun(run:RegressionRun):string {
  if(!SHA.test(run.snapshotSha256)||!SHA.test(run.labelsSha256)||
      !run.evaluation.observations.length||run.evaluation.observations.length>MAX_REGRESSION_CASES)invalid();
  return encode(wire(run));
}
function wire(run:RegressionRun):RunWire{
  return {
    format:FORMAT,version:1,policy:POLICY,authority_verified:false,
    snapshot_sha256:run.snapshotSha256,labels_sha256:run.labelsSha256,
    observations:run.evaluation.observations.map(row=>({
      case_key:collectionEvalCaseKey(row.target),
      coverage:row.part.coverage,
      retrieved:row.part.answer.citations.map(coordinate),
    })),
  };
}
export async function captureCollectionRegressionRun(documents:readonly CollectionDocument[],
  cases:readonly CollectionEvalCase[],signal:AbortSignal,onProgress?:(completed:number,total:number)=>void){
  const identity=await identities(documents,cases,signal);
  const evaluation=await evaluateCollectionAsync(documents,cases,signal,onProgress);
  const run={...identity,evaluation};
  return {run,text:serializeCollectionRegressionRun(run)};
}
/** A saved run may have been made by an earlier retrieval implementation.
 * Match the complete extraction and exact label set first, then resolve each
 * recorded coordinate into the attached corpus. No stored excerpt or score
 * is accepted. Page scope, duplicates and coverage are checked independently.
 */
export async function parseCollectionRegressionRun(text:string,documents:readonly CollectionDocument[],
  cases:readonly CollectionEvalCase[],signal:AbortSignal):Promise<RegressionRun>{
  signal.throwIfAborted();
  const raw=object(decode(text),['format','version','policy','authority_verified',
    'snapshot_sha256','labels_sha256','observations']);
  if(raw.format!==FORMAT||raw.version!==1||raw.policy!==POLICY||raw.authority_verified!==false||
      typeof raw.snapshot_sha256!=='string'||!SHA.test(raw.snapshot_sha256)||
      typeof raw.labels_sha256!=='string'||!SHA.test(raw.labels_sha256)||
      !Array.isArray(raw.observations)||raw.observations.length!==cases.length||
      !cases.length||cases.length>MAX_REGRESSION_CASES)invalid();
  const identity=await identities(documents,cases,signal);
  if(raw.snapshot_sha256!==identity.snapshotSha256||raw.labels_sha256!==identity.labelsSha256)invalid();
  const observations:CollectionEvalObservation[]=[];
  for(const [i,target] of cases.entries()){
    signal.throwIfAborted();
    const row=object(raw.observations[i],['case_key','coverage','retrieved']);
    if(row.case_key!==collectionEvalCaseKey(target)||!Array.isArray(row.retrieved)||
        row.retrieved.length>MAX_RECORDED_CITATIONS)invalid();
    // Reuse current scope and coverage rules, but not current citations.
    const part=runCollectionStep(documents,{question:target.question,documentIds:[target.documentId],
      includeContext:target.includeContext}).results[0].parts[0];
    if(row.coverage!==part.coverage)invalid();
    const seen=new Set<string>();
    const citations:Passage[]=[];
    for(const item of row.retrieved){
      const point=object(item,['page','ordinal']);
      if(typeof point.page!=='number'||typeof point.ordinal!=='number')invalid();
      const source=resolveCollectionEvalFragment(documents,target.documentId,point.page,point.ordinal);
      if(seen.has(key(source))||(part.answer.pageFilter!==undefined&&source.page!==part.answer.pageFilter))invalid();
      collectionCitation(documents,target.documentId,source);
      seen.add(key(source));
      citations.push(source);
    }
    const recorded:CollectionPart={
      coverage:part.coverage,
      answer:{...part.answer,citations,kind:citations.length?'passages':'insufficient',
        // Historical runs do not record these auxiliary retrieval fields.
        // Never present current values as historical results.
        contextGroups:[],printedFields:[],matchedCounts:{original:0,revised:0},missingRoles:[]},
    };
    observations.push(scoreCollectionObservation(target,recorded));
  }
  signal.throwIfAborted();
  const run={...identity,evaluation:summarizeCollectionEvaluation(observations)};
  if(encode(wire(run))!==text)invalid();
  return run;
}
function minus(left:readonly Passage[],right:readonly Passage[]){
  const others=new Set(right.map(key));
  return left.filter(row=>!others.has(key(row)));
}
function quality(row:CollectionEvalObservation):number[]{
  if(row.target.label==='no_expected_match')return [row.outcome==='expected_abstention'?1:0];
  // Precision when nothing was retrieved is undefined. Use zero only for
  // this direction comparison; displayed metrics retain null.
  return [row.recall??0,row.precision??0,row.reciprocalRank??0];
}
function compareCase(baseline:CollectionEvalObservation,current:CollectionEvalObservation):RegressionCase{
  const a=baseline.part.answer.citations,b=current.part.answer.citations;
  const added=minus(b,a),removed=minus(a,b);
  const gainedExpected=minus(current.expectedFound,baseline.expectedFound);
  const lostExpected=minus(baseline.expectedFound,current.expectedFound);
  const orderChanged=!equalOrder(a.filter(row=>!removed.includes(row)),b.filter(row=>!added.includes(row)));
  const old=quality(baseline),next=quality(current);
  const better=next.some((score,i)=>score>old[i]),worse=next.some((score,i)=>score<old[i]);
  const change:RegressionChange=better&&worse?'mixed':better?'improved':worse?'regressed':
    added.length||removed.length||orderChanged?'different_retrieval':'unchanged';
  return {key:collectionEvalCaseKey(current.target),target:current.target,baseline,current,
    added,removed,gainedExpected,lostExpected,orderChanged,change};
}
const metricDirections:Record<RegressionMetricName,'higher'|'lower'>={
  microPrecision:'higher',microRecall:'higher',meanReciprocalRank:'higher',
  exactCoverageCases:'higher',correctAbstentions:'higher',unexpectedMatches:'lower',
  incompleteCoverageCases:'lower',
};
function metricRows(a:CollectionEvalMetrics,b:CollectionEvalMetrics):RegressionMetric[]{
  return (Object.keys(metricDirections) as RegressionMetricName[]).map(name=>{
    const baseline=a[name],current=b[name];
    return {name,baseline,current,delta:baseline===null||current===null?null:current-baseline,
      direction:metricDirections[name]};
  });
}
export function compareCollectionRegressionRuns(baseline:RegressionRun,current:RegressionRun):RegressionComparison{
  if(baseline.snapshotSha256!==current.snapshotSha256||baseline.labelsSha256!==current.labelsSha256||
      baseline.evaluation.observations.length!==current.evaluation.observations.length)invalid();
  const cases=current.evaluation.observations.map((row,i)=>{
    const previous=baseline.evaluation.observations[i];
    if(collectionEvalCaseKey(previous.target)!==collectionEvalCaseKey(row.target))invalid();
    return compareCase(previous,row);
  });
  const counts:Record<RegressionChange,number>={improved:0,regressed:0,mixed:0,unchanged:0,different_retrieval:0};
  for(const row of cases)counts[row.change]++;
  return {baseline,current,metrics:metricRows(baseline.evaluation.metrics,current.evaluation.metrics),cases,counts};
}
export async function compareCollectionRegressionFile(text:string,documents:readonly CollectionDocument[],
  cases:readonly CollectionEvalCase[],signal:AbortSignal,onProgress?:(completed:number,total:number)=>void){
  const baseline=await parseCollectionRegressionRun(text,documents,cases,signal);
  const current=await captureCollectionRegressionRun(documents,cases,signal,onProgress);
  signal.throwIfAborted();
  return compareCollectionRegressionRuns(baseline,current.run);
}
export async function readCollectionRegressionFile(file:File,signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_REGRESSION_RUN_BYTES)invalid();
  const bytes=await file.arrayBuffer();
  signal.throwIfAborted();
  if(bytes.byteLength!==file.size)invalid();
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
