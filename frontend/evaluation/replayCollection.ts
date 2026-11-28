/** Offline retrieval over a validated native snapshot, never over fake PDFs.
 * The output is compatible with browser evidence/label replay. The command
 * does not open, hash, or extract the original PDF bytes. */
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBounded, publishExclusive } from './localFiles';
import { buildIndex } from '../src/pdfChatCore';
import { indexedCollectionIds, parseIndexedCollectionPlan, serializeIndexedCollectionEvidence,
  verifyIndexedCollectionEvidence, MAX_COLLECTION_PLAN_BYTES, MAX_COLLECTION_REPORT_BYTES,
  type CollectionIndexedSource } from '../src/pdfChatCollection';
import { parseCollectionSnapshot, MAX_COLLECTION_SNAPSHOT_BYTES } from '../src/pdfChatCollectionReplay';
import { parseCollectionEvalLabels, evaluateCollectionAsync, serializeEvaluatedCollection,
  MAX_COLLECTION_EVAL_BYTES } from '../src/pdfChatCollectionEvaluation';
import { serializeCollectionRegressionRun, MAX_REGRESSION_RUN_BYTES } from '../src/pdfChatCollectionRegression';
import { requestHash } from '../src/pdfChatEmbeddingBridge';

export type ReplayMode = 'questions'|'labels'|'regression'|'verify-evidence'|'verify-evaluation';
export type ReplayOptions = { mode:ReplayMode;snapshot:string;input:string;output:string;labels?:string };
const MODES:readonly ReplayMode[]=['questions','labels','regression','verify-evidence','verify-evaluation'];
const help='Usage: npm run replay:collection -- --mode questions|labels|regression|verify-evidence|verify-evaluation --snapshot snapshot.json --input input.json --output output.json [--labels labels.json]';

export function parseReplayArguments(args:readonly string[]):ReplayOptions{
  if(args.length%2||args.length<8||args.length>10)throw new Error('Invalid arguments.');
  const values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!['--mode','--snapshot','--input','--output','--labels'].includes(key)||
        values.has(key)||!value||value.startsWith('--'))throw new Error('Invalid arguments.');
    values.set(key,value);
  }
  const mode=values.get('--mode') as ReplayMode;
  if(!MODES.includes(mode)||!values.has('--snapshot')||!values.has('--input')||!values.has('--output')||
      values.has('--labels')!==(mode==='verify-evaluation'))throw new Error('Invalid arguments.');
  const path=(key:string)=>{
    const value=values.get(key)!;
    if(extname(value).toLowerCase()!=='.json')throw new Error('Expected JSON path.');
    return resolve(value);
  };
  return {mode,snapshot:path('--snapshot'),input:path('--input'),output:path('--output'),
    ...(mode==='verify-evaluation'?{labels:path('--labels')}:{})};
}

export function loadSnapshotIndexes(text:string):CollectionIndexedSource[]{
  const snapshot=parseCollectionSnapshot(text);
  const sources=snapshot.sources.map(({id,corpus})=>({
    id,corpus,index:buildIndex(corpus.passages),
    chars:corpus.passages.reduce((sum,row)=>sum+row.text.length,0),
  }));
  indexedCollectionIds(sources);
  return sources;
}

type ReplayOutput={text:string;limit:number;summary:Record<string,unknown>};
export async function replaySnapshot(mode:ReplayMode,snapshot:string,input:string,signal:AbortSignal,
  labels?:string):Promise<ReplayOutput>{
  signal.throwIfAborted();
  if(!MODES.includes(mode)||(mode==='verify-evaluation')!==(labels!==undefined))throw new Error('Invalid replay request.');
  const sources=loadSnapshotIndexes(snapshot);
  const snapshotDigest=await requestHash(snapshot);
  signal.throwIfAborted();
  const summary={mode,documents:sources.length,snapshot_sha256:snapshotDigest,
    pdf_bytes_verified:false,native_extraction_replayed:false,authority_verified:false};
  if(mode==='questions'){
    const steps=parseIndexedCollectionPlan(input,indexedCollectionIds(sources));
    const text=serializeIndexedCollectionEvidence(sources,steps);
    return {text,limit:MAX_COLLECTION_REPORT_BYTES,summary:{...summary,questions:steps.length}};
  }
  if(mode==='verify-evidence'){
    const result=verifyIndexedCollectionEvidence(input,sources);
    const report={format:'noticebridge-snapshot-replay-verification',version:1,...summary,
      artifact_sha256:await requestHash(input),exact_replay:true,questions:result.questions};
    signal.throwIfAborted();
    return {text:JSON.stringify(report,null,2)+'\n',limit:4096,summary:report};
  }
  const labelText=labels??input;
  const cases=await parseCollectionEvalLabels(labelText,sources,signal);
  const evaluation=await evaluateCollectionAsync(sources,cases,signal,undefined,()=>Promise.resolve());
  const labelsDigest=await requestHash(labelText);
  signal.throwIfAborted();
  const report=serializeEvaluatedCollection(evaluation,labelsDigest);
  if(mode==='labels')return {text:report,limit:MAX_COLLECTION_EVAL_BYTES,
    summary:{...summary,labels_sha256:labelsDigest,metrics:evaluation.metrics}};
  if(mode==='regression')return {
    text:serializeCollectionRegressionRun({snapshotSha256:snapshotDigest,labelsSha256:labelsDigest,evaluation}),
    limit:MAX_REGRESSION_RUN_BYTES,summary:{...summary,labels_sha256:labelsDigest,cases:cases.length},
  };
  if(input!==report)throw new Error('Evaluation does not exactly replay.');
  const verification={format:'noticebridge-snapshot-replay-verification',version:1,...summary,
    artifact_sha256:await requestHash(input),labels_sha256:labelsDigest,exact_replay:true,cases:cases.length};
  signal.throwIfAborted();
  return {text:JSON.stringify(verification,null,2)+'\n',limit:4096,summary:verification};
}

export async function main(args:readonly string[]):Promise<number>{
  if(args.length===1&&args[0]==='--help'){console.log(help);return 0;}
  const controller=new AbortController();
  try{
    const options=parseReplayArguments(args);
    const snapshot=readBounded(options.snapshot,MAX_COLLECTION_SNAPSHOT_BYTES);
    const limit=options.mode==='questions'?MAX_COLLECTION_PLAN_BYTES:
      options.mode==='verify-evidence'?MAX_COLLECTION_REPORT_BYTES:MAX_COLLECTION_EVAL_BYTES;
    const input=readBounded(options.input,limit);
    const labels=options.labels?readBounded(options.labels,MAX_COLLECTION_EVAL_BYTES).text:undefined;
    const result=await replaySnapshot(options.mode,snapshot.text,input.text,controller.signal,labels);
    publishExclusive(options.output,result.text,result.limit);
    console.log(JSON.stringify(result.summary));
    return 0;
  }catch{
    console.error('Collection snapshot replay failed: invalid or mismatched artifacts, or unavailable output.');
    console.error(help);
    return 1;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.exitCode=await main(process.argv.slice(2));
}
