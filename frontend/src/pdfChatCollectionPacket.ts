/** A review packet is a portable, private reading and verification artifact.
 * It is deliberately distinct from an editable question plan, and never
 * imports saved answers into the current collection. */
import { pageCoverage } from './pdfChatCore';
import { collectionStats, collectionSteps, collectionCitation, serializeCollectionEvidence, verifyCollectionEvidence,
  type CollectionDocument, type CollectionTurn } from './pdfChatCollection';
import { serializeCollectionWorkspace, parseCollectionWorkspace, type CollectionWorkspace } from './pdfChatCollectionWorkspace';
import { collectionReviewCounts, type CollectionReviewEntry, type CollectionReviewStatus } from './pdfChatCollectionReview';
import { serializeCollectionSnapshot } from './pdfChatCollectionReplay';
import { requestHash } from './pdfChatEmbeddingBridge';

export const MAX_COLLECTION_PACKET_BYTES=12*1024*1024;
export const MAX_COLLECTION_READING_COPY_BYTES=6*1024*1024;
const FORMAT='noticebridge-collection-review-packet';
const POLICY='Private native excerpts and personal annotations; verify actual PDF pages and official publication.';
export type PacketDocument={
  document_id:string;physical_pages:number;processed_pages:number;missing_pages:number[];
  limited_pages:number[];limited:boolean;native_fragments:number;
};
export type PacketQuote={
  document_id:string;page:number;ordinal:number;native_text:string;text_sha256:string;
  coverage:ReturnType<typeof pageCoverage>;status:CollectionReviewStatus;note:string;
};
export type PacketQuestionPart={
  question:string;physical_page:number|null;coverage:string;kind:string;strict_match_count:number;
  citations:{page:number;ordinal:number;text:string}[];
};
export type CollectionPacket={
  format:typeof FORMAT;version:1;policy:string;authority_verified:false;
  snapshot_sha256:string;workspace:unknown;evidence_report:unknown;
  sources:PacketDocument[];review_counts:ReturnType<typeof collectionReviewCounts>;review_quotes:PacketQuote[];
};
export type VerifiedCollectionPacket={packet:CollectionPacket;workspace:CollectionWorkspace};
function invalid():never{throw new Error('Invalid or mismatched private collection review packet.');}
function encode(value:unknown){return JSON.stringify(value,null,2)+'\n';}
function bound(text:string,max:number){
  if(typeof text!=='string'||!text||text.length>max||new TextEncoder().encode(text).byteLength>max)invalid();
}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.prototype.hasOwnProperty.call(row,key)))invalid();
  return row;
}
function nested(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  return encode(value);
}
function sources(documents:readonly CollectionDocument[]):PacketDocument[]{
  collectionStats(documents);
  if(!documents.length)invalid();
  return [...documents].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(doc=>({
    document_id:doc.id,physical_pages:doc.corpus.pageCount,processed_pages:doc.corpus.processedPages,
    missing_pages:[...doc.corpus.missingPages],limited_pages:[...doc.corpus.limitedPages],
    limited:doc.corpus.limited,native_fragments:doc.corpus.passages.length,
  }));
}
async function quote(documents:readonly CollectionDocument[],entry:CollectionReviewEntry,signal?:AbortSignal):Promise<PacketQuote>{
  signal?.throwIfAborted();
  const source=collectionCitation(documents,entry.documentId,entry.source).source;
  const doc=documents.find(doc=>doc.id===entry.documentId)!;
  const text_sha256=await requestHash(source.text);
  signal?.throwIfAborted();
  return {document_id:doc.id,page:source.page,ordinal:source.ordinal,native_text:source.text,text_sha256,
    coverage:pageCoverage(doc.corpus,source.page),status:entry.status,note:entry.note};
}
/** The workspace's strict annotation validation and canonical question
 * replay are reused. The saved packet does not trust cached answer objects. */
