import {test,expect} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {compareCollectionSnapshots,serializeSnapshotDifference,verifySnapshotDifference,filterSnapshotDifferences,snapshotDifferencePage} from '../src/pdfChatSnapshotDifference';
import type {Passage} from '../src/pdfChatCore';
const signal=()=>new AbortController().signal;
const line=(page:number,ordinal:number,text:string,x0?:number):Passage=>({page,ordinal,text,role:'original',...(x0===undefined?{}:{position:{x0,x1:x0+10,y:30,height:8}})});
async function doc(docs:CollectionDocument[],bytes:string,passages:Passage[],pageCount=2,limited=false){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({passages,pageCount,processedPages:pageCount,missingPages:Array.from({length:pageCount},(_,i)=>i+1).filter(page=>!passages.some(row=>row.page===page)),limitedPages:[],limited}));
}
test('snapshot coordinate merge separates text, geometry and membership changes',async()=>{
  const a=await doc([],'same bytes',[line(1,1,'identical',1),line(1,2,'old text',2),line(1,3,'same wording',3),line(1,4,'old wording',4),line(2,1,'left only')]);
  const b=await doc([],'same bytes',[line(1,1,'identical',1),line(1,2,'new text',2),line(1,3,'same wording',9),line(1,4,'new wording',9),line(2,2,'right only')]);
  const left=serializeCollectionSnapshot([a]),right=serializeCollectionSnapshot([b]);
  const result=await compareCollectionSnapshots(left,right,signal());
  expect(result.sameFingerprintSet).toBe(true);expect(result.exactSnapshotMatch).toBe(false);
  expect(result.counts).toEqual({identical:1,text:1,geometry:1,text_and_geometry:1,left_only:1,right_only:1});
  const source=result.sources[0];
  expect(source.coverage?.matches).toBe(true);expect(source.status).toBe('different');
  expect(source.pages.map(row=>row.page)).toEqual([1,2]);
  expect(filterSnapshotDifferences(source,{kind:'changed',page:2}).map(row=>row.kind)).toEqual(['left_only','right_only']);
  expect(filterSnapshotDifferences(source,{kind:'geometry',page:null})[0].left?.text).toBe('same wording');
  expect(snapshotDifferencePage(source.fragments,1)).toHaveLength(6);
  expect(()=>snapshotDifferencePage(source.fragments,2)).toThrow();
  const report=serializeSnapshotDifference(result);
  expect(report).not.toContain('old text');expect(report).not.toContain('private.pdf');
  expect(JSON.parse(report)).toMatchObject({authority_verified:false,pdf_bytes_verified:false,extraction_completeness_verified:false});
  expect(await verifySnapshotDifference(report,left,right,signal())).toEqual(result);
  await expect(verifySnapshotDifference(report,left,left,signal())).rejects.toThrow();
  await expect(verifySnapshotDifference(report.trim(),left,right,signal())).rejects.toThrow();
});
test('same text in different claimed sources is never paired',async()=>{
  const a=await doc([],'left',[line(1,1,'shared words')]),b=await doc([],'right',[line(1,1,'shared words')]);
  const result=await compareCollectionSnapshots(serializeCollectionSnapshot([a]),serializeCollectionSnapshot([b]),signal());
  expect(result.sameFingerprintSet).toBe(false);expect(result.counts.identical).toBe(0);
  expect(result.counts.left_only).toBe(1);expect(result.counts.right_only).toBe(1);
  expect(result.sources.map(row=>row.status).sort()).toEqual(['left_only','right_only']);
  expect(result.sources.every(row=>row.coverage===null)).toBe(true);
});
test('coverage-only differences do not imply text changes',async()=>{
  const a=await doc([],'same',[line(1,1,'same text')]),b=await doc([],'same',[line(1,1,'same text')],2,true);
  const result=await compareCollectionSnapshots(serializeCollectionSnapshot([a]),serializeCollectionSnapshot([b]),signal());
  expect(result.sources[0].status).toBe('different');expect(result.sources[0].coverage?.matches).toBe(false);
  expect(result.counts.identical).toBe(1);expect(result.counts.text).toBe(0);
});
test('identical canonical snapshots and aborts are explicit',async()=>{
  const a=await doc([],'a',[line(1,1,'hello')]),b=await doc([a],'b',[line(2,1,'world')]);
  const left=serializeCollectionSnapshot([a,b]),right=serializeCollectionSnapshot([b,a]);
  const result=await compareCollectionSnapshots(left,right,signal());
  expect(result.exactSnapshotMatch).toBe(true);expect(result.sources.every(row=>row.status==='identical')).toBe(true);
  const controller=new AbortController();controller.abort();
  await expect(compareCollectionSnapshots(left,right,controller.signal)).rejects.toThrow();
  await expect(compareCollectionSnapshots(left+' ',right,signal())).rejects.toThrow();
  expect(()=>filterSnapshotDifferences(result.sources[0],{kind:'all',page:0})).toThrow();
});
