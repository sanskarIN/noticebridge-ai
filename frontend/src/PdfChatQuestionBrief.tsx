import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {MAX_QUESTION_BRIEF_BYTES,exportQuestionBrief,verifyQuestionBrief,questionBriefReadingCopy,briefCoverageLabel,
  inspectBriefCitation,type QuestionBrief} from './pdfChatQuestionBrief';

type Props={documents:readonly CollectionDocument[];turn:CollectionTurn;names:Map<string,string>;disabled:boolean;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
function download(text:string,filename:string,type:string){
  const url=URL.createObjectURL(new Blob([text],{type}));
  const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);
  try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
export default function PdfChatQuestionBrief({documents,turn,names,disabled,onInspect}:Props){
  const [part,setPart]=useState(0),[prepared,setPrepared]=useState<{brief:QuestionBrief;json:string}|null>(null);
  const [approved,setApproved]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  useEffect(()=>{active.current?.abort();setPrepared(null);setApproved(false);setStatus('');setError('');setPart(0);},[documents,turn]);
  async function prepare(){
    if(disabled||active.current)return;
    const task=new AbortController();active.current=task;setBusy(true);setError('');setStatus('');setApproved(false);setPrepared(null);
    try{
      const json=await exportQuestionBrief(documents,turn,part,true,task.signal);
      task.signal.throwIfAborted();
      // The generated canonical artifact is local only until export consent.
      setPrepared({brief:JSON.parse(json) as QuestionBrief,json});
    }catch{if(!task.signal.aborted)setError('Unable to prepare evidence for this saved question part.');}
    finally{if(active.current===task){active.current=null;setBusy(false);}}
  }
  async function verify(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file||disabled||active.current)return;
    const task=new AbortController();active.current=task;setBusy(true);setError('');setStatus('');
    try{
      if(!file.size||file.size>MAX_QUESTION_BRIEF_BYTES)throw Error('size');
      const bytes=await file.arrayBuffer();task.signal.throwIfAborted();
      if(bytes.byteLength!==file.size)throw Error('size');
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
      const result=await verifyQuestionBrief(text,serializeCollectionSnapshot(documents),task.signal);
      task.signal.throwIfAborted();
      setStatus('Exact evidence brief reproduced for '+result.sources.length+' PDF(s). No answers or conversation were imported.');
    }catch{if(!task.signal.aborted)setError('Evidence brief rejected. Attach the exact native collection and unchanged report.');}
    finally{if(active.current===task){active.current=null;setBusy(false);}}
  }
  function save(kind:'json'|'text'){
    if(!prepared||!approved||disabled||busy)return;
    setApproved(false);setError('');setStatus('');
    try{
      if(kind==='json')download(prepared.json,'noticebridge-question-brief.json','application/json');
      else download(questionBriefReadingCopy(prepared.brief),'noticebridge-question-brief.txt','text/plain;charset=utf-8');
      setStatus('Private question evidence brief exported.');
    }catch{setError('Unable to export the bounded private reading copy.');}
  }
  return <details className="chat-collection-inspection" aria-label="Question evidence brief">
    <summary>Prepare a focused evidence brief</summary>
    <p>Keep just one saved question part and its independent native evidence. This does not turn candidate excerpts into verified claims.</p>
    <label>Question part for brief<select value={part} disabled={disabled||busy} onChange={event=>{
      setPart(Number(event.target.value));setPrepared(null);setApproved(false);setStatus('');setError('');
    }}>{turn.results[0].parts.map((row,i)=><option key={i} value={i}>{i+1}. {row.answer.question}</option>)}</select></label>
    <button type="button" className="chat-button" disabled={disabled||busy} onClick={()=>void prepare()}>Prepare question evidence brief</button>
    {prepared&&<div className="chat-answer">
      <h4>{prepared.brief.question}</h4>
      <p>{prepared.brief.physical_page===null?'All indexed physical pages':'Physical page '+prepared.brief.physical_page}</p>
      {prepared.brief.sources.map(source=><section key={source.document_id} className="chat-citation">
        <h5>{names.get(source.document_id)}</h5>
        <p>{briefCoverageLabel(source.coverage)}</p>
        <p>{source.strict_matches} strict matches · {source.displayed} displayed fragments · {source.omitted_strict_matches} undisplayed strict matches.</p>
        {source.outcome==='no_evidence'&&<p>No displayed evidence; absence is not established.</p>}
        {source.outcome==='nearby_excerpts'&&<p>Nearby-line candidates only; no strict match.</p>}
        {source.printed_fields.length>0&&<dl>{source.printed_fields.map(field=><div key={field.citation}>
          <dt>{field.label} [{field.citation}]</dt><dd>{field.value}</dd>
        </div>)}</dl>}
        {source.citations.map(citation=><div key={citation.rank} className="chat-citation">
          <p className="chat-muted">[{citation.rank}] {citation.channel} · page {citation.page} · fragment {citation.ordinal}</p>
          <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{citation.text}</p>
          <button type="button" className="chat-button" disabled={disabled} onClick={event=>onInspect(source.document_id,
            inspectBriefCitation(documents,turn,prepared.brief,source.document_id,citation),event.currentTarget)}>Inspect brief citation {citation.rank}</button>
        </div>)}
      </section>)}
      <p>Exports include private question wording, native excerpts, text hashes and source fingerprints, but no local filenames or review notes.</p>
      <label className="chat-checkbox"><input type="checkbox" checked={approved} disabled={disabled||busy}
        onChange={event=>setApproved(event.target.checked)}/> I approve exporting this private question evidence brief.</label>
      <button type="button" className="chat-button" disabled={!approved||disabled||busy} onClick={()=>save('json')}>Export verifiable question brief</button>
      <button type="button" className="chat-button" disabled={!approved||disabled||busy} onClick={()=>save('text')}>Export plain-text question reading copy</button>
    </div>}
    <label className="chat-session-file">Verify saved question evidence brief<input type="file" accept=".json,application/json"
      disabled={disabled||busy} onChange={event=>void verify(event)}/></label>
    {busy&&<button type="button" className="chat-button" onClick={()=>active.current?.abort()}>Cancel question brief operation</button>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {status&&<p role="status" className="chat-note">{status}</p>}
  </details>;
}