export async function buildCollectionPacket(documents:readonly CollectionDocument[],turns:CollectionTurn[],
  reviews:CollectionReviewEntry[],consent:boolean,signal?:AbortSignal):Promise<CollectionPacket>{
  if(consent!==true)invalid();
  signal?.throwIfAborted();
  const snapshot=serializeCollectionSnapshot(documents);
  const workspaceText=await serializeCollectionWorkspace(documents,{turns,reviews},signal);
  const workspace=await parseCollectionWorkspace(workspaceText,documents,signal);
  const evidence=workspace.turns.length?JSON.parse(serializeCollectionEvidence(documents,collectionSteps(workspace.turns))):null;
  const review_quotes:PacketQuote[]=[];
  for(const entry of workspace.reviews)review_quotes.push(await quote(documents,entry,signal));
  const packet:CollectionPacket={format:FORMAT,version:1,policy:POLICY,authority_verified:false,
    snapshot_sha256:await requestHash(snapshot),workspace:JSON.parse(workspaceText),evidence_report:evidence,
    sources:sources(documents),review_counts:collectionReviewCounts(workspace.reviews),review_quotes};
  signal?.throwIfAborted();
  bound(encode(packet),MAX_COLLECTION_PACKET_BYTES);
  return packet;
}
export async function serializeCollectionPacket(documents:readonly CollectionDocument[],turns:CollectionTurn[],
  reviews:CollectionReviewEntry[],consent:boolean,signal?:AbortSignal){
  return encode(await buildCollectionPacket(documents,turns,reviews,consent,signal));
}
/** Verification checks the complete live extraction snapshot, not just the
 * PDF hash or displayed citations. All redundant evidence is reconstructed
 * from the current native corpus. No state is restored by this function. */
