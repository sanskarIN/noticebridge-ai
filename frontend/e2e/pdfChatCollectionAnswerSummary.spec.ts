import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionAnswerSummary,filterCollectionAnswerRows,collectionSharedAnswerQuotes} from '../src/pdfChatCollectionAnswerSummary';
async function add(docs:CollectionDocument[],bytes:string,lines:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'notice.pdf'),new AbortController().signal,async()=>({
    passages:lines.flatMap((page,index)=>page.map((text,i)=>({role:'original' as const,page:index+1,ordinal:i+1,text}))),
    pageCount:lines.length,processedPages:lines.length,
    missingPages:lines.flatMap((page,i)=>page.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
test('summary exposes distinct literal values, missing fields and incomplete coverage independently',async()=>{
  const a=await add([],'a',[['Application fee: INR 500','Application fee: INR 250']]);
  const b=await add([a],'b',[['Application fee: INR 350']]);
  const c=await add([a,b],'c',[[]]);
  const docs=[a,b,c],turn=runCollectionStep(docs,{question:'Application fee? Eligibility?',documentIds:docs.map(doc=>doc.id),includeContext:false});
  const summary=collectionAnswerSummary(docs,turn);
  expect(summary).toMatchObject({documents:3,searches:6,matchingSearches:2,limitedSearches:2});
  expect(summary.rows[0].printedState).toBe('multiple');
  expect(summary.rows[0].cells[0].direct?.values.map(row=>row.value)).toEqual(['INR 500','INR 250']);
  expect(summary.rows[0].cells[2].direct).toBeNull();
  expect(summary.rows[1].state).toBe('none');
  expect(filterCollectionAnswerRows(summary,'printed')).toEqual([summary.rows[0]]);
  expect(filterCollectionAnswerRows(summary,'no_match')).toEqual([summary.rows[1]]);
});
test('page constraints and saved document order are retained regardless of attachment order',async()=>{
  const a=await add([],'a',[['Application fee: INR 500'],['Application fee: INR 250']]);
  const b=await add([a],'b',[['Application fee: INR 350']]);
  const docs=[a,b],turn=runCollectionStep(docs,{question:'Application fee on page 2?',documentIds:[b.id,a.id],includeContext:false});
  const row=collectionAnswerSummary(docs,turn).rows[0];
  expect(row.page).toBe(2);
  expect(row.printedState).toBe('missing');
  expect(row.cells.map(cell=>cell.documentId)).toEqual([b.id,a.id]);
  expect(row.cells[0].part.coverage).toBe('not_present');
  expect(row.cells[1].direct?.values[0].sources[0].source).toBe(a.corpus.passages[1]);
});
test('qualified questions cannot be reduced to a bare field',async()=>{
  const a=await add([],'a',[['Application fee: INR 500','Rural applicants pay INR 250']]);
  const turn=runCollectionStep([a],{question:'What is the application fee for rural applicants?',documentIds:[a.id],includeContext:false});
  expect(collectionAnswerSummary([a],turn).rows[0].field).toBeNull();
});
test('shared quotations count distinct PDFs and preserve independent source identity',async()=>{
  const a=await add([],'a',[['Application fee: INR 500','Application fee: INR 500']]);
  const b=await add([a],'b',[['Application fee: INR 500']]);
  const docs=[a,b],turn=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id,b.id],includeContext:false});
  const row=collectionAnswerSummary(docs,turn).rows[0];
  expect(row.printedState).toBe('same_text');
  const quotes=collectionSharedAnswerQuotes(docs,row);
  expect(quotes).toHaveLength(1);
  expect(quotes[0].documents.map(group=>group.documentId)).toEqual([a.id,b.id]);
  expect(quotes[0].documents[1].sources[0]).toBe(b.corpus.passages[0]);
});
test('overview recomputes the saved question rather than trusting cached citations',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']]);
  const turn=runCollectionStep([a],{question:'Application fee?',documentIds:[a.id],includeContext:false});
  const tampered=structuredClone(turn);tampered.results[0].parts[0].answer.citations[0].text='forged';
  const summary=collectionAnswerSummary([a],tampered);
  expect(summary.rows[0].cells[0].part.answer.citations[0]).toBe(a.corpus.passages[0]);
  expect(summary.rows[0].printedState).toBe('single');
});
