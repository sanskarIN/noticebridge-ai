import {test,expect} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,MAX_COLLECTION_TURNS,type CollectionDocument,type CollectionStep} from '../src/pdfChatCollection';
import {prepareWorkspaceMerge,workspaceMergeSummary,applyWorkspaceMerge,setWorkspaceMergeChoice,workspaceConflictPage} from '../src/pdfChatCollectionWorkspaceMerge';
import {serializeCollectionWorkspace,parseCollectionWorkspace,type CollectionWorkspace} from '../src/pdfChatCollectionWorkspace';
import {MAX_COLLECTION_REVIEW_ITEMS,type CollectionReviewEntry} from '../src/pdfChatCollectionReview';
const signal=()=>new AbortController().signal;
async function fixture(){
  async function add(docs:CollectionDocument[],bytes:string){
    return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
      passages:Array.from({length:110},(_,i)=>({role:'original' as const,page:1,ordinal:i+1,
        text:i===0?'Application fee: INR 500':i===1?'Eligibility: Class 12':'Printed rule '+i})),
      pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
    }));
  }
  const a=await add([],'a'),b=await add([a],'b'),docs=[a,b];
  const step=(question:string,documentIds=[a.id,b.id],includeContext=false)=>runCollectionStep(docs,{question,documentIds,includeContext});
  const review=(i:number,note='',status:CollectionReviewEntry['status']='unreviewed',doc=a):CollectionReviewEntry=>
    ({documentId:doc.id,source:doc.corpus.passages[i],note,status});
  const current={turns:[step('Application fee?'),step('Application fee?')],reviews:[review(0,'Current note'),review(1,'Same')]};
  const imported={turns:[step('Application fee?'),step('Eligibility?'),step('Application fee?',[b.id,a.id]),
    step('Application fee?',[a.id,b.id],true)],reviews:[review(0,'Imported note','reviewed_manually'),review(1,'Same'),review(2,'New')]};
  return {a,b,docs,step,review,current,imported};
}
test('merge preserves current question order and appends distinct exact steps only',async()=>{
  const f=await fixture(),plan=prepareWorkspaceMerge(f.docs,f.current,f.imported);
  expect(plan.steps).toHaveLength(5);
  expect(plan.duplicateQuestions).toBe(1);
  expect(plan.importedQuestionCount).toBe(3);
  expect(plan.steps.slice(0,2)).toEqual(f.current.turns.map(row=>row.step));
  expect(plan.steps[3].documentIds).toEqual([f.b.id,f.a.id]);
  expect(plan.steps[4].includeContext).toBe(true);
  expect(plan.identicalReviews).toBe(1);
  expect(plan.importedOnlyReviews).toBe(1);
  expect(plan.conflicts[0]).toMatchObject({noteDiffers:true,statusDiffers:true});
  expect(workspaceMergeSummary(plan,[]).ready).toBe(false);
});
test('conflict resolution is required and keeps annotations separate from evidence',async()=>{
  const f=await fixture(),plan=prepareWorkspaceMerge(f.docs,f.current,f.imported),key=plan.conflicts[0].key;
  expect(()=>applyWorkspaceMerge(f.docs,f.current,plan,[])).toThrow();
  const choices=setWorkspaceMergeChoice(plan,[],key,'use_imported');
  expect(workspaceMergeSummary(plan,choices).ready).toBe(true);
  const merged=applyWorkspaceMerge(f.docs,f.current,plan,choices);
  expect(merged.reviews.map(row=>row.note)).toEqual(['Imported note','Same','New']);
  expect(merged.reviews[0].source).toBe(f.a.corpus.passages[0]);
  expect(merged.turns[0].results[0].parts[0].answer.citations[0]).toBe(f.a.corpus.passages[0]);
  expect(f.current.reviews[0].note).toBe('Current note');
  expect(f.current.turns).toHaveLength(2);
  const kept=applyWorkspaceMerge(f.docs,f.current,plan,setWorkspaceMergeChoice(plan,choices,key,'keep_current'));
  expect(kept.reviews[0].note).toBe('Current note');
  expect(kept.reviews[0].status).toBe('unreviewed');
  expect(setWorkspaceMergeChoice(plan,choices,key,null)).toEqual([]);
});
test('no cross-PDF conflict when printed text and coordinates happen to match',async()=>{
  const f=await fixture();
  const plan=prepareWorkspaceMerge(f.docs,{turns:[],reviews:[f.review(0,'A')]},{turns:[],reviews:[f.review(0,'B','reviewed_manually',f.b)]});
  expect(plan.conflicts).toEqual([]);
  expect(workspaceMergeSummary(plan,[]).ready).toBe(true);
  const merged=applyWorkspaceMerge(f.docs,plan.current,plan,[]);
  expect(merged.reviews.map(row=>row.documentId)).toEqual([f.a.id,f.b.id]);
});
test('combined limits reject atomic application rather than truncating',async()=>{
  const f=await fixture();
  const current={turns:Array.from({length:MAX_COLLECTION_TURNS},()=>f.step('Application fee?')),
    reviews:Array.from({length:MAX_COLLECTION_REVIEW_ITEMS},(_,i)=>f.review(i))};
  const questions={turns:[f.step('Eligibility?')],reviews:[]};
  const q=prepareWorkspaceMerge(f.docs,current,questions);
  expect(q.overQuestionLimit).toBe(true);
  expect(workspaceMergeSummary(q,[]).ready).toBe(false);
  expect(()=>applyWorkspaceMerge(f.docs,current,q,[])).toThrow();
  const reviews={turns:[],reviews:[f.review(100)]};
  const v=prepareWorkspaceMerge(f.docs,current,reviews);
  expect(v.overReviewLimit).toBe(true);
  expect(()=>applyWorkspaceMerge(f.docs,current,v,[])).toThrow();
});
test('stale references and malicious conflict decisions reject without altering current state',async()=>{
  const f=await fixture(),plan=prepareWorkspaceMerge(f.docs,f.current,f.imported);
  const key=plan.conflicts[0].key;
  const choice={key,choice:'keep_current' as const};
  expect(()=>applyWorkspaceMerge(f.docs,{...f.current,reviews:[...f.current.reviews]},plan,[choice])).toThrow();
  expect(()=>applyWorkspaceMerge([f.a],f.current,plan,[choice])).toThrow();
  expect(()=>applyWorkspaceMerge(f.docs,f.current,plan,[choice,choice])).toThrow();
  expect(()=>applyWorkspaceMerge(f.docs,f.current,plan,[{...choice,key:'forged'}])).toThrow();
  expect(()=>setWorkspaceMergeChoice(plan,[],'unknown','keep_current')).toThrow();
  const forged={...plan,steps:[],reviewEntries:[]};
  expect(applyWorkspaceMerge(f.docs,f.current,forged,[choice]).turns).toHaveLength(5);
  expect(f.current.reviews).toHaveLength(2);
});
test('validates live citation identities, notes, status and duplicate reviews',async()=>{
  const f=await fixture();
  for(const entry of [
    {...f.review(0),source:{...f.a.corpus.passages[0]}},
    {...f.review(0),documentId:f.b.id},
    {...f.review(0),note:'x'.repeat(501)},
    {...f.review(0),status:'verified' as never},
  ])expect(()=>prepareWorkspaceMerge(f.docs,f.current,{turns:[],reviews:[entry]})).toThrow();
  expect(()=>prepareWorkspaceMerge(f.docs,f.current,{turns:[],reviews:[f.review(0),f.review(0)]})).toThrow();
  const invalidStep:CollectionStep={question:'',documentIds:[f.a.id],includeContext:false};
  const invalid:CollectionWorkspace={turns:[{step:invalidStep,results:[]}],reviews:[]};
  expect(()=>prepareWorkspaceMerge(f.docs,f.current,invalid)).toThrow();
});
test('imported workspace can be merged and exported using the existing canonical contract',async()=>{
  const f=await fixture();
  const text=await serializeCollectionWorkspace(f.docs,f.imported,signal());
  const imported=await parseCollectionWorkspace(text,f.docs,signal());
  const plan=prepareWorkspaceMerge(f.docs,f.current,imported);
  const merged=applyWorkspaceMerge(f.docs,f.current,plan,[{key:plan.conflicts[0].key,choice:'use_imported'}]);
  const exported=await serializeCollectionWorkspace(f.docs,merged,signal());
  const restored=await parseCollectionWorkspace(exported,[...f.docs].reverse(),signal());
  expect(restored.turns).toEqual(merged.turns);
  expect(restored.reviews).toEqual(merged.reviews);
  expect(exported).not.toContain('INR 500');
  expect(exported).not.toContain('private.pdf');
});
test('identical workspace does not create a spurious merge and pagination remains bounded',async()=>{
  const f=await fixture(),plan=prepareWorkspaceMerge(f.docs,f.current,f.current);
  expect(workspaceMergeSummary(plan,[]).reason).toContain('no new work');
  expect(workspaceConflictPage([],1)).toEqual({pages:1,rows:[]});
  expect(()=>workspaceConflictPage([],2)).toThrow();
  expect(()=>workspaceConflictPage([],1,0)).toThrow();
});
