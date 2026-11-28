import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {collectionQuality,filterQualityPages,filterQualityFragments,qualityPage,inspectQualityFragment,exportCollectionQuality,verifyQualityReport} from '../src/pdfChatCollectionQuality';
import type {Passage} from '../src/pdfChatCore';
const signal=()=>new AbortController().signal;
function row(page:number,ordinal:number,text:string,geometry=true):Passage{
  return {role:'original',page,ordinal,text,...(geometry?{position:{x0:10,x1:20,y:50,height:8}}:{})};
}
async function add(docs:CollectionDocument[],bytes:string,passages:Passage[],processed=3,physical=3){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages,pageCount:physical,processedPages:processed,missingPages:Array.from({length:processed},(_,i)=>i+1).filter(page=>!passages.some(source=>source.page===page)),
    limited:physical>processed,limitedPages:[],
  }));
}
test('quality flags distinguish exact duplicates within pages and across pages',async()=>{
  const a=await add([],'a',[row(1,1,'Shared line'),row(1,2,'Shared line'),row(1,3,'broken \ufffd'),row(1,4,'\ue000',false),row(2,1,'Shared line'),row(2,2,'Normal text')],3,1000);
  const b=await add([a],'b',[row(1,1,'Shared line')],1,1);
  const docs=[a,b],result=collectionQuality(docs,[a.id,b.id]);
  expect(result.fragments).toBe(7);expect(result.flaggedFragments).toBe(5);
  expect(result.counts).toEqual({replacement:1,private_use:1,control:0,no_letters_or_digits:1,missing_geometry:1,duplicate_on_page:2,repeated_across_pages:3});
  const source=result.sources[0];
  expect(source.pages).toHaveLength(3);expect(source.unprocessedPages).toBe(997);
  expect(source.pages[2].coverage).toBe('no_indexed_text');
  expect(result.sources[1].flaggedFragments).toBe(0);
  expect(filterQualityPages(source,{flag:'all',coverage:'all',onlyFlagged:true}).map(page=>page.page)).toEqual([1,2,3]);
  expect(filterQualityPages(source,{flag:'duplicate_on_page',coverage:'all',onlyFlagged:true}).map(page=>page.page)).toEqual([1]);
  const item=filterQualityFragments(source.pages[0],'replacement')[0];
  expect(inspectQualityFragment(docs,result,a.id,item)).toBe(a.corpus.passages[2]);
  expect(()=>inspectQualityFragment(docs,result,b.id,item)).toThrow();
  expect(()=>inspectQualityFragment(docs,result,a.id,{...item})).toThrow();
});
test('quality count is per fragment not per character or cross-document text',async()=>{
  const a=await add([],'a',[row(1,1,'\ufffd\ufffd'),row(1,2,'\u200dabc'),row(1,3,'123'),row(1,4,'--')],1,1);
  const result=collectionQuality([a],[a.id]);
  expect(result.counts.replacement).toBe(1);expect(result.counts.control).toBe(1);
  expect(result.counts.no_letters_or_digits).toBe(2);
  expect(result.flaggedFragments).toBe(3);
  expect(qualityPage([],1)).toMatchObject({first:0,last:0,pages:1});
  expect(()=>qualityPage([],2)).toThrow();
  expect(()=>collectionQuality([a],[a.id,a.id])).toThrow();
  expect(()=>collectionQuality([a],[])).toThrow();
});
test('quality export is exact snapshot-bound and avoids text or filenames',async()=>{
  const a=await add([],'a',[row(1,1,'private \ufffd excerpt')],1,1),docs=[a],snapshot=serializeCollectionSnapshot(docs);
  await expect(exportCollectionQuality(docs,[a.id],false,signal())).rejects.toThrow();
  const report=await exportCollectionQuality(docs,[a.id],true,signal());
  expect(report).not.toContain('private.pdf');expect(report).not.toContain('excerpt');
  const result=await verifyQualityReport(report,snapshot,signal());
  expect(result).toMatchObject({authority_verified:false,pdf_bytes_verified:false,flagged_fragments:1});
  expect(result.sources[0].pages[0].flagged).toEqual([{ordinal:1,flags:['replacement']}]);
  const raw=JSON.parse(report);raw.counts.replacement=0;
  await expect(verifyQualityReport(JSON.stringify(raw,null,2)+'\n',snapshot,signal())).rejects.toThrow();
  await expect(verifyQualityReport(report.trim(),snapshot,signal())).rejects.toThrow();
  const ctrl=new AbortController();ctrl.abort();
  await expect(exportCollectionQuality(docs,[a.id],true,ctrl.signal)).rejects.toThrow();
});
