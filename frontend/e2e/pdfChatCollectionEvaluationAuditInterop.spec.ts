import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {collectionEvalCaseKey,serializeCollectionEvalLabels,serializeCollectionEvalReport,type CollectionEvalCase} from '../src/pdfChatCollectionEvaluation';
import {evaluateVariants,serializeVariantEvaluation} from '../src/pdfChatQuestionVariants';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),limited:false,limitedPages:[],
  }));
}
const program=[
  'import json, sys',
  'from noticebridge.chat_collection_evaluation_audit import audit_evaluation',
  'p=json.load(sys.stdin)',
  'result=audit_evaluation(p["report"].encode(), p["labels"].encode(), p["snapshot"].encode())',
  'print(json.dumps(result))',
].join('\n');
function audit(report:string,labels:string,snapshot:string){
  return JSON.parse(execFileSync(process.env.NOTICEBRIDGE_PYTHON??'python',['-c',program],{
    cwd:'../backend',input:JSON.stringify({report,labels,snapshot}),encoding:'utf8',timeout:15000,
  }));
}
test('Python independently recomputes browser evaluation and paired experiment metrics',async()=>{
  const a=await add([],'a',[['Application fee: INR 500','Application fee: INR 250'],[]]);
  const b=await add([a],'b',[['Eligibility: Class 12']]);
  const docs=[a,b],snapshot=serializeCollectionSnapshot(docs);
  const targets:CollectionEvalCase[]=[
    {documentId:a.id,question:'Application fee on page 1?',includeContext:false,label:'evidence',expected:[{source:a.corpus.passages[1]}],note:'Private human note'},
    {documentId:b.id,question:'Unobtainium?',includeContext:false,label:'no_expected_match',expected:[],note:''},
  ];
  const labels=await serializeCollectionEvalLabels(docs,targets,signal());
  const evaluation=await serializeCollectionEvalReport(docs,targets,signal());
  const verified=audit(evaluation,labels,snapshot);
  expect(verified.metrics).toEqual(JSON.parse(evaluation).metrics);
  expect(verified).toMatchObject({metrics_recomputed:true,retrieval_replayed:false,authority_verified:false});
  const variants=await evaluateVariants(docs,labels,[
    {caseKey:collectionEvalCaseKey(targets[0]),question:targets[0].question,includeContext:true,equivalenceConfirmed:true},
    {caseKey:collectionEvalCaseKey(targets[1]),question:'Eligibility?',includeContext:false,equivalenceConfirmed:true},
  ],signal());
  const report=serializeVariantEvaluation(variants,true),checked=audit(report,labels,snapshot);
  expect(checked.metrics).toEqual(JSON.parse(report).metrics);expect(checked.outcomes).toEqual(variants.outcomes);
  expect(JSON.stringify(checked)).not.toContain('Private human note');
  const forged=JSON.parse(report);forged.outcomes.improved=99;
  expect(()=>audit(JSON.stringify(forged,null,2)+'\n',labels,snapshot)).toThrow();
});
