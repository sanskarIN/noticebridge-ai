import {execFileSync} from 'node:child_process';
import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {exportReferenceReport} from '../src/pdfChatReferenceReport';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.map((text,i)=>({role:'original' as const,page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
  }));
}
const program=[
  'import json,sys',
  'from noticebridge.chat_collection_reference_audit import audit_reference_index',
  'p=json.load(sys.stdin)',
  'print(json.dumps(audit_reference_index(p["report"].encode(),p["snapshot"].encode())))',
].join('\n');
function verify(report:string,snapshot:string){
  return JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',program],{
    input:JSON.stringify({report,snapshot}),encoding:'utf8',timeout:20000,
  }));
}
test('Python matches browser explicit reference groups and UTF-16 offsets',async()=>{
  const a=await add([],'a',['Clause 4.2(a) Private eligibility','😀 See Clause 4.2(a) and Section 9.',
    'Section 1é is not a valid identifier','Annexure B and Schedule A-2','ſection 7']);
  const b=await add([a],'b',['Clause 4.2(a) Private rule','Article 2B','Annexure K']);
  const docs=[a,b],snapshot=serializeCollectionSnapshot(docs);
  const report=await exportReferenceReport(docs,[b.id,a.id],true,signal());
  const value=verify(report,snapshot),expected=JSON.parse(report);
  expect(value).toMatchObject({reference_index_recomputed:true,reference_relationships_verified:false,
    total_occurrences:expected.total_occurrences,groups:expected.groups.length,source_ids:[b.id,a.id]});
  expect(JSON.stringify(value)).not.toContain('Private');
  expected.groups[0].sides[1].inline[0].end_utf16--;
  expect(()=>verify(JSON.stringify(expected),snapshot)).toThrow();
});
