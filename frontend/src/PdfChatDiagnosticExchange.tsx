import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {MAX_REFERENCE_REPORT_BYTES,exportReferenceReport,verifyReferenceReport} from './pdfChatReferenceReport';
import {MAX_QUALITY_REPORT_BYTES,exportCollectionQuality,verifyQualityReport} from './pdfChatCollectionQuality';

type Mode='references'|'quality';
type Props={documents:readonly CollectionDocument[];selected:readonly string[];mode:Mode;disabled?:boolean};
const settings={
  references:{label:'reference index',file:'noticebridge-reference-index.json',limit:MAX_REFERENCE_REPORT_BYTES,
    detail:'Printed reference identifiers, source fingerprints and UTF-16 coordinates; no whole source lines or filenames.'},
  quality:{label:'native quality',file:'noticebridge-native-quality.json',limit:MAX_QUALITY_REPORT_BYTES,
    detail:'Source fingerprints and diagnostic coordinates; no native fragment text or filenames.'},
};
function download(text:string,name:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;link.download=name;document.body.append(link);
  try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
export default function PdfChatDiagnosticExchange({documents,selected,mode,disabled=false}:Props){
  const config=settings[mode];
  const [approved,setApproved]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[status,setStatus]=useState('');
  const active=useRef<AbortController|null>(null);
  const signature=selected.join(',');
  // Scope changes invalidate consent and cancel any pending computation.
  useEffect(()=>{active.current?.abort();setApproved(false);setError('');setStatus('');},[documents,signature,mode]);
  useEffect(()=>()=>active.current?.abort(),[]);
  async function exportReport(){
    if(!approved||disabled||!selected.length||active.current)return;
    const task=new AbortController();active.current=task;
    setBusy(true);setApproved(false);setError('');setStatus('');
    try{
      const text=mode==='references'?
        await exportReferenceReport(documents,selected,true,task.signal):
        await exportCollectionQuality(documents,selected,true,task.signal);
      task.signal.throwIfAborted();
      download(text,config.file);
      setStatus('Private '+config.label+' report exported.');
    }catch{if(!task.signal.aborted)setError('Unable to export the exact diagnostic report.');}
    finally{if(active.current===task){active.current=null;setBusy(false);}}
  }
  async function verify(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file||disabled||active.current)return;
    const task=new AbortController();active.current=task;
    setBusy(true);setError('');setStatus('');setApproved(false);
    try{
      if(!file.size||file.size>config.limit)throw Error('size');
      const bytes=await file.arrayBuffer();task.signal.throwIfAborted();
      if(bytes.byteLength!==file.size)throw Error('size');
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
      const snapshot=serializeCollectionSnapshot(documents);
      const checked=mode==='references'?await verifyReferenceReport(text,snapshot,task.signal):
        await verifyQualityReport(text,snapshot,task.signal);
      task.signal.throwIfAborted();
      setStatus('Exact '+config.label+' report reproduced for '+checked.source_ids.length+
        ' PDF(s) against the attached native snapshot. Authority and extraction completeness remain unverified.');
    }catch{if(!task.signal.aborted)setError('Report rejected. Attach the exact source collection and use an unchanged diagnostic artifact.');}
    finally{if(active.current===task){active.current=null;setBusy(false);}}
  }
  return <details className="chat-collection-inspection" aria-label={config.label+' report exchange'}>
    <summary>Export or verify {config.label} report</summary>
    <p>{config.detail} Verification recomputes the saved scope, which may differ from the current selection. It never imports an answer or changes the index.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={approved}
      disabled={disabled||busy||!selected.length} onChange={event=>setApproved(event.target.checked)}/>
      I approve exporting this private {config.label} report.</label>
    <button type="button" className="chat-button" disabled={disabled||busy||!approved||!selected.length}
      onClick={()=>void exportReport()}>Export {config.label} report</button>
    <label className="chat-session-file">Verify saved {config.label} report
      <input type="file" accept=".json,application/json" disabled={disabled||busy||!documents.length}
        onChange={event=>void verify(event)}/></label>
    {busy&&<button type="button" className="chat-button" onClick={()=>active.current?.abort()}>Cancel diagnostic exchange</button>}
    {error&&<p className="chat-error" role="alert">{error}</p>}
    {status&&<p className="chat-note" role="status">{status}</p>}
  </details>;
}
