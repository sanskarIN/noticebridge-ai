import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {pinCollectionEvidence,updateCollectionEvidence,collectionReviewKey} from '../src/pdfChatCollectionReview';
import {buildReviewQueue,buildReviewQueueAsync,filterReviewQueue,reviewQueuePage,queueQuestionDraft,queueSource,
  serializeReviewQueue,verifyReviewQueue,readReviewQueue} from '../src/pdfChatCollectionReviewQueue';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],name:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([name],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Application fee: INR 500','Application fee: INR 250','Eligibility: Class 12',
    'Rural applicants','Registration certificate required']]);
  const b=await add([a],'b',[['Application fee: INR 350'],[]]);
  const docs=[a,b];
  const turns=[
    runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id,b.id],includeContext:false}),
    runCollectionStep(docs,{question:'Eligibility on page 2?',documentIds:[a.id,b.id],includeContext:false}),
    runCollectionStep(docs,{question:'Rural registration certificate?',documentIds:[a.id],includeContext:true}),
  ];
  const source=a.corpus.passages[0];
  const reviews=updateCollectionEvidence(pinCollectionEvidence(docs,[],a.id,source),collectionReviewKey(a.id,source),
    {status:'reviewed_manually',note:'Private note'});
  return {a,b,docs,turns,reviews};
}
test('queue preserves independent searches, ambiguity and coverage reasons',async()=>{
  const f=await fixture(),q=buildReviewQueue(f.docs,f.turns,f.reviews);
  expect(q.turns).toBe(3);expect(q.searches).toBe(5);
  expect(q.reasonCounts.multiple_values).toBe(1);
  expect(q.reasonCounts.coverage).toBe(3);
  expect(q.reasonCounts.no_match).toBe(2);
  expect(q.reasonCounts.context_only).toBe(1);
  const ambiguous=q.items.find(row=>row.reasons.includes('multiple_values'))!;
  expect(ambiguous.documentId).toBe(f.a.id);
  expect(ambiguous.savedEvidence).toBe(1);expect(ambiguous.manuallyReviewed).toBe(1);
  expect(ambiguous.printedValues).toBe(2);
  expect(ambiguous.evidence.every(source=>f.a.corpus.passages.includes(source))).toBe(true);
  expect(queueSource(f.docs,q,ambiguous,ambiguous.evidence[0])).toBe(ambiguous.evidence[0]);
  expect(()=>queueSource(f.docs,q,ambiguous,f.b.corpus.passages[0])).toThrow();
});
test('filters do not change reasons and draft remains scoped to the saved physical page',async()=>{
  const f=await fixture(),q=buildReviewQueue(f.docs,f.turns,f.reviews);
  const rows=filterReviewQueue(q,{reason:'no_match',documentId:f.b.id,review:'unsaved',query:'eligibility'});
  expect(rows).toHaveLength(1);
  expect(queueQuestionDraft(f.docs,f.turns,rows[0])).toEqual({question:'Eligibility on page 2?',documentIds:[f.b.id],includeContext:false});
  expect(()=>queueQuestionDraft(f.docs,f.turns,{...rows[0],physicalPage:1})).toThrow();
  expect(reviewQueuePage(rows,1).rows).toEqual(rows);
  expect(()=>reviewQueuePage(rows,2)).toThrow();
});
test('different literal values across PDFs are independent review cues',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']]),b=await add([a],'b',[['Application fee: INR 350']]);
  const docs=[a,b],turn=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id,b.id],includeContext:false});
  const queue=buildReviewQueue(docs,[turn],[]);
  expect(queue.reasonCounts.different_values).toBe(2);
  expect(queue.items.map(row=>row.documentId)).toEqual([a.id,b.id]);
});
test('queue export replays exact diagnostics without including annotation notes or quotations',async()=>{
  const f=await fixture();
  const text=await serializeReviewQueue(f.docs,f.turns,f.reviews,true,signal());
  expect(text).not.toContain('Private note');expect(text).not.toContain('INR 500');expect(text).not.toContain('private.pdf');
  expect(await verifyReviewQueue(text,[...f.docs].reverse(),f.turns,f.reviews,signal())).toEqual(buildReviewQueue(f.docs,f.turns,f.reviews));
  await expect(serializeReviewQueue(f.docs,f.turns,f.reviews,false,signal())).rejects.toThrow();
  await expect(verifyReviewQueue(text,f.docs,f.turns,[],signal())).rejects.toThrow();
  await expect(verifyReviewQueue(text,f.docs,f.turns.slice(1),f.reviews,signal())).rejects.toThrow();
  const raw=JSON.parse(text);raw.authority_verified=true;
  await expect(verifyReviewQueue(JSON.stringify(raw,null,2)+'\n',f.docs,f.turns,f.reviews,signal())).rejects.toThrow();
  expect(await readReviewQueue(new File([text],'queue.json'),signal())).toBe(text);
  await expect(readReviewQueue(new File([new Uint8Array([255])],'bad.json'),signal())).rejects.toThrow();
});
test('asynchronous queue is identical and stops atomically after cancellation',async()=>{
  const f=await fixture(),progress:number[]=[];
  expect(await buildReviewQueueAsync(f.docs,f.turns,f.reviews,signal(),done=>progress.push(done),async()=>{}))
    .toEqual(buildReviewQueue(f.docs,f.turns,f.reviews));
  expect(progress).toEqual([0,1,2,3]);
  const ctrl=new AbortController();
  await expect(buildReviewQueueAsync(f.docs,f.turns,f.reviews,ctrl.signal,done=>{if(done===1)ctrl.abort();},async()=>{})).rejects.toThrow();
});
