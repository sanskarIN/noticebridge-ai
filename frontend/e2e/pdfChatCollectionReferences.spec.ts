import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionReferenceIndex,filterReferenceIndex,referenceIndexPage,inspectReferenceOccurrence,referenceTrails,referenceKey} from '../src/pdfChatCollectionReferences';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Clause 4.2(a) Eligibility','Applicants should consult Clause 4.2(a) and Section 9.',
    'See Clause 4.2(a) twice: Clause 4.2(a).'],['Annexure A Documents','Clause 4.2(a) Fee']]);
  const b=await add([a],'b',[['Clause 4.2(a) Other notice','See Annexure A and Rule 8.'],[]]);
  return {a,b,docs:[a,b]};
}
test('reference index separates repeated leading candidates from physical inline mentions',async()=>{
  const {a,b,docs}=await fixture(),index=collectionReferenceIndex(docs,[a.id,b.id]);
  const group=index.groups.find(row=>row.key==='clause:4.2(a)')!;
  expect(group).toMatchObject({state:'multiple_leading',documents:2,leadingCount:3,inlineCount:3,occurrences:6});
  expect(group.sides[0].inline.map(row=>row.source.ordinal)).toEqual([2,3,3]);
  expect(group.sides[0].leading.map(row=>row.source.page)).toEqual([1,2]);
  expect(index.groups.find(row=>row.key==='section:9')?.state).toBe('no_leading');
  expect(index.groups.find(row=>row.key==='annexure:a')?.state).toBe('single_leading');
  expect(index.documentCoverage[1].missingPages).toEqual([2]);
  expect(index.examinedFragments).toBe(7);
});
test('reference filters retain selected document identity and support shared keys',async()=>{
  const {a,b,docs}=await fixture(),index=collectionReferenceIndex(docs,[b.id,a.id]);
  const filter={kind:'all' as const,state:'all' as const,documentId:'all',text:'',sharedOnly:true};
  expect(filterReferenceIndex(index,filter).map(row=>row.key)).toEqual(['clause:4.2(a)','annexure:a']);
  expect(filterReferenceIndex(index,{...filter,kind:'clause',text:'4.2'})).toHaveLength(1);
  expect(filterReferenceIndex(index,{...filter,sharedOnly:false,state:'no_leading',documentId:b.id}).map(row=>row.key)).toEqual(['rule:8']);
  expect(()=>filterReferenceIndex(index,{...filter,documentId:'fake'})).toThrow();
  expect(referenceIndexPage([],1)).toEqual({rows:[],pages:1,first:0,last:0});
  expect(()=>referenceIndexPage([],2)).toThrow();
});
test('one-hop trail excludes the exact source, keeps repeated occurrences and other PDFs separate',async()=>{
  const {a,b,docs}=await fixture(),index=collectionReferenceIndex(docs,[a.id,b.id]);
  const source=a.corpus.passages[1],trails=referenceTrails(docs,index,a.id,source);
  expect(trails.map(row=>row.printed)).toEqual(['Clause 4.2(a)','Section 9']);
  const clause=trails[0];
  expect(clause.sameDocument.map(row=>row.leading)).toEqual([true,true,false,false]);
  expect(clause.sameDocument.every(row=>row.source!==source)).toBe(true);
  expect(clause.otherDocuments.map(row=>row.documentId)).toEqual([b.id]);
  expect(trails[1].sameDocument).toEqual([]);
  expect(trails[1].otherDocuments).toEqual([]);
  const local=collectionReferenceIndex(docs,[a.id]);
  expect(referenceTrails(docs,local,a.id,source)[0].otherDocuments).toEqual([]);
  expect(()=>referenceTrails(docs,local,b.id,b.corpus.passages[0])).toThrow();
});
test('source inspection is bound to exact occurrence and live source object',async()=>{
  const {a,b,docs}=await fixture(),index=collectionReferenceIndex(docs,[a.id,b.id]);
  const group=index.groups.find(row=>row.key==='clause:4.2(a)')!,item=group.sides[0].inline[0];
  expect(inspectReferenceOccurrence(docs,index,group,item)).toBe(item.source);
  expect(item.source.text.slice(item.range.start,item.range.end)).toBe(item.printed);
  expect(()=>inspectReferenceOccurrence(docs,index,group,{...item})).toThrow();
  expect(()=>inspectReferenceOccurrence(docs,index,{...group},item)).toThrow();
  expect(()=>inspectReferenceOccurrence([b],index,group,item)).toThrow();
  expect(()=>referenceTrails(docs,index,a.id,{...item.source})).toThrow();
});
test('invalid identifiers are not invented or expanded from nearby lines',async()=>{
  const a=await add([],'a',[['Clause','4.2(a)','Section abc','Annexure B','Refer to Rule 12345','Rule 3.1(b)']]);
  const index=collectionReferenceIndex([a],[a.id]);
  expect(index.groups.map(row=>row.key)).toEqual(['rule:3.1(b)','annexure:b']);
  expect(()=>referenceKey({kind:'clause',identifier:'A'})).toThrow();
  expect(()=>collectionReferenceIndex([a],[a.id,a.id])).toThrow();
});