export async function verifyCollectionPacket(text:string,documents:readonly CollectionDocument[],signal?:AbortSignal):
  Promise<VerifiedCollectionPacket>{
  signal?.throwIfAborted();
  bound(text,MAX_COLLECTION_PACKET_BYTES);
  let value:unknown;
  try{value=JSON.parse(text);}catch{return invalid();}
  const raw=object(value,['format','version','policy','authority_verified','snapshot_sha256','workspace',
    'evidence_report','sources','review_counts','review_quotes']);
  if(raw.format!==FORMAT||raw.version!==1||raw.policy!==POLICY||raw.authority_verified!==false||
      typeof raw.snapshot_sha256!=='string'||raw.snapshot_sha256!==await requestHash(serializeCollectionSnapshot(documents)))invalid();
  const workspace=await parseCollectionWorkspace(nested(raw.workspace),documents,signal);
  if(workspace.turns.length){
    if(raw.evidence_report===null)invalid();
    verifyCollectionEvidence(nested(raw.evidence_report),documents);
  }else if(raw.evidence_report!==null)invalid();
  const packet=await buildCollectionPacket(documents,workspace.turns,workspace.reviews,true,signal);
  if(encode(packet)!==text)invalid();
  return {packet,workspace};
}
export async function loadCollectionPacket(file:File,documents:readonly CollectionDocument[],signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_COLLECTION_PACKET_BYTES)invalid();
  const bytes=await file.arrayBuffer();signal.throwIfAborted();
  if(bytes.byteLength!==file.size||bytes.byteLength>MAX_COLLECTION_PACKET_BYTES)invalid();
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return invalid();}
  return verifyCollectionPacket(text,documents,signal);
}
function escape(value:unknown){
  return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function coverageLabel(value:string){return value.replaceAll('_',' ');}
const styles='body{font:16px/1.55 system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#172033;background:white}'+
  'h1,h2,h3,h4{line-height:1.3}article,section{margin:1.2rem 0}blockquote{border-left:4px solid #567;padding:.4rem 1rem;margin:.75rem 0;white-space:pre-wrap;overflow-wrap:anywhere}'+
  'code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.5rem;text-align:left;vertical-align:top}'+
  '.notice{border:2px solid #567;padding:1rem}.note{white-space:pre-wrap;overflow-wrap:anywhere}'+
  '@media print{body{margin:0;font-size:11pt}.citation{break-inside:avoid}h2,h3,h4{break-after:avoid}}';
type WireEvidence={questions:{step:{question:string;documentIds:string[];includeContext:boolean};
  results:{document_id:string;parts:PacketQuestionPart[]}[]}[]};
/** Generate a static, script-free HTML reading copy only from a locally
 * constructed or independently verified packet. Every source and annotation
 * is escaped. No links, network resources or untrusted markup are emitted. */
export async function collectionPacketReadingCopy(documents:readonly CollectionDocument[],turns:CollectionTurn[],
  reviews:CollectionReviewEntry[],consent:boolean,signal?:AbortSignal):Promise<string>{
  const packet=await buildCollectionPacket(documents,turns,reviews,consent,signal);
  const evidence=packet.evidence_report as WireEvidence|null;
  const names=new Map(packet.sources.map((source,index)=>[source.document_id,'Source '+(index+1)]));
  const label=(id:string)=>escape(names.get(id)??id);
  const parts=[
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; base-uri &apos;none&apos;; form-action &apos;none&apos;">',
    '<title>NoticeBridge AI — Private collection review</title><style>'+styles+'</style></head><body>',
    '<h1>Private collection evidence review</h1>',
    '<p class="notice">Native extraction excerpts and personal notes only. Verify actual PDF pages and official publication. No answer accuracy, extraction completeness or issuer authority is certified.</p>',
    '<h2>Source inventory</h2><p>Native snapshot SHA-256: <code>'+escape(packet.snapshot_sha256)+'</code></p>',
    '<table><thead><tr><th>Source</th><th>Fingerprint</th><th>Native coverage</th></tr></thead><tbody>',
  ];
  for(const source of packet.sources){
    parts.push('<tr><td>'+label(source.document_id)+'</td><td><code>'+escape(source.document_id)+'</code></td><td>'+
      escape(source.processed_pages+'/'+source.physical_pages+' physical pages processed; '+source.native_fragments+' fragments')+
      (source.limited?' · limited extraction':'')+
      '<br>Missing pages: '+escape(source.missing_pages.join(', ')||'none indexed as missing')+
      '<br>Limited pages: '+escape(source.limited_pages.join(', ')||'none flagged')+'</td></tr>');
  }
  parts.push('</tbody></table><h2>Question evidence</h2>');
  if(!evidence)parts.push('<p>No saved question turns.</p>');
  for(const [index,turn] of (evidence?.questions??[]).entries()){
    signal?.throwIfAborted();
    parts.push('<section><h3>Question '+(index+1)+'</h3><p class="note">'+escape(turn.step.question)+'</p>');
    for(const side of turn.results){
      parts.push('<article><h4>'+label(side.document_id)+'</h4>');
      for(const part of side.parts){
        parts.push('<p><strong>'+escape(part.question)+'</strong> · '+escape(coverageLabel(part.coverage))+
          (part.physical_page===null?'':' · Physical page '+escape(part.physical_page))+'</p>');
        if(!part.citations.length)parts.push('<p>No matching indexed evidence. This is not proof of absence.</p>');
        for(const source of part.citations)parts.push('<div class="citation"><p>Physical page '+escape(source.page)+
          ' · fragment '+escape(source.ordinal)+'</p><blockquote>'+escape(source.text)+'</blockquote></div>');
      }
      parts.push('</article>');
    }
    parts.push('</section>');
  }
  parts.push('<h2>Personal review annotations</h2>');
  if(!packet.review_quotes.length)parts.push('<p>No saved review annotations.</p>');
  for(const row of packet.review_quotes){
    parts.push('<article class="citation"><h3>'+label(row.document_id)+' · physical page '+escape(row.page)+' · fragment '+escape(row.ordinal)+'</h3>'+
      '<p>Native coverage: '+escape(coverageLabel(row.coverage))+' · Personal status: '+escape(coverageLabel(row.status))+'</p>'+
      '<blockquote>'+escape(row.native_text)+'</blockquote><p>Text SHA-256: <code>'+escape(row.text_sha256)+'</code></p>'+
      '<p class="note">Personal note: '+escape(row.note||'(none)')+'</p></article>');
  }
  parts.push('<p>This static reading copy is not a verification artifact. Use the canonical JSON packet and matching PDF collection for replay.</p></body></html>\n');
  const html=parts.join('\n');
  signal?.throwIfAborted();bound(html,MAX_COLLECTION_READING_COPY_BYTES);
  return html;
}
