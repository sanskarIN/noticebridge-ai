/** Explicit local checkpoint. PDF bytes remain in the browser profile;
 * this is not encrypted storage, backup, authentication or cloud sync. */
import {admitCollectionDocument,collectionStats,MAX_COLLECTION_DOCUMENTS,MAX_COLLECTION_BYTES,MAX_COLLECTION_FILE_BYTES,
  type CollectionDocument,type CollectionExtractor,type CollectionTurn} from './pdfChatCollection';
import {serializeCollectionSnapshot,parseCollectionSnapshot,MAX_COLLECTION_SNAPSHOT_BYTES} from './pdfChatCollectionReplay';
import {serializeCollectionWorkspace,parseCollectionWorkspace,MAX_COLLECTION_WORKSPACE_BYTES} from './pdfChatCollectionWorkspace';
import type {CollectionReviewEntry} from './pdfChatCollectionReview';
import {requestHash} from './pdfChatEmbeddingBridge';
const FORMAT='noticebridge-browser-collection-checkpoint';
const SHA=/^[a-f0-9]{64}$/;
const TOKEN=/^[a-f0-9]{32}$/;
export type CheckpointSource={id:string;name:string;bytes:Blob;size:number};
export type CollectionCheckpoint={format:typeof FORMAT;version:1;revision:string;snapshot:string;snapshotSha256:string;
  workspace:string|null;workspaceSha256:string|null;selected:string[];files:CheckpointSource[]};
