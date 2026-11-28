import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {MAX_QUESTION,type Passage} from './pdfChatCore';
import {MAX_COLLECTION_PLAN_BYTES,type CollectionDocument,type CollectionTurn} from './pdfChatCollection';
import {MAX_BATCH_QUESTIONS,MAX_BATCH_SEARCHES,summarizeCollectionBatch,batchPage,type BatchProgress} from './pdfChatCollectionBatch';
import {makeScopedDraft,editScopedDraft,moveScopedDraft,removeScopedDraft,validateScopedPlan,runScopedPlan,
  applyScopedPlan,exportScopedPlan,importScopedPlan,type ScopedDraft,type ScopedPlanStage} from './pdfChatScopedPlan';
const issueText={empty:'Enter a question.',selection:'Select at least one attached PDF, without duplicates.',
  question:'Invalid question or unsupported page/scope wording.',duplicate:'An identical question, selection and context already appears.'};
type Props={documents:readonly CollectionDocument[];selected:string[];turns:CollectionTurn[];names:Map<string,string>;
  onApply:(turns:CollectionTurn[])=>void;onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
function save(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-scoped-question-plan.json';
  document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatScopedPlan({documents,selected,turns,names,onApply,onInspect}:Props){
  const [rows,setRows]=useState<ScopedDraft[]>([]);
  const [stage,setStage]=useState<ScopedPlanStage|null>(null);
  const [pending,setPending]=useState<ScopedDraft[]|null>(null);
  const [approval,setApproval]=useState<ScopedDraft[]|null>(null);
  const [progress,setProgress]=useState<BatchProgress|null>(null);
  const [reading,setReading]=useState(false);
  const [page,setPage]=useState(1);
  const [feedback,setFeedback]=useState('');
  const [error,setError]=useState('');
  const nextKey=useRef(1),controller=useRef<AbortController|null>(null),generation=useRef(0);
  const latest=useRef({documents,turns,rows});latest.current={documents,turns,rows};
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  const busy=progress!==null||reading;
  const validation=validateScopedPlan(documents,rows,turns);
  const exportable=validateScopedPlan(documents,rows,[]).ready;
  const fresh=stage?.rows===rows&&stage.batch.documents===documents&&stage.batch.history===turns;
  const summary=fresh?summarizeCollectionBatch(stage!.batch.result):null;
  const shown=batchPage(summary?.rows??[],summary?page:1);
  function change(next:ScopedDraft[]){
    setRows(next);setStage(null);setApproval(null);setPending(null);setPage(1);setFeedback('');setError('');
  }
  function add(){
    if(busy||rows.length>=MAX_BATCH_QUESTIONS)return;
    change([...rows,makeScopedDraft(nextKey.current++,selected)]);
  }
  function edit(key:number,value:Partial<Omit<ScopedDraft,'key'>>){change(editScopedDraft(rows,key,value));}
  async function prepare(){
    if(controller.current||!validation.ready)return;
    const operation=new AbortController();controller.current=operation;const token=++generation.current;
    setStage(null);setProgress({completed:0,total:rows.length});setError('');setFeedback('');setPage(1);
    try{
      const result=await runScopedPlan(documents,rows,turns,operation.signal,value=>{
        if(generation.current===token)setProgress(value);
      });
      if(generation.current!==token||operation.signal.aborted)return;
      if(latest.current.documents!==documents||latest.current.turns!==turns||latest.current.rows!==rows){
        setError('Collection work changed. Prepare this plan again.');return;
      }
      setStage(result);
    }catch{if(generation.current===token&&!operation.signal.aborted)setError('Unable to prepare the complete scoped plan.');}
    finally{if(generation.current===token){controller.current=null;setProgress(null);}}
  }
  async function read(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file||controller.current)return;
    const task=new AbortController();controller.current=task;const token=++generation.current;
    setReading(true);setError('');setPending(null);
    try{
      if(!file.size||file.size>MAX_COLLECTION_PLAN_BYTES)throw Error('size');
      const bytes=await file.arrayBuffer();task.signal.throwIfAborted();
      if(bytes.byteLength!==file.size)throw Error('size');
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
      const imported=importScopedPlan(documents,text,nextKey.current);
      if(generation.current!==token||task.signal.aborted||latest.current.documents!==documents)return;
      nextKey.current+=imported.length;setPending(imported);
    }catch{if(generation.current===token&&!task.signal.aborted)setError('Question plan rejected. Attach its exact PDF set and use a bounded canonical plan.');}
    finally{if(generation.current===token){controller.current=null;setReading(false);}}
  }
  return <details className="chat-collection-inspection" aria-label="Independently scoped question planner">
    <summary>Build a question plan with different PDF scopes</summary>
    <p>Each row can search different attached PDFs and can enable nearby-line candidates independently.
      No answers are added to the conversation until a complete prepared plan is explicitly appended.</p>
    <p className="chat-muted">{rows.length}/{MAX_BATCH_QUESTIONS} draft rows · {validation.searches}/{MAX_BATCH_SEARCHES} independent searches · {validation.capacity} remaining history slots.</p>
    {rows.map((row,i)=><fieldset key={row.key} className="chat-citation" disabled={busy}>
      <legend>Scoped question {i+1}</legend>
      <label>Question {i+1}<textarea maxLength={MAX_QUESTION} rows={2} value={row.question}
        onChange={event=>edit(row.key,{question:event.target.value})}/></label>
      <div className="chat-collection-filter-grid">
        {documents.map(doc=><label className="chat-checkbox" key={doc.id}>
          <input type="checkbox" checked={row.documentIds.includes(doc.id)} onChange={event=>edit(row.key,{
            documentIds:event.target.checked?[...row.documentIds,doc.id]:row.documentIds.filter(id=>id!==doc.id),
          })}/> Search {names.get(doc.id)} for question {i+1}</label>)}
      </div>
      <label className="chat-checkbox"><input type="checkbox" checked={row.includeContext}
        onChange={event=>edit(row.key,{includeContext:event.target.checked})}/> Search nearby lines for question {i+1}</label>
      <div className="chat-toolbar">
        <button type="button" className="chat-button" onClick={()=>edit(row.key,{documentIds:[...selected]})}>Use current PDF selection for question {i+1}</button>
        <button type="button" className="chat-button" disabled={i===0} onClick={()=>change(moveScopedDraft(rows,row.key,-1))}>Move question {i+1} earlier</button>
        <button type="button" className="chat-button" disabled={i===rows.length-1} onClick={()=>change(moveScopedDraft(rows,row.key,1))}>Move question {i+1} later</button>
        <button type="button" className="chat-button" onClick={()=>change(removeScopedDraft(rows,row.key))}>Remove scoped question {i+1}</button>
      </div>
      {validation.issues.filter(issue=>issue.key===row.key).map(issue=><p key={issue.reason} className="chat-note">{issueText[issue.reason]}</p>)}
    </fieldset>)}
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={busy||rows.length>=MAX_BATCH_QUESTIONS} onClick={add}>Add scoped question</button>
      <button type="button" className="chat-button" disabled={busy||!validation.ready} onClick={()=>void prepare()}>Prepare independently scoped plan</button>
      {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel scoped plan operation</button>}
    </div>
    {validation.reason&&<p className="chat-muted">{validation.reason}</p>}
    {progress&&<p role="status">Prepared {progress.completed} of {progress.total} independent question turns.</p>}
    {stage&&!fresh&&<p className="chat-note">Saved questions changed. Prepare the plan again before appending.</p>}
    {summary&&<section aria-label="Prepared independently scoped plan">
      <h4>Prepared results — not yet appended</h4>
      <p>{summary.searches} independent searches; {summary.matched} with matching fragments; {summary.unmatched} without matches; {summary.limited} with incomplete coverage.</p>
      {shown.rows.map(row=><article key={row.index} className="chat-answer">
        <h5>{row.index+1}. {row.question}</h5>
        {row.cells.map(cell=><details key={cell.documentId}>
          <summary>{names.get(cell.documentId)} — {cell.matchCount}/{cell.parts.length} parts matched</summary>
          {cell.parts.map((part,i)=><div key={i} className="chat-citation">
            <p>{part.answer.question} · {part.coverage.replaceAll('_',' ')}</p>
            {part.answer.citations.map(source=><div key={source.page+':'+source.ordinal}>
              <p>{source.text}</p><button type="button" className="chat-button" onClick={event=>onInspect(cell.documentId,source,event.currentTarget)}>Inspect scoped plan source {source.page}:{source.ordinal}</button>
            </div>)}
          </div>)}
        </details>)}
      </article>)}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous scoped results</button>
        <span>Page {page} of {shown.pages}</span><button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next scoped results</button>
      </div>}
      <button type="button" className="chat-button" disabled={!fresh||busy} onClick={()=>{
        try{const next=applyScopedPlan(documents,rows,turns,stage!);onApply(next);change([]);setFeedback('Scoped question plan appended.');}
        catch{setError('The prepared plan is no longer valid.');}
      }}>Append independently scoped questions</button>
    </section>}
    <h4>Private plan exchange</h4>
    <label className="chat-checkbox"><input type="checkbox" checked={approval===rows} disabled={busy||!exportable}
      onChange={event=>setApproval(event.target.checked?rows:null)}/> I approve exporting these private scoped questions and PDF fingerprints.</label>
    <button type="button" className="chat-button" disabled={busy||approval!==rows||!exportable} onClick={()=>{
      try{save(exportScopedPlan(documents,rows,true));setApproval(null);setFeedback('Private scoped question plan exported.');}
      catch{setError('Unable to export this scoped question plan.');}
    }}>Export scoped question plan</button>
    <label className="chat-session-file">Import scoped question plan<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>void read(event)}/></label>
    {pending&&<section className="chat-note" aria-label="Imported scoped question draft preview">
      <p>{pending.length} imported draft row(s). Applying replaces only the unsent draft; existing conversation remains unchanged.</p>
      {pending.map(row=><p key={row.key}>{row.question} — {row.documentIds.map(id=>names.get(id)).join('; ')}</p>)}
      <button type="button" className="chat-button" onClick={()=>change(pending)}>Replace scoped draft with imported plan</button>
      <button type="button" className="chat-button" onClick={()=>setPending(null)}>Discard imported scoped plan</button>
    </section>}
    {feedback&&<p role="status">{feedback}</p>}{error&&<p role="alert" className="chat-error">{error}</p>}
  </details>;
}
