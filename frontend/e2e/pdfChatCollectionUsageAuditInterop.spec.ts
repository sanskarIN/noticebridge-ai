import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {pinCollectionEvidence,updateCollectionEvidence,collectionReviewKey} from '../src/pdfChatCollectionReview';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {serializeCollectionPacket} from '../src/pdfChatCollectionPacket';
import {exportEvidenceUsage} from '../src/pdfChatEvidenceUsage';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.map((text,i)=>({role:'original',page:1,ordinal:i+1,text,position:{x0:10,x1:100,y:100-i*12,height:10}})),
    pageCount:1,processedPages:1,missingPages:[],limitedPages:[],limited:false,
  }));
}
const program=[
  'import json,sys',
  'from noticebridge.chat_collection_usage_audit import audit_usage',
  'p=json.load(sys.stdin)',
  'print(json.dumps(audit_usage(p["report"].encode(),p["packet"].encode(),p["snapshot"].encode())))',
].join('\n');
function check(report:string,packet:string,snapshot:string){
  return JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',program],{input:JSON.stringify({report,packet,snapshot}),encoding:'utf8',timeout:20000}));
}
test('Python recomputes actual browser citation usage including contextual fallback and review-only rows',async()=>{
  const a=await add([],'a',['Registration certificate','required for rural applicants','Private pinned line']);
  const b=await add([a],'b',['Registration certificate']);
  const docs=[a,b];
  const turns=[
    runCollectionStep(docs,{question:'Registration certificate?',documentIds:[b.id,a.id],includeContext:false}),
    runCollectionStep(docs,{question:'Registration certificate rural?',documentIds:[a.id],includeContext:true}),
    runCollectionStep(docs,{question:'Unobtainium?',documentIds:[b.id],includeContext:false}),
  ];
  expect(turns[1].results[0].parts[0].answer.contextGroups).toHaveLength(1);
  let reviews=pinCollectionEvidence(docs,[],a.id,a.corpus.passages[0]);
  reviews=updateCollectionEvidence(reviews,collectionReviewKey(a.id,a.corpus.passages[0]),{status:'reviewed_manually',note:'Private note'});
  reviews=pinCollectionEvidence(docs,reviews,a.id,a.corpus.passages[2]);
  const report=await exportEvidenceUsage(docs,turns,reviews,true,signal());
  const packet=await serializeCollectionPacket(docs,turns,reviews,true,signal());
  const snapshot=serializeCollectionSnapshot(docs),result=check(report,packet,snapshot);
  expect(result).toMatchObject({usage_recomputed:true,retrieval_replayed:false,authority_verified:false,
    counts:{question_turns:3,searches:4,unmatched:1,citations:4,distinct_citations:3,reused_fragments:1,uncited_annotations:1}});
  expect(JSON.stringify(result)).not.toContain('Private note');
  const raw=JSON.parse(report);raw.rows[0].uses[0].rank=99;
  expect(()=>check(JSON.stringify(raw),packet,snapshot)).toThrow();
});
test('annotation-only packets retain uncited rows in the independent audit',async()=>{
  const a=await add([],'a',['Private saved quote']),docs=[a],reviews=pinCollectionEvidence(docs,[],a.id,a.corpus.passages[0]);
  const report=await exportEvidenceUsage(docs,[],reviews,true,signal()),packet=await serializeCollectionPacket(docs,[],reviews,true,signal());
  expect(check(report,packet,serializeCollectionSnapshot(docs)).counts).toMatchObject({question_turns:0,citations:0,uncited_annotations:1});
});
