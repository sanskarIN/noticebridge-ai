import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {pinCollectionEvidence,updateCollectionEvidence,collectionReviewKey} from '../src/pdfChatCollectionReview';
import {serializeCollectionPacket,verifyCollectionPacket,collectionPacketReadingCopy,loadCollectionPacket,
  MAX_COLLECTION_PACKET_BYTES} from '../src/pdfChatCollectionPacket';
async function add(docs:CollectionDocument[],bytes:string,lines:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),new AbortController().signal,async()=>({
    passages:lines.map((text,i)=>({role:'original' as const,page:1,ordinal:i+1,text})),
    pageCount:1,processedPages:1,missingPages:[],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',['Application fee: INR 500','Other native fragment']),
    b=await add([a],'b',['Application fee: INR 350']);
  const docs=[a,b];
  const turns=[runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id,b.id],includeContext:false})];
  const source=a.corpus.passages[0];
  const reviews=updateCollectionEvidence(pinCollectionEvidence(docs,[],a.id,source),collectionReviewKey(a.id,source),
    {note:'Personal review note',status:'needs_followup'});
  return {a,b,docs,turns,reviews};
}
test('canonical packet binds the entire native snapshot and recomputes both question and annotation evidence',async()=>{
  const {a,b,docs,turns,reviews}=await fixture();
  await expect(serializeCollectionPacket(docs,turns,reviews,false)).rejects.toThrow();
  const text=await serializeCollectionPacket(docs,turns,reviews,true);
  expect(text).toContain('Application fee: INR 500');
  expect(text).toContain('Application fee: INR 350');
  expect(text).toContain('Personal review note');
  expect(text).not.toContain('private.pdf');
  expect(text).not.toContain('Other native fragment');
  const result=await verifyCollectionPacket(text,[b,a]);
  expect(result.workspace).toEqual({turns,reviews});
  expect(result.packet.authority_verified).toBe(false);
  expect(result.packet.review_quotes[0]).toMatchObject({document_id:a.id,native_text:'Application fee: INR 500',status:'needs_followup'});
  expect((await loadCollectionPacket(new File([text],'packet.json'),docs,new AbortController().signal)).packet).toEqual(result.packet);
});
test('even an unquoted native extraction change invalidates a packet with unchanged PDF fingerprints',async()=>{
  const {b,docs,turns,reviews}=await fixture();
  const text=await serializeCollectionPacket(docs,turns,reviews,true);
  const changed=await add([],'a',['Application fee: INR 500','Changed unrelated native text']);
  await expect(verifyCollectionPacket(text,[changed,b])).rejects.toThrow();
  await expect(verifyCollectionPacket(text,[b])).rejects.toThrow();
});
test('tampered evidence, notes, coverage, quote hashes or authority flags fail closed',async()=>{
  const {docs,turns,reviews}=await fixture();
  const text=await serializeCollectionPacket(docs,turns,reviews,true);
  const raw=JSON.parse(text);
  const mutations=[
    (v:any)=>{v.authority_verified=true;},(v:any)=>{v.snapshot_sha256='f'.repeat(64);},
    (v:any)=>{v.sources[0].processed_pages=0;},(v:any)=>{v.review_counts.needs_followup=0;},
    (v:any)=>{v.review_quotes[0].native_text='forged';},(v:any)=>{v.review_quotes[0].text_sha256='f'.repeat(64);},
    (v:any)=>{v.review_quotes[0].note='forged';},(v:any)=>{v.evidence_report.questions[0].results[0].parts[0].citations[0].text='forged';},
    (v:any)=>{v.evidence_report=null;},(v:any)=>{v.workspace=null;},
  ];
  for(const mutate of mutations){
    const changed=structuredClone(raw);mutate(changed);
    await expect(verifyCollectionPacket(JSON.stringify(changed,null,2)+'\n',docs)).rejects.toThrow();
  }
  await expect(verifyCollectionPacket(text.trim(),docs)).rejects.toThrow();
  await expect(verifyCollectionPacket('x'.repeat(MAX_COLLECTION_PACKET_BYTES+1),docs)).rejects.toThrow();
});
test('question-only and annotation-only packets are supported, empty packets are not',async()=>{
  const {docs,turns,reviews}=await fixture();
  for(const work of [{turns,reviews:[]},{turns:[],reviews}]){
    const result=await verifyCollectionPacket(await serializeCollectionPacket(docs,work.turns,work.reviews,true),docs);
    expect(result.workspace).toEqual(work);
  }
  await expect(serializeCollectionPacket(docs,[],[],true)).rejects.toThrow();
});
test('static reading copy escapes all native excerpts and notes and has no executable content',async()=>{
  const a=await add([],'a',['Application fee: <img src=x onerror=alert(1)>']);
  const docs=[a],source=a.corpus.passages[0];
  const turns=[runCollectionStep(docs,{question:'Application fee?',documentIds:[a.id],includeContext:false})];
  const reviews=updateCollectionEvidence(pinCollectionEvidence(docs,[],a.id,source),collectionReviewKey(a.id,source),
    {note:'<script>alert(1)</script> & "private"'});
  const html=await collectionPacketReadingCopy(docs,turns,reviews,true);
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;private&quot;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('private.pdf');
  expect(html).toContain('Content-Security-Policy');
  expect(html).toContain('not a verification artifact');
});
test('pre-cancelled packet operations never export or verify data',async()=>{
  const {docs,turns,reviews}=await fixture();
  const text=await serializeCollectionPacket(docs,turns,reviews,true);
  const controller=new AbortController();controller.abort();
  await expect(serializeCollectionPacket(docs,turns,reviews,true,controller.signal)).rejects.toThrow();
  await expect(verifyCollectionPacket(text,docs,controller.signal)).rejects.toThrow();
});