export type CheckpointState={documents:CollectionDocument[];turns:CollectionTurn[];reviews:CollectionReviewEntry[];selected:string[]};
export type CheckpointInfo={revision:string;documents:number;bytes:number;containsWork:boolean};
export type CheckpointProgress={completed:number;total:number};
function invalid():never{throw new Error('Invalid, changed or unavailable local collection checkpoint.');}
function object(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).length!==keys.length||keys.some(key=>!Object.hasOwn(raw,key)))invalid();
  return raw;
}
function bounded(value:unknown,maximum:number):string{
  if(typeof value!=='string'||!value||value.length>maximum||new TextEncoder().encode(value).byteLength>maximum)invalid();
  return value;
}
function fileName(value:unknown):string{
  if(typeof value!=='string'||value.length>255||!value.trim()||!value.toLowerCase().endsWith('.pdf')||
      /[\u0000-\u001f\u007f/\\\uD800-\uDFFF]/u.test(value))invalid();
  return value;
}
function sha(value:unknown):string{
  if(typeof value!=='string'||!SHA.test(value))invalid();
  return value;
}
function selection(value:unknown,ids:readonly string[]):string[]{
  if(!Array.isArray(value)||value.length>ids.length||new Set(value).size!==value.length||
    value.some(id=>typeof id!=='string'||!ids.includes(id)))invalid();
  return [...value];
}
function revisionToken(){
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function hashBytes(bytes:ArrayBuffer){
  const value=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(value),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function validateCheckpoint(value:unknown):CollectionCheckpoint{
  const row=object(value,['format','version','revision','snapshot','snapshotSha256','workspace','workspaceSha256','selected','files']);
  if(row.format!==FORMAT||row.version!==1||typeof row.revision!=='string'||!TOKEN.test(row.revision)||
    !Array.isArray(row.files)||!row.files.length||row.files.length>MAX_COLLECTION_DOCUMENTS)invalid();
  let total=0;
  const ids=new Set<string>();
  const files=row.files.map(value=>{
    const item=object(value,['id','name','bytes','size']);
    const id=sha(item.id),name=fileName(item.name);
    if(ids.has(id)||!(item.bytes instanceof Blob)||typeof item.size!=='number'||!Number.isSafeInteger(item.size)||
      item.size<1||item.size>MAX_COLLECTION_FILE_BYTES||item.bytes.size!==item.size)invalid();
    ids.add(id);total+=item.size;
    if(total>MAX_COLLECTION_BYTES)invalid();
    return {id,name,bytes:item.bytes,size:item.size};
  });
  const snapshot=bounded(row.snapshot,MAX_COLLECTION_SNAPSHOT_BYTES),snapshotSha256=sha(row.snapshotSha256);
  if((row.workspace===null)!==(row.workspaceSha256===null))invalid();
  const workspace=row.workspace===null?null:bounded(row.workspace,MAX_COLLECTION_WORKSPACE_BYTES);
  const workspaceSha256=row.workspaceSha256===null?null:sha(row.workspaceSha256);
  return {format:FORMAT,version:1,revision:row.revision,snapshot,snapshotSha256,workspace,workspaceSha256,
    selected:selection(row.selected,[...ids]),files};
}
export function checkpointInfo(value:CollectionCheckpoint):CheckpointInfo{
  const checkpoint=validateCheckpoint(value);
  return {revision:checkpoint.revision,documents:checkpoint.files.length,bytes:checkpoint.files.reduce((n,row)=>n+row.size,0),
    containsWork:checkpoint.workspace!==null};
}
export async function buildCheckpoint(state:CheckpointState,consent:boolean,signal:AbortSignal):Promise<CollectionCheckpoint>{
  signal.throwIfAborted();
  if(consent!==true||!state.documents.length)invalid();
  collectionStats(state.documents);
  const snapshot=serializeCollectionSnapshot(state.documents);
  const workspace=state.turns.length||state.reviews.length?await serializeCollectionWorkspace(state.documents,
    {turns:state.turns,reviews:state.reviews},signal):null;
  const files:CheckpointSource[]=[];
  for(const doc of state.documents){
    signal.throwIfAborted();
    const bytes=await doc.file.arrayBuffer();signal.throwIfAborted();
    if(bytes.byteLength!==doc.file.size||await hashBytes(bytes)!==doc.id)invalid();
    signal.throwIfAborted();
    files.push({id:doc.id,name:fileName(doc.file.name),bytes:new Blob([bytes],{type:'application/pdf'}),size:bytes.byteLength});
  }
  const snapshotSha256=await requestHash(snapshot);
  const workspaceSha256=workspace===null?null:await requestHash(workspace);
  signal.throwIfAborted();
  return validateCheckpoint({format:FORMAT,version:1,revision:revisionToken(),snapshot,snapshotSha256,
    workspace,workspaceSha256,selected:state.selected,files});
}
/** Restore re-extracts each immutable PDF byte snapshot and compares the
 * entire canonical native extraction. The saved workspace is then replayed
 * against the new live index, never hydrated from stored answer objects. */
export async function restoreCheckpoint(value:unknown,extract:CollectionExtractor,signal:AbortSignal,
  onProgress?:(progress:CheckpointProgress)=>void):Promise<CheckpointState>{
  signal.throwIfAborted();
  const checkpoint=validateCheckpoint(value);
  if(await requestHash(checkpoint.snapshot)!==checkpoint.snapshotSha256||
    checkpoint.workspace!==null&&await requestHash(checkpoint.workspace)!==checkpoint.workspaceSha256)invalid();
  signal.throwIfAborted();
  const expected=parseCollectionSnapshot(checkpoint.snapshot);
  const ids=checkpoint.files.map(row=>row.id).sort();
  if(expected.sources.map(row=>row.id).join(',')!==ids.join(','))invalid();
  const documents:CollectionDocument[]=[];
  onProgress?.({completed:0,total:checkpoint.files.length});
  for(const file of checkpoint.files){
    signal.throwIfAborted();
    const bytes=await file.bytes.arrayBuffer();signal.throwIfAborted();
    if(bytes.byteLength!==file.size||await hashBytes(bytes)!==file.id)invalid();
    signal.throwIfAborted();
    const doc=await admitCollectionDocument(documents,new File([bytes],file.name,{type:'application/pdf'}),signal,extract);
    if(doc.id!==file.id)invalid();
    documents.push(doc);
    onProgress?.({completed:documents.length,total:checkpoint.files.length});
  }
  signal.throwIfAborted();
  if(serializeCollectionSnapshot(documents)!==checkpoint.snapshot)invalid();
  const workspace=checkpoint.workspace===null?{turns:[],reviews:[]}:
    await parseCollectionWorkspace(checkpoint.workspace,documents,signal);
  signal.throwIfAborted();
  return {documents,...workspace,selected:checkpoint.selected};
}
