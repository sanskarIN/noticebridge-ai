import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionRecovery,collectionRecoveryDraft,collectionRecoveryLead} from '../src/pdfChatCollectionRecovery';

async function add(docs:CollectionDocument[],name:string,lines:string[]){
  return admitCollectionDocument(docs,new File([name],name+'.pdf'),new AbortController().signal,async()=>({
    passages:lines.map((text,i)=>({role:'original' as const,page:i+1,ordinal:1,text})),
    pageCount:lines.length,processedPages:lines.length,missingPages:[],limited:false,limitedPages:[],
  }));
}
test('recovery never mixes terms or spelling candidates across collection documents or page scopes',async()=>{
  const a=await add([],'a',['Registration certificate required','Registration fee']);
  const b=await add([a],'b',['Registration certifacate required','Different text']);
  const docs=[a,b];
  const turn=runCollectionStep(docs,{question:'Registration certifacate on page 1?',documentIds:[a.id,b.id],includeContext:false});
  const left=collectionRecovery(docs,a.id,turn.results[0].parts[0]);
  const right=collectionRecovery(docs,b.id,turn.results[1].parts[0]);
  expect(left.recovery.sides[0].state).toBe('missing_terms');
  expect(right.recovery.sides[0].state).toBe('full_match_available');
  const suggestion=left.recovery.sides[0].suggestions.find(row=>row.candidate==='certificate');
  expect(suggestion).toBeDefined();
  expect(collectionRecoveryDraft(docs,left,suggestion!,true)).toEqual({
    question:'Registration certificate on page 1?',documentIds:[a.id],includeContext:true,
  });
  expect(()=>collectionRecoveryDraft(docs,right,suggestion!,true)).toThrow();
  const lead=left.recovery.sides[0].leads[0];
  expect(collectionRecoveryLead(docs,left,lead)).toBe(a.corpus.passages[0]);
  expect(()=>collectionRecoveryLead(docs,right,lead)).toThrow();
  expect(()=>collectionRecovery(docs,a.id,turn.results[1].parts[0])).toThrow();
});
test('diagnostic keeps unmatched baseline and excludes terms from other physical pages',async()=>{
  const a=await add([],'a',['Registration','Certificate']);
  const docs=[a];
  const part=runCollectionStep(docs,{question:'Registration certificate on page 1?',documentIds:[a.id],includeContext:false}).results[0].parts[0];
  const before=JSON.stringify(part);
  const result=collectionRecovery(docs,a.id,part);
  expect(result.recovery.sides[0].coverage.map(row=>[row.term,row.fragments])).toEqual([['registration',1],['certificate',0]]);
  expect(result.recovery.sides[0].leads).toHaveLength(1);
  expect(JSON.stringify(part)).toBe(before);
});
