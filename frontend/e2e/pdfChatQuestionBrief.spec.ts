import {expect,test} from '@playwright/test';
import {admitCollectionDocument,runCollectionStep,type CollectionDocument} from '../src/pdfChatCollection';
import {serializeCollectionSnapshot} from '../src/pdfChatCollectionReplay';
import {exportQuestionBrief,verifyQuestionBrief,questionBriefReadingCopy,inspectBriefCitation,buildQuestionBrief,encodeQuestionBrief} from '../src/pdfChatQuestionBrief';
import {requestHash} from '../src/pdfChatEmbeddingBridge';
const signal=()=>new AbortController().signal;
async function add(docs:CollectionDocument[],bytes:string,pages:string[][]){
  return admitCollectionDocument(docs,new File([bytes],'private.pdf'),signal(),async()=>({
    passages:pages.flatMap((rows,i)=>rows.map((text,j)=>({role:'original' as const,page:i+1,ordinal:j+1,text}))),
    pageCount:pages.length,processedPages:pages.length,missingPages:pages.flatMap((rows,i)=>rows.length?[]:[i+1]),
    limited:false,limitedPages:[],
  }));
}
async function fixture(){
  const a=await add([],'a',[['Application fee: INR 500','Registration certificate','required for rural applicants'],['Eligibility: Class 12']]);
  const b=await add([a],'b',[['Application fee: INR 350'],[]]);
  const docs=[a,b],snapshot=serializeCollectionSnapshot(docs);
  const turn=runCollectionStep(docs,{question:'Application fee? Eligibility on page 2?',documentIds:[b.id,a.id],includeContext:false});
  return {a,b,docs,snapshot,turn};
}
test('focused brief preserves source and question scope including missing native page',async()=>{
  const {a,b,docs,snapshot,turn}=await fixture();
  const text=await exportQuestionBrief(docs,turn,1,true,signal());
  const brief=await verifyQuestionBrief(text,snapshot,signal());
  expect(brief.physical_page).toBe(2);
  expect(brief.sources.map(row=>row.document_id)).toEqual([b.id,a.id]);
  expect(brief.sources[0]).toMatchObject({coverage:'no_indexed_text',outcome:'no_evidence',displayed:0});
  const side=brief.sources[1],citation=side.citations[0];
  expect(citation).toMatchObject({rank:1,page:2,ordinal:1,text:'Eligibility: Class 12',channel:'strict'});
  expect(citation.text_sha256).toBe(await requestHash(citation.text));
  expect(inspectBriefCitation(docs,turn,brief,a.id,citation)).toBe(a.corpus.passages[3]);
  expect(()=>inspectBriefCitation(docs,turn,brief,b.id,citation)).toThrow();
  expect(()=>inspectBriefCitation(docs,turn,brief,a.id,{...citation})).toThrow();
  expect(text).not.toContain('private.pdf');expect(text).not.toContain('INR 500');
  expect(questionBriefReadingCopy(brief)).toContain('No displayed native evidence; this does not prove absence.');
});
test('literal printed values remain candidates and nearby evidence remains separate',async()=>{
  const {a,docs,snapshot,turn}=await fixture();
  const brief=await verifyQuestionBrief(await exportQuestionBrief(docs,turn,0,true,signal()),snapshot,signal());
  expect(brief.sources[1].printed_fields[0]).toMatchObject({label:'Application fee',value:'INR 500'});
  expect(questionBriefReadingCopy(brief)).toContain('Literal printed field candidates');
  const nearby=runCollectionStep(docs,{question:'Registration certificate rural?',documentIds:[a.id],includeContext:true});
  const other=await verifyQuestionBrief(await exportQuestionBrief(docs,nearby,0,true,signal()),snapshot,signal());
  expect(other.sources[0].outcome).toBe('nearby_excerpts');
  expect(other.sources[0].citations.every(row=>row.channel==='nearby')).toBe(true);
  expect(other.sources[0].printed_fields).toEqual([]);
  expect(questionBriefReadingCopy(other)).toContain('Nearby-line candidates only; no strict match.');
});
test('brief replay rejects altered hashes, source text and question metadata',async()=>{
  const {docs,snapshot,turn}=await fixture(),text=await exportQuestionBrief(docs,turn,0,true,signal());
  for(const change of [(v:any)=>v.snapshot_sha256='0'.repeat(64),(v:any)=>v.sources.reverse(),
    (v:any)=>v.sources[0].citations[0].text='forged',(v:any)=>v.sources[0].citations[0].text_sha256='0'.repeat(64),
    (v:any)=>v.sources[0].printed_fields[0].value='forged',(v:any)=>v.authority_verified=true,
    (v:any)=>v.question='Different question',(v:any)=>v.part_index=1]){
    const value=JSON.parse(text);change(value);
    await expect(verifyQuestionBrief(JSON.stringify(value,null,2)+'\n',snapshot,signal())).rejects.toThrow();
  }
  await expect(verifyQuestionBrief(text.trim(),snapshot,signal())).rejects.toThrow();
  await expect(exportQuestionBrief(docs,turn,0,false,signal())).rejects.toThrow();
  await expect(exportQuestionBrief(docs,turn,9,true,signal())).rejects.toThrow();
  await expect(exportQuestionBrief(docs,{...turn,results:[]},0,true,signal())).rejects.toThrow();
});
test('reading copy quotes control sequences and exact replay does not import answers',async()=>{
  const a=await add([],'a',[['Notice: <script>alert(1)</script>','Notice: text with "quotes"']]),docs=[a];
  const snapshot=serializeCollectionSnapshot(docs),step={question:'Notice?',documentIds:[a.id],includeContext:false};
  const brief=await buildQuestionBrief(snapshot,step,0,signal());
  expect(brief.sources[0].citations.length).toBe(2);
  const copy=questionBriefReadingCopy(brief);
  expect(copy).toContain(JSON.stringify('Notice: text with "quotes"'));
  expect(await verifyQuestionBrief(encodeQuestionBrief(brief),snapshot,signal())).toEqual(brief);
});
