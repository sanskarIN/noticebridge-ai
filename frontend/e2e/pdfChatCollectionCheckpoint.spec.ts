import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument,type CollectionExtractor} from '../src/pdfChatCollection';
import {pinCollectionEvidence,updateCollectionEvidence,collectionReviewKey} from '../src/pdfChatCollectionReview';
import {buildCheckpoint,restoreCheckpoint,validateCheckpoint,checkpointInfo,type CheckpointState} from '../src/pdfChatCollectionCheckpoint';
const signal=()=>new AbortController().signal;
const extract:CollectionExtractor=async file=>({passages:[{role:'original',page:1,ordinal:1,text:await file.text()}],
  pageCount:1,processedPages:1,missingPages:[],limitedPages:[],limited:false});
async function fixture(){
  const docs:CollectionDocument[]=[];
  for(const [name,text] of [['A.pdf','Application fee: INR 500'],['B.pdf','Eligibility: Class 12']]){
    docs.push(await admitCollectionDocument(docs,new File([text],name),signal(),extract));
  }
  const [a,b]=docs;
  const turns=[runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id],includeContext:false})];
  const source=a.corpus.passages[0];
  const reviews=updateCollectionEvidence(pinCollectionEvidence(docs,[],a.id,source),collectionReviewKey(a.id,source),
    {note:'Private annotation',status:'needs_followup'});
  const state:CheckpointState={documents:docs,turns,reviews,selected:[b.id]};
  return {a,b,state};
}
test('checkpoint stores exact bytes only after consent and restores fresh live source identity',async()=>{
  const f=await fixture();await expect(buildCheckpoint(f.state,false,signal())).rejects.toThrow();
  const checkpoint=await buildCheckpoint(f.state,true,signal());
  expect(checkpointInfo(checkpoint)).toMatchObject({documents:2,containsWork:true});
  expect(checkpoint.files.map(file=>file.name)).toEqual(['A.pdf','B.pdf']);
  expect(await checkpoint.files[0].bytes.text()).toBe('Application fee: INR 500');
  const progress:number[]=[];
  const result=await restoreCheckpoint(checkpoint,extract,signal(),p=>progress.push(p.completed));
  expect(progress).toEqual([0,1,2]);
  expect(result.selected).toEqual(f.state.selected);
  expect(result.turns).toEqual(f.state.turns);expect(result.reviews).toEqual(f.state.reviews);
  expect(result.documents[0].corpus.passages[0]).not.toBe(f.a.corpus.passages[0]);
  expect(result.turns[0].results[0].parts[0].answer.citations[0]).toBe(result.documents[0].corpus.passages[0]);
  expect(result.reviews[0].source).toBe(result.documents[0].corpus.passages[0]);
});
test('source-only checkpoint restores without inventing saved work',async()=>{
  const f=await fixture(),state={...f.state,turns:[],reviews:[],selected:[]};
  const value=await buildCheckpoint(state,true,signal());
  expect(value.workspace).toBeNull();expect(value.workspaceSha256).toBeNull();
  expect(checkpointInfo(value).containsWork).toBe(false);
  expect(await restoreCheckpoint(value,extract,signal())).toMatchObject({turns:[],reviews:[],selected:[]});
});
test('checkpoint rejects different bytes, extraction, digests and malformed source metadata',async()=>{
  const f=await fixture(),value=await buildCheckpoint(f.state,true,signal());
  for(const raw of [
    {...value,version:2},{...value,revision:'fake'},{...value,selected:['fake']},
    {...value,files:[value.files[0],value.files[0]]},{...value,files:[{...value.files[0],name:'../A.pdf'},value.files[1]]},
    {...value,files:[{...value.files[0],size:1},value.files[1]]},{...value,workspaceSha256:null},
  ])expect(()=>validateCheckpoint(raw)).toThrow();
  await expect(restoreCheckpoint({...value,snapshotSha256:'0'.repeat(64)},extract,signal())).rejects.toThrow();
  await expect(restoreCheckpoint({...value,workspaceSha256:'0'.repeat(64)},extract,signal())).rejects.toThrow();
  const bad={...value,files:[{...value.files[0],bytes:new Blob(['X'.repeat(value.files[0].size)])},value.files[1]]};
  await expect(restoreCheckpoint(bad,extract,signal())).rejects.toThrow();
  await expect(restoreCheckpoint(value,async file=>{
    const c=await extract(file,'original',signal());return {...c,passages:c.passages.map(row=>({...row,text:'Different extraction'}))};
  },signal())).rejects.toThrow();
});
test('cancellation aborts restore after a completed source without exposing partial state',async()=>{
  const f=await fixture(),value=await buildCheckpoint(f.state,true,signal()),ctrl=new AbortController();
  await expect(restoreCheckpoint(value,extract,ctrl.signal,p=>{if(p.completed===1)ctrl.abort();})).rejects.toThrow();
  expect(f.state.documents).toHaveLength(2);expect(f.state.turns).toHaveLength(1);
});
