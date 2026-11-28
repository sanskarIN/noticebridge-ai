import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionRequirements,collectionRequirementPage,collectionRequirementSource,collectionRequirementCounterparts} from '../src/pdfChatCollectionRequirements';
async function add(docs:CollectionDocument[],name:string,lines:string[]){
  return admitCollectionDocument(docs,new File([name],name+'.pdf'),new AbortController().signal,async()=>({
    passages:lines.map((text,i)=>({role:'original' as const,page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:lines.length?[]:[1],limited:false,limitedPages:[],
  }));
}
const filter={kind:'all',keyword:'',wording:'all'} as const;
test('exact requirement counterparts remain bound to separate documents, not duplicate fragments',async()=>{
  const a=await add([],'a',['Applicants must submit a certificate','Applicants must submit a certificate','Do not pay cash']);
  const b=await add([a],'b',['Applicants must submit a certificate','Payment is optional']);
  const c=await add([a,b],'c',['Applicants must submit a different certificate']);
  const docs=[a,b,c],ids=docs.map(doc=>doc.id);
  const result=collectionRequirements(docs,ids,filter);
  expect(result.hits).toHaveLength(6);
  expect(result.counts).toMatchObject({mandatory:4,prohibited:1,permission:1});
  expect(result.hits[0].matchingDocumentIds).toEqual([b.id]);
  expect(result.hits[1].matchingDocumentIds).toEqual([b.id]);
  expect(collectionRequirementCounterparts(docs,result,result.hits[0])).toEqual([{documentId:b.id,source:b.corpus.passages[0]}]);
  expect(collectionRequirementSource(docs,result,result.hits[0])).toBe(a.corpus.passages[0]);
  expect(()=>collectionRequirementSource(docs,result,{...result.hits[0]})).toThrow();
  expect(collectionRequirements(docs,ids,{...filter,wording:'shared'}).hits).toHaveLength(3);
  expect(collectionRequirements(docs,ids,{...filter,wording:'unshared'}).hits).toHaveLength(3);
  expect(collectionRequirements(docs,[a.id],{...filter,wording:'shared'}).hits).toEqual([]);
});
test('filters preserve literal cues and physical scope and reject unsupported options',async()=>{
  const a=await add([],'a',['Applicants must submit a certificate unless exempt','Applicants must not pay cash','Other text']);
  const result=collectionRequirements([a],[a.id],{...filter,kind:'exception',keyword:'certificate'});
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0].kinds).toEqual(['mandatory','exception']);
  expect(collectionRequirements([a],[a.id],{...filter,page:2}).hits).toEqual([]);
  expect(()=>collectionRequirements([a],[a.id],{...filter,page:81})).toThrow();
  expect(()=>collectionRequirements([a],[a.id],{...filter,keyword:'x'.repeat(121)})).toThrow();
  expect(()=>collectionRequirements([a],[a.id],{...filter,wording:'invalid' as never})).toThrow();
  expect(()=>collectionRequirements([a],[a.id,a.id],filter)).toThrow();
  expect(collectionRequirementPage(result.hits,1).rows).toEqual(result.hits);
  expect(()=>collectionRequirementPage(result.hits,2)).toThrow();
});
