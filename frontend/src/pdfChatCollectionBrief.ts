/** Explicit broad-question inspection. This does not modify the strict
 * answer, generate prose from unrelated fragments or infer what applies. */
import {collectionCitation,runCollectionStep,type CollectionDocument,type CollectionPart,type CollectionStep} from './pdfChatCollection';
import {parsePageFilter,parseRequirementQuestion} from './pdfChatInsights';
import {buildNoticeOverview,type OverviewValue,type FieldDefinition} from './pdfChatOverview';
import {detectOutlineHeading,type OutlineHeading} from './pdfChatStructure';
import {requirementCues,type RequirementKind,type RequirementCue} from './pdfChatRequirements';
import {questionReferences,searchReference,type Reference,type ExplorerHit} from './pdfChatEvidenceExplorer';
import {pageScopedIndex,type Passage} from './pdfChatCore';
export const BRIEF_PAGE_SIZE=8;
export const BRIEF_SAMPLE_LIMIT=12;
export type BroadIntent={kind:'summary'}|{kind:'requirements';requirement:RequirementKind|'all'}|
  {kind:'references';references:Reference[]};
export type BriefField={definition:FieldDefinition;distinctValues:number;values:OverviewValue[]};
export type BriefHeading={source:Passage;heading:OutlineHeading};
export type BriefRequirement={source:Passage;kinds:RequirementKind[];cues:RequirementCue[];total:number};
export type BriefReference={reference:Reference;hits:ExplorerHit[]};
export type CollectionBrief={documentId:string;question:string;physicalPage?:number;intent:BroadIntent;
  coverage:CollectionPart['coverage'];fragments:number;fields:BriefField[];headings:BriefHeading[];
  requirements:BriefRequirement[];requirementCounts:Record<RequirementKind,number>;references:BriefReference[];
  sample:Passage[];sampledPages:number;scopedPages:number;sampleLimited:boolean};
