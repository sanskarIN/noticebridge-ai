import {expect,test} from '@playwright/test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectionPdf} from './helpers/collectionPdf';
import {ingestCollection,verifyIngestedCollection,readPdfInputs,parseIngestArguments,main} from '../evaluation/ingestCollection';
import {parseCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import type {CollectionExtractor} from '../src/pdfChatCollection';
const signal=()=>new AbortController().signal;
const synthetic=(name:string,pages:string[][])=>new File([new Uint8Array(collectionPdf(pages))],name,{type:'application/pdf'});
test('Node PDF.js creates a native snapshot from actual PDF bytes with per-page provenance',async()=>{
  const a=synthetic('private-a.pdf',[['Application fee: INR 500'],['Eligibility: Class 12']]);
  const b=synthetic('private-b.pdf',[['Application fee: INR 350']]);
  const result=await ingestCollection([a,b],signal());
  expect(result.status).toBe(0);
  expect(result.summary).toMatchObject({documents:2,fragments:3,pdf_bytes_read:true,authority_verified:false,browser_extraction_replayed:false});
  const snapshot=parseCollectionSnapshot(result.text);
  expect(snapshot.sources.flatMap(source=>source.corpus.passages.map(row=>row.text)).sort())
    .toEqual(['Application fee: INR 350','Application fee: INR 500','Eligibility: Class 12']);
  expect(snapshot.sources.find(source=>source.corpus.pageCount===2)?.corpus.passages[1].page).toBe(2);
  expect(result.text).not.toContain('private-a.pdf');
  const checked=await verifyIngestedCollection(result.text,[b,a],signal());
  expect(checked.status).toBe(0);
  expect(checked.summary).toMatchObject({all_pdf_bytes_match:true,all_native_extractions_match:true,authority_verified:false});
});
test('independent verification distinguishes missing or changed source bytes',async()=>{
  const a=synthetic('a.pdf',[['Eligibility: Class 12']]),b=synthetic('b.pdf',[['Application fee: INR 350']]);
  const snapshot=(await ingestCollection([a,b],signal())).text;
  const result=await verifyIngestedCollection(snapshot,[a],signal());
  expect(result.status).toBe(3);
  expect(JSON.parse(result.text).sources.map((row:any)=>row.state).sort()).toEqual(['exact_replay','missing_pdf']);
  const different=synthetic('b.pdf',[['Application fee: INR 700']]);
  expect((await verifyIngestedCollection(snapshot,[a,different],signal())).status).toBe(3);
  await expect(ingestCollection([a,a],signal())).rejects.toThrow();
});
test('ingestion is atomic on cancellation, failed extraction and malformed input',async()=>{
  const a=synthetic('a.pdf',[['Eligibility: Class 12']]);
  const bad=new File(['not a PDF'],'invalid.pdf');
  await expect(ingestCollection([a,bad],signal())).rejects.toThrow();
  const ctrl=new AbortController();ctrl.abort();
  await expect(ingestCollection([a],ctrl.signal)).rejects.toThrow();
  const failure:CollectionExtractor=async()=>{throw Error('invalid');};
  await expect(ingestCollection([a],signal(),failure)).rejects.toThrow();
});
test('argument parser rejects duplicate paths, unknown options and output aliases',()=>{
  expect(parseIngestArguments(['--pdf','a.pdf','--pdf','b.PDF','--output','snapshot.json']).pdfs).toHaveLength(2);
  for(const args of [
    [],['--pdf','a.pdf'],['--pdf','a.txt','--output','a.json'],
    ['--pdf','a.pdf','--pdf','a.pdf','--output','a.json'],
    ['--pdf','a.pdf','--output','a.json','--verify-snapshot','a.json'],
    ['--pdf','a.pdf','--output','a.json','--unknown','b.json'],
  ])expect(()=>parseIngestArguments(args)).toThrow();
});
test('CLI bounded binary read and exclusive publication preserve existing output',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'noticebridge-ingest-'));
  try{
    const pdf=join(dir,'private.pdf'),output=join(dir,'snapshot.json'),report=join(dir,'replay.json');
    writeFileSync(pdf,collectionPdf([['Application fee: INR 500']]));
    expect(readPdfInputs([pdf])[0].name).toBe('private.pdf');
    expect(await main(['--pdf',pdf,'--output',output])).toBe(0);
    const before=readFileSync(output,'utf8');
    expect(parseCollectionSnapshot(before).sources[0].corpus.passages[0].text).toBe('Application fee: INR 500');
    expect(await main(['--pdf',pdf,'--output',output])).toBe(1);
    expect(readFileSync(output,'utf8')).toBe(before);
    expect(await main(['--pdf',pdf,'--output',report,'--verify-snapshot',output])).toBe(0);
    expect(JSON.parse(readFileSync(report,'utf8')).status).toBe('exact_replay');
    const malformed=join(dir,'bad.pdf'),noOutput=join(dir,'failed.json');
    writeFileSync(malformed,'not a PDF');
    expect(await main(['--pdf',malformed,'--output',noOutput])).toBe(1);
    expect(existsSync(noOutput)).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
