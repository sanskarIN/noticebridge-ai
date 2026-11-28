/** Replay paired question experiments from canonical snapshot/label/plan
 * artifacts. The command never opens PDF bytes or invokes a model. */
import {extname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBounded,publishExclusive} from './localFiles';
import {loadSnapshotIndexes} from './replayCollection';
import {MAX_COLLECTION_SNAPSHOT_BYTES} from '../src/pdfChatCollectionReplay';
import {MAX_COLLECTION_EVAL_BYTES} from '../src/pdfChatCollectionEvaluation';
import {MAX_VARIANT_REPORT_BYTES,verifyVariantEvaluation,serializeVariantEvaluation} from '../src/pdfChatQuestionVariants';
import {MAX_VARIANT_PLAN_BYTES,runVariantPlan} from '../src/pdfChatVariantPlan';
import {requestHash} from '../src/pdfChatEmbeddingBridge';

type Mode='run'|'verify';
export type VariantOptions={mode:Mode;snapshot:string;labels:string;input:string;output:string};
const help='Usage: npm run variants:collection -- --mode run|verify --snapshot snapshot.json --labels labels.json --input plan-or-report.json --output report.json';
function invalid():never{throw Error('Invalid paired collection experiment arguments.');}
export function parseVariantArguments(args:readonly string[]):VariantOptions{
  if(args.length!==10)invalid();
  const values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!['--mode','--snapshot','--labels','--input','--output'].includes(key)||values.has(key)||!value||value.startsWith('--'))invalid();
    values.set(key,value);
  }
  const mode=values.get('--mode');
  if(mode!=='run'&&mode!=='verify')invalid();
  const path=(key:string)=>{
    const value=values.get(key);if(!value||extname(value).toLowerCase()!=='.json')invalid();return resolve(value);
  };
  const result={mode,snapshot:path('--snapshot'),labels:path('--labels'),input:path('--input'),output:path('--output')};
  if(new Set([result.snapshot,result.labels,result.input,result.output]).size!==4)invalid();
  return result;
}
export async function executeVariantCommand(options:VariantOptions,signal:AbortSignal){
  signal.throwIfAborted();
  const snapshot=readBounded(options.snapshot,MAX_COLLECTION_SNAPSHOT_BYTES);
  const labels=readBounded(options.labels,MAX_COLLECTION_EVAL_BYTES);
  const input=readBounded(options.input,options.mode==='run'?MAX_VARIANT_PLAN_BYTES:MAX_VARIANT_REPORT_BYTES);
  const sources=loadSnapshotIndexes(snapshot.text);
  if(await requestHash(snapshot.text)!==snapshot.sha256||await requestHash(labels.text)!==labels.sha256)invalid();
  signal.throwIfAborted();
  const replay=options.mode==='run'?await runVariantPlan(input.text,sources,labels.text,signal):
    {result:await verifyVariantEvaluation(input.text,sources,labels.text,signal),text:input.text};
  if(serializeVariantEvaluation(replay.result,true)!==replay.text)invalid();
  const summary={format:'noticebridge-offline-question-variant-replay',version:1,mode:options.mode,
    snapshot_sha256:snapshot.sha256,labels_sha256:labels.sha256,input_sha256:input.sha256,
    report_sha256:await requestHash(replay.text),cases:replay.result.cases.length,outcomes:replay.result.outcomes,
    native_extraction_replayed:false,pdf_bytes_verified:false,equivalence_verified:false,authority_verified:false};
  signal.throwIfAborted();
  publishExclusive(options.output,replay.text,MAX_VARIANT_REPORT_BYTES);
  return summary;
}
export async function main(args:readonly string[]):Promise<number>{
  if(args.length===1&&args[0]==='--help'){console.log(help);return 0;}
  const operation=new AbortController(),cancel=()=>operation.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{console.log(JSON.stringify(await executeVariantCommand(parseVariantArguments(args),operation.signal)));return 0;}
  catch{console.error('Paired collection experiment rejected. Check exact snapshot, labels, input and exclusive output.');return 1;}
  finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main(process.argv.slice(2)).then(code=>{process.exitCode=code;});
