/** Native extraction diagnostics, not OCR confidence or reading-order truth.
 * Work only on retained native fragments. Never modify the retrieval corpus. */
import {pageCoverage,type Corpus,type Passage,type PageCoverage} from './pdfChatCore';
import {collectionCitation,collectionStats,type CollectionDocument} from './pdfChatCollection';
import {serializeCollectionSnapshot,parseCollectionSnapshot,MAX_COLLECTION_SNAPSHOT_BYTES} from './pdfChatCollectionReplay';
import {requestHash} from './pdfChatEmbeddingBridge';

export const QUALITY_PAGE_SIZE=10;
export const QUALITY_FRAGMENT_SIZE=8;
export const MAX_QUALITY_REPORT_BYTES=6*1024*1024;
export const QUALITY_FLAGS=['replacement','private_use','control','no_letters_or_digits','missing_geometry','duplicate_on_page','repeated_across_pages'] as const;
export type QualityFlag=typeof QUALITY_FLAGS[number];
export type QualityCounts=Record<QualityFlag,number>;
export type QualityFragment={source:Passage;flags:QualityFlag[]};
export type QualityPage={page:number;coverage:PageCoverage;fragments:number;characters:number;counts:QualityCounts;flagged:QualityFragment[]};
export type SourceQuality={id:string;physicalPages:number;processedPages:number;unprocessedPages:number;limited:boolean;
  fragments:number;characters:number;counts:QualityCounts;pages:QualityPage[];flaggedFragments:number};
