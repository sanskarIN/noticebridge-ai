/** One question-part evidence brief. The brief is rebuilt from the native
 * ranker, never from a saved answer or an imported quotation. It preserves
 * source order and explicitly separates literal fields from contextual hits. */
import {buildIndex,type Passage} from './pdfChatCore';
import {runIndexedCollectionStep,indexedCollectionCitation,type CollectionIndexedSource,type CollectionDocument,
  type CollectionStep,type CollectionTurn,type CollectionPart} from './pdfChatCollection';
import {parseCollectionSnapshot,serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {requestHash} from './pdfChatEmbeddingBridge';

export const MAX_QUESTION_BRIEF_BYTES=512*1024;
const FORMAT='noticebridge-collection-question-brief';
const POLICY='Private native retrieval evidence only; not a certified answer, completeness or publisher authority.';
export type BriefCitation={rank:number;page:number;ordinal:number;text:string;channel:'strict'|'nearby';text_sha256:string};
export type BriefSource={document_id:string;coverage:CollectionPart['coverage'];strict_matches:number;displayed:number;
  omitted_strict_matches:number;outcome:'literal_fields'|'strict_excerpts'|'nearby_excerpts'|'no_evidence';
  printed_fields:{citation:number;label:string;value:string}[];
  context_groups:{page:number;citations:number[]}[];citations:BriefCitation[]};
export type QuestionBrief={format:typeof FORMAT;version:1;policy:typeof POLICY;authority_verified:false;
  extraction_completeness_verified:false;answer_accuracy_verified:false;pdf_bytes_verified:false;
  snapshot_sha256:string;step:CollectionStep;part_index:number;question:string;physical_page:number|null;sources:BriefSource[]};
function invalid():never{throw Error('Invalid or mismatched question evidence brief.');}
function bound(text:string){
  if(typeof text!=='string'||!text||text.length>MAX_QUESTION_BRIEF_BYTES||
    new TextEncoder().encode(text).byteLength>MAX_QUESTION_BRIEF_BYTES)invalid();
}
function exactObject(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(row,key)))invalid();
  return row;
}
async function sourceBrief(documents:readonly CollectionIndexedSource[],id:string,part:CollectionPart,signal:AbortSignal):Promise<BriefSource>{
  const {answer}=part;
  const nearby=new Set(answer.contextGroups.flatMap(group=>group.citations));
  const citations:BriefCitation[]=[];
  for(let i=0;i<answer.citations.length;i++){
    signal.throwIfAborted();
    const source=indexedCollectionCitation(documents,id,answer.citations[i]),rank=i+1;
    citations.push({rank,page:source.page,ordinal:source.ordinal,text:source.text,
      channel:nearby.has(rank)?'nearby':'strict',text_sha256:await requestHash(source.text)});
  }
  const strict=answer.matchedCounts.original;
  const strictDisplayed=citations.filter(row=>row.channel==='strict').length;
  return {document_id:id,coverage:part.coverage,strict_matches:strict,displayed:citations.length,
    omitted_strict_matches:Math.max(0,strict-strictDisplayed),
    outcome:answer.printedFields.length?'literal_fields':strictDisplayed?'strict_excerpts':citations.length?'nearby_excerpts':'no_evidence',
    printed_fields:answer.printedFields.map(row=>({...row})),
    context_groups:answer.contextGroups.map(row=>({page:row.page,citations:[...row.citations]})),citations};
}
export async function buildQuestionBrief(snapshotText:string,step:CollectionStep,partIndex:number,signal:AbortSignal):Promise<QuestionBrief>{
  signal.throwIfAborted();
  const snapshot=parseCollectionSnapshot(snapshotText);
  const documents=snapshot.sources.map(({id,corpus})=>({id,corpus,index:buildIndex(corpus.passages),
    chars:corpus.passages.reduce((n,row)=>n+row.text.length,0)}));
  const fresh=runIndexedCollectionStep(documents,step);
  if(!Number.isSafeInteger(partIndex)||partIndex<0||partIndex>=fresh.results[0].parts.length)invalid();
  const first=fresh.results[0].parts[partIndex].answer;
  const sources:BriefSource[]=[];
  for(const side of fresh.results){
    const part=side.parts[partIndex];
    if(part.answer.question!==first.question||part.answer.pageFilter!==first.pageFilter)invalid();
    sources.push(await sourceBrief(documents,side.documentId,part,signal));
  }
  const hash=await requestHash(snapshotText);signal.throwIfAborted();
  return {format:FORMAT,version:1,policy:POLICY,authority_verified:false,extraction_completeness_verified:false,
    answer_accuracy_verified:false,pdf_bytes_verified:false,snapshot_sha256:hash,
    step:fresh.step,part_index:partIndex,question:first.question,physical_page:first.pageFilter??null,sources};
}
export function encodeQuestionBrief(brief:QuestionBrief){
  const text=JSON.stringify(brief,null,2)+'\n';bound(text);return text;
}
export async function exportQuestionBrief(documents:readonly CollectionDocument[],turn:CollectionTurn,partIndex:number,consent:boolean,signal:AbortSignal){
  if(consent!==true)invalid();
  const fresh=runIndexedCollectionStep(documents,turn.step);
  if(JSON.stringify(fresh)!==JSON.stringify(turn))invalid();
  return encodeQuestionBrief(await buildQuestionBrief(serializeCollectionSnapshot(documents),turn.step,partIndex,signal));
}
export async function verifyQuestionBrief(candidate:string,snapshotText:string,signal:AbortSignal){
  signal.throwIfAborted();bound(candidate);
  let raw:unknown;try{raw=JSON.parse(candidate);}catch{return invalid();}
  const row=exactObject(raw,['format','version','policy','authority_verified','extraction_completeness_verified',
    'answer_accuracy_verified','pdf_bytes_verified','snapshot_sha256','step','part_index','question','physical_page','sources']);
  if(row.format!==FORMAT||row.version!==1||row.policy!==POLICY||typeof row.part_index!=='number')invalid();
  const actual=await buildQuestionBrief(snapshotText,row.step as CollectionStep,row.part_index,signal);
  if(encodeQuestionBrief(actual)!==candidate)invalid();
  return actual;
}
const coverageText:Record<CollectionPart['coverage'],string>={
  some_text:'Some native text was indexed; completeness is unknown.',
  partial:'Native indexing is partial; relevant text may be missing.',
  no_indexed_text:'No native text was indexed in this scope.',
  not_present:'The requested physical page is not present.',
  not_indexed:'The requested physical page was not indexed.',
};
export function briefCoverageLabel(value:CollectionPart['coverage']){return coverageText[value];}
/** Plain-text reading copy intentionally has no active links, markup or
 * embedded files. All source text is delimited, not rendered as commands. */
