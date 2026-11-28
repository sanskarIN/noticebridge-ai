import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {prepareCollectionModelPlan,reviewCollectionModelBundle} from '../src/pdfChatCollectionModels';
import {collectionModelPreflight,verifyCollectionModelPreflight,readCollectionModelPreflightFile,
  MAX_COLLECTION_MODEL_PREFLIGHT_BYTES} from '../src/pdfChatCollectionModelPreflight';

const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,texts:string[]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:texts.map((text,i)=>({role:'original' as const,page:i+1,ordinal:1,text})),
    pageCount:Math.max(1,texts.length),processedPages:Math.max(1,texts.length),
    missingPages:texts.length?[]:[1],limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'first',['Application fee: INR 500','Eligibility: Class 12']);
  const b=await add([a],'second',['Application fee: INR 350']);
  const c=await add([a,b],'empty',[]);
  const docs=[a,b,c];
  const turn=runCollectionStep(docs,{question:'Application fee?',documentIds:docs.map(row=>row.id),includeContext:false});
  const plan=await prepareCollectionModelPlan(docs,turn,0,[b.id,a.id,c.id],'full');
  return {a,b,c,docs,turn,plan};
}
const encode=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const program=[
  'import asyncio, json, sys, httpx',
  'from noticebridge.chat_collection_models import parse_manifest, admit_request, preflight_collection, run_collection',
  'payload = json.load(sys.stdin)',
  'manifest = parse_manifest(payload["manifest"].encode())',
  'admitted = tuple(admit_request(manifest, entry, raw.encode())',
  '                 for entry, raw in zip(manifest.requests, payload["requests"], strict=True))',
  'class Stream(httpx.AsyncByteStream):',
  '    def __init__(self, value): self.value = value',
  '    async def __aiter__(self): yield json.dumps(self.value).encode()',
  'def reply(value): return httpx.Response(200, stream=Stream(value))',
  'def handler(req):',
  '    assert req.url.host == "127.0.0.1"',
  '    if req.url.path == "/api/tags":',
  '        return reply({"models": [{"name":"embedding:latest","digest":"a"*64},',
  '                                 {"name":"answer:latest","digest":"b"*64}]})',
  '    body = json.loads(req.content)',
  '    if req.url.path == "/api/embed":',
  '        return reply({"model":"embedding:latest","embeddings":[[1,0] for _ in body["input"]]})',
  '    assert req.url.path == "/api/generate"',
  '    candidates = json.loads(body["prompt"])["candidates"]',
  '    texts = [row["text"] for row in candidates]',
  '    assert not ("Application fee: INR 500" in texts and "Application fee: INR 350" in texts)',
  '    fee = next(row for row in candidates if row["text"].startswith("Application fee:"))',
  '    return reply({"model":"answer:latest","done":True,"done_reason":"stop",',
  '                  "response":json.dumps({"status":"extract","quotes":',
  '                    [{"id":fee["id"],"quote":fee["text"]}]})})',
  'if payload["mode"] == "preflight":',
  '    output = preflight_collection(manifest, admitted)',
  'else:',
  '    output = asyncio.run(run_collection(manifest, admitted, embedding_model="embedding:latest",',
  '        embedding_digest="a"*64, answer_model="answer:latest", answer_digest="b"*64,',
  '        consent=True, _transport=httpx.MockTransport(handler)))',
  'sys.stdout.buffer.write(output)',
].join('\n');
test('preflight retains request order, physical page counts and skipped PDFs without quotations',async()=>{
  const {a,b,c,plan}=await fixture();
  const report=await collectionModelPreflight(plan);
  expect(report.requests.map(row=>row.document_id)).toEqual([b.id,a.id]);
  expect(report.skipped_document_ids).toEqual([c.id]);
  expect(report.total_candidate_fragments).toBe(3);
  expect(report.total_baseline_fragments).toBe(2);
  expect(report.requests[1].physical_pages).toEqual([{page:1,candidate_fragments:1},{page:2,candidate_fragments:1}]);
  const text=encode(report);
  expect(text).not.toContain('INR 500');
  expect(text).not.toContain('private.pdf');
  expect(await verifyCollectionModelPreflight(text,plan)).toEqual(report);
});
test('real Python offline preflight exactly matches browser reconstruction',async()=>{
  const {plan}=await fixture();
  const output=execFileSync(process.env.PYTHON||'python',['-c',program],{
    input:JSON.stringify({mode:'preflight',manifest:plan.manifest,requests:plan.requests.map(row=>row.request.text)}),
    timeout:20000,maxBuffer:MAX_COLLECTION_MODEL_PREFLIGHT_BYTES,
  }).toString('utf8');
  expect(await verifyCollectionModelPreflight(output,plan)).toEqual(await collectionModelPreflight(plan));
});
test('real Python collection runner returns browser-verifiable isolated proposal bundle',async()=>{
  const {a,b,docs,plan}=await fixture();
  const output=execFileSync(process.env.PYTHON||'python',['-c',program],{
    input:JSON.stringify({mode:'run',manifest:plan.manifest,requests:plan.requests.map(row=>row.request.text)}),
    timeout:20000,maxBuffer:800*1024,
  }).toString('utf8');
  const reviewed=await reviewCollectionModelBundle(docs,plan,output);
  expect(reviewed.map(row=>row.documentId)).toEqual([b.id,a.id]);
  expect(reviewed.map(row=>row.review.extractive.proposal.spans[0].source))
    .toEqual([b.corpus.passages[0],a.corpus.passages[0]]);
  expect(output).not.toContain('INR 500');
  expect(output).not.toContain('INR 350');
});
test('preflight verification rejects forged counts, source IDs, order and extra data',async()=>{
  const {plan}=await fixture();
  const report=await collectionModelPreflight(plan);
  for(const mutate of [
    (v:any)=>{v.authority_verified=true;},
    (v:any)=>{v.total_candidate_fragments++;},
    (v:any)=>{v.requests.reverse();},
    (v:any)=>{v.requests[0].document_id='0'.repeat(64);},
    (v:any)=>{v.requests[0].physical_pages[0].page=2;},
    (v:any)=>{v.skipped_document_ids=[];},
    (v:any)=>{v.requests[0].text='private';},
    (v:any)=>{v.manifest_sha256='0'.repeat(64);},
  ]){
    const raw=structuredClone(report);mutate(raw);
    await expect(verifyCollectionModelPreflight(encode(raw),plan)).rejects.toThrow();
  }
  await expect(verifyCollectionModelPreflight(encode(report).trim(),plan)).rejects.toThrow();
  await expect(verifyCollectionModelPreflight('x'.repeat(MAX_COLLECTION_MODEL_PREFLIGHT_BYTES+1),plan)).rejects.toThrow();
});
test('preflight file reader and verifier enforce cancellation and strict UTF-8',async()=>{
  const {plan}=await fixture();
  const text=encode(await collectionModelPreflight(plan));
  const file=new File([text],'preflight.json');
  expect(await readCollectionModelPreflightFile(file,signal())).toBe(text);
  await expect(readCollectionModelPreflightFile(new File([],'empty.json'),signal())).rejects.toThrow();
  await expect(readCollectionModelPreflightFile(new File([new Uint8Array([255])],'bad.json'),signal())).rejects.toThrow();
  const controller=new AbortController();controller.abort();
  await expect(readCollectionModelPreflightFile(file,controller.signal)).rejects.toThrow();
  await expect(verifyCollectionModelPreflight(text,plan,controller.signal)).rejects.toThrow();
});
