import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {parseBooleanEvidenceQuery,searchBooleanEvidence,booleanResultPage,inspectBooleanHit} from '../src/pdfChatBooleanEvidence';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Application fee: INR 500 for rural applicants','Application fee: INR 350 refundable',
    'Registration fee: INR 200','rural applicants','Application fee'],['Application fee: INR 100 for rural applicants']]);
  const b=await add([a],'b',[['Application fee: INR 500 for rural applicants','Registration fee: INR 200'],[]]);
  return {a,b,docs:[a,b]};
}
test('explicit precedence and grouped alternatives produce literal independent fragment matches',async()=>{
  const f=await fixture();
  const query={documentIds:[f.a.id,f.b.id],ignoreAsciiCase:true,expression:'"application fee" AND "rural" OR "registration fee"'};
  const result=searchBooleanEvidence(f.docs,query);
  expect(result.sides.map(side=>side.hits.length)).toEqual([3,2]);
  expect(result.sides[0].hits[0].matchedPhrases).toEqual(['application fee','rural']);
  expect(result.sides[0].hits[1].matchedPhrases).toEqual(['registration fee']);
  const grouped=searchBooleanEvidence(f.docs,{...query,expression:'"application fee" AND ("rural" OR "registration fee")'});
  expect(grouped.sides.map(side=>side.hits.length)).toEqual([2,1]);
});
test('NOT is fragment-local and cannot produce a pure absence search',async()=>{
  const f=await fixture();
  const result=searchBooleanEvidence(f.docs,{documentIds:[f.a.id],ignoreAsciiCase:true,
    expression:'"application fee" AND NOT "refundable"'});
  expect(result.sides[0].hits.map(hit=>hit.source.ordinal)).toEqual([1,5,1]);
  for(const query of ['NOT "fee"','"fee" OR NOT "rural"','NOT ("fee" AND "rural")','NOT NOT NOT "fee"'])
    expect(()=>parseBooleanEvidenceQuery(query)).toThrow();
  expect(parseBooleanEvidenceQuery('NOT NOT "fee"').phrases).toEqual(['fee']);
  expect(parseBooleanEvidenceQuery('NOT (NOT "fee" OR "rural")').phrases).toEqual(['fee','rural']);
});
test('parser rejects unsupported syntax and enforces token, nesting and phrase budgets',()=>{
  for(const query of ['', 'fee', '"fee" "rural"', '"fee" and "rural"', '"fee" AND', '"fee" OR OR "rural"',
    '("fee"', '"fee")', '""','"  "','("fee" OR )','"bad\\n"','"a'.repeat(300),
    '('.repeat(7)+'"fee"'+')'.repeat(7),Array.from({length:13},()=>'"x"').join(' OR '),
    '"'+ 'a'.repeat(121)+'"'])
    expect(()=>parseBooleanEvidenceQuery(query)).toThrow();
  expect(parseBooleanEvidenceQuery('"a\\"b" AND "c\\\\d"').phrases).toEqual(['a"b','c\\d']);
  expect(parseBooleanEvidenceQuery('"fee" OR "fee"').phrases).toEqual(['fee']);
});
test('case folding and merged offsets do not change underlying source text',async()=>{
  const f=await fixture();
  const query={documentIds:[f.a.id],ignoreAsciiCase:true,expression:'"application fee" AND "fee:"'};
  const result=searchBooleanEvidence(f.docs,query),hit=result.sides[0].hits[0];
  expect(hit.source.text.slice(hit.ranges[0].start,hit.ranges[0].end)).toBe('Application fee:');
  expect(searchBooleanEvidence(f.docs,{...query,ignoreAsciiCase:false}).total).toBe(0);
  expect(inspectBooleanHit(f.docs,result,f.a.id,hit)).toBe(hit.source);
  expect(()=>inspectBooleanHit(f.docs,result,f.b.id,hit)).toThrow();
  expect(()=>inspectBooleanHit(f.docs,result,f.a.id,{...hit})).toThrow();
});
test('page and document scopes never substitute alternate sources or join native lines',async()=>{
  const f=await fixture();
  const result=searchBooleanEvidence(f.docs,{documentIds:[f.b.id,f.a.id],page:2,ignoreAsciiCase:true,
    expression:'"application fee" AND "rural"'});
  expect(result.sides.map(row=>row.hits.length)).toEqual([0,1]);
  expect(result.sides[0].coverage.pageState).toBe('no_indexed_text');
  expect(result.sides[1].hits[0].source.page).toBe(2);
  expect(booleanResultPage(result.sides[1].hits,1).hits).toHaveLength(1);
  expect(()=>booleanResultPage([],2)).toThrow();
  expect(()=>searchBooleanEvidence(f.docs,{...result.query,page:81})).toThrow();
});