function invalid():never{throw Error('Invalid or mismatched broad collection question.');}
export function broadCollectionIntent(question:string):BroadIntent|null{
  const {content}=parsePageFilter(question);
  const clean=content.trim().replace(/\?$/,'').trim().replace(/[ \t]+/g,' ');
  if(/^(?:summari[sz]e (?:this |the )?(?:pdf|notice|document|page)|(?:give|show) me (?:a |the )?(?:summary|overview) of (?:this |the )?(?:pdf|notice|document|page)|what is (?:this |the )?(?:pdf|notice|document|page) about|(?:list|show) (?:the )?(?:key|important) (?:points|details)(?: in (?:this|the) (?:pdf|notice|document|page))?)$/i.test(clean))return {kind:'summary'};
  const requirement=parseRequirementQuestion(question);
  if(requirement)return {kind:'requirements',requirement};
  const refs=questionReferences(clean);
  // A narrow explicit request for one or more printed references. Other
  // qualified questions stay lexical rather than broadening their subject.
  if(refs.length&&/^(?:show|find|locate|where is|where are|what is|what does|what do|what are|read)\s/i.test(clean)&&
    /^(?:show|find|locate|where is|where are|what is|what does|what do|what are|read)\s+(?:the\s+)?(?:clause|section|paragraph|rule|article|annexure|schedule)\b/i.test(clean)){
    const remainder=clean.replace(/^(?:show|find|locate|where is|where are|what is|what does|what do|what are|read)\s+(?:the\s+)?/i,'');
    // Only exact identifiers separated by and/comma, with optional "say".
    const residual=remainder.replace(/\s+say$/i,'');
    const segments=residual.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i);
    if(segments.length===refs.length&&segments.every((text,i)=>text.toLowerCase()===refs[i].kind+' '+refs[i].identifier))
      return {kind:'references',references:refs};
  }
  return null;
}
function samplePages(rows:readonly Passage[]){
  const byPage=new Map<number,Passage>();
  for(const source of rows)if(!byPage.has(source.page))byPage.set(source.page,source);
  const candidates=[...byPage.values()];
  if(candidates.length<=BRIEF_SAMPLE_LIMIT)return {sample:candidates,scopedPages:candidates.length,sampleLimited:false};
  const indexes=Array.from({length:BRIEF_SAMPLE_LIMIT},(_,i)=>Math.floor(i*(candidates.length-1)/(BRIEF_SAMPLE_LIMIT-1)));
  return {sample:indexes.map(i=>candidates[i]),scopedPages:candidates.length,sampleLimited:true};
}
export function collectionBrief(documents:readonly CollectionDocument[],documentId:string,part:CollectionPart,
  includeContext:boolean):CollectionBrief|null{
  const intent=broadCollectionIntent(part.answer.question);
  if(!intent)return null;
  const doc=documents.find(row=>row.id===documentId);
  if(!doc||part.answer.scope!=='original')invalid();
  for(const source of part.answer.citations)collectionCitation(documents,documentId,source);
  const replay=runCollectionStep(documents,{question:part.answer.question,documentIds:[documentId],includeContext});
  const fresh=replay.results[0]?.parts[0];
  if(!fresh||replay.results[0].parts.length!==1||JSON.stringify(fresh)!==JSON.stringify(part))invalid();
  const physicalPage=part.answer.pageFilter,index=physicalPage===undefined?doc.index:pageScopedIndex(doc.index,physicalPage);
  const rows=index.rows.map(row=>row.passage);
  const fields:BriefField[]=intent.kind==='summary'?buildNoticeOverview(index).map(field=>({
    definition:field.definition,distinctValues:field.original.distinctValues,values:field.original.values,
  })): [];
  const headings:BriefHeading[]=[],requirements:BriefRequirement[]=[];
  const requirementCounts:Record<RequirementKind,number>={mandatory:0,prohibited:0,exception:0,permission:0,recommendation:0};
  if(intent.kind!=='references')for(const source of rows){
    if(intent.kind==='summary'){
      const heading=detectOutlineHeading(source.text);
      if(heading)headings.push({source,heading});
    }
    const cues=requirementCues(source.text);
    if(!cues.total)continue;
    if(intent.kind==='requirements'&&intent.requirement!=='all'&&!cues.kinds.includes(intent.requirement))continue;
    requirements.push({source,kinds:cues.kinds,cues:cues.cues,total:cues.total});
    for(const kind of cues.kinds)requirementCounts[kind]++;
  }
  const references:BriefReference[]=intent.kind==='references'?intent.references.map(reference=>({
    reference,hits:searchReference(index,{scope:'original',page:physicalPage},reference).hits,
  })):[];
  const sampled=intent.kind==='summary'?samplePages(rows):{sample:[],scopedPages:new Set(rows.map(row=>row.page)).size,sampleLimited:false};
  return {documentId,question:part.answer.question,physicalPage,intent,coverage:part.coverage,fragments:rows.length,
    fields,headings,requirements,requirementCounts,references,...sampled,sampledPages:sampled.sample.length};
}
export function briefPage<T>(rows:readonly T[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/BRIEF_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*BRIEF_PAGE_SIZE;
  return {rows:rows.slice(offset,offset+BRIEF_PAGE_SIZE),pages,first:rows.length?offset+1:0,last:Math.min(rows.length,offset+BRIEF_PAGE_SIZE)};
}
export function inspectBriefSource(documents:readonly CollectionDocument[],brief:CollectionBrief,source:Passage){
  if(brief.physicalPage!==undefined&&source.page!==brief.physicalPage)invalid();
  const found=brief.sample.includes(source)||brief.headings.some(row=>row.source===source)||
    brief.requirements.some(row=>row.source===source)||brief.references.some(row=>row.hits.some(hit=>hit.source===source))||
    brief.fields.some(field=>field.values.some(value=>value.citations.some(citation=>citation.source===source)));
  if(!found)invalid();
  return collectionCitation(documents,brief.documentId,source).source;
}
export function briefFieldDraft(documents:readonly CollectionDocument[],brief:CollectionBrief,field:BriefField,
  includeContext:boolean):CollectionStep{
  if(!brief.fields.includes(field)||typeof includeContext!=='boolean')invalid();
  const question=field.definition.query+(brief.physicalPage===undefined?'':' on page '+brief.physicalPage)+'?';
  const step={question,documentIds:[brief.documentId],includeContext};
  return runCollectionStep(documents,step).step;
}
