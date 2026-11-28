/** Editable, independently scoped question plan. Draft rows are never
 * treated as saved answers. Validation collects row-specific failures before
 * performing any retrieval, and preserves the user's exact question order. */
import {MAX_QUESTION} from './pdfChatCore';
import {collectionStats,normalizeCollectionStep,MAX_COLLECTION_TURNS,serializeCollectionPlan,parseCollectionPlan,
  type CollectionDocument,type CollectionStep,type CollectionTurn} from './pdfChatCollection';
import {MAX_BATCH_QUESTIONS,MAX_BATCH_SEARCHES,runCollectionBatch,appendCollectionBatch,type BatchStage,type BatchProgress} from './pdfChatCollectionBatch';
import {planQuestions} from './pdfChatInsights';
export type ScopedDraft={key:number;question:string;documentIds:string[];includeContext:boolean};
export type ScopedDraftIssue={key:number;reason:'empty'|'selection'|'question'|'duplicate'};
export type ScopedPlanValidation={steps:CollectionStep[];issues:ScopedDraftIssue[];searches:number;capacity:number;ready:boolean;reason:string|null};
export type ScopedPlanStage={rows:readonly ScopedDraft[];batch:BatchStage};
function invalid():never{throw new Error('Invalid or stale scoped collection question plan.');}
function uniqueKeys(rows:readonly ScopedDraft[]){
  if(!Array.isArray(rows)||rows.length>MAX_BATCH_QUESTIONS||new Set(rows.map(row=>row.key)).size!==rows.length||
    rows.some(row=>!Number.isSafeInteger(row.key)||row.key<1))invalid();
}
export function makeScopedDraft(key:number,selection:readonly string[],question='',includeContext=false):ScopedDraft{
  if(!Number.isSafeInteger(key)||key<1||!Array.isArray(selection)||typeof question!=='string'||question.length>MAX_QUESTION||
      typeof includeContext!=='boolean')invalid();
  return {key,question,documentIds:[...selection],includeContext};
}
export function editScopedDraft(rows:readonly ScopedDraft[],key:number,change:Partial<Omit<ScopedDraft,'key'>>):ScopedDraft[]{
  uniqueKeys(rows);
  if(!rows.some(row=>row.key===key)||!change||Object.keys(change).some(key=>!['question','documentIds','includeContext'].includes(key)))invalid();
  return rows.map(row=>row.key===key?makeScopedDraft(row.key,change.documentIds??row.documentIds,
    change.question??row.question,change.includeContext??row.includeContext):row);
}
export function moveScopedDraft(rows:readonly ScopedDraft[],key:number,direction:-1|1):ScopedDraft[]{
  uniqueKeys(rows);
  const index=rows.findIndex(row=>row.key===key);
  if(index<0||direction!==-1&&direction!==1||index+direction<0||index+direction>=rows.length)invalid();
  const next=[...rows];
  [next[index],next[index+direction]]=[next[index+direction],next[index]];
  return next;
}
export function removeScopedDraft(rows:readonly ScopedDraft[],key:number){
  uniqueKeys(rows);
  if(!rows.some(row=>row.key===key))invalid();
  return rows.filter(row=>row.key!==key);
}
export function validateScopedPlan(documents:readonly CollectionDocument[],rows:readonly ScopedDraft[],
  history:readonly CollectionTurn[]):ScopedPlanValidation{
  collectionStats(documents);uniqueKeys(rows);
  if(!Array.isArray(history)||history.length>MAX_COLLECTION_TURNS)invalid();
  const capacity=MAX_COLLECTION_TURNS-history.length;
  const ids=documents.map(doc=>doc.id);
  const issues:ScopedDraftIssue[]=[],steps:CollectionStep[]=[];
  const seen=new Set<string>();
  let searches=0;
  for(const row of rows){
    if(typeof row.question!=='string'||!row.question.trim()){issues.push({key:row.key,reason:'empty'});continue;}
    if(!Array.isArray(row.documentIds)||!row.documentIds.length||new Set(row.documentIds).size!==row.documentIds.length||
      row.documentIds.some(id=>!ids.includes(id))){issues.push({key:row.key,reason:'selection'});continue;}
    let step:CollectionStep;
    try{step=normalizeCollectionStep({question:row.question.trim(),documentIds:row.documentIds,includeContext:row.includeContext},ids);}
    catch{issues.push({key:row.key,reason:'question'});continue;}
    const signature=JSON.stringify(step);
    if(seen.has(signature)){issues.push({key:row.key,reason:'duplicate'});continue;}
    seen.add(signature);steps.push(step);searches+=planQuestions(step.question).length*step.documentIds.length;
  }
  const reason=!rows.length?'Add at least one question.':issues.length?'Correct the marked question rows.':
    rows.length>capacity?'The plan exceeds the remaining conversation slots.':
    searches>MAX_BATCH_SEARCHES?'The plan exceeds the independent search budget.':null;
  return {steps,issues,searches,capacity,ready:reason===null,reason};
}
export async function runScopedPlan(documents:readonly CollectionDocument[],rows:readonly ScopedDraft[],
  history:readonly CollectionTurn[],signal:AbortSignal,onProgress?:(progress:BatchProgress)=>void,
  yieldControl:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,0))):Promise<ScopedPlanStage>{
  signal.throwIfAborted();
  const validation=validateScopedPlan(documents,rows,history);
  if(!validation.ready)invalid();
  const result=await runCollectionBatch(documents,validation.steps,validation.capacity,{signal,onProgress,yieldControl});
  signal.throwIfAborted();
  return {rows,batch:{documents,history,result}};
}
export function applyScopedPlan(documents:readonly CollectionDocument[],rows:readonly ScopedDraft[],
  history:readonly CollectionTurn[],stage:ScopedPlanStage){
  if(stage.rows!==rows)invalid();
  const validation=validateScopedPlan(documents,rows,history);
  if(!validation.ready||JSON.stringify(validation.steps)!==JSON.stringify(stage.batch.result.turns.map(turn=>turn.step)))invalid();
  return appendCollectionBatch(documents,history,stage.batch);
}
/** Question plan uses the existing canonical exchange schema. The draft's
 * row keys are local UI identities and never exported. No answers included. */
export function exportScopedPlan(documents:readonly CollectionDocument[],rows:readonly ScopedDraft[],consent:boolean){
  if(consent!==true)invalid();
  const checked=validateScopedPlan(documents,rows,[]);
  if(!checked.ready)invalid();
  return serializeCollectionPlan(documents,checked.steps);
}
export function importScopedPlan(documents:readonly CollectionDocument[],text:string,startKey:number){
  const steps=parseCollectionPlan(text,documents);
  if(steps.length>MAX_BATCH_QUESTIONS||!Number.isSafeInteger(startKey)||startKey<1||
    !Number.isSafeInteger(startKey+steps.length))invalid();
  const rows=steps.map((step,i)=>makeScopedDraft(startKey+i,step.documentIds,step.question,step.includeContext));
  if(!validateScopedPlan(documents,rows,[]).ready)invalid();
  return rows;
}
