/** Guided question composition uses an explicit, fixed vocabulary.
 * The user decides which fields, document identities and physical pages to
 * search. No question is submitted automatically or derived from an answer. */
import {fieldDefinitions,type FieldId} from './pdfChatOverview';
import {MAX_QUESTION,pageCoverage} from './pdfChatCore';
import {MAX_COLLECTION_TURNS,collectionStats,normalizeCollectionStep,type CollectionDocument,type CollectionStep,type CollectionTurn} from './pdfChatCollection';
import {planQuestions,parseSearchQuestion} from './pdfChatInsights';
import {parseReference,type ReferenceKind} from './pdfChatEvidenceExplorer';
import {previewCollectionDraft,type DraftPreview} from './pdfChatCollectionComposer';

export type GuideGroup='application'|'registration'|'payment'|'assessment'|'verification'|'eligibility'|'contact'|'overview';
export type GuideId=FieldId|'summary'|'requirements'|'prohibitions'|'exceptions';
export type GuideOption={id:GuideId;label:string;question:string;group:GuideGroup};
export const GUIDE_GROUPS:Record<GuideGroup,string>={application:'Application and correction',registration:'Registration',
  payment:'Fees and payment',assessment:'Examinations and interviews',verification:'Verification and reporting',
  eligibility:'Eligibility and selection',contact:'Application method and contact',overview:'Overview and requirement wording'};
