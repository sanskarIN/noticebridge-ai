/** Compare two already validated native snapshots. Matching fingerprint
 * strings in files are not proof of possession of the original PDF bytes.
 * Never interpret extraction differences as amendments to a notice. */
import {parseCollectionSnapshot} from './pdfChatCollectionReplay';
import {compareExtractionCoverage,type CoverageComparison} from './pdfChatSourceReplay';
import {requestHash} from './pdfChatEmbeddingBridge';
import type {Corpus,Passage} from './pdfChatCore';

export const MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES=6*1024*1024;
export type DifferenceKind='identical'|'text'|'geometry'|'text_and_geometry'|'left_only'|'right_only';
export type FragmentDifference={page:number;ordinal:number;kind:DifferenceKind;left:Passage|null;right:Passage|null};
export type DifferenceCounts=Record<DifferenceKind,number>;
export type PageDifference={page:number;counts:DifferenceCounts};
export type SourceDifference={id:string;status:'identical'|'different'|'left_only'|'right_only';
  coverage:CoverageComparison|null;leftFragments:number;rightFragments:number;counts:DifferenceCounts;pages:PageDifference[];
  fragments:FragmentDifference[]};
export type SnapshotDifference={leftSha256:string;rightSha256:string;sameFingerprintSet:boolean;exactSnapshotMatch:boolean;
  sources:SourceDifference[];counts:DifferenceCounts};
const KINDS:DifferenceKind[]=['identical','text','geometry','text_and_geometry','left_only','right_only'];
function invalid():never{throw Error('Invalid snapshot difference request or report.');}
function empty():DifferenceCounts{return {identical:0,text:0,geometry:0,text_and_geometry:0,left_only:0,right_only:0};}
function add(target:DifferenceCounts,other:DifferenceCounts){for(const kind of KINDS)target[kind]+=other[kind];}
function order(a:Passage,b:Passage){return a.page-b.page||a.ordinal-b.ordinal;}
function geometry(a:Passage,b:Passage){
  if(!a.position||!b.position)return Boolean(a.position)===Boolean(b.position);
  return a.position.x0===b.position.x0&&a.position.x1===b.position.x1&&a.position.y===b.position.y&&a.position.height===b.position.height;
}
function classify(a:Passage|null,b:Passage|null):DifferenceKind{
  if(!a)return 'right_only';if(!b)return 'left_only';
  const sameText=a.text===b.text,sameGeometry=geometry(a,b);
  return sameText?(sameGeometry?'identical':'geometry'):(sameGeometry?'text':'text_and_geometry');
}
function compareSource(id:string,left:Corpus|undefined,right:Corpus|undefined):SourceDifference{
  const a=left?.passages??[],b=right?.passages??[];
  const counts=empty(),pages=new Map<number,DifferenceCounts>(),fragments:FragmentDifference[]=[];
  let i=0,j=0;
  while(i<a.length||j<b.length){
    const x=a[i],y=b[j];
    const cmp=!x?1:!y?-1:order(x,y);
    const l=cmp<=0?a[i++]:null,r=cmp>=0?b[j++]:null;
    const row=l??r!;
    const kind=classify(l,r);
    counts[kind]++;
    let pageCounts=pages.get(row.page);
    if(!pageCounts){pageCounts=empty();pages.set(row.page,pageCounts);}
    pageCounts[kind]++;
    fragments.push({page:row.page,ordinal:row.ordinal,kind,left:l,right:r});
  }
  const coverage=left&&right?compareExtractionCoverage(left,right):null;
  const status=!left?'right_only':!right?'left_only':
    coverage?.matches&&counts.identical===fragments.length?'identical':'different';
  return {id,status,coverage,leftFragments:a.length,rightFragments:b.length,counts,
    pages:[...pages].map(([page,counts])=>({page,counts})),fragments};
}
export async function compareCollectionSnapshots(leftText:string,rightText:string,signal:AbortSignal):Promise<SnapshotDifference>{
  signal.throwIfAborted();
  const left=parseCollectionSnapshot(leftText),right=parseCollectionSnapshot(rightText);
  const a=new Map(left.sources.map(row=>[row.id,row.corpus])),b=new Map(right.sources.map(row=>[row.id,row.corpus]));
  const ids=[...new Set([...a.keys(),...b.keys()])].sort();
  const counts=empty(),sources:SourceDifference[]=[];
  for(const id of ids){
    signal.throwIfAborted();
    const result=compareSource(id,a.get(id),b.get(id));
    add(counts,result.counts);sources.push(result);
  }
  const [leftSha256,rightSha256]=await Promise.all([requestHash(leftText),requestHash(rightText)]);
  signal.throwIfAborted();
  return {leftSha256,rightSha256,sameFingerprintSet:ids.every(id=>a.has(id)&&b.has(id)),
    exactSnapshotMatch:leftText===rightText,sources,counts};
}
export function filterSnapshotDifferences(source:SourceDifference,options:{page:number|null;kind:DifferenceKind|'changed'|'all'}){
  if(options.page!==null&&(!Number.isSafeInteger(options.page)||options.page<1||options.page>80)||
    ![...KINDS,'changed','all'].includes(options.kind))invalid();
  return source.fragments.filter(row=>(options.page===null||row.page===options.page)&&
    (options.kind==='all'||(options.kind==='changed'?row.kind!=='identical':row.kind===options.kind)));
}
export const SNAPSHOT_DIFF_PAGE_SIZE=12;
export function snapshotDifferencePage(rows:readonly FragmentDifference[],page:number){
  if(!Number.isSafeInteger(page)||page<1||page>Math.max(1,Math.ceil(rows.length/SNAPSHOT_DIFF_PAGE_SIZE)))invalid();
  return rows.slice((page-1)*SNAPSHOT_DIFF_PAGE_SIZE,page*SNAPSHOT_DIFF_PAGE_SIZE);
}
/** No text or geometry is exported, only exact snapshot hashes, coverage
 * metadata, counts and coordinate-level classifications. */
export function serializeSnapshotDifference(result:SnapshotDifference):string{
  const report={format:'noticebridge-collection-snapshot-difference',version:1,
    authority_verified:false,pdf_bytes_verified:false,extraction_completeness_verified:false,
    left_sha256:result.leftSha256,right_sha256:result.rightSha256,same_fingerprint_set:result.sameFingerprintSet,
    exact_snapshot_match:result.exactSnapshotMatch,counts:result.counts,
    sources:result.sources.map(row=>({id:row.id,status:row.status,coverage:row.coverage,left_fragments:row.leftFragments,
      right_fragments:row.rightFragments,counts:row.counts,pages:row.pages,
      changed_coordinates:row.fragments.filter(item=>item.kind!=='identical').map(item=>({page:item.page,ordinal:item.ordinal,kind:item.kind}))}))};
  const text=JSON.stringify(report,null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES)invalid();
  return text;
}
export async function verifySnapshotDifference(candidate:string,left:string,right:string,signal:AbortSignal){
  if(!candidate||candidate.length>MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES||
    new TextEncoder().encode(candidate).byteLength>MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES)invalid();
  const result=await compareCollectionSnapshots(left,right,signal);
  if(serializeSnapshotDifference(result)!==candidate)invalid();
  return result;
}
