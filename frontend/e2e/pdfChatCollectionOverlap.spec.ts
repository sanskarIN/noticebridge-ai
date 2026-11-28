import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {admitCollectionDocument,type CollectionDocument} from '../src/pdfChatCollection';
import {collectionOverlap,filterCollectionOverlap,inspectOverlapSource,overlapPage,serializeCollectionOverlap,
  verifyCollectionOverlap,readOverlapFile,normalizeOverlapScope} from '../src/pdfChatCollectionOverlap';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),
    limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Common notice heading','Common notice heading','Application fee: INR 500','A only'],['Another shared fragment']]);
  const b=await add([a],'b',[['Common notice heading','Application fee: INR 350','Another shared fragment'],[]]);
  const c=await add([a,b],'c',[['Common notice heading','application fee: INR 500','C only']]);
  const docs=[a,b,c],scope={documentIds:docs.map(doc=>doc.id),minimumLength:1,physicalPage:null};
  return {a,b,c,docs,scope};
}
test('literal overlap counts distinct documents separately from repeated native occurrences',async()=>{
  const f=await fixture(),result=collectionOverlap(f.docs,f.scope);
  expect(result.sharedGroups).toBe(2);expect(result.exclusiveGroups).toBe(5);expect(result.occurrences).toBe(11);
  const heading=result.groups[0];
  expect(heading.text).toBe('Common notice heading');expect(heading.occurrences).toBe(4);
  expect(heading.sources.map(source=>source.fragments.length)).toEqual([2,1,1]);
  expect(result.documents[0]).toMatchObject({fragments:5,distinctTexts:4,sharedTexts:2,exclusiveTexts:2});
  expect(result.pairs[0]).toMatchObject({sharedTexts:2,leftOnly:2,rightOnly:1});
  expect(result.pairs[1]).toMatchObject({sharedTexts:1,leftOnly:3,rightOnly:2});
  expect(result.documents[1].coverage).toBe('partial');
  expect(result.groups.some(row=>row.text==='application fee: INR 500'&&row.sources.length===1)).toBe(true);
});
test('exact source inspection rejects text matches from a different document or copied object',async()=>{
  const f=await fixture(),result=collectionOverlap(f.docs,f.scope),group=result.groups[0],source=group.sources[0].fragments[0];
  expect(inspectOverlapSource(f.docs,result,group,f.a.id,source)).toBe(source);
  expect(()=>inspectOverlapSource(f.docs,result,group,f.b.id,source)).toThrow();
  expect(()=>inspectOverlapSource(f.docs,result,group,f.a.id,{...source})).toThrow();
  expect(()=>inspectOverlapSource(f.docs,result,{...group},f.a.id,source)).toThrow();
});
test('physical page scope never broadens to another page or claims absent PDF text',async()=>{
  const f=await fixture(),result=collectionOverlap(f.docs,{...f.scope,physicalPage:2});
  expect(result.groups).toHaveLength(1);expect(result.groups[0].sources[0].documentId).toBe(f.a.id);
  expect(result.documents.map(row=>row.coverage)).toEqual(['some_text','no_indexed_text','not_present']);
  expect(result.sharedGroups).toBe(0);
});
test('filters distinguish exclusive, shared and every selected source without affecting counts',async()=>{
  const f=await fixture(),result=collectionOverlap(f.docs,f.scope);
  expect(filterCollectionOverlap(result,{presence:'every',documentId:'all',query:''})).toHaveLength(1);
  expect(filterCollectionOverlap(result,{presence:'shared',documentId:f.a.id,query:'ANOTHER'})).toHaveLength(1);
  expect(filterCollectionOverlap(result,{presence:'exclusive',documentId:f.c.id,query:''})).toHaveLength(2);
  expect(overlapPage(result.groups,1,2).rows).toHaveLength(2);
  expect(()=>overlapPage(result.groups,5,2)).toThrow();
  expect(()=>normalizeOverlapScope(f.docs,{...f.scope,minimumLength:901})).toThrow();
  expect(()=>normalizeOverlapScope(f.docs,{...f.scope,documentIds:[f.a.id,f.a.id]})).toThrow();
  expect(()=>normalizeOverlapScope(f.docs,{...f.scope,physicalPage:81})).toThrow();
});
test('canonical overlap report binds full snapshot, exact counts and all occurrence references',async()=>{
  const f=await fixture(),text=await serializeCollectionOverlap(f.docs,f.scope,true,signal());
  expect(text).not.toContain('Common notice heading');expect(text).not.toContain('private.pdf');
  expect(await verifyCollectionOverlap(text,[...f.docs].reverse(),signal())).toEqual(collectionOverlap(f.docs,f.scope));
  for(const mutate of [
    (v:any)=>{v.authority_verified=true;},(v:any)=>{v.shared_groups++;},(v:any)=>{v.pairs[0].sharedTexts++;},
    (v:any)=>{v.groups[0].sources[0].fragments[0].ordinal=999;},(v:any)=>{v.snapshot_sha256='0'.repeat(64);},
    (v:any)=>{v.scope.documentIds.reverse();},
  ]){
    const raw=JSON.parse(text);mutate(raw);
    await expect(verifyCollectionOverlap(JSON.stringify(raw,null,2)+'\n',f.docs,signal())).rejects.toThrow();
  }
  await expect(serializeCollectionOverlap(f.docs,f.scope,false,signal())).rejects.toThrow();
  await expect(verifyCollectionOverlap(text,[f.a,f.b],signal())).rejects.toThrow();
  expect(await readOverlapFile(new File([text],'overlap.json'),signal())).toBe(text);
  await expect(readOverlapFile(new File([new Uint8Array([255])],'bad.json'),signal())).rejects.toThrow();
});

test('Python independently recomputes actual browser overlap artifacts with UTF-16 ordering',async()=>{
  const a=await add([],'a',[['Common','Common','𐀀','\uE000','Private clause']]);
  const b=await add([a],'b',[['Common','Different clause'],[]]);
  const docs=[a,b],scope={documentIds:[b.id,a.id],minimumLength:1,physicalPage:null};
  const snapshot=serializeCollectionSnapshot(docs);
  const report=await serializeCollectionOverlap(docs,scope,true,signal());
  const python=[
    'import json, sys',
    'from noticebridge.chat_collection_overlap import audit_overlap',
    'from noticebridge.chat_collection_audit import encode_audit',
    'value = json.load(sys.stdin)',
    'sys.stdout.buffer.write(encode_audit(audit_overlap(value["report"].encode(), value["snapshot"].encode())))',
  ].join('\n');
  const result=JSON.parse(execFileSync(process.env.PYTHON||'python',['-c',python],{
    input:JSON.stringify({report,snapshot}),timeout:20000,maxBuffer:128*1024,
  }).toString('utf8'));
  expect(result).toMatchObject({literal_overlap_recomputed:true,pdf_bytes_verified:false,native_extraction_replayed:false,
    authority_verified:false,counts:{documents:2,pairs:1,shared_groups:1,exclusive_groups:4,occurrences:7}});
  expect(JSON.stringify(result)).not.toContain('Private clause');
});
