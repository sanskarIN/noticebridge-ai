import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {prepareCollectionModelPlan,reviewCollectionModelResult,type CollectionModelRequest} from '../src/pdfChatCollectionModels';
import {serializeCollectionEvalLabels,type CollectionEvalCase} from '../src/pdfChatCollectionEvaluation';
import {evaluateCollectionModels,serializeModelEvaluation,verifyModelEvaluation} from '../src/pdfChatCollectionModelEvaluation';
import {pipelineSelection} from '../src/pdfChatPipeline';
import {requestHash} from '../src/pdfChatEmbeddingBridge';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.map((text,i)=>({role:'original',page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:lines.length?[]:[1],limitedPages:[],limited:false,
  }));
}
async function result(entry:CollectionModelRequest,ordinal:number|null){
  const ids=[...entry.request.embedding.allowed.keys()].reverse().slice(0,8);
  const ranks={original:ids},selected=pipelineSelection(entry.request,ranks);
  const source=ordinal===null?null:[...selected.allowed.values()].find(source=>source.ordinal===ordinal)!;
  return JSON.stringify({format:'noticebridge-chat-pipeline-result',version:1,request_sha256:entry.digest,
    ranking:{format:'noticebridge-chat-embedding-result',version:1,request_sha256:await requestHash(entry.request.embedding.text),
      model:'embed:latest',model_digest:'a'.repeat(64),dimension:2,candidate_count:entry.request.embedding.allowed.size,ranks,authority_verified:false},
    extractive:{format:'noticebridge-chat-extractive-result',version:1,request_sha256:await requestHash(selected.text),
      model:'answer:latest',model_digest:'b'.repeat(64),proposal:{status:source?'extract':'insufficient',
        spans:source?[{id:'original:'+source.page+':'+source.ordinal,start:0,end:source.text.length}]:[]},authority_verified:false},
    authority_verified:false},null,2)+'\n';
}
async function fixture(){
  const a=await add([],'a',['Application fee: INR 500','Payment amount is five hundred rupees']);
  const b=await add([a],'b',['Eligibility: Class 12']);
  const c=await add([a,b],'c',[]);
  const docs=[a,b,c],turn=runCollectionStep(docs,{question:'Application fee?',documentIds:docs.map(doc=>doc.id),includeContext:false});
  const plan=await prepareCollectionModelPlan(docs,turn,0,turn.step.documentIds,'full');
  const reviews=await Promise.all(plan.requests.map(async(entry,i)=>reviewCollectionModelResult(docs,entry,await result(entry,i===0?2:null))));
  const targets:CollectionEvalCase[]=[
    {documentId:a.id,question:'Application fee?',includeContext:false,label:'evidence',expected:[{source:a.corpus.passages[1]}],note:'Private label'},
    {documentId:b.id,question:'Application fee?',includeContext:false,label:'no_expected_match',expected:[],note:''},
    {documentId:c.id,question:'Eligibility?',includeContext:false,label:'no_expected_match',expected:[],note:''},
  ];
  const labels=await serializeCollectionEvalLabels(docs,targets,signal());
  return {a,b,c,docs,turn,plan,reviews,targets,labels};
}
test('paired labels compare native baseline, fused candidates and proposal fragments independently',async()=>{
  const f=await fixture(),value=await evaluateCollectionModels(f.docs,f.turn,f.plan,f.reviews,f.labels,signal());
  expect(value.cases).toHaveLength(2);
  expect(value.baseline.microRecall).toBe(0);expect(value.fused.microRecall).toBe(1);expect(value.proposal.microRecall).toBe(1);
  expect(value.baseline.correctAbstentions).toBe(1);expect(value.proposal.correctAbstentions).toBe(1);
  expect(value.fused.correctAbstentions).toBe(0);
  expect(value.shortlistRecall).toBe(1);expect(value.otherLabelCases).toBe(1);
  expect(value.skipped).toEqual([{documentId:f.c.id,reason:'no_native_candidates'}]);
  expect(value.cases[0].proposal.expectedFound[0]).toBe(f.a.corpus.passages[1]);
});
test('missing review and unmatched label are reported instead of silently scoring zero',async()=>{
  const f=await fixture();
  const partial=await evaluateCollectionModels(f.docs,f.turn,f.plan,f.reviews.slice(0,1),f.labels,signal());
  expect(partial.cases).toHaveLength(1);expect(partial.skipped).toContainEqual({documentId:f.b.id,reason:'no_review'});
  const label=await serializeCollectionEvalLabels(f.docs,[f.targets[0]],signal());
  const unmatched=await evaluateCollectionModels(f.docs,f.turn,f.plan,f.reviews,label,signal());
  expect(unmatched.skipped).toContainEqual({documentId:f.b.id,reason:'no_label'});
  await expect(evaluateCollectionModels(f.docs,f.turn,f.plan,f.reviews.slice(1),label,signal())).rejects.toThrow();
});
test('exact source identity, request and context flags remain bound',async()=>{
  const f=await fixture();
  await expect(evaluateCollectionModels(f.docs,f.turn,{...f.plan,manifestDigest:'0'.repeat(64)},f.reviews,f.labels,signal())).rejects.toThrow();
  await expect(evaluateCollectionModels(f.docs,f.turn,f.plan,[f.reviews[0],f.reviews[0]],f.labels,signal())).rejects.toThrow();
  await expect(evaluateCollectionModels(f.docs,f.turn,f.plan,[{...f.reviews[0],documentId:f.b.id}],f.labels,signal())).rejects.toThrow();
  const other=await serializeCollectionEvalLabels(f.docs,[{...f.targets[0],includeContext:true}],signal());
  await expect(evaluateCollectionModels(f.docs,f.turn,f.plan,f.reviews,other,signal())).rejects.toThrow();
});
test('report requires consent and exact paired recomputation, without source excerpts or label notes',async()=>{
  const f=await fixture(),value=await evaluateCollectionModels(f.docs,f.turn,f.plan,f.reviews,f.labels,signal());
  expect(()=>serializeModelEvaluation(value,false)).toThrow();
  const report=serializeModelEvaluation(value,true);
  expect(report).not.toContain('Private label');expect(report).not.toContain('five hundred');expect(report).not.toContain('private.pdf');
  expect(await verifyModelEvaluation(report,f.docs,f.turn,f.plan,f.reviews,f.labels,signal())).toEqual(value);
  const raw=JSON.parse(report);raw.authority_verified=true;
  await expect(verifyModelEvaluation(JSON.stringify(raw,null,2)+'\n',f.docs,f.turn,f.plan,f.reviews,f.labels,signal())).rejects.toThrow();
  const ctrl=new AbortController();ctrl.abort();
  await expect(evaluateCollectionModels(f.docs,f.turn,f.plan,f.reviews,f.labels,ctrl.signal)).rejects.toThrow();
});
