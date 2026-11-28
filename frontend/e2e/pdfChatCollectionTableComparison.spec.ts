import {expect,test} from '@playwright/test';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionTableInventory} from '../src/pdfChatCollectionLayout';
import {compareCollectionTables,filterTableComparison,tableComparisonPage,inspectTableComparisonCell,
  serializeTableComparison,verifyTableComparison,readTableComparison} from '../src/pdfChatCollectionTableComparison';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,rows:string[][],page=1){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:rows.flatMap((row,i)=>row.map((text,j)=>({role:'original' as const,page,ordinal:i*row.length+j+1,text,
      position:{x0:20+j*200,x1:100+j*200,y:700-i*24,height:12}}))),
    pageCount:page,processedPages:page,missingPages:Array.from({length:page-1},(_,i)=>i+1),limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Category','Application fee','Eligibility'],['General','INR 500','Class 12'],['Rural','INR 250','Class 10']]);
  const b=await add([a],'b',[['Category','Application fee'],['GENERAL','INR 350'],['Urban','INR 250']],2);
  const docs=[a,b],choices=collectionTableInventory(docs,[a.id,b.id]).map(side=>({documentId:side.documentId,key:side.tables[0].key}));
  return {a,b,docs,choices};
}
test('explicit table comparison separates missing categories and fields from literal differences',async()=>{
  const {a,b,docs,choices}=await fixture();
  const result=compareCollectionTables(docs,choices);
  const general=result.rows.find(row=>row.categoryKey==='general'&&row.field==='application_fee')!;
  expect(general.state).toBe('different_text');
  expect(general.differentCategoryLabels).toBe(true);
  expect(general.cells.map(cell=>cell.value?.text)).toEqual(['INR 500','INR 350']);
  expect(general.cells.map(cell=>cell.value?.page)).toEqual([1,2]);
  expect(result.rows.find(row=>row.categoryKey==='general'&&row.field==='eligibility')?.cells[1].state).toBe('missing_field');
  expect(result.rows.find(row=>row.categoryKey==='rural'&&row.field==='application_fee')?.cells[1].state).toBe('missing_category');
  expect(result.rows.find(row=>row.categoryKey==='rural'&&row.field==='eligibility')?.cells[1].state).toBe('missing_both');
  expect(result.rows.find(row=>row.categoryKey==='urban'&&row.field==='application_fee')?.cells[0].state).toBe('missing_category');
  expect(result.limited).toBe(true);
  expect(inspectTableComparisonCell(docs,result,general,general.cells[0],general.cells[0].value!)).toBe(a.corpus.passages[4]);
  expect(()=>inspectTableComparisonCell(docs,result,general,general.cells[0],b.corpus.passages[3])).toThrow();
});
test('selection is explicit and no table from the same PDF is silently reused',async()=>{
  const {docs,choices}=await fixture();
  expect(()=>compareCollectionTables(docs,choices.slice(0,1))).toThrow();
  expect(()=>compareCollectionTables(docs,[choices[0],choices[0]])).toThrow();
  expect(()=>compareCollectionTables(docs,[choices[0],{...choices[1],key:choices[0].key}])).toThrow();
  const result=compareCollectionTables(docs,[...choices].reverse());
  expect(result.tables.map(row=>row.documentId)).toEqual([choices[1].documentId,choices[0].documentId]);
  expect(filterTableComparison(result,{state:'different_text',field:'all',category:'GENERAL'})).toHaveLength(1);
  expect(filterTableComparison(result,{state:'same_text',field:'all',category:''})).toEqual([]);
  expect(tableComparisonPage([],1)).toEqual({pages:1,rows:[],first:0,last:0});
  expect(()=>tableComparisonPage([],2)).toThrow();
});
test('private report recomputes all cells and binds the full extraction snapshot',async()=>{
  const {docs,choices}=await fixture();
  await expect(serializeTableComparison(docs,choices,false)).rejects.toThrow();
  const text=await serializeTableComparison(docs,choices,true);
  expect(text).toContain('INR 500');
  expect(text).not.toContain('private.pdf');
  expect((await verifyTableComparison(text,[...docs].reverse())).counts).toEqual(compareCollectionTables(docs,choices).counts);
  for(const mutate of [
    (v:any)=>{v.authority_verified=true;},
    (v:any)=>{v.rows[0].cells[0].value.text='forged';},
    (v:any)=>{v.snapshot_sha256='0'.repeat(64);},
    (v:any)=>{v.choices.reverse();},
    (v:any)=>{v.counts.missing++;},
  ]){
    const raw=JSON.parse(text);mutate(raw);
    await expect(verifyTableComparison(JSON.stringify(raw,null,2)+'\n',docs)).rejects.toThrow();
  }
  expect(await readTableComparison(new File([text],'table.json'),signal())).toBe(text);
  await expect(readTableComparison(new File([new Uint8Array([255])],'bad.json'),signal())).rejects.toThrow();
  const cancelled=new AbortController();cancelled.abort();
  await expect(verifyTableComparison(text,docs,cancelled.signal)).rejects.toThrow();
});
