import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionOutline,filterCollectionOutline,collectionSectionFragments,collectionSectionSource,alignCollectionSections,
  collectionOutlinePage} from '../src/pdfChatCollectionOutline';
async function add(docs:CollectionDocument[],name:string,lines:string[]){
  return admitCollectionDocument(docs,new File([name],name+'.pdf'),new AbortController().signal,async()=>({
    passages:lines.map((text,i)=>({role:'original' as const,page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
  }));
}
const filter={kind:'all',keyword:'',sharedOnly:false} as const;
test('outline retains repeated physical heading candidates and distinct document keys',async()=>{
  const a=await add([],'a',['Preamble','Eligibility criteria','Class 12','Eligibility criteria','Other condition']);
  const b=await add([a],'b',['Eligibility criteria','Class 12','Payment instructions','Pay online']);
  const sides=collectionOutline([a,b],[a.id,b.id]);
  expect(sides[0].outline.beforeFirst).toEqual([a.corpus.passages[0]]);
  const rows=filterCollectionOutline(sides,filter);
  expect(rows).toHaveLength(4);
  expect(rows[0].repeatedHere).toBe(2);
  expect(rows[1].repeatedHere).toBe(2);
  expect(rows[0].counterpartDocuments).toEqual([b.id]);
  expect(rows[0].key).not.toBe(rows[1].key);
  expect(filterCollectionOutline(sides,{...filter,sharedOnly:true})).toHaveLength(3);
  expect(filterCollectionOutline(sides,{...filter,keyword:'payment'})).toHaveLength(1);
  expect(collectionSectionFragments([a,b],a.id,rows[0].key,'Class')).toEqual([a.corpus.passages[2]]);
  expect(collectionSectionSource([a,b],a.id,rows[0].key,a.corpus.passages[2])).toBe(a.corpus.passages[2]);
  expect(()=>collectionSectionSource([a,b],a.id,rows[0].key,a.corpus.passages[4])).toThrow();
  expect(()=>collectionSectionFragments([a,b],b.id,rows[0].key,'')).toThrow();
});
test('explicit section alignment is exact, bounded, and does not infer a revision direction',async()=>{
  const a=await add([],'a',['Eligibility criteria','Class 12','Age 18']);
  const b=await add([a],'b',['Eligibility criteria','Class 12','Age 21']);
  const docs=[a,b],sides=collectionOutline(docs,[a.id,b.id]);
  const left=sides[0].sections[0],right=sides[1].sections[0];
  const result=alignCollectionSections(docs,a.id,left.key,b.id,right.key);
  expect(result).toMatchObject({matched:2,leftUnpaired:1,rightUnpaired:1,repeatedText:false});
  expect(result.rows.map(row=>row.kind)).toEqual(['same','same','left_only','right_only']);
  expect(result.rows[0]).toMatchObject({left:a.corpus.passages[0],right:b.corpus.passages[0]});
  expect(alignCollectionSections(docs,b.id,right.key,a.id,left.key)).toMatchObject({matched:2,leftUnpaired:1,rightUnpaired:1});
  expect(()=>alignCollectionSections(docs,a.id,left.key,a.id,left.key)).toThrow();
});
test('different headings and very large candidate spans cannot be silently aligned',async()=>{
  const a=await add([],'a',['Eligibility criteria',...Array.from({length:161},(_,i)=>'Text '+i)]);
  const b=await add([a],'b',['Eligibility criteria','Class 12','Payment instructions','Pay online']);
  const docs=[a,b],sides=collectionOutline(docs,[a.id,b.id]);
  const left=sides[0].sections[0],right=sides[1].sections[0];
  expect(()=>alignCollectionSections(docs,a.id,left.key,b.id,right.key)).toThrow('budget');
  expect(()=>alignCollectionSections(docs,a.id,left.key,b.id,sides[1].sections[1].key)).toThrow();
  expect(collectionOutlinePage([],1)).toEqual({items:[],pages:1,first:0,last:0});
  expect(()=>collectionOutlinePage([],2)).toThrow();
});
