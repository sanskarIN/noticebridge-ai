/** Exact offline reproduction of coordinate-level native diagnostics. */
import {extname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBounded,publishExclusive} from './localFiles';
import {parseCollectionSnapshot,MAX_COLLECTION_SNAPSHOT_BYTES} from '../src/pdfChatCollectionReplay';
import {qualitySnapshotReport,verifyQualityReport,MAX_QUALITY_REPORT_BYTES} from '../src/pdfChatCollectionQuality';
import {referenceSnapshotReport,verifyReferenceReport,MAX_REFERENCE_REPORT_BYTES} from '../src/pdfChatReferenceReport';
import {requestHash} from '../src/pdfChatEmbeddingBridge';

type Kind='quality'|'references';
type Options={kind:Kind;snapshot:string;output:string;candidate?:string;ids:string[]};
const help='Usage: npm run diagnostics:collection -- --kind quality|references --snapshot snapshot.json --output report.json [--source SHA256 ... | --verify-report report.json]';
function invalid():never{throw Error('Invalid diagnostic command arguments.');}
export function parseDiagnosticArguments(args:readonly string[]):Options{
  if(args.length%2)invalid();
  const fields=new Map<string,string>(),ids:string[]=[];
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!value||value.startsWith('--'))invalid();
    if(key==='--source'){
      if(!/^[0-9a-f]{64}$/.test(value)||ids.includes(value)||ids.length>=6)invalid();
      ids.push(value);continue;
    }
    if(!['--kind','--snapshot','--output','--verify-report'].includes(key)||fields.has(key))invalid();
    fields.set(key,value);
  }
  const kind=fields.get('--kind');
  if(kind!=='quality'&&kind!=='references')invalid();
  function path(key:string,optional=false){
    const value=fields.get(key);
    if(optional&&value===undefined)return undefined;
    if(!value||extname(value).toLowerCase()!=='.json')invalid();
    return resolve(value);
  }
  const snapshot=path('--snapshot')!,output=path('--output')!,candidate=path('--verify-report',true);
  if(snapshot===output||candidate===output||candidate===snapshot||candidate&&ids.length)invalid();
  return {kind,snapshot,output,candidate,ids};
}
export async function executeDiagnostics(options:Options,signal:AbortSignal){
  signal.throwIfAborted();
  const snapshot=readBounded(options.snapshot,MAX_COLLECTION_SNAPSHOT_BYTES);
  if(await requestHash(snapshot.text)!==snapshot.sha256)invalid();
  signal.throwIfAborted();
  const limit=options.kind==='quality'?MAX_QUALITY_REPORT_BYTES:MAX_REFERENCE_REPORT_BYTES;
  let text:string;
  if(options.candidate){
    const candidate=readBounded(options.candidate,limit);
    if(options.kind==='quality')await verifyQualityReport(candidate.text,snapshot.text,signal);
    else await verifyReferenceReport(candidate.text,snapshot.text,signal);
    text=candidate.text;
  }else{
    const ids=options.ids.length?options.ids:parseCollectionSnapshot(snapshot.text).sources.map(row=>row.id);
    text=options.kind==='quality'?await qualitySnapshotReport(snapshot.text,ids,signal):
      await referenceSnapshotReport(snapshot.text,ids,signal);
  }
  const report=JSON.parse(text);
  const summary={kind:options.kind,source_count:report.source_ids.length,snapshot_sha256:snapshot.sha256,
    report_sha256:await requestHash(text),saved_report_reproduced:Boolean(options.candidate),
    pdf_bytes_verified:false,authority_verified:false};
  signal.throwIfAborted();publishExclusive(options.output,text,limit);
  return summary;
}
export async function main(args:readonly string[]):Promise<number>{
  if(args.length===1&&args[0]==='--help'){console.log(help);return 0;}
  const task=new AbortController(),cancel=()=>task.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{console.log(JSON.stringify(await executeDiagnostics(parseDiagnosticArguments(args),task.signal)));return 0;}
  catch{console.error('Collection diagnostics failed. Check exact snapshot, selected source IDs and exclusive output path.');return 1;}
  finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main(process.argv.slice(2)).then(code=>{process.exitCode=code;});