const groups:Record<FieldId,GuideGroup>={
  application_deadline:'application',application_start:'application',correction_start:'application',correction_deadline:'application',
  registration_deadline:'registration',registration_start:'registration',application_fee:'payment',exam_fee:'payment',
  registration_fee:'payment',payment_deadline:'payment',payment_method:'payment',
  exam_date:'assessment',exam_time:'assessment',exam_venue:'assessment',interview_date:'assessment',interview_time:'assessment',
  interview_venue:'assessment',admit_card_date:'assessment',result_date:'assessment',
  verification_date:'verification',verification_time:'verification',verification_venue:'verification',reporting_time:'verification',reporting_venue:'verification',
  eligibility:'eligibility',documents:'eligibility',age_limit:'eligibility',minimum_age:'eligibility',maximum_age:'eligibility',
  selection_process:'eligibility',vacancy_count:'eligibility',application_method:'contact',application_portal:'contact',
  contact_email:'contact',contact_phone:'contact',
};
export const GUIDE_OPTIONS:readonly GuideOption[]=[
  ...fieldDefinitions.map(field=>({id:field.id,label:field.label,question:field.query,group:groups[field.id]})),
  {id:'summary',label:'Native document overview',question:'Summarize this notice',group:'overview'},
  {id:'requirements',label:'Requirement wording',question:'List the requirements',group:'overview'},
  {id:'prohibitions',label:'Prohibited actions',question:'What must I not do',group:'overview'},
  {id:'exceptions',label:'Exception wording',question:'List the exceptions',group:'overview'},
];
const byId=new Map(GUIDE_OPTIONS.map(row=>[row.id,row]));
export const MAX_GUIDE_PARTS=4;
export type GuidedPart={kind:'template';id:GuideId;page:number|null}|{kind:'reference';referenceKind:ReferenceKind;identifier:string;page:number|null};
export type GuidedDraft={parts:GuidedPart[];documentIds:string[];includeContext:boolean};
export type GuideInventory={id:GuideId;documentsWithField:number;occurrences:number;pages:number[]};
function invalid():never{throw Error('Invalid guided collection question.');}
function validatePage(page:number|null){
  if(page!==null&&(!Number.isSafeInteger(page)||page<1||page>80))invalid();
}
function cleanPart(part:GuidedPart):string{
  validatePage(part.page);
  let text:string;
  if(part.kind==='template'){
    const option=byId.get(part.id);if(!option)invalid();text=option.question;
  }else if(part.kind==='reference'){
    const ref=parseReference(part.referenceKind+' '+part.identifier);
    if(ref.kind!==part.referenceKind||ref.identifier!==part.identifier.toLowerCase())invalid();
    text='Show '+ref.kind+' '+ref.identifier;
  }else invalid();
  return text+(part.page===null?'':' on page '+part.page);
}
export function guidedQuestionText(parts:readonly GuidedPart[]){
  if(!Array.isArray(parts)||!parts.length||parts.length>MAX_GUIDE_PARTS)invalid();
  const rows=parts.map(cleanPart);
  if(new Set(rows).size!==rows.length)invalid();
  const question=rows.join('? ')+'?';
  if(question.length>MAX_QUESTION||planQuestions(question).length!==rows.length)invalid();
  // Reparse each planned part to ensure the generated wording did not
  // accidentally trigger another scope or multi-question grammar.
  planQuestions(question).forEach((text,index)=>{
    if(parseSearchQuestion(text).page!==(parts[index].page??undefined))invalid();
  });
  return question;
}
export function prepareGuidedDraft(documents:CollectionDocument[],draft:GuidedDraft,turns:CollectionTurn[]):DraftPreview{
  if(!draft||typeof draft.includeContext!=='boolean'||turns.length>=MAX_COLLECTION_TURNS)invalid();
  const question=guidedQuestionText(draft.parts);
  return previewCollectionDraft(documents,question,draft.documentIds,draft.includeContext,turns);
}
export function guidedStep(documents:CollectionDocument[],draft:GuidedDraft,turns:CollectionTurn[]):CollectionStep{
  const preview=prepareGuidedDraft(documents,draft,turns);
  return normalizeCollectionStep(preview.step,documents.map(doc=>doc.id));
}
export function guideInventory(documents:readonly CollectionDocument[],selection:readonly string[]):GuideInventory[]{
  collectionStats(documents);
  if(new Set(selection).size!==selection.length||selection.some(id=>!documents.some(doc=>doc.id===id)))invalid();
  const fields=new Map<FieldId,{docs:Set<string>;count:number;pages:Set<number>}>();
  for(const doc of documents){
    if(!selection.includes(doc.id))continue;
    for(const row of doc.index.rows){
      const field=row.field;if(!field)continue;
      let item=fields.get(field.definition.id);
      if(!item){item={docs:new Set(),count:0,pages:new Set()};fields.set(field.definition.id,item);}
      item.docs.add(doc.id);item.count++;item.pages.add(row.passage.page);
    }
  }
  return GUIDE_OPTIONS.map(option=>{
    const info=fields.get(option.id as FieldId);
    return {id:option.id,documentsWithField:info?.docs.size??0,occurrences:info?.count??0,pages:[...(info?.pages??[])].sort((a,b)=>a-b)};
  });
}
export function filterGuideOptions(group:GuideGroup|'all',needle:string,onlyRecognized:boolean,inventory:readonly GuideInventory[]){
  if(group!=='all'&&!Object.hasOwn(GUIDE_GROUPS,group)||typeof needle!=='string'||needle.length>100||typeof onlyRecognized!=='boolean')invalid();
  const query=needle.trim().toLowerCase();
  return GUIDE_OPTIONS.filter(option=>(group==='all'||option.group===group)&&(!query||(option.label+' '+option.question).toLowerCase().includes(query))&&
    (!onlyRecognized||inventory.some(row=>row.id===option.id&&row.occurrences>0)));
}
export function guidePageAvailability(documents:readonly CollectionDocument[],ids:readonly string[],page:number|null){
  validatePage(page);collectionStats(documents);
  if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!documents.some(doc=>doc.id===id)))invalid();
  return ids.map(id=>{
    const doc=documents.find(row=>row.id===id)!;
    return {id,coverage:page===null?(doc.corpus.limited?'limited':!doc.corpus.passages.length?'no_indexed_text':'some_text'):pageCoverage(doc.corpus,page),
      physicalPages:doc.corpus.pageCount};
  });
}
export function moveGuidedPart(parts:readonly GuidedPart[],index:number,delta:-1|1){
  if(!Number.isSafeInteger(index)||index<0||index>=parts.length||(delta!==-1&&delta!==1)||index+delta<0||index+delta>=parts.length)invalid();
  const next=[...parts];[next[index],next[index+delta]]=[next[index+delta],next[index]];return next;
}
