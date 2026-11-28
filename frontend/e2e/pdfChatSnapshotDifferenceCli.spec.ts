import {expect,test} from '@playwright/test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {admitCollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {parseSnapshotDifferenceArguments,runSnapshotDifference,main} from '../evaluation/compareCollectionSnapshots';
const signal=()=>new AbortController().signal;
async function snapshot(text:string){
  const doc=await admitCollectionDocument([],new File(['same bytes'],'private.pdf'),signal(),async()=>({
    passages:[{role:'original',page:1,ordinal:1,text}],pageCount:1,processedPages:1,limited:false,missingPages:[],limitedPages:[],
  }));
  return serializeCollectionSnapshot([doc]);
}
test('CLI writes coordinate-only difference and reproduces against the exact two snapshots',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'noticebridge-difference-'));
  try{
    const left=join(directory,'a.json'),right=join(directory,'b.json'),output=join(directory,'diff.json'),verified=join(directory,'verified.json');
    writeFileSync(left,await snapshot('private left phrase'));writeFileSync(right,await snapshot('private right phrase'));
    const args=['--left',left,'--right',right,'--output',output,'--require-exact'];
    const result=await runSnapshotDifference(parseSnapshotDifferenceArguments(args),signal());
    expect(result.status).toBe(3);
    expect(result.summary).toMatchObject({exact_snapshot_match:false,same_fingerprint_set:true,pdf_bytes_verified:false});
    const report=readFileSync(output,'utf8');
    expect(report).not.toContain('private left phrase');expect(report).not.toContain('private right phrase');
    expect(await main(args)).toBe(1);expect(readFileSync(output,'utf8')).toBe(report);
    expect(await main(['--left',left,'--right',right,'--verify-report',output,'--output',verified])).toBe(0);
    expect(readFileSync(verified,'utf8')).toBe(report);
    writeFileSync(right,readFileSync(left));
    const invalid=join(directory,'invalid.json');
    expect(await main(['--left',left,'--right',right,'--verify-report',output,'--output',invalid])).toBe(1);
    expect(existsSync(invalid)).toBe(false);
    expect(await main(['--left',left,'--right',right,'--output',invalid,'--require-exact'])).toBe(0);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('argument parser rejects ambiguous or unsafe output aliases',()=>{
  for(const args of [[],['--left','a.pdf','--right','b.json','--output','c.json'],
    ['--left','a.json','--right','b.json','--output','./a.json'],['--left','a.json','--right','b.json','--output','c.json','--require-exact','--require-exact'],
    ['--left','a.json','--right','b.json','--output','c.json','--verify-report','c.json'],
    ['--left','a.json','--right','b.json','--output','c.json','--unknown']])
    expect(()=>parseSnapshotDifferenceArguments(args)).toThrow();
  expect(parseSnapshotDifferenceArguments(['--left','a.json','--right','a.json','--output','c.json']).requireExact).toBe(false);
});
