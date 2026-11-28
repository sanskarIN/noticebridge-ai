import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import type {VariantDraft} from './pdfChatQuestionVariants';
import {serializeVariantPlan,loadVariantPlan} from './pdfChatVariantPlan';

type Props={documents:readonly CollectionDocument[];labelsText:string;drafts:VariantDraft[];valid:boolean;disabled:boolean;
  onImport:(drafts:VariantDraft[])=>void};
type Pending={drafts:VariantDraft[];original:VariantDraft[]};
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-question-variant-plan.json';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatVariantPlan({documents,labelsText,drafts,valid,disabled,onImport}:Props){
  const [approval,setApproval]=useState<VariantDraft[]|null>(null),[pending,setPending]=useState<Pending|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const active=useRef<AbortController|null>(null),latest=useRef(drafts);latest.current=drafts;
  useEffect(()=>()=>active.current?.abort(),[]);
  useEffect(()=>{active.current?.abort();setApproval(null);setPending(null);setFeedback('');},[drafts,documents,labelsText]);
  const canExport=!disabled&&!busy&&valid&&approval===drafts;
  async function exportPlan(){
    if(!canExport||active.current)return;
    const task=new AbortController();active.current=task;setBusy(true);setApproval(null);setError('');setFeedback('');
    try{
      const text=await serializeVariantPlan(documents,labelsText,drafts,true,task.signal);
      task.signal.throwIfAborted();if(latest.current!==drafts)return;
      download(text);setFeedback('Private paired question plan exported.');
    }catch{if(!task.signal.aborted)setError('Unable to export a valid confirmed paired plan.');}
    finally{if(active.current===task){active.current=null;setBusy(false);}}
  }
  async function load(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file||disabled||active.current)return;
    const task=new AbortController();active.current=task;setBusy(true);setPending(null);setError('');setFeedback('');
    try{
      const imported=await loadVariantPlan(file,documents,labelsText,task.signal);
      task.signal.throwIfAborted();if(latest.current!==drafts)return;
      setPending({drafts:imported,original:drafts});
    }catch{if(!task.signal.aborted)setError('Paired plan rejected. Import its exact human label artifact first.');}
    finally{if(active.current===task){active.current=null;setBusy(false);}}
  }
  return <details className="chat-collection-inspection" aria-label="Portable paired question plan">
    <summary>Export or import a reusable paired experiment plan</summary>
    <p>Plans contain only private question wording, PDF fingerprints, label artifact hash and explicitly confirmed context settings.
      They do not contain retrieved evidence, label notes or PDF text. The offline command uses the same native retrieval implementation.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={approval===drafts} disabled={disabled||busy||!valid}
      onChange={event=>setApproval(event.target.checked?drafts:null)}/> I approve exporting these private confirmed paired questions.</label>
    <button type="button" className="chat-button" disabled={!canExport} onClick={()=>void exportPlan()}>Export paired question plan</button>
    <label className="chat-session-file">Import paired question plan<input type="file" accept=".json,application/json" disabled={disabled||busy}
      onChange={event=>void load(event)}/></label>
    {busy&&<button type="button" className="chat-button" onClick={()=>active.current?.abort()}>Cancel paired plan exchange</button>}
    {pending&&<section className="chat-note" aria-label="Imported paired plan preview">
      <p>{pending.drafts.length} validated pair(s). Applying replaces only the current experiment draft, not any saved conversation.</p>
      {pending.drafts.map(row=><p key={row.caseKey}>{row.question} · {row.includeContext?'nearby enabled':'strict only'}</p>)}
      <button type="button" className="chat-button" disabled={disabled||busy||pending.original!==drafts} onClick={()=>{
        onImport(pending.drafts);setPending(null);
      }}>Use imported paired question plan</button>
      <button type="button" className="chat-button" onClick={()=>setPending(null)}>Discard imported paired plan</button>
    </section>}
    {error&&<p role="alert" className="chat-error">{error}</p>}{feedback&&<p role="status">{feedback}</p>}
  </details>;
}