export function questionBriefReadingCopy(brief:QuestionBrief){
  const lines=['NOTICEBRIDGE AI — PRIVATE QUESTION EVIDENCE BRIEF',POLICY,
    'Snapshot SHA-256: '+brief.snapshot_sha256,'Question part '+(brief.part_index+1)+': '+JSON.stringify(brief.question),
    'Scope: '+(brief.physical_page===null?'All indexed physical pages':'Physical page '+brief.physical_page),
    'Nearby-line fallback: '+(brief.step.includeContext?'enabled':'disabled'),''];
  brief.sources.forEach((source,i)=>{
    lines.push('PDF '+(i+1)+' — SHA-256 '+source.document_id,briefCoverageLabel(source.coverage),
      'Strict matches: '+source.strict_matches+'; displayed fragments: '+source.displayed+
      '; undisplayed strict matches: '+source.omitted_strict_matches+'.');
    if(source.outcome==='no_evidence')lines.push('No displayed native evidence; this does not prove absence.');
    if(source.outcome==='nearby_excerpts')lines.push('Nearby-line candidates only; no strict match.');
    if(source.printed_fields.length){
      lines.push('Literal printed field candidates (not inferred values):');
      source.printed_fields.forEach(field=>lines.push('  ['+field.citation+'] '+JSON.stringify(field.label)+': '+JSON.stringify(field.value)));
    }
    for(const citation of source.citations)lines.push(
      '['+citation.rank+'] '+citation.channel+' | physical page '+citation.page+', fragment '+citation.ordinal,
      '  Text SHA-256: '+citation.text_sha256,
      '  Native excerpt: '+JSON.stringify(citation.text));
    lines.push('');
  });
  lines.push('Verify the original physical pages and official publication before relying on any candidate.','');
  const text=lines.join('\n');bound(text);return text;
}
export function inspectBriefCitation(documents:readonly CollectionDocument[],turn:CollectionTurn,brief:QuestionBrief,id:string,citation:BriefCitation):Passage{
  if(JSON.stringify(turn.step)!==JSON.stringify(brief.step))invalid();
  const side=brief.sources.find(row=>row.document_id===id);
  const part=turn.results.find(row=>row.documentId===id)?.parts[brief.part_index];
  if(!side||!side.citations.includes(citation)||!part)invalid();
  const source=part.answer.citations[citation.rank-1];
  if(!source||source.page!==citation.page||source.ordinal!==citation.ordinal||source.text!==citation.text)invalid();
  return indexedCollectionCitation(documents,id,source);
}
