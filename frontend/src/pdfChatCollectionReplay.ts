/** Private collection snapshots and independent native extraction replay.
 * Fingerprints identify bytes, not issuer authority. Replay results describe
 * exact extraction only, not completeness or correctness of an answer. */
import type { Corpus } from './pdfChatCore';
import { collectionStats, prepareCollectionFile, MAX_COLLECTION_DOCUMENTS, MAX_COLLECTION_BYTES,
  MAX_COLLECTION_CHARS, MAX_COLLECTION_PASSAGES, type CollectionDocument, type CollectionExtractor } from './pdfChatCollection';
import { serializeCorpusSnapshot, parseCorpusSnapshot, validateNativeCorpus } from './pdfChatCorpusSnapshot';
import { compareExtractedFragments, compareExtractionCoverage, type ExtractionCounts,
  type CoverageComparison } from './pdfChatSourceReplay';

export const MAX_COLLECTION_SNAPSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_COLLECTION_REPLAY_BYTES = 128 * 1024;
const FORMAT = 'noticebridge-collection-native-snapshot';
const POLICY = 'Private native text and geometry; not certified transcription or issuer authenticity.';
const REPLAY_FORMAT = 'noticebridge-collection-source-replay';
const REPLAY_POLICY = 'Exact PDF fingerprints and bounded native extraction replay only; not authority or answer verification.';
const SHA = /^[a-f0-9]{64}$/;
type SnapshotSource = { id: string; corpus: Corpus };
export type CollectionSnapshot = { sources: SnapshotSource[] };
type ReplayState = 'exact_replay' | 'different_extraction' | 'missing_pdf' | 'extraction_failed' | 'unexpected_pdf';
export type CollectionReplaySource = {
  id: string; state: ReplayState; bytes: number | null;
  coverage: CoverageComparison | null; fragments: ExtractionCounts | null;
};
export type CollectionReplayReport = {
  format: typeof REPLAY_FORMAT; version: 1; policy: string;
  authority_verified: false; extraction_completeness_verified: false; answer_accuracy_verified: false;
  snapshot_sha256: string; all_pdf_bytes_match: boolean; all_native_extractions_match: boolean;
  status: 'exact_replay' | 'not_reproduced'; sources: CollectionReplaySource[];
};
export type CollectionReplayProgress = { stage: 'hashing' | 'extracting' | 'compared'; completed: number; total: number };
export type CollectionReplayOptions = { signal: AbortSignal; extract: CollectionExtractor;
  onProgress?: (progress: CollectionReplayProgress) => void };
function invalid(): never { throw new Error('Invalid or oversized collection snapshot or source replay.'); }
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(raw,key)))invalid();
  return raw;
}
function bounded(text:string,max:number):string{
  if(typeof text!=='string'||!text||text.length>max||new TextEncoder().encode(text).byteLength>max)invalid();
  return text;
}
function parse(text:string,max:number):unknown{
  bounded(text,max);
  try{return JSON.parse(text);}catch{return invalid();}
}
function order(a:string,b:string){return a<b?-1:a>b?1:0;}
function sourceBudget(sources:readonly SnapshotSource[]){
  if(!sources.length||sources.length>MAX_COLLECTION_DOCUMENTS)invalid();
  let count=0,chars=0;
  const ids=new Set<string>();
  for(const source of sources){
    if(!SHA.test(source.id)||ids.has(source.id))invalid();
    ids.add(source.id);
    count+=source.corpus.passages.length;
    chars+=source.corpus.passages.reduce((sum,row)=>sum+row.text.length,0);
  }
  if(count>MAX_COLLECTION_PASSAGES||chars>MAX_COLLECTION_CHARS)invalid();
}
function wireSource(source:SnapshotSource){
  // Reuse the exact single-document canonical extraction contract.
  return JSON.parse(serializeCorpusSnapshot({original:source.id},{original:source.corpus}));
}
function encodeSnapshot(sources:readonly SnapshotSource[]):string{
  sourceBudget(sources);
  return bounded(JSON.stringify({format:FORMAT,version:1,policy:POLICY,authority_verified:false,
    sources:[...sources].sort((a,b)=>order(a.id,b.id)).map(wireSource)},null,2)+'\n',MAX_COLLECTION_SNAPSHOT_BYTES);
}
export function serializeCollectionSnapshot(documents:readonly CollectionDocument[]):string{
  collectionStats(documents);
  return encodeSnapshot(documents.map(doc=>({id:doc.id,corpus:doc.corpus})));
}
export function parseCollectionSnapshot(text:string):CollectionSnapshot{
  const raw=record(parse(text,MAX_COLLECTION_SNAPSHOT_BYTES),['format','version','policy','authority_verified','sources']);
  if(raw.format!==FORMAT||raw.version!==1||raw.policy!==POLICY||raw.authority_verified!==false||
      !Array.isArray(raw.sources)||!raw.sources.length||raw.sources.length>MAX_COLLECTION_DOCUMENTS)invalid();
  const sources:SnapshotSource[]=[];
  for(const value of raw.sources){
    const single=parseCorpusSnapshot(JSON.stringify(value,null,2)+'\n');
    if(single.attached.length!==1||single.attached[0]!=='original'||!single.pins.original||!single.corpora.original)invalid();
    sources.push({id:single.pins.original,corpus:single.corpora.original});
  }
  sourceBudget(sources);
  if(encodeSnapshot(sources)!==text)invalid();
  return {sources};
}
async function digest(text:string,signal:AbortSignal){
  signal.throwIfAborted();
  if(!globalThis.crypto?.subtle)invalid();
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  signal.throwIfAborted();
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function loadCollectionSnapshot(file:File,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_COLLECTION_SNAPSHOT_BYTES)invalid();
  const buffer=await file.arrayBuffer();
  signal.throwIfAborted();
  if(buffer.byteLength!==file.size||buffer.byteLength>MAX_COLLECTION_SNAPSHOT_BYTES)invalid();
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);}catch{return invalid();}
  parseCollectionSnapshot(text);
  return text;
}
function empty(id:string,state:ReplayState,bytes:number|null):CollectionReplaySource{
  return {id,state,bytes,coverage:null,fragments:null};
}
/** File matching is by exact fingerprint, never filename or selection
 * order. Unexpected files are not extracted. Duplicate bytes are rejected
 * instead of silently counting the same source twice. */
