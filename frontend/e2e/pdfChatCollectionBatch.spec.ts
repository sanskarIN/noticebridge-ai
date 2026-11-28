import { expect, test } from '@playwright/test';
import { admitCollectionDocument, runCollectionStep, type CollectionDocument } from '../src/pdfChatCollection';
import { prepareCollectionBatch, runCollectionBatch, summarizeCollectionBatch, appendCollectionBatch,
  batchCitation, batchPage, MAX_BATCH_TEXT } from '../src/pdfChatCollectionBatch';

async function add(docs: CollectionDocument[], name: string, lines: string[]) {
  return admitCollectionDocument(docs, new File([name], name + '.pdf'), new AbortController().signal,
    async () => ({ passages: lines.map((text, i) => ({ role:'original' as const, page:1, ordinal:i+1,text })),
      pageCount:1,processedPages:1,missingPages:lines.length?[]:[1],limited:false,limitedPages:[] }));
}
async function fixture() {
  const a = await add([], 'a', ['Application fee: INR 500','Eligibility: Class 12']);
  const b = await add([a], 'b', ['Application fee: INR 350']);
  const c = await add([a,b], 'c', []);
  return { a,b,c,docs:[a,b,c] };
}
const signal = () => new AbortController().signal;
test('batch preserves explicit selected document order and independent question parts', async () => {
  const {a,b,c,docs}=await fixture();
  const steps=prepareCollectionBatch(docs,'Application fee?\r\n\n Eligibility? ',[b.id,a.id,c.id],false,24);
  const progress: number[]=[];
  const result=await runCollectionBatch(docs,steps,24,{signal:signal(),onProgress:p=>progress.push(p.completed)});
  expect(progress).toEqual([0,1,2]);
  expect(result.searches).toBe(6);
  const summary=summarizeCollectionBatch(result);
  expect(summary).toMatchObject({questions:2,searches:6,matched:3,unmatched:3,limited:2});
  expect(summary.rows[0].cells.map(cell=>cell.documentId)).toEqual([b.id,a.id,c.id]);
  expect(batchCitation(docs,summary.rows[0].cells[0],0,0)).toBe(b.corpus.passages[0]);
  expect(summary.rows[1].cells.map(cell=>cell.state)).toEqual(['no_match','all_matched','no_match']);
  expect(()=>batchCitation(docs,summary.rows[1].cells[0],0,0)).toThrow();
});
test('batch rejects duplicate, malformed, over-capacity and over-budget requests before searching', async () => {
  const {a,b,c,docs}=await fixture();
  for(const input of ['','  ','Fee?\nFee?','Fee?\u0000','x'.repeat(401),'x'.repeat(MAX_BATCH_TEXT+1),
    Array.from({length:13},(_,i)=>'Question '+i).join('\n')]) {
    expect(()=>prepareCollectionBatch(docs,input,[a.id],false,24)).toThrow();
  }
  expect(()=>prepareCollectionBatch(docs,'Fee?\nEligibility?',[a.id],false,1)).toThrow();
  expect(()=>prepareCollectionBatch(docs,'Fee?',[],false,24)).toThrow();
  expect(()=>prepareCollectionBatch(docs,'Fee?',[a.id,a.id],false,24)).toThrow();
  expect(()=>prepareCollectionBatch(docs,'Fee? in the revised notice',[a.id],false,24)).toThrow();
  const d=await add(docs,'d',['Text d']), e=await add([...docs,d],'e',['Text e']), f=await add([...docs,d,e],'f',['Text f']);
  const all=[a,b,c,d,e,f];
  const expensive=Array.from({length:7},(_,i)=>'Fee '+i+'? Eligibility? Deadline? Documents?').join('\n');
  expect(()=>prepareCollectionBatch(all,expensive,all.map(doc=>doc.id),false,24)).toThrow();
});
test('cancellation and failed runs never expose a partial result', async () => {
  const {a,docs}=await fixture();
  const steps=prepareCollectionBatch(docs,'Fee?\nEligibility?',[a.id],false,24);
  const controller=new AbortController();
  const progress:number[]=[];
  await expect(runCollectionBatch(docs,steps,24,{signal:controller.signal,onProgress:p=>{
    progress.push(p.completed); if(p.completed===1)controller.abort();
  }})).rejects.toThrow();
  expect(progress).toEqual([0,1]);
  await expect(runCollectionBatch(docs,steps,24,{signal:controller.signal})).rejects.toThrow();
});
test('append preserves prefix and exact source objects and rejects stale or altered staged results', async () => {
  const {a,docs}=await fixture();
  const history=[runCollectionStep(docs,{question:'Fee?',documentIds:[a.id],includeContext:false})];
  const steps=prepareCollectionBatch(docs,'Eligibility?',[a.id],false,23);
  const result=await runCollectionBatch(docs,steps,23,{signal:signal()});
  const stage={documents:docs,history,result};
  const next=appendCollectionBatch(docs,history,stage);
  expect(next).toHaveLength(2);
  expect(next[0]).toBe(history[0]);
  expect(next[1].results[0].parts[0].answer.citations[0]).toBe(a.corpus.passages[1]);
  expect(()=>appendCollectionBatch([...docs],history,stage)).toThrow('changed');
  expect(()=>appendCollectionBatch(docs,[...history],stage)).toThrow('changed');
  expect(()=>appendCollectionBatch(docs,history,{...stage,result:{...result,searches:99}})).toThrow();
  const forged=structuredClone(result);
  forged.turns[0].results[0].parts[0].answer.citations[0].text='forged';
  expect(()=>appendCollectionBatch(docs,history,{...stage,result:forged})).toThrow();
  expect(history).toHaveLength(1);
});
test('batch page bounds are explicit',()=>{
  expect(batchPage([],1)).toEqual({pages:1,rows:[]});
  expect(()=>batchPage([],2)).toThrow();
  expect(()=>batchPage([],0)).toThrow();
});
