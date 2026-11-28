import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {broadCollectionIntent,collectionBrief,briefPage,inspectBriefSource,briefFieldDraft} from '../src/pdfChatCollectionBrief';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Important dates','Application deadline: 20 December 2026','Applicants must submit a certificate.',
    'Clause 4: Eligibility'],['Application fee: INR 500','Applicants must not submit duplicate forms.','See Clause 4.']]);
  const b=await add([a],'b',[['Application fee: INR 350'],[]]);
  return {a,b,docs:[a,b]};
}
function ask(docs:CollectionDocument[],id:string,question:string,includeContext=false){
  return runCollectionStep(docs,{question,documentIds:[id],includeContext}).results[0].parts[0];
}
test('summary intent is explicit and never strips substantive qualifiers',()=>{
  for(const question of ['Summarize this notice?','Summarise the document','What is this PDF about?','Give me a summary of this PDF','List key details on page 2?'])
    expect(broadCollectionIntent(question)).toEqual({kind:'summary'});
  for(const question of ['Summarize rural eligibility','What are the requirements for rural applicants?','Application fee?','What does Clause 4 require for students?'])
    expect(broadCollectionIntent(question)).toBeNull();
  expect(broadCollectionIntent('What must I not do?')).toEqual({kind:'requirements',requirement:'prohibited'});
  expect(broadCollectionIntent('Show Clause 4 and Section 9?')).toEqual({kind:'references',references:[{kind:'clause',identifier:'4'},{kind:'section',identifier:'9'}]});
});
test('source-linked summary keeps all recognized candidate categories and exact physical identities',async()=>{
  const {a,b,docs}=await fixture(),part=ask(docs,a.id,'Summarize this notice?'),brief=collectionBrief(docs,a.id,part,false)!;
  expect(brief.fields.map(field=>field.definition.id)).toEqual(['application_deadline','application_fee']);
  expect(brief.headings.map(row=>row.source.text)).toEqual(['Important dates','Clause 4: Eligibility']);
  expect(brief.requirements.map(row=>row.source.text)).toEqual(['Applicants must submit a certificate.','Applicants must not submit duplicate forms.']);
  expect(brief.requirementCounts.mandatory).toBe(1);expect(brief.requirementCounts.prohibited).toBe(1);
  expect(brief.sample.map(source=>source.page)).toEqual([1,2]);
  const source=brief.fields[0].values[0].citations[0].source;
  expect(inspectBriefSource(docs,brief,source)).toBe(source);
  expect(()=>inspectBriefSource(docs,brief,b.corpus.passages[0])).toThrow();
  expect(()=>inspectBriefSource(docs,brief,{...source})).toThrow();
  expect(briefFieldDraft(docs,brief,brief.fields[1],false)).toEqual({question:'Application fee?',documentIds:[a.id],includeContext:false});
  expect(part.answer.citations).toEqual(ask(docs,a.id,'Summarize this notice?').answer.citations);
});
test('page scoped summary does not silently broaden to other native pages',async()=>{
  const {a,b,docs}=await fixture(),part=ask(docs,a.id,'Summarize this PDF on page 2?');
  const brief=collectionBrief(docs,a.id,part,false)!;
  expect(brief.physicalPage).toBe(2);expect(brief.fragments).toBe(3);
  expect(brief.fields.map(row=>row.definition.id)).toEqual(['application_fee']);
  expect(briefFieldDraft(docs,brief,brief.fields[0],true).question).toBe('Application fee on page 2?');
  expect(()=>inspectBriefSource(docs,brief,a.corpus.passages[0])).toThrow();
  const empty=collectionBrief(docs,b.id,ask(docs,b.id,'Summarize this PDF on page 2?'),false)!;
  expect(empty.coverage).toBe('no_indexed_text');expect(empty.fragments).toBe(0);expect(empty.sample).toEqual([]);
});
test('requirement and reference views remain separate from strict answer and from each other',async()=>{
  const {a,docs}=await fixture();
  const brief=collectionBrief(docs,a.id,ask(docs,a.id,'What must I not do?'),false)!;
  expect(brief.fields).toEqual([]);expect(brief.requirements).toHaveLength(1);
  expect(brief.requirements[0].kinds).toEqual(['prohibited']);
  const refs=collectionBrief(docs,a.id,ask(docs,a.id,'Show Clause 4?'),false)!;
  expect(refs.requirements).toEqual([]);expect(refs.references[0].hits.map(hit=>hit.source.page)).toEqual([1,2]);
  expect(refs.references[0].hits.map(hit=>hit.startsWithReference)).toEqual([true,false]);
});
test('orientation samples bounded evenly across indexed pages and reject stale saved parts',async()=>{
  const a=await add([],'a',Array.from({length:30},(_,i)=>['Opening fragment '+(i+1)])),docs=[a];
  const part=ask(docs,a.id,'Summarize the PDF?'),brief=collectionBrief(docs,a.id,part,false)!;
  expect(brief.sampledPages).toBe(12);expect(brief.scopedPages).toBe(30);expect(brief.sampleLimited).toBe(true);
  expect(brief.sample[0].page).toBe(1);expect(brief.sample.at(-1)?.page).toBe(30);
  expect(briefPage(brief.sample,2).rows).toHaveLength(4);
  expect(()=>briefPage([],2)).toThrow();
  expect(()=>collectionBrief(docs,a.id,{...part,coverage:'partial'},false)).toThrow();
});
