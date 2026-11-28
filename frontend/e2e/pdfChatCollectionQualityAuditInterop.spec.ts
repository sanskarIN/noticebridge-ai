import {execFileSync} from 'node:child_process';
import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {exportCollectionQuality} from '../src/pdfChatCollectionQuality';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],id:string,rows:string[][]){
  return admitCollectionDocument(docs,new File([id],'private.pdf'),signal(),async()=>({
    passages:rows.flatMap((lines,i)=>lines.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:rows.length,processedPages:rows.length,missingPages:rows.flatMap((lines,i)=>lines.length?[]:[i+1]),
    limited:false,limitedPages:[],
  }));
}
function verify(report:string,snapshot:string){
  const program=[
    'import json,sys',
    'from noticebridge.chat_collection_quality_audit import audit_quality',
    'p=json.load(sys.stdin)',
    'print(json.dumps(audit_quality(p["report"].encode(),p["snapshot"].encode())))',
  ].join('\n');
  return JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',program],{
    input:JSON.stringify({report,snapshot}),encoding:'utf8',timeout:20000,
  }));
}
test('independent Python recomputes browser flags, counts and selected scope',async()=>{
  const a=await add([],'a',[['Private same','Private same','abc\u200ddef','\ufffd'],['Private same','😀','\ue000'],[]]);
  const b=await add([a],'b',[['Private same']]);
  const docs=[a,b],snapshot=serializeCollectionSnapshot(docs);
  const report=await exportCollectionQuality(docs,[b.id,a.id],true,signal());
  const value=verify(report,snapshot),expected=JSON.parse(report);
  expect(value).toMatchObject({diagnostics_recomputed:true,native_extraction_replayed:false,pdf_bytes_verified:false,
    source_ids:[b.id,a.id],counts:expected.counts,flagged_fragments:expected.flagged_fragments});
  expect(JSON.stringify(value)).not.toContain('Private same');
  const tampered=JSON.parse(report);tampered.sources[0].pages[0].flagged[0].flags=[];
  expect(()=>verify(JSON.stringify(tampered),snapshot)).toThrow();
});
