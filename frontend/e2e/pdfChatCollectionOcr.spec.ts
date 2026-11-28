import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {parseCollectionOcr,replaceCollectionOcr,collectionOcrStats,collectionOcrSearch,collectionOcrPage,
  collectionOcrPages,runCollectionOcr,removeCollectionOcr,collectionOcrPageList} from '../src/pdfChatCollectionOcr';
async function add(docs:CollectionDocument[],bytes:string,text:string){
  return admitCollectionDocument(docs,new File([bytes],'notice.pdf'),new AbortController().signal,async()=>({
    passages:text?[{role:'original',page:1,ordinal:1,text}]:[],
    pageCount:2,processedPages:2,missingPages:text?[2]:[1,2],limited:false,limitedPages:[],
  }));
}
function report(doc:CollectionDocument,lines:string[],page=1,role='original'){
  return JSON.stringify({format:'noticebridge-chat-ocr-review',version:1,source_sha256:doc.id,role,
    page_count:doc.corpus.pageCount,pages:[{page,status:lines.length?'ok':'empty',
      lines:lines.map((text,i)=>({ordinal:i+1,text}))}]},null,2)+'\n';
}
async function fixture(){
  const a=await add([],'a','Application fee: INR 500'),b=await add([a],'b','');
  return {a,b,docs:[a,b]};
}
test('OCR reports bind to the exact PDF and remain outside native retrieval',async()=>{
  const {a,b,docs}=await fixture();
  const first=parseCollectionOcr(docs,a.id,report(a,['Application fee: INR 500','Application fee: INR 999']));
  const second=parseCollectionOcr(docs,b.id,report(b,['Application fee: INR 350']));
  const entries=replaceCollectionOcr(docs,replaceCollectionOcr(docs,[],first),second);
  expect(collectionOcrStats(docs,entries)).toMatchObject({documents:2,pages:2,lines:3});
  expect(collectionOcrPage(docs,first,1).lines.map(row=>row.nativeExact)).toEqual([true,false]);
  expect(()=>parseCollectionOcr(docs,b.id,report(a,['Text']))).toThrow();
  expect(()=>parseCollectionOcr(docs,a.id,report(a,['Text'],1,'revised'))).toThrow();
  const turn=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id,b.id],includeContext:false});
  expect(turn.results[1].parts[0].answer.kind).toBe('insufficient');
  const results=collectionOcrSearch(docs,entries,turn,0);
  expect(results[1].matches.map(row=>row.source.text)).toEqual(['Application fee: INR 350']);
  expect(turn.results[1].parts[0].answer.citations).toEqual([]);
  expect(removeCollectionOcr(entries,a.id)).toEqual([second]);
});
test('OCR page scoping and absent reports do not substitute another PDF or page',async()=>{
  const {a,b,docs}=await fixture();
  const entry=parseCollectionOcr(docs,a.id,report(a,['Eligibility: Class 12'],1));
  const turn=runCollectionStep(docs,{question:'Eligibility on page 2?',documentIds:[a.id,b.id],includeContext:false});
  expect(collectionOcrSearch(docs,[entry],turn,0).map(row=>row.state)).toEqual(['page_not_reviewed','missing_review']);
  expect(()=>collectionOcrPage(docs,entry,2)).toThrow();
  expect(collectionOcrPages(docs,a.id,'2,1')).toEqual([1,2]);
  expect(()=>collectionOcrPages(docs,a.id,'3')).toThrow();
  expect(collectionOcrPageList([],1)).toEqual({pages:1,rows:[]});
});
test('local OCR requires consent and validates the exact source and selected physical pages',async()=>{
  const {a,b,docs}=await fixture();
  const signal=new AbortController().signal;
  const incoming=parseCollectionOcr(docs,a.id,report(a,['Application fee: INR 500'])).review;
  let calls=0;
  const runner=async()=>{calls++;return incoming;};
  await expect(runCollectionOcr(docs,a.id,'1',signal,false,runner)).rejects.toThrow();
  expect(calls).toBe(0);
  expect((await runCollectionOcr(docs,a.id,'1',signal,true,runner)).documentId).toBe(a.id);
  await expect(runCollectionOcr(docs,b.id,'1',signal,true,runner)).rejects.toThrow();
  await expect(runCollectionOcr(docs,a.id,'2',signal,true,runner)).rejects.toThrow();
  const abort=new AbortController();abort.abort();
  await expect(runCollectionOcr(docs,a.id,'1',abort.signal,true,runner)).rejects.toThrow();
});
