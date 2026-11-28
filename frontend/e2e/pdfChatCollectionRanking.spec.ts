import {test,expect} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {buildIndex,rankedMatches,rankedMatchDetails,matchTermScores,pageScopedIndex,queryTerms,knownQuestionField,type Passage} from '../src/pdfChatCore';
import {explainCollectionRanking,filterCollectionRanking,collectionRankingPage,collectionRankingTermScores,inspectCollectionRanking} from '../src/pdfChatCollectionRanking';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Application fee: INR 500','Application fee: INR 500','Application charges: INR 350',
    'Application fee: INR 250','Application fee: INR 100','Application fee: INR 600','Eligibility: Class 12'],
    ['Application fee: INR 999','Registration deadline: 10 December']]);
  const b=await add([a],'b',[['Application fee: INR 100']]);
  return {a,b,docs:[a,b]};
}
test('ranking trace exactly preserves strict answer order, duplicates and omitted candidates',async()=>{
  const {a,docs}=await fixture();
  const part=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id],includeContext:false}).results[0].parts[0];
  const trace=explainCollectionRanking(docs,a.id,part,false);
  expect(trace.strictMatches).toBe(6);
  expect(trace.collapsedDuplicates).toBe(1);
  expect(trace.shownStrictMatches).toBe(4);
  expect(trace.rows.filter(row=>row.displayed).map(row=>row.passage)).toEqual(part.answer.citations);
  expect(filterCollectionRanking(trace,{mode:'all',display:'omitted',query:''})).toHaveLength(2);
  expect(trace.rows.every(row=>row.rank>0)).toBe(true);
  expect(trace.rows.every(row=>row.passage.role==='original')).toBe(true);
  expect(trace.rows.every(row=>!row.passage.text.includes('Eligibility'))).toBe(true);
});
test('page-scoped score explanation retains complete PDF document frequencies',async()=>{
  const {a,docs}=await fixture();
  const part=runCollectionStep(docs,{question:'Application fee on page 2?',documentIds:[a.id],includeContext:false}).results[0].parts[0];
  const trace=explainCollectionRanking(docs,a.id,part,false);
  expect(trace.physicalPage).toBe(2);
  expect(trace.indexedFragments).toBe(9);
  expect(trace.scopedFragments).toBe(2);
  expect(trace.rows).toHaveLength(1);
  expect(trace.rows[0].passage.text).toContain('999');
  const scores=collectionRankingTermScores(trace,trace.rows[0]);
  expect(scores.every(row=>row.df===7)).toBe(true);
  expect(scores.reduce((sum,row)=>sum+row.contribution,0)).toBe(trace.rows[0].score);
  expect(inspectCollectionRanking(docs,trace,trace.rows[0])).toBe(a.corpus.passages[7]);
});
test('field aliases can qualify independently of all query terms without claiming equivalence',()=>{
  const rows:Passage[]=[
    {role:'original',page:1,ordinal:1,text:'Eligibility: Class 12'},
    {role:'original',page:1,ordinal:2,text:'Educational qualification: Class 10'},
    {role:'revised',page:1,ordinal:1,text:'Eligibility: Degree'},
  ];
  const index=buildIndex(rows),words=queryTerms('educational qualification'),field=knownQuestionField(words);
  const ranked=rankedMatchDetails(index,words,'original',field);
  expect(ranked.map(row=>row.passage)).toEqual(rankedMatches(index,words,'original',field));
  expect(ranked.every(row=>row.knownField)).toBe(true);
  expect(ranked.some(row=>!row.lexical)).toBe(true);
  expect(ranked.every(row=>row.passage.role==='original')).toBe(true);
  for(const row of ranked)expect(matchTermScores(index,row.passage,words).reduce((n,x)=>n+x.contribution,0)).toBe(row.score);
  expect(()=>matchTermScores(index,{...rows[0]},words)).toThrow();
});
test('context fallback is separate and cannot masquerade as a scored strict candidate',async()=>{
  const a=await add([],'a',[['Rural applicants','Registration certificate required']]),docs=[a];
  const question='Rural registration certificate?';
  const part=runCollectionStep(docs,{question,documentIds:[a.id],includeContext:true}).results[0].parts[0];
  const trace=explainCollectionRanking(docs,a.id,part,true);
  expect(trace.state).toBe('contextual');
  expect(trace.rows).toEqual([]);
  expect(trace.context[0]).toEqual(a.corpus.passages);
  const strict=runCollectionStep(docs,{question,documentIds:[a.id],includeContext:false}).results[0].parts[0];
  expect(explainCollectionRanking(docs,a.id,strict,false).state).toBe('no_match');
  expect(()=>explainCollectionRanking(docs,a.id,part,false)).toThrow();
});
test('forged, missing and other-document citation identities reject',async()=>{
  const {a,b,docs}=await fixture();
  const part=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id],includeContext:false}).results[0].parts[0];
  const trace=explainCollectionRanking(docs,a.id,part,false);
  expect(()=>explainCollectionRanking(docs,b.id,part,false)).toThrow();
  expect(()=>explainCollectionRanking(docs,a.id,{...part,answer:{...part.answer,citations:[]}},false)).toThrow();
  expect(()=>explainCollectionRanking(docs,a.id,{...part,answer:{...part.answer,citations:part.answer.citations.map(row=>({...row}))}},false)).toThrow();
  expect(()=>collectionRankingTermScores(trace,{...trace.rows[0]})).toThrow();
  expect(()=>inspectCollectionRanking(docs,trace,{...trace.rows[0]})).toThrow();
  expect(()=>filterCollectionRanking(trace,{mode:'fake' as never,display:'all',query:''})).toThrow();
  expect(collectionRankingPage([],1)).toEqual({pages:1,rows:[],first:0,last:0});
  expect(()=>collectionRankingPage([],2)).toThrow();
});
test('accelerated and scan-path ranking details remain exactly equivalent',()=>{
  const passages:Passage[]=Array.from({length:200},(_,i)=>({role:i%4===0?'revised':'original',page:Math.floor(i/20)+1,
    ordinal:i%20+1,text:i%3===0?'Application fee: INR 500':i%3===1?'Application charges: INR 300':'Eligibility: Class 12'}));
  const index=buildIndex(passages);
  for(const question of ['Application fee','eligibility','rural eligibility','application charges','not present']){
    const words=queryTerms(question),field=knownQuestionField(words);
    for(const role of ['original','revised'] as const){
      expect(rankedMatchDetails(index,words,role,field)).toEqual(rankedMatchDetails({...index},words,role,field));
      for(const page of [1,2,8])expect(rankedMatchDetails(pageScopedIndex(index,page),words,role,field))
        .toEqual(rankedMatchDetails({...index,rows:index.rows.filter(row=>row.passage.page===page)},words,role,field));
    }
  }
});
