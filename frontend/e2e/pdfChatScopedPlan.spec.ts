import {test,expect} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {makeScopedDraft,editScopedDraft,moveScopedDraft,removeScopedDraft,validateScopedPlan,runScopedPlan,
  applyScopedPlan,exportScopedPlan,importScopedPlan} from '../src/pdfChatScopedPlan';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,text:string){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:[{role:'original',page:1,ordinal:1,text}],pageCount:1,processedPages:1,missingPages:[],limitedPages:[],limited:false,
  }));
}
async function fixture(){
  const a=await add([],'a','Application fee: INR 500'),b=await add([a],'b','Eligibility: Class 12');
  const docs=[a,b],rows=[makeScopedDraft(1,[a.id],'Application fee?'),makeScopedDraft(2,[b.id],'Eligibility?',true)];
  return {a,b,docs,rows};
}
test('mixed per-question selections and context flags run atomically in draft order',async()=>{
  const {a,b,docs,rows}=await fixture(),history:ReturnType<typeof runCollectionStep>[]=[];
  const validation=validateScopedPlan(docs,rows,history);
  expect(validation).toMatchObject({ready:true,searches:2,capacity:24});
  const stage=await runScopedPlan(docs,rows,history,signal());
  expect(stage.batch.result.turns.map(turn=>turn.results.map(side=>side.documentId))).toEqual([[a.id],[b.id]]);
  expect(stage.batch.result.turns.map(turn=>turn.step.includeContext)).toEqual([false,true]);
  expect(history).toEqual([]);
  expect(applyScopedPlan(docs,rows,history,stage)).toEqual(stage.batch.result.turns);
  expect(()=>applyScopedPlan(docs,[...rows],history,stage)).toThrow();
  expect(()=>applyScopedPlan(docs,rows,[...history],stage)).toThrow();
});
test('invalid row diagnostics preserve the draft and distinguish duplicate exact steps',async()=>{
  const {a,b,docs,rows}=await fixture();
  const invalid=[...rows,makeScopedDraft(3,[a.id],'Application fee?'),makeScopedDraft(4,[],'Eligibility?'),
    makeScopedDraft(5,[b.id],'Application fee on page 81?'),makeScopedDraft(6,[a.id],'')];
  const checked=validateScopedPlan(docs,invalid,[]);
  expect(checked.ready).toBe(false);
  expect(checked.issues).toEqual([{key:3,reason:'duplicate'},{key:4,reason:'selection'},{key:5,reason:'question'},{key:6,reason:'empty'}]);
  expect(validateScopedPlan(docs,[...rows,makeScopedDraft(3,[b.id],'Application fee?')],[]).ready).toBe(true);
  await expect(runScopedPlan(docs,invalid,[],signal())).rejects.toThrow();
});
test('draft moves and edits do not mutate source rows',async()=>{
  const {a,b,rows}=await fixture();
  expect(moveScopedDraft(rows,2,-1).map(row=>row.key)).toEqual([2,1]);
  expect(removeScopedDraft(rows,1)).toEqual([rows[1]]);
  const changed=editScopedDraft(rows,1,{question:'Eligibility?',documentIds:[b.id],includeContext:true});
  expect(changed[0]).toMatchObject({key:1,question:'Eligibility?',documentIds:[b.id],includeContext:true});
  expect(rows[0].documentIds).toEqual([a.id]);
  expect(()=>moveScopedDraft(rows,1,-1)).toThrow();
  expect(()=>editScopedDraft(rows,999,{question:'No'})).toThrow();
});
test('canonical scoped plan exports no citations and imports only with exact PDF set',async()=>{
  const {a,docs,rows}=await fixture();
  expect(()=>exportScopedPlan(docs,rows,false)).toThrow();
  const text=exportScopedPlan(docs,rows,true);
  expect(text).not.toContain('INR 500');expect(text).not.toContain('private.pdf');
  const imported=importScopedPlan([...docs].reverse(),text,10);
  expect(imported.map(row=>row.key)).toEqual([10,11]);
  expect(imported.map(({key,...row})=>row)).toEqual(rows.map(({key,...row})=>row));
  expect(()=>importScopedPlan([a],text,1)).toThrow();
  expect(()=>importScopedPlan(docs,text.trim(),1)).toThrow();
});
test('capacity and cancellation prevent partial history application',async()=>{
  const {docs,rows}=await fixture();
  const history=Array.from({length:23},()=>runCollectionStep(docs,{question:rows[0].question,documentIds:rows[0].documentIds,includeContext:false}));
  expect(validateScopedPlan(docs,rows,history).ready).toBe(false);
  await expect(runScopedPlan(docs,rows,history,signal())).rejects.toThrow();
  const ctrl=new AbortController(),empty:typeof history=[];
  await expect(runScopedPlan(docs,rows,empty,ctrl.signal,progress=>{if(progress.completed===1)ctrl.abort();},async()=>{})).rejects.toThrow();
  expect(empty).toEqual([]);
});
