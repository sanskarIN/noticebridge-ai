import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {pinCollectionEvidence} from '../src/pdfChatCollectionReview';
import {sourceHistory,filterSourceHistory,sourceHistoryPage,validateSourceHistoryUse,sourceHistoryDraft} from '../src/pdfChatSourceHistory';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.map((text,i)=>({role:'original' as const,page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',['Application fee: INR 500','Eligibility: Class 12']);
  const b=await add([a],'b',['Application fee: INR 500']);
  const docs=[a,b],turns=[
    runCollectionStep(docs,{question:'Application fee? Eligibility?',documentIds:[b.id,a.id],includeContext:false}),
    runCollectionStep(docs,{question:'Application fee on page 1?',documentIds:[a.id],includeContext:true}),
    runCollectionStep(docs,{question:'Application fee?',documentIds:[b.id],includeContext:false}),
  ];
  const source=a.corpus.passages[0],reviews=pinCollectionEvidence(docs,[],a.id,source);
  return {a,b,docs,turns,source,reviews};
}
test('citation history isolates identical coordinates and text in other PDFs',async()=>{
  const {a,b,docs,turns,source,reviews}=await fixture();
  const history=sourceHistory(docs,turns,reviews,a.id,source);
  expect(history.uses.map(row=>[row.turn,row.part,row.rank])).toEqual([[0,0,1],[1,0,1]]);
  expect(history).toMatchObject({distinctTurns:2,strictUses:2,nearbyUses:0,annotation:{status:'unreviewed'}});
  const other=sourceHistory(docs,turns,reviews,b.id,b.corpus.passages[0]);
  expect(other.uses.map(row=>row.turn)).toEqual([0,2]);expect(other.annotation).toBeNull();
  expect(()=>sourceHistory(docs,turns,reviews,b.id,source)).toThrow();
});
test('history draft preserves explicit historical wording, page and context',async()=>{
  const {a,b,docs,turns,source,reviews}=await fixture(),history=sourceHistory(docs,turns,reviews,a.id,source);
  expect(sourceHistoryDraft(docs,turns,history,history.uses[0],'this_pdf')).toEqual({
    question:turns[0].results[0].parts[0].answer.question,documentIds:[a.id],includeContext:false,
  });
  expect(sourceHistoryDraft(docs,turns,history,history.uses[0],'original_selection').documentIds).toEqual([b.id,a.id]);
  expect(sourceHistoryDraft(docs,turns,history,history.uses[1],'this_pdf')).toEqual(turns[1].step);
  expect(validateSourceHistoryUse(docs,turns,history,history.uses[0])).toBe(turns[0]);
  expect(()=>validateSourceHistoryUse(docs,turns.slice(1),history,history.uses[0])).toThrow();
  expect(()=>validateSourceHistoryUse(docs,turns,history,{...history.uses[0]})).toThrow();
});
test('filter and pagination do not change stored citation identity',async()=>{
  const {a,docs,turns,source,reviews}=await fixture(),history=sourceHistory(docs,turns,reviews,a.id,source);
  expect(filterSourceHistory(history,'printed','page 1')).toEqual([history.uses[1]]);
  expect(filterSourceHistory(history,'nearby','')).toEqual([]);
  expect(filterSourceHistory(history,'all','never found')).toEqual([]);
  expect(sourceHistoryPage(history.uses,1).rows).toEqual(history.uses);
  expect(()=>sourceHistoryPage(history.uses,2)).toThrow();
  const empty=sourceHistory(docs,[],reviews,a.id,source);
  expect(empty.uses).toEqual([]);expect(empty.annotation?.source).toBe(source);
});
