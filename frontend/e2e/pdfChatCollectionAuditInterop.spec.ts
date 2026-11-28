import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {pinCollectionEvidence,updateCollectionEvidence,collectionReviewKey} from '../src/pdfChatCollectionReview';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {serializeCollectionPacket} from '../src/pdfChatCollectionPacket';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.flatMap((page,i)=>page.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text,
      position:{x0:10,x1:100,y:100-j*12,height:10}}))),
    pageCount:lines.length,processedPages:lines.length,
    missingPages:lines.flatMap((page,i)=>page.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
const python=[
  'import json, sys',
  'from noticebridge.chat_collection_audit import audit_packet, encode_audit',
  'value = json.load(sys.stdin)',
  'report = audit_packet(value["packet"].encode(), value["snapshot"].encode())',
  'sys.stdout.buffer.write(encode_audit(report))',
].join('\n');
function check(packet:string,snapshot:string){
  return JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',python],{
    input:JSON.stringify({packet,snapshot}),timeout:20000,maxBuffer:128*1024,
  }).toString('utf8'));
}
test('Python structural auditor validates actual browser packet with independent source scopes',async()=>{
  const a=await add([],'a',[['Application fee: INR 500','Eligibility: Class 12'],['Application fee: INR 250']]);
  const b=await add([a],'b',[['Application fee: INR 350'],[]]);
  const docs=[a,b];
  const turns=[
    runCollectionStep(docs,{question:'Application fee? Eligibility?',documentIds:[b.id,a.id],includeContext:false}),
    runCollectionStep(docs,{question:'Application fee on page 2?',documentIds:[a.id,b.id],includeContext:false}),
  ];
  const source=a.corpus.passages[0];
  const reviews=updateCollectionEvidence(pinCollectionEvidence(docs,[],a.id,source),collectionReviewKey(a.id,source),
    {note:'Private annotation 😀',status:'needs_followup'});
  const packet=await serializeCollectionPacket(docs,turns,reviews,true);
  const snapshot=serializeCollectionSnapshot(docs);
  const result=check(packet,snapshot);
  expect(result).toMatchObject({snapshot_references_consistent:true,retrieval_replayed:false,native_extraction_replayed:false,
    authority_verified:false,pdf_byte_set_matches:null,counts:{documents:2,question_turns:2,question_parts:6,review_annotations:1}});
  expect(JSON.stringify(result)).not.toContain('INR 500');
  expect(JSON.stringify(result)).not.toContain('Private annotation');
});
test('Python auditor checks a browser contextual fallback without claiming relevance replay',async()=>{
  const a=await add([],'a',[['Registration certificate','required for rural applicants']]);
  const docs=[a];
  const turn=runCollectionStep(docs,{question:'Registration certificate rural?',documentIds:[a.id],includeContext:true});
  expect(turn.results[0].parts[0].answer.contextGroups).toHaveLength(1);
  const packet=await serializeCollectionPacket(docs,[turn],[],true);
  expect(check(packet,serializeCollectionSnapshot(docs)).counts).toMatchObject({context_groups:1,citations:2});
});
test('Python audit rejects altered browser quote and independently altered snapshot bytes',async()=>{
  const a=await add([],'a',[['Application fee: INR 500']]);
  const docs=[a],turn=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id],includeContext:false});
  const packet=await serializeCollectionPacket(docs,[turn],[],true),snapshot=serializeCollectionSnapshot(docs);
  const raw=JSON.parse(packet);raw.evidence_report.questions[0].results[0].parts[0].citations[0].text='forged';
  expect(()=>check(JSON.stringify(raw),snapshot)).toThrow();
  expect(()=>check(packet,snapshot.replace('INR 500','INR 999'))).toThrow();
});
