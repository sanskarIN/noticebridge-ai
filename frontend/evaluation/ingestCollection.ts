/** Local PDF.js extraction and canonical collection snapshot creation.
 * This command reads private PDF files in a local Node process. It does
 * not use an external model, upload files, or claim issuer authenticity. */
import {basename,dirname,extname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {readBoundedBinary,readBounded,publishExclusive} from './localFiles';
import {admitCollectionDocument,MAX_COLLECTION_DOCUMENTS,MAX_COLLECTION_BYTES,MAX_COLLECTION_FILE_BYTES,
  type CollectionDocument,type CollectionExtractor} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot,parseCollectionSnapshot,MAX_COLLECTION_SNAPSHOT_BYTES,replayCollectionSources,
  MAX_COLLECTION_REPLAY_BYTES} from '../src/pdfChatCollectionReplay';
import {readNativePdf} from '../src/pdfChatReadNative';
import {requestHash} from '../src/pdfChatEmbeddingBridge';
import type {getDocument} from 'pdfjs-dist';
export type IngestOptions={pdfs:string[];output:string;snapshot?:string};
const help='Usage: npm run ingest:collection -- --pdf a.pdf [--pdf b.pdf ...] --output snapshot.json [--verify-snapshot existing.json]';
function invalid():never{throw new Error('Invalid collection ingestion request.');}
export function parseIngestArguments(args:readonly string[]):IngestOptions{
  if(args.length%2||args.length<4||args.length>2*(MAX_COLLECTION_DOCUMENTS+2))invalid();
  const pdfs:string[]=[];
  let output:string|undefined,snapshot:string|undefined;
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!value||value.startsWith('--'))invalid();
    if(key==='--pdf'){
      if(extname(value).toLowerCase()!=='.pdf'||pdfs.length===MAX_COLLECTION_DOCUMENTS)invalid();
      pdfs.push(resolve(value));
    }else if(key==='--output'||key==='--verify-snapshot'){
      if(extname(value).toLowerCase()!=='.json')invalid();
      if(key==='--output'){if(output)invalid();output=resolve(value);}
      else{if(snapshot)invalid();snapshot=resolve(value);}
    }else invalid();
  }
  if(!pdfs.length||new Set(pdfs).size!==pdfs.length||!output||output===snapshot)invalid();
  return {pdfs,output,...(snapshot?{snapshot}:{})};
}
export function readPdfInputs(paths:readonly string[]):File[]{
  if(!paths.length||paths.length>MAX_COLLECTION_DOCUMENTS||new Set(paths.map(path=>resolve(path))).size!==paths.length)invalid();
  let total=0;
  const seen=new Set<string>(),files:File[]=[];
  for(const path of paths){
    if(extname(path).toLowerCase()!=='.pdf')invalid();
    const input=readBoundedBinary(path,Math.min(MAX_COLLECTION_FILE_BYTES,MAX_COLLECTION_BYTES-total));
    total+=input.bytes;
    if(seen.has(input.sha256)||total>MAX_COLLECTION_BYTES)invalid();
    seen.add(input.sha256);
    // Make an independent immutable File byte snapshot before any extraction.
    files.push(new File([new Uint8Array(input.data)],basename(path),{type:'application/pdf'}));
  }
  return files;
}
let nodeLoader:Promise<typeof getDocument>|null=null;
async function localLoader():Promise<typeof getDocument>{
  if(!nodeLoader)nodeLoader=(async()=>{
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require=createRequire(import.meta.url);
    const root=dirname(require.resolve('pdfjs-dist/package.json'));
    const loader:typeof getDocument=(options)=>{
      if(!options||typeof options!=='object'||!('data' in options)||!options.data)invalid();
      // Only bundled local resources, no remote URL or external cMap service.
      return pdfjs.getDocument({...options,useSystemFonts:false,useWorkerFetch:false,
        standardFontDataUrl:join(root,'standard_fonts')+sep,cMapUrl:join(root,'cmaps')+sep,
        cMapPacked:true,wasmUrl:join(root,'wasm')+sep,disableFontFace:true});
    };
    return loader;
  })();
  return nodeLoader;
}
export const readLocalPdf:CollectionExtractor=async(file,role,signal)=>{
  signal.throwIfAborted();
  const loader=await localLoader();signal.throwIfAborted();
  return readNativePdf(file,role,signal,loader);
};
export type IngestResult={text:string;summary:Record<string,unknown>;limit:number;status:number};
export async function ingestCollection(files:readonly File[],signal:AbortSignal,extract:CollectionExtractor=readLocalPdf):Promise<IngestResult>{
  signal.throwIfAborted();
  if(!files.length||files.length>MAX_COLLECTION_DOCUMENTS||files.reduce((n,file)=>n+file.size,0)>MAX_COLLECTION_BYTES)invalid();
  const documents:CollectionDocument[]=[];
  for(const file of files){
    signal.throwIfAborted();
    documents.push(await admitCollectionDocument(documents,file,signal,extract));
  }
  signal.throwIfAborted();
  const text=serializeCollectionSnapshot(documents);
  const snapshotSha=await requestHash(text);
  signal.throwIfAborted();
  return {text,limit:MAX_COLLECTION_SNAPSHOT_BYTES,status:0,summary:{
    format:'noticebridge-local-collection-ingestion',documents:documents.length,snapshot_sha256:snapshotSha,
    fragments:documents.reduce((n,doc)=>n+doc.corpus.passages.length,0),
    limited_documents:documents.filter(doc=>doc.corpus.limited||doc.corpus.missingPages.length>0).length,
    pdf_bytes_read:true,authority_verified:false,browser_extraction_replayed:false,
  }};
}
export async function verifyIngestedCollection(snapshot:string,files:readonly File[],signal:AbortSignal,
  extract:CollectionExtractor=readLocalPdf):Promise<IngestResult>{
  parseCollectionSnapshot(snapshot);
  const result=await replayCollectionSources(snapshot,files,{signal,extract});
  return {text:result.text,limit:MAX_COLLECTION_REPLAY_BYTES,status:result.report.status==='exact_replay'?0:3,
    summary:{format:result.report.format,status:result.report.status,all_pdf_bytes_match:result.report.all_pdf_bytes_match,
      all_native_extractions_match:result.report.all_native_extractions_match,snapshot_sha256:result.report.snapshot_sha256,
      authority_verified:false}};
}
export async function main(args:readonly string[]):Promise<number>{
  if(args.length===1&&args[0]==='--help'){console.log(help);return 0;}
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
    const options=parseIngestArguments(args);
    const files=readPdfInputs(options.pdfs);
    const result=options.snapshot?await verifyIngestedCollection(readBounded(options.snapshot,MAX_COLLECTION_SNAPSHOT_BYTES).text,
      files,controller.signal):await ingestCollection(files,controller.signal);
    controller.signal.throwIfAborted();
    publishExclusive(options.output,result.text,result.limit);
    console.log(JSON.stringify(result.summary));
    return result.status;
  }catch{
    console.error('Local collection PDF ingestion failed. Check file limits, PDF extraction and the output path.');
    return 1;
  }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  void main(process.argv.slice(2)).then(code=>{process.exitCode=code;});
}
