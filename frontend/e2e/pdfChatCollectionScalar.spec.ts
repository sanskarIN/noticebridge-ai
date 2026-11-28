import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionScalarAnalysis,explainScalarPair,inspectScalarSource} from '../src/pdfChatCollectionScalar';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][],limited=false){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited,limitedPages:[],
  }));
}
const turn=(docs:CollectionDocument[],question='Application fee?')=>runCollectionStep(docs,{question,documentIds:docs.map(doc=>doc.id),includeContext:false});
test('exact decimal minor units and neutral document order are preserved',async()=>{
  const a=await add([],'a',[['Application fee: INR 1,000.10']]),b=await add([a],'b',[['Application fee: INR 350.05']]),
    c=await add([a,b],'c',[['Application fee: INR 1000.10']]);
  const docs=[a,b,c],result=collectionScalarAnalysis(docs,turn(docs),0)!;
  expect(result.kind).toBe('money');expect(result.sides.every(side=>side.status==='available')).toBe(true);
  expect(result.pairs).toEqual([
    {left:a.id,right:b.id,status:'available',kind:'money',currency:'INR',difference:-65005n},
    {left:a.id,right:c.id,status:'available',kind:'money',currency:'INR',difference:0n},
    {left:b.id,right:c.id,status:'available',kind:'money',currency:'INR',difference:65005n},
  ]);
  expect(explainScalarPair(result.pairs[0])).toContain('INR 650.05 lower');
  expect(explainScalarPair(result.pairs[1])).toContain('same numeric value');
  const first=result.sides[0];
  if(first.status!=='available')throw Error('fixture');
  expect(inspectScalarSource(docs,result,first,first.source)).toBe(a.corpus.passages[0]);
  expect(()=>inspectScalarSource(docs,result,{...first},first.source)).toThrow();
});
test('different currency notation never implies conversion or matching amount',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']]),b=await add([a],'b',[['Application fee: USD 5']]),
    c=await add([a,b],'c',[['Application fee: Rs. 500']]);
  const docs=[a,b,c],result=collectionScalarAnalysis(docs,turn(docs),0)!;
  expect(result.pairs.every(pair=>pair.status==='unavailable'&&pair.reason==='different_currency')).toBe(true);
});
test('calendar arithmetic is exact, not inclusive or inferred extension',async()=>{
  const a=await add([],'a',[['Application deadline: 28 February 2028']]),b=await add([a],'b',[['Application deadline: 2028-03-01']]);
  const docs=[a,b],result=collectionScalarAnalysis(docs,turn(docs,'Application deadline?'),0)!;
  expect(result.pairs[0]).toMatchObject({status:'available',kind:'date',difference:2});
  expect(explainScalarPair(result.pairs[0])).toContain('2 calendar days later');
});
test('coverage, missing, multiple, qualified and unrecognized values remain unavailable',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']],true);
  const b=await add([a],'b',[['Eligibility: Class 12']]);
  const c=await add([a,b],'c',[['Application fee: INR 500','Application fee: INR 250']]);
  const d=await add([a,b,c],'d',[['Application fee: INR 500','Application fee is waived for some applicants']]);
  const e=await add([a,b,c,d],'e',[['Application fee: 500 to 700']]);
  const f=await add([a,b,c,d,e],'f',[['Application fee: INR 500']]);
  const docs=[a,b,c,d,e,f],result=collectionScalarAnalysis(docs,turn(docs),0)!;
  expect(result.sides.map(side=>side.status==='available'?'available':side.reason))
    .toEqual(['coverage','missing_value','multiple_values','possible_conditions','unrecognized_value','available']);
  expect(result.pairs.every(pair=>pair.status==='unavailable')).toBe(true);
  expect(result.pairs).toHaveLength(15);
});
test('physical page restriction and non-scalar qualified questions cannot broaden arithmetic',async()=>{
  const a=await add([],'a',[['Application fee: INR 500'],['Application fee: INR 100']]);
  const b=await add([a],'b',[['Application fee: INR 350']]);
  const docs=[a,b],result=collectionScalarAnalysis(docs,turn(docs,'Application fee on page 2?'),0)!;
  expect(result.page).toBe(2);
  expect(result.sides[0]).toMatchObject({status:'available',kind:'money',value:{minor:10000n}});
  expect(result.sides[1]).toMatchObject({status:'unavailable',reason:'coverage'});
  expect(collectionScalarAnalysis(docs,turn(docs,'Application fee for rural applicants?'),0)).toBeNull();
  expect(collectionScalarAnalysis(docs,turn(docs,'Eligibility?'),0)).toBeNull();
  expect(()=>collectionScalarAnalysis(docs,turn(docs),1)).toThrow();
});
