import {expect,test} from '@playwright/test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {admitCollectionDocument,runCollectionStep,serializeCollectionPlan} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {exportQuestionBrief,verifyQuestionBrief,questionBriefReadingCopy} from '../src/pdfChatQuestionBrief';
import {main,parseBriefArguments} from '../evaluation/collectionBrief';
const signal=()=>new AbortController().signal;
async function fixture(){
  const doc=await admitCollectionDocument([],new File(['a'],'private.pdf'),signal(),async()=>({
    passages:[{role:'original' as const,page:1,ordinal:1,text:'Application fee: INR 500'},
      {role:'original' as const,page:2,ordinal:1,text:'Eligibility: Class 12'}],
    pageCount:2,processedPages:2,missingPages:[],limited:false,limitedPages:[],
  }));
  const docs=[doc],turn=runCollectionStep(docs,{question:'Application fee? Eligibility on page 2?',documentIds:[doc.id],includeContext:false});
  return {docs,turn,snapshot:serializeCollectionSnapshot(docs),plan:serializeCollectionPlan(docs,[turn.step])};
}
test('offline brief output matches browser replay, reading copy and exclusive writes',async()=>{
  const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'noticebridge-brief-'));
  try{
    const snapshot=join(dir,'snapshot.json'),plan=join(dir,'plan.json'),output=join(dir,'brief.json');
    const verified=join(dir,'verified.json'),reading=join(dir,'reading.txt'),bad=join(dir,'bad.json');
    writeFileSync(snapshot,f.snapshot);writeFileSync(plan,f.plan);
    const args=['--snapshot',snapshot,'--plan',plan,'--turn','1','--part','2','--output',output];
    expect(await main(args)).toBe(0);
    const expected=await exportQuestionBrief(f.docs,f.turn,1,true,signal());
    expect(readFileSync(output,'utf8')).toBe(expected);
    expect(await main(args)).toBe(1);expect(readFileSync(output,'utf8')).toBe(expected);
    expect(await main(['--snapshot',snapshot,'--verify-report',output,'--output',verified])).toBe(0);
    expect(readFileSync(verified,'utf8')).toBe(expected);
    expect(await main(['--snapshot',snapshot,'--verify-report',output,'--reading-copy','--output',reading])).toBe(0);
    expect(readFileSync(reading,'utf8')).toBe(questionBriefReadingCopy(await verifyQuestionBrief(expected,f.snapshot,signal())));
    expect(await main(args.map(v=>v===output?bad:v==='2'?'3':v))).toBe(1);
    expect(existsSync(bad)).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('CLI argument parser requires explicit valid input scope and output type',()=>{
  const good=['--snapshot','a.json','--plan','b.json','--turn','1','--part','2','--output','c.json'];
  expect(parseBriefArguments(good)).toMatchObject({turn:1,part:2,readingCopy:false});
  for(const args of [[...good,'--verify-report','d.json'],[...good,'--reading-copy'],
    good.map(v=>v==='2'?'0':v),good.map(v=>v==='c.json'?'a.json':v),
    good.map(v=>v==='1'?'01':v),good.slice(0,-2),[...good,'--turn','2']]){
    expect(()=>parseBriefArguments(args)).toThrow();
  }
});
