import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {previewCollectionDraft,draftFieldLabel} from '../src/pdfChatCollectionComposer';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][],limited=false){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited,limitedPages:[],
  }));
}
test('preview shares actual planner, document ordering and physical page coverage',async()=>{
  const a=await add([],'a',[['Application fee: INR 500'],['Eligibility: Class 12']]);
  const b=await add([a],'b',[['Application fee: INR 350']]);
  const docs=[a,b],preview=previewCollectionDraft(docs,'Application fee? Eligibility on page 2?',[b.id,a.id],false,[]);
  expect(preview.step.documentIds).toEqual([a.id,b.id]);
  expect(preview.searches).toBe(4);expect(preview.unavailable).toBe(1);
  expect(preview.parts[0].field).toBe('application_fee');
  expect(preview.parts[1].page).toBe(2);
  expect(preview.parts[1].scopes).toEqual([{id:a.id,coverage:'some_text',fragments:1},{id:b.id,coverage:'not_present',fragments:0}]);
  const run=runCollectionStep(docs,preview.step);
  for(const [i,result] of run.results.entries())for(const [j,part] of result.parts.entries()){
    expect(part.coverage).toBe(preview.parts[j].scopes[i].coverage);
    expect(part.answer.question).toBe(preview.parts[j].question);
  }
});
test('preview recognizes broad inspection without claiming matching evidence',async()=>{
  const a=await add([],'a',[['Eligibility: Class 12'],[]],true);
  const result=previewCollectionDraft([a],'Summarize this notice?',[a.id],true,[]);
  expect(result.parts[0].broad).toEqual({kind:'summary'});
  expect(result.parts[0].scopes[0].coverage).toBe('partial');
  expect(result.partial).toBe(1);expect(result.remainingTurns).toBe(24);
  expect(draftFieldLabel('application_fee')).toBe('Application fee');expect(draftFieldLabel(null)).toBeNull();
});
test('repeated turns compare exact selection, wording and context settings',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']]),b=await add([a],'b',[['Application fee: INR 200']]);
  const docs=[a,b],first=previewCollectionDraft(docs,'Application fee?',[a.id,b.id],false,[]);
  const history=[runCollectionStep(docs,first.step)];
  expect(previewCollectionDraft(docs,' Application fee? ',[b.id,a.id],false,history).repeatTurns).toEqual([1]);
  expect(previewCollectionDraft(docs,'Application fee?',[a.id,b.id],true,history).repeatTurns).toEqual([]);
  expect(previewCollectionDraft(docs,'Application fee?',[a.id],false,history).repeatTurns).toEqual([]);
  expect(previewCollectionDraft(docs,'Application fee',[a.id,b.id],false,history).repeatTurns).toEqual([]);
});
test('invalid routing, selections, page ranges and excess parts fail closed',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']]);
  for(const q of ['','What is the fee in the revised PDF?','fee on page 2-3','fee on page 0','fee on page 1 and 2','a?b?c?d?e?'])
    expect(()=>previewCollectionDraft([a],q,[a.id],false,[])).toThrow();
  for(const selected of [[],[a.id,a.id],['f'.repeat(64)]])
    expect(()=>previewCollectionDraft([a],'fee',selected,false,[])).toThrow();
});
test('strict term budget is visible without blocking a valid request',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']]);
  const result=previewCollectionDraft([a],'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec',[a.id],false,[]);
  expect(result.parts[0].terms.length).toBeGreaterThan(16);
  expect(result.parts[0].strictTermBudget).toBe(false);
  expect(runCollectionStep([a],result.step).results[0].parts[0].answer.kind).toBe('insufficient');
});
