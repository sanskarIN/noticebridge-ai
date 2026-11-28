import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {compareSavedParts,filterTurnDiff,turnDiffPage,inspectTurnDiff,exportTurnDifference,verifyTurnDifference} from '../src/pdfChatTurnDifference';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Application fee: INR 500'],['Eligibility: Class 12']]);
  const b=await add([a],'b',[['Application fee: INR 500']]);
  const docs=[a,b],ask=(question:string,documentIds:string[],includeContext=false)=>runCollectionStep(docs,{question,documentIds,includeContext});
  const turns=[ask('Application fee? Eligibility?',[a.id,b.id]),ask('Application fee?',[a.id],true),ask('Eligibility on page 2?',[a.id])];
  return {a,b,docs,turns};
}
const ptr=(turn:number,part=0)=>({turn,part});
test('one-sided PDF selection never counts as evidence loss in common sources',async()=>{
  const f=await fixture(),result=compareSavedParts(f.docs,f.turns,ptr(0),ptr(1));
  expect(result.sameDocumentSet).toBe(false);expect(result.sameContext).toBe(false);
  expect(result.commonDocuments).toBe(1);expect(result.shared).toBe(1);
  expect(result.leftOnly).toBe(0);expect(result.rightOnly).toBe(0);
  expect(result.documents[1].state).toBe('left_only');
  expect(result.documents[1].leftOnly).toBe(1);expect(result.documents[1].right).toBeNull();
  expect(result.documents[0].rows[0].source).toBe(f.a.corpus.passages[0]);
  expect(inspectTurnDiff(f.docs,result,result.documents[0],result.documents[0].rows[0])).toBe(f.a.corpus.passages[0]);
});
test('different parts and physical page scopes remain explicit',async()=>{
  const f=await fixture(),result=compareSavedParts(f.docs,f.turns,ptr(0,0),ptr(2));
  expect(result.sameWording).toBe(false);expect(result.samePhysicalPage).toBe(false);
  expect(result.leftOnly).toBe(1);expect(result.rightOnly).toBe(1);expect(result.shared).toBe(0);
  const row=result.documents[0];
  expect(filterTurnDiff(row,'left_only')[0].source.page).toBe(1);
  expect(filterTurnDiff(row,'right_only')[0].source.page).toBe(2);
  expect(filterTurnDiff(row,'shared')).toEqual([]);
  expect(turnDiffPage(row.rows,1).rows).toHaveLength(2);
  expect(()=>turnDiffPage(row.rows,2)).toThrow();
  expect(()=>inspectTurnDiff(f.docs,result,row,{...row.rows[0]})).toThrow();
});
test('two parts of one turn are valid comparisons, identical pointers are not',async()=>{
  const f=await fixture(),value=compareSavedParts(f.docs,f.turns,ptr(0),ptr(0,1));
  expect(value.commonDocuments).toBe(2);expect(value.leftOnly).toBe(2);expect(value.rightOnly).toBe(1);
  expect(value.documents[1].right?.kind).toBe('insufficient');
  expect(()=>compareSavedParts(f.docs,f.turns,ptr(0),ptr(0))).toThrow();
  expect(()=>compareSavedParts(f.docs,f.turns,ptr(0,9),ptr(1))).toThrow();
});
test('coordinate-only comparison report replays exact historical positions and steps',async()=>{
  const f=await fixture(),left=ptr(0),right=ptr(2);
  await expect(exportTurnDifference(f.docs,f.turns,left,right,false,signal())).rejects.toThrow();
  const text=await exportTurnDifference(f.docs,f.turns,left,right,true,signal());
  expect(text).not.toContain('INR 500');expect(text).not.toContain('Class 12');expect(text).not.toContain('private.pdf');
  expect(await verifyTurnDifference(text,f.docs,f.turns,signal())).toEqual(compareSavedParts(f.docs,f.turns,left,right));
  const raw=JSON.parse(text);raw.shared=99;
  await expect(verifyTurnDifference(JSON.stringify(raw,null,2)+'\n',f.docs,f.turns,signal())).rejects.toThrow();
  await expect(verifyTurnDifference(text,f.docs,[...f.turns].reverse(),signal())).rejects.toThrow();
  const bad=structuredClone(f.turns);bad[0].results[0].parts[0].answer.citations=[];
  expect(()=>compareSavedParts(f.docs,bad,left,right)).toThrow();
});
