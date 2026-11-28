import {expect,test} from '@playwright/test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {admitCollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {serializeCollectionEvalLabels,collectionEvalCaseKey,type CollectionEvalCase} from '../src/pdfChatCollectionEvaluation';
import {serializeVariantPlan,parseVariantPlan,runVariantPlan,loadVariantPlan} from '../src/pdfChatVariantPlan';
import {evaluateVariants,serializeVariantEvaluation} from '../src/pdfChatQuestionVariants';
import {parseVariantArguments,main} from '../evaluation/collectionVariants';
const signal=()=>new AbortController().signal;
async function fixture(){
  const doc=await admitCollectionDocument([],new File(['private bytes'],'private.pdf'),signal(),async()=>({
    passages:[{role:'original',page:1,ordinal:1,text:'Application fee: INR 500'}],
    pageCount:1,processedPages:1,missingPages:[],limitedPages:[],limited:false,
  }));
  const docs=[doc],target:CollectionEvalCase={documentId:doc.id,question:'Application fee?',includeContext:false,
    label:'evidence',expected:[{source:doc.corpus.passages[0]}],note:'Private human note'};
  const labels=await serializeCollectionEvalLabels(docs,[target],signal());
  const drafts=[{caseKey:collectionEvalCaseKey(target),question:target.question,includeContext:true,equivalenceConfirmed:true}];
  const snapshot=serializeCollectionSnapshot(docs),plan=await serializeVariantPlan(docs,labels,drafts,true,signal());
  return {docs,target,labels,drafts,snapshot,plan};
}
test('paired plan has no retrieved text and exact label binding',async()=>{
  const f=await fixture();
  expect(f.plan).not.toContain('Private human note');expect(f.plan).not.toContain('INR 500');expect(f.plan).not.toContain('private.pdf');
  expect(await parseVariantPlan(f.plan,f.docs,f.labels,signal())).toEqual(f.drafts);
  expect(await loadVariantPlan(new File([f.plan],'plan.json'),f.docs,f.labels,signal())).toEqual(f.drafts);
  const direct=serializeVariantEvaluation(await evaluateVariants(f.docs,f.labels,f.drafts,signal()),true);
  expect((await runVariantPlan(f.plan,f.docs,f.labels,signal())).text).toBe(direct);
  await expect(serializeVariantPlan(f.docs,f.labels,f.drafts,false,signal())).rejects.toThrow();
  const changed=await serializeCollectionEvalLabels(f.docs,[{...f.target,note:'Other note'}],signal());
  await expect(parseVariantPlan(f.plan,f.docs,changed,signal())).rejects.toThrow();
  await expect(parseVariantPlan(f.plan.trim(),f.docs,f.labels,signal())).rejects.toThrow();
  const raw=JSON.parse(f.plan);raw.cases[0].equivalence_confirmed=false;
  await expect(parseVariantPlan(JSON.stringify(raw,null,2)+'\n',f.docs,f.labels,signal())).rejects.toThrow();
});
test('offline run and verify produce the same canonical report and reject overwrite',async()=>{
  const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'noticebridge-variant-'));
  try{
    const snapshot=join(dir,'snapshot.json'),labels=join(dir,'labels.json'),plan=join(dir,'plan.json'),report=join(dir,'report.json'),verified=join(dir,'verified.json');
    writeFileSync(snapshot,f.snapshot);writeFileSync(labels,f.labels);writeFileSync(plan,f.plan);
    const args=['--snapshot',snapshot,'--labels',labels];
    expect(await main(['--mode','run',...args,'--input',plan,'--output',report])).toBe(0);
    const expected=(await runVariantPlan(f.plan,f.docs,f.labels,signal())).text;
    expect(readFileSync(report,'utf8')).toBe(expected);
    expect(await main(['--mode','verify',...args,'--input',report,'--output',verified])).toBe(0);
    expect(readFileSync(verified,'utf8')).toBe(expected);
    expect(await main(['--mode','run',...args,'--input',plan,'--output',report])).toBe(1);
    const malformed=join(dir,'bad.json'),out=join(dir,'not-created.json');
    writeFileSync(malformed,'{}');
    expect(await main(['--mode','run',...args,'--input',malformed,'--output',out])).toBe(1);
    expect(existsSync(out)).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('paired command rejects duplicate artifact paths and modes',()=>{
  const args=['--mode','run','--snapshot','a.json','--labels','b.json','--input','c.json','--output','d.json'];
  expect(parseVariantArguments(args).mode).toBe('run');
  expect(()=>parseVariantArguments([...args,'--extra','x'])).toThrow();
  expect(()=>parseVariantArguments(args.map(value=>value==='d.json'?'./a.json':value))).toThrow();
  expect(()=>parseVariantArguments(args.map(value=>value==='run'?'unknown':value))).toThrow();
});
