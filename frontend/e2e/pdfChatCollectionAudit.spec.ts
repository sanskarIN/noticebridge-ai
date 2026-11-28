import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {serializeCollectionPacket} from '../src/pdfChatCollectionPacket';
import {reconstructCollectionAudit,verifyCollectionStructuralAudit,readCollectionAuditArtifact,
  MAX_COLLECTION_AUDIT_BYTES} from '../src/pdfChatCollectionAudit';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,text:string){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:[{role:'original',page:1,ordinal:1,text}],
    pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a','Application fee: INR 500'),b=await add([a],'b','Application fee: INR 350');
  const docs=[a,b],turn=runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id,b.id],includeContext:false});
  return {a,b,docs,packet:await serializeCollectionPacket(docs,[turn],[],true),snapshot:serializeCollectionSnapshot(docs)};
}
const encode=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
test('reconstruction binds current packet and reports unchecked PDF bytes distinctly',async()=>{
  const {docs,packet}=await fixture();
  const report=await reconstructCollectionAudit(packet,docs,false);
  expect(report).toMatchObject({pdf_bytes_checked:false,pdf_byte_set_matches:null,retrieval_replayed:false,
    native_extraction_replayed:false,answer_accuracy_verified:false,authority_verified:false,
    counts:{documents:2,native_fragments:2,question_turns:1,question_parts:2,citations:2,printed_fields:2}});
  expect(report.sources.every(row=>row.pdf_bytes===null)).toBe(true);
  expect(await verifyCollectionStructuralAudit(encode(report),packet,[...docs].reverse())).toEqual(report);
});
test('checked byte set reconstructs actual immutable file hashes and sizes',async()=>{
  const {docs,packet}=await fixture();
  const report=await reconstructCollectionAudit(packet,docs,true);
  expect(report.pdf_byte_set_matches).toBe(true);
  expect(report.sources.map(row=>row.pdf_bytes)).toEqual([1,1]);
  await expect(reconstructCollectionAudit(packet,[{...docs[0],file:new File(['z'],'private.pdf')},docs[1]],true)).rejects.toThrow();
  expect(await verifyCollectionStructuralAudit(encode(report),packet,docs)).toEqual(report);
});
test('real Python auditor output exactly reproduces browser report contract',async()=>{
  const {docs,packet,snapshot}=await fixture();
  const program=[
    'import json, sys',
    'from noticebridge.chat_collection_audit import audit_packet, encode_audit',
    'value = json.load(sys.stdin)',
    'sys.stdout.buffer.write(encode_audit(audit_packet(value["packet"].encode(), value["snapshot"].encode())))',
  ].join('\n');
  const text=execFileSync(process.env.PYTHON||'python',['-c',program],{
    input:JSON.stringify({packet,snapshot}),timeout:20000,maxBuffer:MAX_COLLECTION_AUDIT_BYTES,
  }).toString('utf8');
  expect(await verifyCollectionStructuralAudit(text,packet,docs)).toEqual(await reconstructCollectionAudit(packet,docs,false));
});
test('audit cannot assert stronger verification or change source or packet identity',async()=>{
  const {docs,packet}=await fixture();
  const report=await reconstructCollectionAudit(packet,docs,true);
  for(const mutate of [
    (v:any)=>{v.authority_verified=true;},
    (v:any)=>{v.retrieval_replayed=true;},
    (v:any)=>{v.native_extraction_replayed=true;},
    (v:any)=>{v.canonical_browser_encoding_verified=true;},
    (v:any)=>{v.packet_sha256='0'.repeat(64);},
    (v:any)=>{v.snapshot_sha256='0'.repeat(64);},
    (v:any)=>{v.counts.citations++;},
    (v:any)=>{v.sources.reverse();},
    (v:any)=>{v.sources[0].pdf_bytes=999;},
    (v:any)=>{v.missing_pdf_ids.push(v.sources[0].document_id);v.pdf_byte_set_matches=false;},
  ]){
    const changed=structuredClone(report);mutate(changed);
    await expect(verifyCollectionStructuralAudit(encode(changed),packet,docs)).rejects.toThrow();
  }
  await expect(verifyCollectionStructuralAudit(encode(report).trim(),packet,docs)).rejects.toThrow();
  await expect(verifyCollectionStructuralAudit(encode(report),packet,[docs[0]])).rejects.toThrow();
});
test('file reads are strict UTF-8, bounded and abortable',async()=>{
  const {docs,packet}=await fixture();
  const report=encode(await reconstructCollectionAudit(packet,docs,false));
  expect(await readCollectionAuditArtifact(new File([report],'audit.json'),'audit',signal())).toBe(report);
  await expect(readCollectionAuditArtifact(new File([],'empty.json'),'audit',signal())).rejects.toThrow();
  await expect(readCollectionAuditArtifact(new File([new Uint8Array([255])],'bad.json'),'audit',signal())).rejects.toThrow();
  await expect(readCollectionAuditArtifact(new File(['x'.repeat(MAX_COLLECTION_AUDIT_BYTES+1)],'big.json'),'audit',signal())).rejects.toThrow();
  const controller=new AbortController();controller.abort();
  await expect(verifyCollectionStructuralAudit(report,packet,docs,controller.signal)).rejects.toThrow();
});
