/** A merge is a staged proposal, never a replacement by default.
 * Both inputs must be source-bound, and conflicting human annotations
 * require explicit per-fragment decisions. No status is promoted by rank. */
import {collectionStats,collectionSteps,normalizeCollectionStep,replayCollectionSteps,
  collectionCitation,MAX_COLLECTION_TURNS,type CollectionDocument,type CollectionStep} from './pdfChatCollection';
import {collectionReviewKey,validCollectionReviewNote,COLLECTION_REVIEW_STATUSES,MAX_COLLECTION_REVIEW_ITEMS,
  type CollectionReviewEntry} from './pdfChatCollectionReview';
import type {CollectionWorkspace} from './pdfChatCollectionWorkspace';

export type MergeChoice='keep_current'|'use_imported';
export type WorkspaceMergeConflict={
  key:string;current:CollectionReviewEntry;imported:CollectionReviewEntry;
  noteDiffers:boolean;statusDiffers:boolean;
};
export type WorkspaceMergePlan={
  sourceIds:string[];
  current:CollectionWorkspace;
  imported:CollectionWorkspace;
  steps:CollectionStep[];
  importedQuestionCount:number;
  duplicateQuestions:number;
  reviewEntries:CollectionReviewEntry[];
  conflicts:WorkspaceMergeConflict[];
  currentOnlyReviews:number;
  importedOnlyReviews:number;
  identicalReviews:number;
  overQuestionLimit:boolean;
  overReviewLimit:boolean;
};
export type WorkspaceMergeResolution={key:string;choice:MergeChoice};
export type WorkspaceMergeSummary={
  questions:number;reviews:number;newQuestions:number;duplicateQuestions:number;
  newReviews:number;identicalReviews:number;conflicts:number;resolved:number;
  ready:boolean;reason:string|null;
};

function invalid():never{throw new Error('Invalid, stale, or unresolved workspace merge.');}
function key(entry:CollectionReviewEntry){return collectionReviewKey(entry.documentId,entry.source);}
function questionKey(step:CollectionStep){
  // Selection ordering affects display and is intentionally meaningful.
  return JSON.stringify([step.question,step.documentIds,step.includeContext]);
}
function ids(documents:readonly CollectionDocument[]){
  collectionStats(documents);
  if(!documents.length)invalid();
  return documents.map(row=>row.id).sort();
}
function sameReview(a:CollectionReviewEntry,b:CollectionReviewEntry){
  return a.status===b.status&&a.note===b.note;
}
function validateWorkspace(documents:readonly CollectionDocument[],workspace:CollectionWorkspace,sourceIds:string[]){
  if(!workspace||!Array.isArray(workspace.turns)||!Array.isArray(workspace.reviews)||
      workspace.turns.length>MAX_COLLECTION_TURNS||workspace.reviews.length>MAX_COLLECTION_REVIEW_ITEMS)invalid();
  const steps=collectionSteps(workspace.turns).map(row=>normalizeCollectionStep(row,sourceIds));
  const reviewKeys=new Set<string>();
  for(const entry of workspace.reviews){
    if(!entry||!validCollectionReviewNote(entry.note)||!COLLECTION_REVIEW_STATUSES.includes(entry.status))invalid();
    collectionCitation(documents,entry.documentId,entry.source);
    const id=key(entry);
    if(reviewKeys.has(id))invalid();
    reviewKeys.add(id);
  }
  return steps;
}

/** Keep every existing question, even intentional repeated questions.
 * Imported questions are appended in their original order only when
 * their exact question, ordered document set and context flag are new. */
export function prepareWorkspaceMerge(documents:readonly CollectionDocument[],current:CollectionWorkspace,
  imported:CollectionWorkspace):WorkspaceMergePlan{
  const sourceIds=ids(documents);
  const steps=validateWorkspace(documents,current,sourceIds);
  const incoming=validateWorkspace(documents,imported,sourceIds);
  const seenQuestions=new Set(steps.map(questionKey));
  let duplicateQuestions=0,importedQuestionCount=0;
  for(const step of incoming){
    const signature=questionKey(step);
    if(seenQuestions.has(signature)){duplicateQuestions++;continue;}
    steps.push(step);seenQuestions.add(signature);importedQuestionCount++;
  }
  const currentByKey=new Map(current.reviews.map(entry=>[key(entry),entry]));
  const importedByKey=new Map(imported.reviews.map(entry=>[key(entry),entry]));
  const reviewEntries:CollectionReviewEntry[]=[];
  const conflicts:WorkspaceMergeConflict[]=[];
  let currentOnlyReviews=0,importedOnlyReviews=0,identicalReviews=0;
  for(const entry of current.reviews){
    const id=key(entry),other=importedByKey.get(id);
    reviewEntries.push({...entry});
    if(!other){currentOnlyReviews++;continue;}
    if(sameReview(entry,other)){identicalReviews++;continue;}
    conflicts.push({key:id,current:entry,imported:other,noteDiffers:entry.note!==other.note,
      statusDiffers:entry.status!==other.status});
  }
  for(const entry of imported.reviews){
    if(currentByKey.has(key(entry)))continue;
    reviewEntries.push({...entry});importedOnlyReviews++;
  }
  return {sourceIds,current,imported,steps,importedQuestionCount,duplicateQuestions,reviewEntries,conflicts,
    currentOnlyReviews,importedOnlyReviews,identicalReviews,
    overQuestionLimit:steps.length>MAX_COLLECTION_TURNS,
    overReviewLimit:reviewEntries.length>MAX_COLLECTION_REVIEW_ITEMS};
}

