import {execFileSync} from 'node:child_process';
import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {serializeCollectionPacket} from '../src/pdfChatCollectionPacket';
import {exportQuestionBrief} from '../src/pdfChatQuestionBrief';
import {exportTurnDifference} from '../src/pdfChatTurnDifference';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.map((text,i)=>({role:'original' as const,page:1,ordinal:i+1,text,
      position:{x0:10,x1:100,y:100-i*12,height:10}})),
    pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
  }));
}
const program=[
  'import json,sys',
  'from noticebridge.chat_collection_question_audit import audit_question_artifact',
  'p=json.load(sys.stdin)',
  'print(json.dumps(audit_question_artifact(p["report"].encode(),p["packet"].encode(),p["snapshot"].encode())))',
].join('\n');
function verify(report:string,packet:string,snapshot:string){
  return JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',program],{
    input:JSON.stringify({report,packet,snapshot}),encoding:'utf8',timeout:20000,
  }));
}
test('Python independently checks browser brief and saved part comparison against recorded packet',async()=>{
  const a=await add([],'a',['Application fee: INR 500','Registration certificate','required for rural applicants']);
  const b=await add([a],'b',['Application fee: INR 350']);
  const docs=[a,b],turns=[
    runCollectionStep(docs,{question:'Application fee? Registration certificate?',documentIds:[b.id,a.id],includeContext:false}),
    runCollectionStep(docs,{question:'Registration certificate rural?',documentIds:[a.id],includeContext:true}),
  ];
  const packet=await serializeCollectionPacket(docs,turns,[],true,signal()),snapshot=serializeCollectionSnapshot(docs);
  const brief=await exportQuestionBrief(docs,turns[0],0,true,signal());
  const checked=verify(brief,packet,snapshot);
  expect(checked).toMatchObject({artifact_recomputed:true,retrieval_replayed:false,counts:{documents:2,citations:2}});
  expect(JSON.stringify(checked)).not.toContain('INR 500');
  const diff=await exportTurnDifference(docs,turns,{turn:0,part:1},{turn:1,part:0},true,signal());
  const result=verify(diff,packet,snapshot),expected=JSON.parse(diff);
  expect(result.counts).toMatchObject({common_documents:1,shared:expected.shared,
    left_only:expected.left_only,right_only:expected.right_only,channel_changes:expected.channel_changes});
  const tampered=JSON.parse(diff);tampered.common_documents=99;
  expect(()=>verify(JSON.stringify(tampered),packet,snapshot)).toThrow();
});
