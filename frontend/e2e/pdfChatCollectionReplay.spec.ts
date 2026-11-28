import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument,type CollectionExtractor} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot,parseCollectionSnapshot,replayCollectionSources,verifyCollectionSourceReplay,
  loadCollectionSnapshot,MAX_COLLECTION_SNAPSHOT_BYTES} from '../src/pdfChatCollectionReplay';
import type {Corpus} from '../src/pdfChatCore';

const corpus=(text:string):Corpus=>({passages:[{role:'original',page:1,ordinal:1,text}],
  pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[]});
const signal=()=>new AbortController().signal;
const extract:CollectionExtractor=async file=>corpus(await file.text());
async function add(docs:CollectionDocument[],text:string){
  return admitCollectionDocument(docs,new File([text],'same.pdf'),signal(),extract);
}
async function fixture(){
  const a=await add([],'Application fee: INR 500'),b=await add([a],'Application fee: INR 350');
  return {a,b,docs:[a,b],text:serializeCollectionSnapshot([a,b])};
}
test('snapshot is canonical, independent of attachment ordering and contains no filename or PDF bytes',async()=>{
  const {a,b,docs,text}=await fixture();
  expect(serializeCollectionSnapshot([b,a])).toBe(text);
  expect(text).not.toContain('same.pdf');
  expect(parseCollectionSnapshot(text).sources.map(row=>row.id)).toEqual([a.id,b.id].sort());
  expect(parseCollectionSnapshot(text).sources.map(row=>row.corpus.passages[0].text).sort())
    .toEqual(docs.map(doc=>doc.corpus.passages[0].text).sort());
  expect(await loadCollectionSnapshot(new File([text],'snapshot.json'),signal())).toBe(text);
});
test('replay independently hashes renamed PDFs, preserving deterministic report ordering',async()=>{
  const {a,b,text}=await fixture();
  const files=[new File([await b.file.arrayBuffer()],'renamed.pdf'),a.file];
  const progress:number[]=[];
  const result=await replayCollectionSources(text,files,{signal:signal(),extract,onProgress:p=>progress.push(p.completed)});
  expect(result.report).toMatchObject({status:'exact_replay',all_pdf_bytes_match:true,all_native_extractions_match:true,
    authority_verified:false,extraction_completeness_verified:false,answer_accuracy_verified:false});
  expect(result.report.sources.every(row=>row.state==='exact_replay')).toBe(true);
  expect(progress.at(-1)).toBe(4);
  expect(result.text).not.toContain('Application fee');
  expect(result.text).not.toContain('renamed.pdf');
  expect((await verifyCollectionSourceReplay(result.text,text,[...files].reverse(),{signal:signal(),extract})).text).toBe(result.text);
});
test('missing and unexpected sources are explicit and unrelated files never reach extraction',async()=>{
  const {a,b,text}=await fixture();
  const unexpected=new File(['unrelated'],'other.pdf');
  const calls:string[]=[];
  const result=await replayCollectionSources(text,[a.file,unexpected],{signal:signal(),extract:async file=>{
    calls.push(await file.text());return extract(file,'original',signal());
  }});
  expect(calls).toEqual(['Application fee: INR 500']);
  expect(result.report.status).toBe('not_reproduced');
  expect(result.report.sources.find(row=>row.id===b.id)?.state).toBe('missing_pdf');
  expect(result.report.sources.filter(row=>row.state==='unexpected_pdf')).toHaveLength(1);
  expect(result.report.all_pdf_bytes_match).toBe(false);
});
test('changed native extraction and extraction errors cannot become a successful replay',async()=>{
  const {a,b,text}=await fixture();
  const result=await replayCollectionSources(text,[a.file,b.file],{signal:signal(),extract:async file=>{
    if(await file.text()==='Application fee: INR 500')return corpus('changed');
    throw new Error('extraction failed');
  }});
  expect(result.report.all_pdf_bytes_match).toBe(true);
  expect(result.report.all_native_extractions_match).toBe(false);
  expect(result.report.sources.find(row=>row.id===a.id)).toMatchObject({state:'different_extraction',fragments:{changed_text:1}});
  expect(result.report.sources.find(row=>row.id===b.id)?.state).toBe('extraction_failed');
});
test('snapshot and report contracts reject duplicate, altered and oversized input',async()=>{
  const {a,b,text}=await fixture();
  const raw=JSON.parse(text);
  for(const edit of [(v:any)=>{v.authority_verified=true;},(v:any)=>{v.sources.reverse();},
    (v:any)=>{v.sources.push(v.sources[0]);},(v:any)=>{v.sources[0].sources[0].role='revised';},
    (v:any)=>{v.sources[0].sources[0].passages[0].ordinal=0;}]){
    const copy=structuredClone(raw);edit(copy);
    expect(()=>parseCollectionSnapshot(JSON.stringify(copy,null,2)+'\n')).toThrow();
  }
  expect(()=>parseCollectionSnapshot(text.trim())).toThrow();
  expect(()=>parseCollectionSnapshot('x'.repeat(MAX_COLLECTION_SNAPSHOT_BYTES+1))).toThrow();
  await expect(loadCollectionSnapshot(new File([new Uint8Array([255])],'bad.json'),signal())).rejects.toThrow();
  await expect(replayCollectionSources(text,[a.file,a.file],{signal:signal(),extract})).rejects.toThrow();
  const report=await replayCollectionSources(text,[a.file,b.file],{signal:signal(),extract});
  await expect(verifyCollectionSourceReplay(report.text.replace('"authority_verified": false','"authority_verified": true'),
    text,[a.file,b.file],{signal:signal(),extract})).rejects.toThrow();
});
test('cancellation during hashing or extraction does not emit a partial report',async()=>{
  const {a,b,text}=await fixture();
  const stopped=new AbortController();stopped.abort();
  await expect(replayCollectionSources(text,[a.file,b.file],{signal:stopped.signal,extract})).rejects.toThrow();
  const active=new AbortController();
  await expect(replayCollectionSources(text,[a.file,b.file],{signal:active.signal,extract:async file=>{
    active.abort();return corpus(await file.text());
  }})).rejects.toThrow();
});
