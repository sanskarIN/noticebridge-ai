import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import {readCollectionAuditArtifact,verifyCollectionStructuralAudit,type CollectionAuditReport} from './pdfChatCollectionAudit';
export default function PdfChatCollectionAudit({documents}:{documents:readonly CollectionDocument[]}){
  const [packet,setPacket]=useState<File|null>(null);
  const [audit,setAudit]=useState<File|null>(null);
  const [report,setReport]=useState<CollectionAuditReport|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  function select(event:ChangeEvent<HTMLInputElement>,kind:'packet'|'audit'){
    const file=event.currentTarget.files?.[0]??null;
    event.currentTarget.value='';
    if(busy)return;
    if(kind==='packet')setPacket(file);else setAudit(file);
    setReport(null);setError('');
  }
  async function verify(){
    if(!packet||!audit||controller.current||!documents.length)return;
    const operation=new AbortController();
    controller.current=operation;
    const token=++generation.current;
    const active=()=>token===generation.current&&!operation.signal.aborted;
    setBusy(true);setReport(null);setError('');
    try{
      const packetText=await readCollectionAuditArtifact(packet,'packet',operation.signal);
      const reportText=await readCollectionAuditArtifact(audit,'audit',operation.signal);
      const result=await verifyCollectionStructuralAudit(reportText,packetText,documents,operation.signal);
      if(active())setReport(result);
    }catch{
      if(active())setError('Report rejected. Attach the exact packet, matching PDFs and native extraction. Reports with missing or unexpected PDF bytes are not replayable here.');
    }finally{
      if(token===generation.current){controller.current=null;setBusy(false);}
    }
  }
  return <details className="chat-collection-inspection" aria-label="Offline structural audit report review">
    <summary>Check offline structural audit report against collection</summary>
    <p className="chat-note">The offline checker verifies structure and source references but does not replay native extraction
      or retrieval. This browser panel separately replays the selected canonical packet and checks the audit's exact counts and hashes.
      It does not authenticate the external audit process or verify official authority.</p>
    <p>Export the packet and native snapshot from the same collection, then run the independent Python checker:</p>
    <pre>python -m noticebridge.chat_collection_audit_cli packet.json snapshot.json --output audit.json</pre>
    <p className="chat-muted">Optionally add one --pdf argument per matching source to check exact PDF bytes. This panel can
      reproduce reports with unchecked PDF bytes or a complete matching byte set only.</p>
    <label className="chat-session-file">Structural audit original review packet
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event=>select(event,'packet')}/>
    </label>
    {packet&&<p className="chat-muted">Packet selected: {packet.name}</p>}
    <label className="chat-session-file">Offline structural audit report
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event=>select(event,'audit')}/>
    </label>
    {audit&&<p className="chat-muted">Audit selected: {audit.name}</p>}
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={busy||!packet||!audit||!documents.length} onClick={()=>void verify()}>Verify offline collection structural audit</button>
      {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel structural audit verification</button>}
      <button type="button" className="chat-button" disabled={busy||!packet&&!audit} onClick={()=>{
        setPacket(null);setAudit(null);setReport(null);setError('');
      }}>Clear structural audit files</button>
    </div>
    {busy&&<p role="status">Replaying packet and checking structural audit counts…</p>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {report&&<section aria-label="Collection structural audit result">
      <h4>Offline structural audit matches the current packet</h4>
      <p>Recorded audit PDF byte check: {report.pdf_bytes_checked?'complete matching byte set':'not performed'}.</p>
      <div className="chat-collection-budget">
        <div><strong>{report.counts.documents}</strong><span>Source PDFs</span></div>
        <div><strong>{report.counts.native_fragments}</strong><span>Native fragments</span></div>
        <div><strong>{report.counts.question_parts}</strong><span>Document/question-part results</span></div>
        <div><strong>{report.counts.citations}</strong><span>Displayed quotations</span></div>
        <div><strong>{report.counts.review_annotations}</strong><span>Personal annotations</span></div>
      </div>
      <p>Packet SHA-256: <code className="chat-filename">{report.packet_sha256}</code></p>
      <p>Snapshot SHA-256: <code className="chat-filename">{report.snapshot_sha256}</code></p>
      <p className="chat-note">Report content matches. Historical execution, extraction completeness, answer accuracy and issuer authority remain unverified.</p>
    </section>}
  </details>;
}