export async function replayCollectionSources(snapshotText:string,files:readonly File[],options:CollectionReplayOptions){
  const {signal,extract}=options;
  signal.throwIfAborted();
  const snapshot=parseCollectionSnapshot(snapshotText);
  if(!Array.isArray(files)||files.length>MAX_COLLECTION_DOCUMENTS||
      files.reduce((sum,file)=>sum+file.size,0)>MAX_COLLECTION_BYTES)invalid();
  const prepared=new Map<string,File>();
  const total=files.length+snapshot.sources.length;
  let completed=0;
  const progress=(stage:CollectionReplayProgress['stage'])=>{
    signal.throwIfAborted();options.onProgress?.({stage,completed,total});signal.throwIfAborted();
  };
  for(const file of files){
    progress('hashing');
    const source=await prepareCollectionFile(file,signal);
    if(prepared.has(source.id))invalid();
    prepared.set(source.id,source.file);
    completed++;progress('compared');
  }
  const sources:CollectionReplaySource[]=[];
  for(const expected of snapshot.sources){
    const file=prepared.get(expected.id);
    if(!file){sources.push(empty(expected.id,'missing_pdf',null));completed++;progress('compared');continue;}
    prepared.delete(expected.id);
    progress('extracting');
    try{
      const raw=await extract(file,'original',signal);
      signal.throwIfAborted();
      const observed=validateNativeCorpus('original',expected.id,raw);
      const coverage=compareExtractionCoverage(expected.corpus,observed);
      const fragments=compareExtractedFragments(expected.corpus,observed);
      const identical=coverage.matches&&fragments.identical_fragments===fragments.expected_fragments&&
        fragments.expected_fragments===fragments.observed_fragments;
      sources.push({id:expected.id,state:identical?'exact_replay':'different_extraction',bytes:file.size,coverage,fragments});
    }catch{
      signal.throwIfAborted();
      sources.push(empty(expected.id,'extraction_failed',file.size));
    }
    completed++;progress('compared');
  }
  for(const [id,file] of [...prepared].sort(([a],[b])=>order(a,b)))sources.push(empty(id,'unexpected_pdf',file.size));
  const all_pdf_bytes_match=sources.every(row=>row.state!=='missing_pdf'&&row.state!=='unexpected_pdf');
  const all_native_extractions_match=all_pdf_bytes_match&&sources.every(row=>row.state==='exact_replay');
  const report:CollectionReplayReport={format:REPLAY_FORMAT,version:1,policy:REPLAY_POLICY,
    authority_verified:false,extraction_completeness_verified:false,answer_accuracy_verified:false,
    snapshot_sha256:await digest(snapshotText,signal),all_pdf_bytes_match,all_native_extractions_match,
    status:all_native_extractions_match?'exact_replay':'not_reproduced',sources};
  signal.throwIfAborted();
  return {report,text:bounded(JSON.stringify(report,null,2)+'\n',MAX_COLLECTION_REPLAY_BYTES)};
}
export async function verifyCollectionSourceReplay(candidate:string,snapshotText:string,files:readonly File[],
  options:CollectionReplayOptions){
  bounded(candidate,MAX_COLLECTION_REPLAY_BYTES);
  const replay=await replayCollectionSources(snapshotText,files,options);
  if(replay.text!==candidate)invalid();
  return replay;
}
