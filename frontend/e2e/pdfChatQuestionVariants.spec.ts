import {test,expect} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionEvalCaseKey,serializeCollectionEvalLabels,type CollectionEvalCase} from '../src/pdfChatCollectionEvaluation';
import {evaluateVariantCase,evaluateVariants,validateVariantDraft,serializeVariantEvaluation,verifyVariantEvaluation,inspectVariantSource,variantPage} from '../src/pdfChatQuestionVariants';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:lines.length,processedPages:lines.length,missingPages:lines.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Application fee: INR 500','Private evidence wording'],['Eligibility: Class 12']]);
  const b=await add([a],'b',[['Application fee: INR 250']]);
  const docs=[a,b],target:CollectionEvalCase={documentId:a.id,question:'Application fee on page 1?',includeContext:false,label:'evidence',
    expected:[{source:a.corpus.passages[0]}],note:'Human label'};
  const second:CollectionEvalCase={documentId:b.id,question:'Unobtainium?',includeContext:false,label:'no_expected_match',expected:[],note:''};
  const labels=await serializeCollectionEvalLabels(docs,[target,second],signal());
  return {a,b,docs,target,second,labels};
}
function draft(target:CollectionEvalCase,question:string,includeContext=false){
  return {caseKey:collectionEvalCaseKey(target),question,includeContext,equivalenceConfirmed:true};
}
test('paired wording can expose regression without changing source scope or labels',async()=>{
  const f=await fixture(),row=evaluateVariantCase(f.docs,f.target,draft(f.target,'Unobtainium on page 1?'));
  expect(row.outcome).toBe('regressed');
  expect(row.baseline.correctCount).toBe(1);expect(row.alternative.correctCount).toBe(0);
  expect(row.expectedRemoved).toEqual([f.a.corpus.passages[0]]);
  expect(row.added).toEqual([]);expect(row.removed).toEqual([f.a.corpus.passages[0]]);
  const context=evaluateVariantCase(f.docs,f.target,draft(f.target,f.target.question,true));
  expect(context.outcome).toBe('unchanged');
  expect(context.shared).toEqual([f.a.corpus.passages[0]]);
});
test('equivalence consent, exact page and changed wording/context are mandatory',async()=>{
  const f=await fixture(),base=draft(f.target,'Application charge on page 1?');
  expect(()=>validateVariantDraft(f.docs,f.target,{...base,equivalenceConfirmed:false})).toThrow();
  for(const question of ['Application fee?','Application fee on page 2?','Application fee on page 1? Eligibility?','Application fee in revised notice on page 1?'])
    expect(()=>validateVariantDraft(f.docs,f.target,draft(f.target,question))).toThrow();
  expect(()=>validateVariantDraft(f.docs,f.target,draft(f.target,f.target.question))).toThrow();
  expect(()=>validateVariantDraft(f.docs,f.target,{...base,caseKey:collectionEvalCaseKey(f.second)})).toThrow();
});
test('paired no-match label reports unexpected returns separately',async()=>{
  const f=await fixture(),row=evaluateVariantCase(f.docs,f.second,draft(f.second,'Application fee?'));
  expect(row.baseline.outcome).toBe('expected_abstention');expect(row.alternative.outcome).toBe('unexpected_match');
  expect(row.outcome).toBe('regressed');expect(row.added).toEqual([f.b.corpus.passages[0]]);
});
test('paired evaluation aggregates exact labels and rejects duplicates, cancellation and forged report',async()=>{
  const f=await fixture(),drafts=[draft(f.target,f.target.question,true),draft(f.second,'Application fee?')];
  const progress:number[]=[];
  const result=await evaluateVariants(f.docs,f.labels,drafts,signal(),done=>progress.push(done),async()=>{});
  expect(progress).toEqual([0,1,2]);expect(result.outcomes).toEqual({improved:0,regressed:1,tradeoff:0,unchanged:1});
  expect(result.baseline.microRecall).toBe(1);expect(result.alternative.microRecall).toBe(1);
  expect(result.baseline.correctAbstentions).toBe(1);expect(result.alternative.correctAbstentions).toBe(0);
  expect(inspectVariantSource(f.docs,result,result.cases[0],f.a.corpus.passages[0])).toBe(f.a.corpus.passages[0]);
  expect(()=>inspectVariantSource(f.docs,result,result.cases[0],f.b.corpus.passages[0])).toThrow();
  expect(()=>serializeVariantEvaluation(result,false)).toThrow();
  const text=serializeVariantEvaluation(result,true);
  expect(text).not.toContain('Private evidence wording');expect(text).not.toContain('Human label');expect(text).not.toContain('INR 500');
  expect(await verifyVariantEvaluation(text,f.docs,f.labels,signal())).toEqual(result);
  const raw=JSON.parse(text);raw.outcomes.improved=99;
  await expect(verifyVariantEvaluation(JSON.stringify(raw,null,2)+'\n',f.docs,f.labels,signal())).rejects.toThrow();
  await expect(evaluateVariants(f.docs,f.labels,[drafts[0],drafts[0]],signal())).rejects.toThrow();
  const ctrl=new AbortController();await expect(evaluateVariants(f.docs,f.labels,drafts,ctrl.signal,done=>{if(done===1)ctrl.abort();},async()=>{})).rejects.toThrow();
  expect(variantPage([],1)).toEqual({pages:1,rows:[]});expect(()=>variantPage([],2)).toThrow();
});
