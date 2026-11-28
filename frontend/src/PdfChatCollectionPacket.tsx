import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import type {CollectionReviewEntry} from './pdfChatCollectionReview';
import {serializeCollectionPacket,collectionPacketReadingCopy,loadCollectionPacket,type VerifiedCollectionPacket} from './pdfChatCollectionPacket';

import PdfChatCollectionAudit from './PdfChatCollectionAudit';

type Props={documents:readonly CollectionDocument[];turns:CollectionTurn[];reviews:CollectionReviewEntry[]};
function save(text:string,name:string,type:string){
  const url=URL.createObjectURL(new Blob([text],{type}));
  const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatCollectionPacket({documents,turns,reviews}:Props){
  const [approval,setApproval]=useState<{turns:CollectionTurn[];reviews:CollectionReviewEntry[]}|null>(null);
  const [busy,setBusy]=useState(false);
  const [verified,setVerified]=useState<VerifiedCollectionPacket|null>(null);
  const [error,setError]=useState('');
  const [feedback,setFeedback]=useState('');
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  const current=useRef({turns,reviews});current.current={turns,reviews};
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  const approved=approval?.turns===turns&&approval?.reviews===reviews;
  function start(){
    if(controller.current)return null;
    const operation=new AbortController();controller.current=operation;
    const token=++generation.current;setBusy(true);setApproval(null);setVerified(null);setFeedback('');setError('');
    return {token,operation};
  }
  function active(token:number,operation:AbortController){return token===generation.current&&!operation.signal.aborted;}
  function finish(token:number){if(token===generation.current){controller.current=null;setBusy(false);}}
  async function exportFile(kind:'json'|'html'){
    if(!approved||(!turns.length&&!reviews.length))return;
    const task=start();if(!task)return;
    const {token,operation}=task;
    try{
      const text=kind==='json'?await serializeCollectionPacket(documents,turns,reviews,true,operation.signal):
        await collectionPacketReadingCopy(documents,turns,reviews,true,operation.signal);
      if(!active(token,operation))return;
      if(current.current.turns!==turns||current.current.reviews!==reviews){
        setError('Collection questions or annotations changed. Approve the current review again.');return;
      }
      save(text,kind==='json'?'noticebridge-collection-review-packet.json':'noticebridge-collection-reading-copy.html',
        kind==='json'?'application/json':'text/html;charset=utf-8');
      setFeedback(kind==='json'?'Private canonical collection review packet exported.':'Private static collection reading copy exported.');
    }catch{if(active(token,operation))setError('Unable to prepare the bounded private collection review artifact.');}
    finally{finish(token);}
  }
  async function verify(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file)return;
    const task=start();if(!task)return;
    const {token,operation}=task;
    try{
      const value=await loadCollectionPacket(file,documents,operation.signal);
      if(active(token,operation))setVerified(value);
    }catch{if(active(token,operation))setError('Packet rejected. Attach the exact matching PDFs with the matching native extraction.');}
    finally{finish(token);}
  }
  return <details className="chat-collection-inspection" aria-label="Private collection review packet">
    <summary>Export or verify collection evidence review packet</summary>
    <p className="chat-note">The canonical packet includes private native quotations, questions, personal notes,
      source fingerprints, coverage metadata and a hash of the entire native extraction snapshot.
      It does not include PDF bytes or filenames. The reading copy is static HTML, not a verification artifact.</p>
    <p>{turns.length} current question turn(s) · {reviews.length} current personal review annotation(s).</p>
    <label className="chat-checkbox"><input type="checkbox" checked={approved} disabled={busy}
      onChange={event=>setApproval(event.target.checked?{turns,reviews}:null)}/> I approve exporting these private collection excerpts, questions and review notes.</label>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={busy||!approved||(!turns.length&&!reviews.length)}
        onClick={()=>void exportFile('json')}>Export canonical collection review packet</button>
      <button type="button" className="chat-button" disabled={busy||!approved||(!turns.length&&!reviews.length)}
        onClick={()=>void exportFile('html')}>Export static collection reading copy</button>
    </div>
    <label className="chat-session-file">Verify collection review packet
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event=>void verify(event)}/>
    </label>
    <p className="chat-muted">Verification recomputes against the currently attached PDF fingerprints and full bounded native extraction.
      It does not restore or change the current conversation or review notebook.</p>
    {busy&&<div className="chat-toolbar"><p role="status">Checking private collection review packet…</p>
      <button type="button" className="chat-button" onClick={()=>{controller.current?.abort();setFeedback('Collection packet operation cancelled.');}}>Cancel collection packet operation</button></div>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {feedback&&<p role="status" className="chat-note">{feedback}</p>}
    <PdfChatCollectionAudit documents={documents}/>
    {verified&&<section aria-label="Verified collection packet details" className="chat-answer">
      <h4>Exact collection packet replay matched</h4>
      <p>{verified.workspace.turns.length} saved question turn(s), {verified.workspace.reviews.length} review annotation(s),
        {' '}{verified.packet.sources.length} attached PDF(s).</p>
      <p>Native snapshot SHA-256: <code>{verified.packet.snapshot_sha256}</code></p>
      <p className="chat-note">Only canonical replay matched. Answer accuracy, document completeness and official authority are not established.</p>
    </section>}
  </details>;
}