export type CollectionQuality={sources:SourceQuality[];fragments:number;characters:number;flaggedFragments:number;counts:QualityCounts};
export type QualityFilter={flag:QualityFlag|'all';coverage:PageCoverage|'all';onlyFlagged:boolean};
function invalid():never{throw Error('Invalid native extraction diagnostic or scope.');}
function empty():QualityCounts{return {replacement:0,private_use:0,control:0,no_letters_or_digits:0,missing_geometry:0,duplicate_on_page:0,repeated_across_pages:0};}
function aggregate(target:QualityCounts,source:QualityCounts){for(const flag of QUALITY_FLAGS)target[flag]+=source[flag];}
function characterFlags(text:string):QualityFlag[]{
  const flags:QualityFlag[]=[];
  if(text.includes('\ufffd'))flags.push('replacement');
  if(/[\p{Co}]/u.test(text))flags.push('private_use');
  // Whitespace retained by extraction is not an error. Formatting controls
  // may be legitimate in some scripts; this is a cue for manual inspection.
  if(/[\p{Cc}\p{Cf}]/u.test(text.replace(/[\t\n\r]/g,'')))flags.push('control');
  if(!/[\p{L}\p{N}]/u.test(text))flags.push('no_letters_or_digits');
  return flags;
}
export function analyzeSourceQuality(id:string,corpus:Corpus):SourceQuality{
  const perPage=new Map<number,Passage[]>();
  const textPages=new Map<string,Set<number>>();
  for(const source of corpus.passages){
    const group=perPage.get(source.page)??[];
    group.push(source);perPage.set(source.page,group);
    const pages=textPages.get(source.text)??new Set<number>();
    pages.add(source.page);textPages.set(source.text,pages);
  }
  const counts=empty(),pages:QualityPage[]=[];
  let characters=0,flaggedFragments=0;
  // Only materialize processed pages (at most 80), not a potentially huge
  // physical PDF page count. The omitted count is explicit in the summary.
  for(let page=1;page<=corpus.processedPages;page++){
    const sources=perPage.get(page)??[],local=empty(),flagged:QualityFragment[]=[];
    const frequencies=new Map<string,number>();
    for(const source of sources)frequencies.set(source.text,(frequencies.get(source.text)??0)+1);
    let units=0;
    for(const source of sources){
      units+=source.text.length;
      const flags=characterFlags(source.text);
      if(!source.position)flags.push('missing_geometry');
      if(frequencies.get(source.text)!>1)flags.push('duplicate_on_page');
      if(textPages.get(source.text)!.size>1)flags.push('repeated_across_pages');
      for(const flag of flags)local[flag]++;
      if(flags.length)flagged.push({source,flags});
    }
    aggregate(counts,local);characters+=units;flaggedFragments+=flagged.length;
    pages.push({page,coverage:pageCoverage(corpus,page),fragments:sources.length,characters:units,counts:local,flagged});
  }
  return {id,physicalPages:corpus.pageCount,processedPages:corpus.processedPages,
    unprocessedPages:corpus.pageCount-corpus.processedPages,limited:corpus.limited,
    fragments:corpus.passages.length,characters,counts,pages,flaggedFragments};
}
function analyze(sources:readonly {id:string;corpus:Corpus}[]):CollectionQuality{
  const rows=sources.map(row=>analyzeSourceQuality(row.id,row.corpus));
  const counts=empty();
  for(const row of rows)aggregate(counts,row.counts);
  return {sources:rows,fragments:rows.reduce((n,row)=>n+row.fragments,0),characters:rows.reduce((n,row)=>n+row.characters,0),
    flaggedFragments:rows.reduce((n,row)=>n+row.flaggedFragments,0),counts};
}
export function collectionQuality(documents:readonly CollectionDocument[],selection:readonly string[]):CollectionQuality{
  collectionStats(documents);
  if(!selection.length||new Set(selection).size!==selection.length||selection.some(id=>!documents.some(doc=>doc.id===id)))invalid();
  return analyze(selection.map(id=>documents.find(doc=>doc.id===id)!));
}
export function filterQualityPages(source:SourceQuality,filter:QualityFilter):QualityPage[]{
  if(!filter||![...QUALITY_FLAGS,'all'].includes(filter.flag)||
    !['all','not_present','not_indexed','no_indexed_text','limited','some_text'].includes(filter.coverage)||
    typeof filter.onlyFlagged!=='boolean')invalid();
  return source.pages.filter(row=>(filter.coverage==='all'||row.coverage===filter.coverage)&&
    (!filter.onlyFlagged||row.flagged.length>0||row.coverage!=='some_text')&&
    (filter.flag==='all'||row.counts[filter.flag]>0));
}
export function filterQualityFragments(page:QualityPage,flag:QualityFlag|'all'){
  if(![...QUALITY_FLAGS,'all'].includes(flag))invalid();
  return page.flagged.filter(row=>flag==='all'||row.flags.includes(flag));
}
export function qualityPage<T>(rows:readonly T[],page:number,size=QUALITY_PAGE_SIZE){
  if(![QUALITY_PAGE_SIZE,QUALITY_FRAGMENT_SIZE].includes(size))invalid();
  const pages=Math.max(1,Math.ceil(rows.length/size));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const start=(page-1)*size;
  return {rows:rows.slice(start,start+size),pages,first:rows.length?start+1:0,last:Math.min(start+size,rows.length)};
}
export function inspectQualityFragment(documents:readonly CollectionDocument[],result:CollectionQuality,id:string,row:QualityFragment){
  if(!result.sources.some(source=>source.id===id&&source.pages.some(page=>page.flagged.includes(row))))invalid();
  return collectionCitation(documents,id,row.source).source;
}
function wire(result:CollectionQuality,snapshotSha256:string){
  return {format:'noticebridge-collection-native-quality',version:1,
    policy:'Native extraction cues only; not OCR confidence, reading-order certification or completeness.',
    authority_verified:false,extraction_completeness_verified:false,pdf_bytes_verified:false,snapshot_sha256:snapshotSha256,
    source_ids:result.sources.map(row=>row.id),fragments:result.fragments,characters:result.characters,
    flagged_fragments:result.flaggedFragments,counts:result.counts,
    sources:result.sources.map(source=>({id:source.id,physical_pages:source.physicalPages,processed_pages:source.processedPages,
      unprocessed_pages:source.unprocessedPages,limited:source.limited,fragments:source.fragments,characters:source.characters,
      flagged_fragments:source.flaggedFragments,counts:source.counts,
      pages:source.pages.map(page=>({page:page.page,coverage:page.coverage,fragments:page.fragments,characters:page.characters,
        counts:page.counts,flagged:page.flagged.map(row=>({ordinal:row.source.ordinal,flags:row.flags}))}))}))};
}
function bounded(text:string,max:number){
  if(!text||text.length>max||new TextEncoder().encode(text).byteLength>max)invalid();
  return text;
}
export async function qualitySnapshotReport(snapshotText:string,ids:readonly string[],signal:AbortSignal){
  signal.throwIfAborted();
  const snapshot=parseCollectionSnapshot(bounded(snapshotText,MAX_COLLECTION_SNAPSHOT_BYTES));
  if(!ids.length||ids.length>snapshot.sources.length||new Set(ids).size!==ids.length||
     ids.some(id=>!snapshot.sources.some(row=>row.id===id)))invalid();
  const result=analyze(ids.map(id=>snapshot.sources.find(row=>row.id===id)!));
  const hash=await requestHash(snapshotText);signal.throwIfAborted();
  return bounded(JSON.stringify(wire(result,hash),null,2)+'\n',MAX_QUALITY_REPORT_BYTES);
}
export async function exportCollectionQuality(documents:readonly CollectionDocument[],ids:readonly string[],consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  return qualitySnapshotReport(serializeCollectionSnapshot(documents),ids,signal);
}
export async function verifyQualityReport(candidate:string,snapshotText:string,signal:AbortSignal){
  bounded(candidate,MAX_QUALITY_REPORT_BYTES);
  let raw:unknown;
  try{raw=JSON.parse(candidate);}catch{return invalid();}
  if(!raw||typeof raw!=='object'||!('source_ids' in raw)||!Array.isArray(raw.source_ids)||
    raw.source_ids.some(id=>typeof id!=='string'))invalid();
  const expected=await qualitySnapshotReport(snapshotText,raw.source_ids,signal);
  if(candidate!==expected)invalid();
  return JSON.parse(expected) as ReturnType<typeof wire>;
}
