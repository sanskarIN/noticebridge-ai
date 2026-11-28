import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {pinCollectionEvidence,updateCollectionEvidence,collectionReviewKey} from '../src/pdfChatCollectionReview';
import {buildEvidenceUsage,buildEvidenceUsageAsync,filterEvidenceUsage,usagePage,inspectUsageSource,usageTurn,exportEvidenceUsage,verifyEvidenceUsage} from '../src/pdfChatEvidenceUsage';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.map((text,i)=>({role:'original',page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:[],limitedPages:[],limited:false,
  }));
}
async function fixture(){
  const a=await add([],'a',['Application fee: INR 500','Private extra line']),b=await add([a],'b',['Application fee: INR 500','Eligibility: Class 12']);
  const docs=[a,b],ask=(question:string,ids:string[])=>runCollectionStep(docs,{question,documentIds:ids,includeContext:false});
  const turns=[ask('Application fee?',[a.id,b.id]),ask('Application fee?',[a.id]),ask('Unobtainium?',[b.id])];
  let reviews=pinCollectionEvidence(docs,[],a.id,a.corpus.passages[0]);
  reviews=updateCollectionEvidence(reviews,collectionReviewKey(a.id,a.corpus.passages[0]),{status:'reviewed_manually',note:'Private note'});
  reviews=pinCollectionEvidence(docs,reviews,a.id,a.corpus.passages[1]);
  return {a,b,docs,turns,reviews};
}
test('reverse index isolates PDF coordinates and counts distinct historical turns',async()=>{
  const f=await fixture(),value=buildEvidenceUsage(f.docs,f.turns,f.reviews);
  expect(value).toMatchObject({turns:3,searches:4,unmatched:1,citations:3,distinctCitations:2,reusedFragments:1,uncitedAnnotations:1});
  const [first,second,third]=value.rows;
  expect(first.documentId).toBe(f.a.id);expect(first.turnCount).toBe(2);
  expect(first.uses.map(use=>use.turnIndex)).toEqual([0,1]);expect(first.annotation?.status).toBe('reviewed_manually');
  expect(second.documentId).toBe(f.b.id);expect(second.source.text).toBe(first.source.text);
  expect(third.source.text).toBe('Private extra line');expect(third.uses).toEqual([]);
  expect(value.documents[0]).toMatchObject({distinctCitations:1,citations:2,annotatedCitations:1,uncitedAnnotations:1,searches:2,unmatched:0});
  expect(inspectUsageSource(f.docs,value,first)).toBe(f.a.corpus.passages[0]);
  expect(usageTurn(f.turns,value,first,first.uses[1])).toBe(1);
  expect(()=>inspectUsageSource(f.docs,value,{...first})).toThrow();
  expect(()=>usageTurn(f.turns,value,first,{...first.uses[0]})).toThrow();
});
test('filters distinguish reuse from annotation status and question text',async()=>{
  const f=await fixture(),value=buildEvidenceUsage(f.docs,f.turns,f.reviews);
  const all={documentId:'all',usage:'all' as const,annotation:'all' as const,channel:'all' as const,text:''};
  expect(filterEvidenceUsage(value,{...all,usage:'reused'})).toEqual([value.rows[0]]);
  expect(filterEvidenceUsage(value,{...all,annotation:'unsaved'})).toEqual([value.rows[1]]);
  expect(filterEvidenceUsage(value,{...all,usage:'uncited'})).toEqual([value.rows[2]]);
  expect(filterEvidenceUsage(value,{...all,text:'fee?'})).toHaveLength(2);
  expect(filterEvidenceUsage(value,{...all,documentId:f.b.id,channel:'nearby'})).toEqual([]);
  expect(()=>filterEvidenceUsage(value,{...all,documentId:'unknown'})).toThrow();
  expect(usagePage([],1)).toEqual({rows:[],pages:1,first:0,last:0});
  expect(()=>usagePage([],2)).toThrow();
});
test('replay rejects changed answer arrays and supports abort without partial publication',async()=>{
  const f=await fixture(),bad=structuredClone(f.turns);
  bad[0].results[0].parts[0].answer.citations=[];
  expect(()=>buildEvidenceUsage(f.docs,bad,f.reviews)).toThrow();
  const progress:number[]=[];
  const value=await buildEvidenceUsageAsync(f.docs,f.turns,f.reviews,signal(),done=>progress.push(done),async()=>{});
  expect(progress).toEqual([0,1,2,3]);expect(value).toEqual(buildEvidenceUsage(f.docs,f.turns,f.reviews));
  const ctrl=new AbortController();
  await expect(buildEvidenceUsageAsync(f.docs,f.turns,f.reviews,ctrl.signal,done=>{if(done===1)ctrl.abort();},async()=>{})).rejects.toThrow();
});
test('coordinate-only usage export binds exact saved steps, status and snapshot but omits notes',async()=>{
  const f=await fixture();
  await expect(exportEvidenceUsage(f.docs,f.turns,f.reviews,false,signal())).rejects.toThrow();
  const report=await exportEvidenceUsage(f.docs,f.turns,f.reviews,true,signal());
  expect(report).not.toContain('Private note');expect(report).not.toContain('INR 500');expect(report).not.toContain('Private extra line');
  expect(await verifyEvidenceUsage(report,f.docs,f.turns,f.reviews,signal())).toEqual(buildEvidenceUsage(f.docs,f.turns,f.reviews));
  await expect(verifyEvidenceUsage(report,f.docs,f.turns.slice(1),f.reviews,signal())).rejects.toThrow();
  await expect(verifyEvidenceUsage(report,f.docs,f.turns,[],signal())).rejects.toThrow();
  const raw=JSON.parse(report);raw.rows[0].uses[0].rank=9;
  await expect(verifyEvidenceUsage(JSON.stringify(raw,null,2)+'\n',f.docs,f.turns,f.reviews,signal())).rejects.toThrow();
});
test('annotation-only work remains usable with no questions',async()=>{
  const f=await fixture(),value=buildEvidenceUsage(f.docs,[],f.reviews);
  expect(value.rows).toHaveLength(2);expect(value.uncitedAnnotations).toBe(2);
  expect(value.citations).toBe(0);expect(value.reusedFragments).toBe(0);
});
