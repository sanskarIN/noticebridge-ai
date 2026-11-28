/** Read-only composer inspection. Share the actual planner and scope
 * normalization rather than guessing user intent or running retrieval. */
import {normalizeCollectionStep,collectionStats,MAX_COLLECTION_TURNS,type CollectionDocument,type CollectionStep,type CollectionTurn,type CollectionPart} from './pdfChatCollection';
import {planQuestions,parseSearchQuestion} from './pdfChatInsights';
import {knownQuestionField,queryTerms,pageCoverage} from './pdfChatCore';
import {fieldDefinitions,type FieldId} from './pdfChatOverview';
import {broadCollectionIntent,type BroadIntent} from './pdfChatCollectionBrief';

export type DraftScope={id:string;coverage:CollectionPart['coverage'];fragments:number};
export type DraftPart={question:string;searchText:string;page:number|null;terms:string[];field:FieldId|null;
  broad:BroadIntent|null;strictTermBudget:boolean;scopes:DraftScope[]};
export type DraftPreview={step:CollectionStep;parts:DraftPart[];searches:number;unavailable:number;partial:number;
  repeatTurns:number[];remainingTurns:number};
function invalid(){throw Error('Invalid collection question preview.');}
function scopeFor(doc:CollectionDocument,page:number|null):DraftScope{
  const fragments=page===null?doc.corpus.passages.length:doc.corpus.passages.filter(row=>row.page===page).length;
  const state=page===null?
    (doc.corpus.limited?'partial':!fragments?'no_indexed_text':doc.corpus.missingPages.length?'partial':'some_text'):
    pageCoverage(doc.corpus,page);
  return {id:doc.id,coverage:state==='limited'?'partial':state,fragments};
}
function sameStep(a:CollectionStep,b:CollectionStep){
  return a.question===b.question&&a.includeContext===b.includeContext&&
    a.documentIds.length===b.documentIds.length&&a.documentIds.every((id,i)=>id===b.documentIds[i]);
}
export function previewCollectionDraft(documents:readonly CollectionDocument[],question:string,
  selected:readonly string[],includeContext:boolean,turns:readonly CollectionTurn[]):DraftPreview{
  collectionStats(documents);
  if(typeof question!=='string'||typeof includeContext!=='boolean'||!Array.isArray(selected)||
     new Set(selected).size!==selected.length||selected.some(id=>!documents.some(doc=>doc.id===id))||
     turns.length>MAX_COLLECTION_TURNS)invalid();
  const ids=documents.filter(doc=>selected.includes(doc.id)).map(doc=>doc.id);
  const step=normalizeCollectionStep({question:question.trim(),documentIds:ids,includeContext},documents.map(doc=>doc.id));
  const parts=planQuestions(step.question).map(question=>{
    const parsed=parseSearchQuestion(question),searchText=parsed.content||'?',terms=queryTerms(searchText);
    const page=parsed.page??null;
    return {question,searchText,page,terms,field:knownQuestionField(terms),broad:broadCollectionIntent(question),
      strictTermBudget:terms.length>0&&terms.length<=16,scopes:ids.map(id=>scopeFor(documents.find(doc=>doc.id===id)!,page))};
  });
  const scopes=parts.flatMap(part=>part.scopes);
  return {step,parts,searches:scopes.length,unavailable:scopes.filter(row=>row.coverage!=='some_text'&&row.coverage!=='partial').length,
    partial:scopes.filter(row=>row.coverage==='partial').length,repeatTurns:turns.flatMap((turn,index)=>sameStep(turn.step,step)?[index+1]:[]),
    remainingTurns:MAX_COLLECTION_TURNS-turns.length};
}
export function draftFieldLabel(field:FieldId|null):string|null{
  return fieldDefinitions.find(row=>row.id===field)?.label??null;
}
