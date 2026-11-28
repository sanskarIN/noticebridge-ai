import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {type CollectionEvalCase,evaluateCollection,evaluateCollectionAsync} from '../src/pdfChatCollectionEvaluation';
import {captureCollectionRegressionRun,parseCollectionRegressionRun,compareCollectionRegressionFile,
  compareCollectionRegressionRuns,readCollectionRegressionFile,MAX_REGRESSION_RUN_BYTES} from '../src/pdfChatCollectionRegression';

const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,texts:string[],page2:string[]=[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:[...texts.map((text,i)=>({role:'original' as const,page:1,ordinal:i+1,text})),
      ...page2.map((text,i)=>({role:'original' as const,page:2,ordinal:i+1,text}))],
    pageCount:page2.length?2:1,processedPages:page2.length?2:1,
    missingPages:texts.length?[]:[1],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',['Application fee: INR 500','Eligibility: Class 12'],['Application fee: INR 999']);
  const b=await add([a],'b',['Application fee: INR 350']);
  const docs=[a,b];
  const cases:CollectionEvalCase[]=[
    {documentId:a.id,question:'Application fee on page 1?',includeContext:false,
      label:'evidence',expected:[{source:a.corpus.passages[0]}],note:'Reviewed'},
    {documentId:b.id,question:'Eligibility?',includeContext:false,label:'no_expected_match',expected:[],note:''},
  ];
  return {a,b,docs,cases};
}
const encode=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
test('asynchronous evaluator matches synchronous evaluation and reports exact progress',async()=>{
  const {docs,cases}=await fixture();
  const progress:number[][]=[];
  const observed=await evaluateCollectionAsync(docs,cases,signal(),(done,total)=>progress.push([done,total]),async()=>{});
  expect(observed).toEqual(evaluateCollection(docs,cases));
  expect(progress).toEqual([[0,2],[1,2],[2,2]]);
});
test('asynchronous evaluation stops between cases and rejects pre-aborted execution',async()=>{
  const {docs,cases}=await fixture();
  const controller=new AbortController();
  const progress:number[]=[];
  await expect(evaluateCollectionAsync(docs,cases,controller.signal,(done)=>{
    progress.push(done);if(done===1)controller.abort();
  },async()=>{})).rejects.toThrow();
  expect(progress).toEqual([0,1]);
  await expect(evaluateCollectionAsync(docs,cases,controller.signal)).rejects.toThrow();
});
test('regression capture exports only coordinate identities with source and label binding',async()=>{
  const {docs,cases}=await fixture();
  const {run,text}=await captureCollectionRegressionRun(docs,cases,signal());
  expect(text).not.toContain('INR 500');
  expect(text).not.toContain('Reviewed');
  expect(text).not.toContain('private.pdf');
  expect(text).not.toContain('microRecall');
  expect(run.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(run.labelsSha256).toMatch(/^[a-f0-9]{64}$/);
  const imported=await parseCollectionRegressionRun(text,[...docs].reverse(),cases,signal());
  expect(imported.evaluation.metrics).toEqual(run.evaluation.metrics);
  const compared=await compareCollectionRegressionFile(text,docs,cases,signal());
  expect(compared.counts.unchanged).toBe(2);
  expect(compared.metrics.every(row=>row.delta===null||row.delta===0)).toBe(true);
});
test('comparison reconstructs improvement and regression from historical coordinates, not supplied scores',async()=>{
  const {docs,cases,a}=await fixture();
  const {text}=await captureCollectionRegressionRun(docs,cases,signal());
  const old=JSON.parse(text);
  old.observations[0].retrieved=[{page:1,ordinal:2}];
  old.observations[1].retrieved=[{page:1,ordinal:1}];
  const compared=await compareCollectionRegressionFile(encode(old),docs,cases,signal());
  expect(compared.counts.improved).toBe(2);
  expect(compared.cases[0].gainedExpected).toEqual([a.corpus.passages[0]]);
  expect(compared.cases[0].removed).toEqual([a.corpus.passages[1]]);
  expect(compared.cases[1].baseline.outcome).toBe('unexpected_match');
  expect(compared.cases[1].current.outcome).toBe('expected_abstention');
  expect(compared.metrics.find(row=>row.name==='microRecall')?.delta).toBe(1);
  const reverse=compareCollectionRegressionRuns(compared.current,compared.baseline);
  expect(reverse.counts.regressed).toBe(2);
});
test('precision/recall tradeoff is mixed, with rank and gained evidence preserved',async()=>{
  const {docs,cases,a}=await fixture();
  const expanded=[{...cases[0],expected:[{source:a.corpus.passages[0]},{source:a.corpus.passages[1]}]}];
  const {text}=await captureCollectionRegressionRun(docs,expanded,signal());
  const old=JSON.parse(text);
  // Both labelled fragments are retrieved, but an alternative run can
  // change ordering independently of the number of labelled fragments.
  old.observations[0].retrieved=[{page:1,ordinal:2},{page:1,ordinal:1}];
  const compared=await compareCollectionRegressionFile(encode(old),docs,expanded,signal());
  expect(compared.cases[0].baseline.correctCount).toBe(2);
  expect(compared.cases[0].current.correctCount).toBe(1);
  expect(compared.cases[0].lostExpected).toEqual([a.corpus.passages[1]]);
  expect(compared.counts.regressed).toBe(1);
});
test('snapshot mismatch rejects changed unlabelled text, missing documents and changed labels',async()=>{
  const {docs,cases,b}=await fixture();
  const {text}=await captureCollectionRegressionRun(docs,cases,signal());
  const changed=await add([],'a',['Application fee: INR 500','Different unlabelled text'],['Application fee: INR 999']);
  const relabelled=[{...cases[0],expected:[{source:changed.corpus.passages[0]}]},cases[1]];
  await expect(parseCollectionRegressionRun(text,[changed,b],relabelled,signal())).rejects.toThrow();
  await expect(parseCollectionRegressionRun(text,docs,[{...cases[0],note:'changed'},cases[1]],signal())).rejects.toThrow();
  await expect(parseCollectionRegressionRun(text,docs,[...cases].reverse(),signal())).rejects.toThrow();
  await expect(parseCollectionRegressionRun(text,[docs[0]],cases,signal())).rejects.toThrow();
});
test('historical observations reject duplicates, out-of-scope pages, missing fragments and forged metadata',async()=>{
  const {docs,cases}=await fixture();
  const {text}=await captureCollectionRegressionRun(docs,cases,signal());
  for(const mutate of [
    (v:any)=>{v.authority_verified=true;},
    (v:any)=>{v.version=2;},
    (v:any)=>{v.metrics={microRecall:1};},
    (v:any)=>{v.observations[0].coverage='partial';},
    (v:any)=>{v.observations[0].case_key=v.observations[1].case_key;},
    (v:any)=>{v.observations[0].retrieved=[{page:1,ordinal:1},{page:1,ordinal:1}];},
    (v:any)=>{v.observations[0].retrieved=[{page:2,ordinal:1}];},
    (v:any)=>{v.observations[0].retrieved=[{page:1,ordinal:999}];},
    (v:any)=>{v.observations[0].retrieved=[{page:1,ordinal:1,text:'forged'}];},
    (v:any)=>{v.observations.pop();},
    (v:any)=>{v.observations[0].retrieved=Array.from({length:65},()=>({page:1,ordinal:1}));},
  ]){
    const raw=JSON.parse(text);mutate(raw);
    await expect(parseCollectionRegressionRun(encode(raw),docs,cases,signal())).rejects.toThrow();
  }
  await expect(parseCollectionRegressionRun(text.trim(),docs,cases,signal())).rejects.toThrow();
  await expect(parseCollectionRegressionRun('x'.repeat(MAX_REGRESSION_RUN_BYTES+1),docs,cases,signal())).rejects.toThrow();
});
test('file reading is bounded, strict UTF-8 and abortable',async()=>{
  const {docs,cases}=await fixture();
  const {text}=await captureCollectionRegressionRun(docs,cases,signal());
  expect(await readCollectionRegressionFile(new File([text],'run.json'),signal())).toBe(text);
  await expect(readCollectionRegressionFile(new File([],'empty.json'),signal())).rejects.toThrow();
  await expect(readCollectionRegressionFile(new File([new Uint8Array([255])],'invalid.json'),signal())).rejects.toThrow();
  const stopped=new AbortController();stopped.abort();
  await expect(readCollectionRegressionFile(new File([text],'run.json'),stopped.signal)).rejects.toThrow();
  await expect(parseCollectionRegressionRun(text,docs,cases,stopped.signal)).rejects.toThrow();
});
