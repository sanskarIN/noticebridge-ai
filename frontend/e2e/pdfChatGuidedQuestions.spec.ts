import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {GUIDE_OPTIONS,guideInventory,filterGuideOptions,guidedQuestionText,guidedStep,prepareGuidedDraft,guidePageAvailability,moveGuidedPart,type GuidedPart} from '../src/pdfChatGuidedQuestions';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
const template=(id:'application_fee'|'eligibility'|'summary',page:number|null=null):GuidedPart=>({kind:'template',id,page});
test('guided topics create independent exact field questions with distinct physical scopes',async()=>{
  const a=await add([],'a',[['Application fee: INR 500'],['Eligibility: Class 12']]);
  const b=await add([a],'b',[['Application fee: INR 250']]);
  const docs=[a,b],parts=[template('application_fee',1),template('eligibility',2)];
  expect(guidedQuestionText(parts)).toBe('Application fee on page 1? Eligibility on page 2?');
  const draft={parts,documentIds:[b.id,a.id],includeContext:false},preview=prepareGuidedDraft(docs,draft,[]);
  expect(preview.step.documentIds).toEqual([a.id,b.id]);expect(preview.searches).toBe(4);expect(preview.unavailable).toBe(1);
  const actual=runCollectionStep(docs,guidedStep(docs,draft,[]));
  expect(actual.results[0].parts.map(row=>row.answer.citations[0].text)).toEqual(['Application fee: INR 500','Eligibility: Class 12']);
  expect(actual.results[1].parts[1].coverage).toBe('not_present');
});
test('guide inventory reports only recognized printed labels, not inferred absence',async()=>{
  const a=await add([],'a',[['Application fee: INR 500','Application fee: INR 350'],['Eligibility: Class 12']]);
  const b=await add([a],'b',[['Fee should be paid before applying.']]);
  const docs=[a,b],inventory=guideInventory(docs,[a.id,b.id]);
  expect(inventory.find(row=>row.id==='application_fee')).toEqual({id:'application_fee',documentsWithField:1,occurrences:2,pages:[1]});
  expect(filterGuideOptions('payment','fee',true,inventory).map(row=>row.id)).toEqual(['application_fee']);
  expect(filterGuideOptions('overview','',false,inventory)).toHaveLength(4);
  expect(new Set(GUIDE_OPTIONS.map(row=>row.id)).size).toBe(GUIDE_OPTIONS.length);
  expect(guidePageAvailability(docs,[a.id,b.id],2).map(row=>row.coverage)).toEqual(['some_text','not_present']);
});
test('printed references and summary preserve explicit scope and reject injection',()=>{
  expect(guidedQuestionText([{kind:'reference',referenceKind:'clause',identifier:'4.2(a)',page:3},template('summary')]))
    .toBe('Show clause 4.2(a) on page 3? Summarize this notice?');
  for(const identifier of ['4? Eligibility','4 on page 3','4 and Section 9','', '4; fee'])
    expect(()=>guidedQuestionText([{kind:'reference',referenceKind:'clause',identifier,page:null}])).toThrow();
  expect(()=>guidedQuestionText([template('application_fee'),template('application_fee')])).toThrow();
  expect(()=>guidedQuestionText([template('eligibility',81)])).toThrow();
  expect(()=>guidedQuestionText([])).toThrow();
  const rows=[template('application_fee'),template('eligibility')];
  expect(moveGuidedPart(rows,1,-1)).toEqual([...rows].reverse());expect(()=>moveGuidedPart(rows,0,-1)).toThrow();
});
