import {test,expect} from '@playwright/test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {admitCollectionDocument,serializeCollectionPlan,serializeCollectionEvidence,verifyCollectionEvidence,
  runIndexedCollectionStep,type CollectionDocument,type CollectionStep} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {serializeCollectionEvalLabels,serializeCollectionEvalReport,type CollectionEvalCase} from '../src/pdfChatCollectionEvaluation';
import {captureCollectionRegressionRun,parseCollectionRegressionRun} from '../src/pdfChatCollectionRegression';
import {loadSnapshotIndexes,parseReplayArguments,replaySnapshot,main} from '../evaluation/replayCollection';
const signal=()=>new AbortController().signal;
const encode=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
async function fixture(){
  async function add(docs:CollectionDocument[],bytes:string,lines:string[][],limited=false){
    return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
      passages:lines.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
      pageCount:lines.length,processedPages:lines.length,missingPages:lines.flatMap((rows,i)=>rows.length?[]:[i+1]),
      limited,limitedPages:[],
    }));
  }
  const a=await add([],'a',[['Application fee: INR 500','Eligibility: Class 12'],['Application fee: INR 999']]);
  const b=await add([a],'b',[['Application fee: INR 350','Registration deadline: 10 December'],[]]);
  const docs=[a,b];
  const steps:CollectionStep[]=[
    {question:'Application fee?',documentIds:[b.id,a.id],includeContext:false},
    {question:'Eligibility on page 1?',documentIds:[a.id,b.id],includeContext:true},
    {question:'Application fee on page 2?',documentIds:[a.id,b.id],includeContext:false},
    {question:'Eligibility on page 3?',documentIds:[a.id],includeContext:false},
  ];
  const cases:CollectionEvalCase[]=[
    {documentId:a.id,question:'Application fee on page 1?',includeContext:false,label:'evidence',
      note:'Human-reviewed candidate',expected:[{source:a.corpus.passages[0]}]},
    {documentId:b.id,question:'Eligibility?',includeContext:false,label:'no_expected_match',note:'',expected:[]},
  ];
  return {a,b,docs,steps,cases,snapshot:serializeCollectionSnapshot(docs),
    plan:serializeCollectionPlan(docs,steps),labels:await serializeCollectionEvalLabels(docs,cases,signal())};
}
test('snapshot indexes contain no File objects and preserve exact per-PDF answer parity',async()=>{
  const f=await fixture(),sources=loadSnapshotIndexes(f.snapshot);
  expect(sources.every(row=>!('file' in row))).toBe(true);
  expect(sources.map(row=>row.id)).toEqual([f.a.id,f.b.id].sort());
  const result=await replaySnapshot('questions',f.snapshot,f.plan,signal());
  expect(result.text).toBe(serializeCollectionEvidence(f.docs,f.steps));
  expect(result.summary).toMatchObject({documents:2,questions:4,pdf_bytes_verified:false,native_extraction_replayed:false});
  expect(verifyCollectionEvidence(result.text,f.docs).questions).toBe(4);
  const row=runIndexedCollectionStep(sources,f.steps[2]);
  expect(row.results[0].parts[0].answer.citations[0].text).toBe('Application fee: INR 999');
  expect(row.results[1].parts[0].coverage).toBe('no_indexed_text');
  expect(runIndexedCollectionStep(sources,f.steps[3]).results[0].parts[0].coverage).toBe('not_present');
});
test('evaluation and regression output exactly match browser artifacts, including abstentions',async()=>{
  const f=await fixture();
  const result=await replaySnapshot('labels',f.snapshot,f.labels,signal());
  expect(result.text).toBe(await serializeCollectionEvalReport(f.docs,f.cases,signal()));
  expect(JSON.parse(result.text).metrics).toMatchObject({cases:2,microRecall:1,correctAbstentions:1});
  const run=await replaySnapshot('regression',f.snapshot,f.labels,signal());
  expect(run.text).toBe((await captureCollectionRegressionRun(f.docs,f.cases,signal())).text);
  expect((await parseCollectionRegressionRun(run.text,f.docs,f.cases,signal())).evaluation.metrics.microRecall).toBe(1);
});
test('verification binds actual artifact content, snapshot and labels without claiming PDF verification',async()=>{
  const f=await fixture();
  const evidence=(await replaySnapshot('questions',f.snapshot,f.plan,signal())).text;
  const evaluation=(await replaySnapshot('labels',f.snapshot,f.labels,signal())).text;
  const verified=await replaySnapshot('verify-evidence',f.snapshot,evidence,signal());
  expect(JSON.parse(verified.text)).toMatchObject({exact_replay:true,pdf_bytes_verified:false,
    native_extraction_replayed:false,authority_verified:false});
  const checked=await replaySnapshot('verify-evaluation',f.snapshot,evaluation,signal(),f.labels);
  expect(JSON.parse(checked.text)).toMatchObject({exact_replay:true,cases:2});
  await expect(replaySnapshot('verify-evidence',f.snapshot,evidence.replace('INR 500','INR 501'),signal())).rejects.toThrow();
  await expect(replaySnapshot('verify-evaluation',f.snapshot,evaluation.replace('"microRecall": 1','"microRecall": 0'),signal(),f.labels)).rejects.toThrow();
  await expect(replaySnapshot('verify-evaluation',f.snapshot,evaluation,signal(),f.labels.replace('Human-reviewed','Other'))).rejects.toThrow();
});
test('invalid source sets, malformed plan and label coordinates reject offline just as in browser',async()=>{
  const f=await fixture();
  for(const mutate of [
    (v:any)=>{v.source_ids.reverse();},
    (v:any)=>{v.questions[0].documentIds.push(v.questions[0].documentIds[0]);},
    (v:any)=>{v.questions[0].documentIds=['a'.repeat(64)];},
    (v:any)=>{v.questions[0].question='';},
    (v:any)=>{v.questions[0].includeContext='true';},
    (v:any)=>{v.questions[0].untrusted='extra';},
  ]){
    const raw=JSON.parse(f.plan);mutate(raw);
    await expect(replaySnapshot('questions',f.snapshot,encode(raw),signal())).rejects.toThrow();
  }
  for(const mutate of [
    (v:any)=>{v.authority_verified=true;},
    (v:any)=>{v.source_ids.pop();},
    (v:any)=>{v.cases.push(v.cases[0]);},
    (v:any)=>{v.cases[0].expected[0].page=2;},
    (v:any)=>{v.cases[0].expected[0].ordinal=999;},
    (v:any)=>{v.cases[0].expected[0].text_sha256='0'.repeat(64);},
    (v:any)=>{v.cases[1].label='evidence';},
  ]){
    const raw=JSON.parse(f.labels);mutate(raw);
    await expect(replaySnapshot('labels',f.snapshot,encode(raw),signal())).rejects.toThrow();
  }
  await expect(replaySnapshot('questions',f.snapshot.trim(),f.plan,signal())).rejects.toThrow();
  await expect(replaySnapshot('questions',f.snapshot,f.plan.trim(),signal())).rejects.toThrow();
  const stopped=new AbortController();stopped.abort();
  await expect(replaySnapshot('questions',f.snapshot,f.plan,stopped.signal)).rejects.toThrow();
});
test('argument parser refuses extra, repeated, missing and non-JSON paths',()=>{
  const args=['--mode','questions','--snapshot','source.json','--input','plan.json','--output','result.json'];
  expect(parseReplayArguments(args).mode).toBe('questions');
  for(const invalid of [args.slice(0,-1),[...args,'--mode','labels'],[...args,'--extra','x'],
    [...args,'--labels','labels.json'],args.map(x=>x==='questions'?'fake':x),
    args.map(x=>x==='source.json'?'source.pdf':x)])expect(()=>parseReplayArguments(invalid)).toThrow();
  expect(()=>parseReplayArguments(args.map(x=>x==='questions'?'verify-evaluation':x))).toThrow();
});
test('CLI publishes exclusive outputs only after successful validation',async()=>{
  const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'noticebridge-collection-'));
  try{
    const snapshot=join(dir,'snapshot.json'),input=join(dir,'plan.json'),output=join(dir,'out.json');
    writeFileSync(snapshot,f.snapshot);writeFileSync(input,f.plan);
    const args=['--mode','questions','--snapshot',snapshot,'--input',input,'--output',output];
    expect(await main(args)).toBe(0);
    const original=readFileSync(output,'utf8');
    expect(original).toBe(serializeCollectionEvidence(f.docs,f.steps));
    expect(await main(args)).toBe(1);
    expect(readFileSync(output,'utf8')).toBe(original);
    writeFileSync(input,'invalid');
    const invalidOutput=join(dir,'invalid.json');
    expect(await main([...args.slice(0,-1),invalidOutput])).toBe(1);
    expect(existsSync(invalidOutput)).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
