/** Reproduce a focused evidence brief from a canonical snapshot and plan,
 * or verify a previously exported brief. Never open actual PDF bytes. */
import {extname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBounded,publishExclusive} from './localFiles';
import {MAX_COLLECTION_PLAN_BYTES,parseIndexedCollectionPlan} from '../src/pdfChatCollection';
import {MAX_COLLECTION_SNAPSHOT_BYTES,parseCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {buildQuestionBrief,encodeQuestionBrief,verifyQuestionBrief,questionBriefReadingCopy,
  MAX_QUESTION_BRIEF_BYTES,type QuestionBrief} from '../src/pdfChatQuestionBrief';
import {requestHash} from '../src/pdfChatEmbeddingBridge';

type Options={snapshot:string;output:string;plan?:string;candidate?:string;turn?:number;part?:number;readingCopy:boolean};
const help='Usage: npm run brief:collection -- --snapshot snapshot.json --output brief.json (--plan plan.json --turn 1 --part 1 | --verify-report brief.json) [--reading-copy]';
function invalid():never{throw Error('Invalid focused evidence brief command.');}
function positive(value:string|undefined,max:number){
  if(!value||!(/^[1-9][0-9]*$/).test(value))invalid();
  const n=Number(value);if(!Number.isSafeInteger(n)||n>max)invalid();return n;
}
export function parseBriefArguments(args:readonly string[]):Options{
  const fields=new Map<string,string>();let readingCopy=false;
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==='--reading-copy'){if(readingCopy)invalid();readingCopy=true;continue;}
    if(!['--snapshot','--output','--plan','--verify-report','--turn','--part'].includes(key)||fields.has(key))invalid();
    const value=args[++i];if(!value||value.startsWith('--'))invalid();fields.set(key,value);
  }
  function path(key:string,extension:string,optional=false){
    const value=fields.get(key);if(optional&&value===undefined)return undefined;
    if(!value||extname(value).toLowerCase()!==extension)invalid();return resolve(value);
  }
  const snapshot=path('--snapshot','.json')!,output=path('--output',readingCopy?'.txt':'.json')!;
  const plan=path('--plan','.json',true),candidate=path('--verify-report','.json',true);
  if(Boolean(plan)===Boolean(candidate)||new Set([snapshot,output,plan??candidate]).size!==3)invalid();
  if(candidate&&(fields.has('--turn')||fields.has('--part')))invalid();
  const turn=plan?positive(fields.get('--turn'),24):undefined;
  const part=plan?positive(fields.get('--part'),4):undefined;
  return {snapshot,output,plan,candidate,turn,part,readingCopy};
}
export async function executeBrief(options:Options,signal:AbortSignal){
  signal.throwIfAborted();
  const snapshot=readBounded(options.snapshot,MAX_COLLECTION_SNAPSHOT_BYTES);
  if(await requestHash(snapshot.text)!==snapshot.sha256)invalid();
  signal.throwIfAborted();
  let brief:QuestionBrief;
  if(options.candidate){
    const input=readBounded(options.candidate,MAX_QUESTION_BRIEF_BYTES);
    brief=await verifyQuestionBrief(input.text,snapshot.text,signal);
  }else{
    if(!options.plan||!options.turn||!options.part)invalid();
    const plan=readBounded(options.plan,MAX_COLLECTION_PLAN_BYTES);
    const ids=parseCollectionSnapshot(snapshot.text).sources.map(row=>row.id);
    const steps=parseIndexedCollectionPlan(plan.text,ids);
    const step=steps[options.turn-1];if(!step)invalid();
    brief=await buildQuestionBrief(snapshot.text,step,options.part-1,signal);
  }
  const canonical=encodeQuestionBrief(brief);
  const output=options.readingCopy?questionBriefReadingCopy(brief):canonical;
  const summary={format:'noticebridge-offline-question-brief-replay',version:1,
    snapshot_sha256:snapshot.sha256,brief_sha256:await requestHash(canonical),output_sha256:await requestHash(output),
    saved_report_reproduced:Boolean(options.candidate),reading_copy:options.readingCopy,
    documents:brief.sources.length,citations:brief.sources.reduce((n,row)=>n+row.displayed,0),
    pdf_bytes_verified:false,authority_verified:false,answer_accuracy_verified:false};
  signal.throwIfAborted();publishExclusive(options.output,output,MAX_QUESTION_BRIEF_BYTES);
  return summary;
}
export async function main(args:readonly string[]):Promise<number>{
  if(args.length===1&&args[0]==='--help'){console.log(help);return 0;}
  const task=new AbortController(),cancel=()=>task.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{console.log(JSON.stringify(await executeBrief(parseBriefArguments(args),task.signal)));return 0;}
  catch{console.error('Focused evidence brief failed. Check exact input artifacts, part index and exclusive output path.');return 1;}
  finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main(process.argv.slice(2)).then(code=>{process.exitCode=code;});