function decisionMap(plan:WorkspaceMergePlan,resolutions:readonly WorkspaceMergeResolution[]){
  if(!Array.isArray(resolutions)||resolutions.length>plan.conflicts.length)invalid();
  const known=new Set(plan.conflicts.map(row=>row.key));
  const decisions=new Map<string,MergeChoice>();
  for(const row of resolutions){
    if(!row||!known.has(row.key)||decisions.has(row.key)||
        (row.choice!=='keep_current'&&row.choice!=='use_imported'))invalid();
    decisions.set(row.key,row.choice);
  }
  return decisions;
}

export function workspaceMergeSummary(plan:WorkspaceMergePlan,resolutions:readonly WorkspaceMergeResolution[]):WorkspaceMergeSummary{
  const resolved=decisionMap(plan,resolutions).size;
  let reason:string|null=null;
  if(plan.overQuestionLimit)reason='The combined question history exceeds the collection limit.';
  else if(plan.overReviewLimit)reason='The combined review notebook exceeds the collection limit.';
  else if(resolved!==plan.conflicts.length)reason='Resolve every differing annotation before applying.';
  else if(!plan.importedQuestionCount&&!plan.importedOnlyReviews&&!plan.conflicts.length)reason='The imported workspace adds no new work.';
  return {questions:plan.steps.length,reviews:plan.reviewEntries.length,newQuestions:plan.importedQuestionCount,
    duplicateQuestions:plan.duplicateQuestions,newReviews:plan.importedOnlyReviews,identicalReviews:plan.identicalReviews,
    conflicts:plan.conflicts.length,resolved,ready:reason===null,reason};
}

export function setWorkspaceMergeChoice(plan:WorkspaceMergePlan,resolutions:readonly WorkspaceMergeResolution[],
  key:string,choice:MergeChoice|null):WorkspaceMergeResolution[]{
  decisionMap(plan,resolutions);
  if(!plan.conflicts.some(row=>row.key===key)||(choice!==null&&choice!=='keep_current'&&choice!=='use_imported'))invalid();
  const next=resolutions.filter(row=>row.key!==key);
  if(choice!==null)next.push({key,choice});
  return next;
}

export function workspaceConflictPage(conflicts:readonly WorkspaceMergeConflict[],page:number,pageSize=5){
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>10)invalid();
  const pages=Math.max(1,Math.ceil(conflicts.length/pageSize));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  return {pages,rows:conflicts.slice((page-1)*pageSize,page*pageSize)};
}

/** Rebuild the proposal at apply time. A staged preview cannot inject a
 * fabricated question or review, and a changed current workspace must be
 * re-imported rather than overwritten. */
export function applyWorkspaceMerge(documents:readonly CollectionDocument[],current:CollectionWorkspace,
  staged:WorkspaceMergePlan,resolutions:readonly WorkspaceMergeResolution[]):CollectionWorkspace{
  if(current.turns!==staged.current.turns||current.reviews!==staged.current.reviews||
      ids(documents).join(',')!==staged.sourceIds.join(','))invalid();
  const fresh=prepareWorkspaceMerge(documents,current,staged.imported);
  if(!workspaceMergeSummary(fresh,resolutions).ready)invalid();
  const decisions=decisionMap(fresh,resolutions);
  const importedByKey=new Map(fresh.conflicts.map(row=>[row.key,row.imported]));
  const reviews=fresh.reviewEntries.map(entry=>{
    const id=key(entry);
    return decisions.get(id)==='use_imported'?{...importedByKey.get(id)!}:{...entry};
  });
  const turns=fresh.steps.length?replayCollectionSteps(documents,fresh.steps):[];
  return {turns,reviews};
}
