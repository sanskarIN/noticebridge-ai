import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionEvalTarget,resolveCollectionEvalFragment,validateCollectionEvalCase,upsertCollectionEvalCase,
  evaluateCollection,serializeCollectionEvalLabels,parseCollectionEvalLabels,serializeCollectionEvalReport,
  verifyCollectionEvalReport,collectionEvalPage,type CollectionEvalCase} from '../src/pdfChatCollectionEvaluation';
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),new AbortController().signal,async()=>({
    passages:lines.map((text,index)=>({role:'original' as const,page:1,ordinal:index+1,text})),
    pageCount:1,processedPages:1,missingPages:lines.length?[]:[1],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',['Application fee: INR 500','Eligibility: Class 12']);
  const b=await add([a],'b',['Application fee: INR 350']);
  const docs=[a,b];
  const turn=runCollectionStep(docs,{question:'Application fee? Eligibility?',documentIds:[a.id,b.id],includeContext:false});
  const label=(id:string,part:number,expected:CollectionEvalCase['expected']):CollectionEvalCase=>({
    ...collectionEvalTarget(docs,turn,id,part),expected,label:expected.length?'evidence':'no_expected_match',note:'Human note',
  });
  return {a,b,docs,turn,label};
}
test('retrieval metrics distinguish missed evidence, unlabelled results and labelled abstention',async()=>{
  const {a,b,docs,label}=await fixture();
  const cases=[label(a.id,0,[{source:a.corpus.passages[0]}]),label(b.id,0,[{source:b.corpus.passages[0]}]),
    label(b.id,1,[]),label(a.id,1,[{source:a.corpus.passages[0]}])];
  const result=evaluateCollection(docs,cases);
  expect(result.metrics).toMatchObject({cases:4,evidenceCases:3,abstentionCases:1,correctFragments:2,
    expectedFragments:3,retrievedFragments:3,microPrecision:2/3,microRecall:2/3,meanReciprocalRank:2/3,
    exactCoverageCases:2,correctAbstentions:1,unexpectedMatches:0});
  expect(result.observations[3].expectedMissed).toEqual([a.corpus.passages[0]]);
  expect(result.observations[3].unexpectedRetrieved).toEqual([a.corpus.passages[1]]);
});
test('labels preserve exact document identity, reject foreign sources and enforce page scope',async()=>{
  const {a,b,docs,label}=await fixture();
  expect(resolveCollectionEvalFragment(docs,a.id,1,1)).toBe(a.corpus.passages[0]);
  expect(()=>validateCollectionEvalCase(docs,label(a.id,0,[{source:b.corpus.passages[0]}]))).toThrow();
  expect(()=>validateCollectionEvalCase(docs,{...label(a.id,0,[{source:a.corpus.passages[0]}]),question:'Application fee on page 2?'})).toThrow();
  expect(()=>validateCollectionEvalCase(docs,{...label(a.id,0,[]),label:'evidence'})).toThrow();
  expect(()=>validateCollectionEvalCase(docs,label(a.id,0,[{source:a.corpus.passages[0]},{source:a.corpus.passages[0]}]))).toThrow();
});
test('label upsert replaces only exact question/source/settings key',async()=>{
  const {a,b,docs,label}=await fixture();
  const first=label(a.id,0,[{source:a.corpus.passages[0]}]);
  const other=label(b.id,0,[{source:b.corpus.passages[0]}]);
  const cases=upsertCollectionEvalCase(docs,[first],other);
  expect(cases).toHaveLength(2);
  expect(upsertCollectionEvalCase(docs,cases,{...first,note:'changed'}).map(row=>row.note)).toEqual(['changed','Human note']);
  expect(()=>evaluateCollection(docs,[first,first])).toThrow();
  expect(collectionEvalPage([],1)).toEqual({pages:1,rows:[]});
  expect(()=>collectionEvalPage([],2)).toThrow();
});
test('portable labels bind exact PDF set and fragment hashes without quotes',async()=>{
  const {a,b,docs,label}=await fixture();
  const cases=[label(a.id,0,[{source:a.corpus.passages[0]}]),label(b.id,1,[])];
  const text=await serializeCollectionEvalLabels(docs,cases);
  expect(text).not.toContain('INR 500');expect(text).not.toContain('private.pdf');
  const restored=await parseCollectionEvalLabels(text,[...docs].reverse());
  expect(restored).toEqual(cases);
  expect(restored[0].expected[0].source).toBe(a.corpus.passages[0]);
  const changed=await add([],'a',['Application fee: INR 999','Eligibility: Class 12']);
  await expect(parseCollectionEvalLabels(text,[changed,b])).rejects.toThrow();
  await expect(parseCollectionEvalLabels(text,[a])).rejects.toThrow();
  await expect(parseCollectionEvalLabels(text.trim(),docs)).rejects.toThrow();
  const value=JSON.parse(text);value.cases[0].expected[0].text_sha256='f'.repeat(64);
  await expect(parseCollectionEvalLabels(JSON.stringify(value,null,2)+'\n',docs)).rejects.toThrow();
});
test('report verification reruns evaluation rather than trusting saved success or metrics',async()=>{
  const {a,docs,label}=await fixture();
  const cases=[label(a.id,0,[{source:a.corpus.passages[0]}])];
  const report=await serializeCollectionEvalReport(docs,cases);
  expect(await verifyCollectionEvalReport(report,docs,cases)).toEqual(evaluateCollection(docs,cases).metrics);
  const value=JSON.parse(report);value.metrics.microRecall=0;
  await expect(verifyCollectionEvalReport(JSON.stringify(value,null,2)+'\n',docs,cases)).rejects.toThrow();
  await expect(verifyCollectionEvalReport(report,docs,[{...cases[0],note:'new annotation'}])).rejects.toThrow();
  const controller=new AbortController();controller.abort();
  await expect(parseCollectionEvalLabels(await serializeCollectionEvalLabels(docs,cases),docs,controller.signal)).rejects.toThrow();
});
test('undefined metrics remain null rather than manufacturing perfect scores',async()=>{
  const {b,docs,label}=await fixture();
  const result=evaluateCollection(docs,[label(b.id,1,[])]);
  expect(result.metrics).toMatchObject({microRecall:null,microPrecision:null,meanReciprocalRank:null,correctAbstentions:1});
});
