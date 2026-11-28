import {expect,test} from '@playwright/test';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {exportReferenceReport,verifyReferenceReport} from '../src/pdfChatReferenceReport';
import {exportCollectionQuality} from '../src/pdfChatCollectionQuality';
import {main,parseDiagnosticArguments} from '../evaluation/collectionDiagnostics';

const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:lines.map((text,i)=>({role:'original',page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',['Clause 4.2(a) Private eligibility','😀 See Clause 4.2(a) and Section 9.']);
  const b=await add([a],'b',['Clause 4.2(a) Private rule','See Annexure B.']);
  const docs=[a,b],snapshot=serializeCollectionSnapshot(docs);
  return {a,b,docs,snapshot};
}
test('reference report preserves exact UTF-16 occurrence offsets and source order',async()=>{
  const {a,b,docs,snapshot}=await fixture();
  const report=await exportReferenceReport(docs,[b.id,a.id],true,signal());
  const parsed=await verifyReferenceReport(report,snapshot,signal());
  expect(parsed.source_ids).toEqual([b.id,a.id]);
  const clause=parsed.groups.find(row=>row.identifier==='4.2(a)')!;
  expect(clause.state).toBe('multiple_leading');
  expect(clause.sides.map(row=>row.document_id)).toEqual([b.id,a.id]);
  const item=clause.sides[1].inline[0];
  expect(item.start_utf16).toBe('😀 See '.length);
  expect(a.corpus.passages[1].text.slice(item.start_utf16,item.end_utf16)).toBe('Clause 4.2(a)');
  expect(report).not.toContain('Private eligibility');expect(report).not.toContain('private.pdf');
  expect(parsed.reference_relationships_verified).toBe(false);
  await expect(exportReferenceReport(docs,[a.id],false,signal())).rejects.toThrow();
});
test('reference replay rejects altered source identity, offsets and state',async()=>{
  const {a,b,docs,snapshot}=await fixture();
  const report=await exportReferenceReport(docs,[a.id,b.id],true,signal());
  const changes=[(v:any)=>v.source_ids.reverse(),(v:any)=>v.groups[0].sides[0].leading[0].start_utf16++,
    (v:any)=>v.groups[0].state='no_leading',(v:any)=>v.reference_relationships_verified=true];
  for(const change of changes){
    const raw=JSON.parse(report);change(raw);
    await expect(verifyReferenceReport(JSON.stringify(raw,null,2)+'\n',snapshot,signal())).rejects.toThrow();
  }
  await expect(verifyReferenceReport(report.trim(),snapshot,signal())).rejects.toThrow();
});
for(const kind of ['quality','references'] as const){
  test('offline '+kind+' generation and verification match live report',async()=>{
    const {a,b,docs,snapshot}=await fixture(),dir=mkdtempSync(join(tmpdir(),'noticebridge-diagnostic-'));
    try{
      const input=join(dir,'snapshot.json'),output=join(dir,'report.json'),verified=join(dir,'verified.json');
      writeFileSync(input,snapshot);
      const args=['--kind',kind,'--snapshot',input];
      expect(await main([...args,'--source',b.id,'--source',a.id,'--output',output])).toBe(0);
      const expected=kind==='quality'?await exportCollectionQuality(docs,[b.id,a.id],true,signal()):
        await exportReferenceReport(docs,[b.id,a.id],true,signal());
      expect(readFileSync(output,'utf8')).toBe(expected);
      expect(await main([...args,'--verify-report',output,'--output',verified])).toBe(0);
      expect(readFileSync(verified,'utf8')).toBe(expected);
      expect(await main([...args,'--output',output])).toBe(1);
      expect(readFileSync(output,'utf8')).toBe(expected);
      const bad=join(dir,'bad.json'),missing=join(dir,'missing.json');
      writeFileSync(bad,'{}');
      expect(await main([...args,'--verify-report',bad,'--output',missing])).toBe(1);
      expect(existsSync(missing)).toBe(false);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
}
test('diagnostic CLI rejects duplicate IDs, aliasing paths and conflicting scope',()=>{
  const args=['--kind','quality','--snapshot','a.json','--output','b.json'];
  const id='a'.repeat(64);
  expect(parseDiagnosticArguments([...args,'--source',id]).ids).toEqual([id]);
  expect(()=>parseDiagnosticArguments([...args,'--source',id,'--source',id])).toThrow();
  expect(()=>parseDiagnosticArguments([...args,'--source',id,'--verify-report','c.json'])).toThrow();
  expect(()=>parseDiagnosticArguments(args.map(v=>v==='b.json'?'./a.json':v))).toThrow();
});
