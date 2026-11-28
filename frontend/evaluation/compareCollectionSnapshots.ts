/** Offline snapshot difference diagnostics. No PDF bytes are opened. */
import {extname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBounded,publishExclusive} from './localFiles';
import {MAX_COLLECTION_SNAPSHOT_BYTES} from '../src/pdfChatCollectionReplay';
import {compareCollectionSnapshots,serializeSnapshotDifference,verifySnapshotDifference,MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES} from '../src/pdfChatSnapshotDifference';

type Options={left:string;right:string;output:string;candidate?:string;requireExact:boolean};
const help='Usage: npm run compare:collection-snapshots -- --left left.json --right right.json --output difference.json [--verify-report existing.json] [--require-exact]';
function invalid():never{throw Error('Invalid collection snapshot comparison arguments.');}
export function parseSnapshotDifferenceArguments(args:readonly string[]):Options{
  const values=new Map<string,string>();
  let requireExact=false;
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==='--require-exact'){if(requireExact)invalid();requireExact=true;continue;}
    if(!['--left','--right','--output','--verify-report'].includes(key)||values.has(key))invalid();
    const value=args[++i];
    if(!value||value.startsWith('--')||extname(value).toLowerCase()!=='.json')invalid();
    values.set(key,resolve(value));
  }
  const left=values.get('--left'),right=values.get('--right'),output=values.get('--output'),candidate=values.get('--verify-report');
  if(!left||!right||!output||[left,right,candidate].includes(output))invalid();
  return {left,right,output,candidate,requireExact};
}
export async function runSnapshotDifference(options:Options,signal:AbortSignal){
  signal.throwIfAborted();
  const a=readBounded(options.left,MAX_COLLECTION_SNAPSHOT_BYTES),b=readBounded(options.right,MAX_COLLECTION_SNAPSHOT_BYTES);
  signal.throwIfAborted();
  const result=options.candidate?
    await verifySnapshotDifference(readBounded(options.candidate,MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES).text,a.text,b.text,signal):
    await compareCollectionSnapshots(a.text,b.text,signal);
  signal.throwIfAborted();
  if(result.leftSha256!==a.sha256||result.rightSha256!==b.sha256)invalid();
  const text=serializeSnapshotDifference(result);
  publishExclusive(options.output,text,MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES);
  return {status:options.requireExact&&!result.exactSnapshotMatch?3:0,summary:{
    same_fingerprint_set:result.sameFingerprintSet,exact_snapshot_match:result.exactSnapshotMatch,
    saved_report_reproduced:Boolean(options.candidate),sources:result.sources.length,
    counts:result.counts,pdf_bytes_verified:false,authority_verified:false}};
}
export async function main(args:readonly string[]):Promise<number>{
  if(args.length===1&&args[0]==='--help'){console.log(help);return 0;}
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
    const result=await runSnapshotDifference(parseSnapshotDifferenceArguments(args),controller.signal);
    console.log(JSON.stringify(result.summary));return result.status;
  }catch{console.error('Collection snapshot comparison failed. Check the inputs, report and exclusive output path.');return 1;}
  finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  void main(process.argv.slice(2)).then(code=>{process.exitCode=code;});
}
