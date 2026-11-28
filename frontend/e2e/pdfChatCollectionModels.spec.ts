import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {prepareCollectionModelPlan,reviewCollectionModelResult,bundleCollectionModelResults,reviewCollectionModelBundle,
  runCollectionLocalModels,type CollectionModelRequest} from '../src/pdfChatCollectionModels';
import {pipelineSelection} from '../src/pdfChatPipeline';
import {requestHash} from '../src/pdfChatEmbeddingBridge';
async function add(docs:CollectionDocument[],bytes:string,text:string){
  return admitCollectionDocument(docs,new File([bytes],'notice.pdf'),new AbortController().signal,async()=>({
    passages:text?[{role:'original',page:1,ordinal:1,text}]:[],
    pageCount:1,processedPages:1,missingPages:text?[]:[1],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a','Application fee: INR 500'),b=await add([a],'b','Application fee: INR 350'),c=await add([a,b],'c','');
  const docs=[a,b,c],turn=runCollectionStep(docs,{question:'Application fee?',documentIds:docs.map(doc=>doc.id),includeContext:false});
  const plan=await prepareCollectionModelPlan(docs,turn,0,[a.id,b.id,c.id],'full');
  return {a,b,c,docs,turn,plan};
}
const config={embeddingModel:'embed:latest',embeddingDigest:'a'.repeat(64),answerModel:'answer:latest',answerDigest:'b'.repeat(64)};
async function result(entry:CollectionModelRequest){
  const ids=[...entry.request.embedding.allowed.keys()];
  const ranks={original:ids};
  const selected=pipelineSelection(entry.request,ranks);
  const source=selected.allowed.get(ids[0])!;
  return JSON.stringify({format:'noticebridge-chat-pipeline-result',version:1,request_sha256:entry.digest,
    ranking:{format:'noticebridge-chat-embedding-result',version:1,request_sha256:await requestHash(entry.request.embedding.text),
      model:config.embeddingModel,model_digest:config.embeddingDigest,dimension:2,candidate_count:ids.length,ranks,authority_verified:false},
    extractive:{format:'noticebridge-chat-extractive-result',version:1,request_sha256:await requestHash(selected.text),
      model:config.answerModel,model_digest:config.answerDigest,proposal:{status:'extract',spans:[{id:ids[0],start:0,end:source.text.length}]},authority_verified:false},
    authority_verified:false},null,2)+'\n';
}
test('model requests isolate identical physical IDs by collection document and skip empty native scopes',async()=>{
  const {a,b,c,docs,plan}=await fixture();
  expect(plan.requests.map(row=>row.documentId)).toEqual([a.id,b.id]);
  expect(plan.skipped).toEqual([{documentId:c.id,reason:'no_native_candidates'}]);
  expect(plan.requests[0].digest).not.toBe(plan.requests[1].digest);
  expect(plan.requests[0].request.text).not.toContain('INR 350');
  expect(plan.requests[1].request.text).not.toContain('INR 500');
  const first=await result(plan.requests[0]);
  const reviewed=await reviewCollectionModelResult(docs,plan.requests[0],first);
  expect(reviewed.review.extractive.proposal.spans[0].source).toBe(a.corpus.passages[0]);
  await expect(reviewCollectionModelResult(docs,plan.requests[1],first)).rejects.toThrow();
});
test('result bundle binds exact manifest, ordering, document identities and every inner result',async()=>{
  const {docs,plan}=await fixture();
  const inputs=await Promise.all(plan.requests.map(async entry=>({documentId:entry.documentId,text:await result(entry)})));
  const text=await bundleCollectionModelResults(docs,plan,[...inputs].reverse());
  expect((await reviewCollectionModelBundle(docs,plan,text)).map(row=>row.documentId)).toEqual(plan.requests.map(row=>row.documentId));
  await expect(bundleCollectionModelResults(docs,plan,inputs.slice(1))).rejects.toThrow();
  await expect(bundleCollectionModelResults(docs,plan,[inputs[0],inputs[0]])).rejects.toThrow();
  const raw=JSON.parse(text);raw.results.reverse();
  await expect(reviewCollectionModelBundle(docs,plan,JSON.stringify(raw,null,2)+'\n')).rejects.toThrow();
});
test('direct runner requires consent and rejects partial or cross-document proposals',async()=>{
  const {docs,plan}=await fixture();let calls=0;
  const runner=async(request:typeof plan.requests[number]['request'])=>{
    calls++;const entry=plan.requests.find(row=>row.request===request)!;
    return (await reviewCollectionModelResult(docs,entry,await result(entry))).review;
  };
  const signal=new AbortController().signal;
  await expect(runCollectionLocalModels(docs,plan,config,signal,false,undefined,runner)).rejects.toThrow();
  expect(calls).toBe(0);
  const rows=await runCollectionLocalModels(docs,plan,config,signal,true,undefined,runner);
  expect(rows).toHaveLength(2);expect(calls).toBe(2);
  const wrong=rows[0].review;
  await expect(runCollectionLocalModels(docs,plan,config,signal,true,undefined,async()=>wrong)).rejects.toThrow();
});
test('model preparation validates selected historical part and exact scope',async()=>{
  const {a,b,c,docs,turn}=await fixture();
  await expect(prepareCollectionModelPlan(docs,turn,99,[a.id],'full')).rejects.toThrow();
  await expect(prepareCollectionModelPlan(docs,turn,0,[c.id],'full')).rejects.toThrow();
  const scoped=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id],includeContext:false});
  await expect(prepareCollectionModelPlan(docs,scoped,0,[b.id],'full')).rejects.toThrow();
});
