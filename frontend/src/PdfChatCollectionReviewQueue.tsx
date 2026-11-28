import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument,CollectionTurn,CollectionStep} from './pdfChatCollection';
import type {CollectionReviewEntry} from './pdfChatCollectionReview';
import type {Passage} from './pdfChatCore';
import {buildReviewQueueAsync,filterReviewQueue,reviewQueuePage,queueQuestionDraft,queueSource,serializeReviewQueue,
  verifyReviewQueue,readReviewQueue,REVIEW_QUEUE_REASONS,REVIEW_QUEUE_PAGE_SIZE,
  type ReviewQueue,type QueueReason,type QueueFilter} from './pdfChatCollectionReviewQueue';

const labels:Record<QueueReason,string>={
  coverage:'Incomplete or unavailable native coverage',no_match:'No matching indexed evidence',
  context_only:'Adjacent-line evidence only',missing_field:'No recognized printed value',
  multiple_values:'Multiple distinct printed values',different_values:'Different literal values between selected PDFs',
  additional_context:'Additional matching or nearby text',omitted_matches:'Strict matches omitted by display limit',
};
type Input={documents:readonly CollectionDocument[];turns:readonly CollectionTurn[];reviews:readonly CollectionReviewEntry[]};
type Props=Input&{names:Map<string,string>;disabled:boolean;draftDisabled:boolean;
  onTurn:(index:number)=>void;onDraft:(step:CollectionStep)=>void;onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
type Ready={input:Input;queue:ReviewQueue};
const initialFilter:QueueFilter={reason:'all',documentId:'all',review:'all',query:''};
function same(a:Input,b:Input){return a.documents===b.documents&&a.turns===b.turns&&a.reviews===b.reviews;}
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-collection-review-queue.json';
  document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatCollectionReviewQueue({documents,turns,reviews,names,disabled,draftDisabled,onTurn,onDraft,onInspect}:Props){
  const input={documents,turns,reviews};
  const latest=useRef(input);latest.current=input;
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  const [ready,setReady]=useState<Ready|null>(null);
  const [filter,setFilter]=useState(initialFilter);
  const [page,setPage]=useState(1);
  const [progress,setProgress]=useState('');
  const [feedback,setFeedback]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [consent,setConsent]=useState<Ready|null>(null);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  useEffect(()=>{controller.current?.abort();setConsent(null);setFeedback('');},[documents,turns,reviews,disabled]);
  const current=ready&&same(ready.input,input)?ready:null;
  const rows=current?filterReviewQueue(current.queue,filter):[];
  const activePage=Math.min(page,Math.max(1,Math.ceil(rows.length/REVIEW_QUEUE_PAGE_SIZE)));
  const shown=reviewQueuePage(rows,activePage);
  function change(update:Partial<QueueFilter>){setFilter(old=>({...old,...update}));setPage(1);}
  async function run(mode:'build'|'export'|'verify',file?:File){
    if(disabled||controller.current||!turns.length||mode==='export'&&(!current||consent!==current))return;
    const task=new AbortController();controller.current=task;const token=++generation.current;
    const active=()=>generation.current===token&&!task.signal.aborted&&same(latest.current,input);
    setBusy(true);setError('');setFeedback('');setConsent(null);
    try{
      if(mode==='build'){
        const queue=await buildReviewQueueAsync(documents,turns,reviews,task.signal,(done,total)=>setProgress(done+' / '+total+' saved turns reviewed'));
        if(active()){setReady({input,queue});setPage(1);setFilter(initialFilter);setFeedback('Review queue recomputed.');}
      }else if(mode==='export'){
        const text=await serializeReviewQueue(documents,turns,reviews,true,task.signal);
        if(active()){download(text);setFeedback('Private review queue exported.');}
      }else if(file){
        const queue=await verifyReviewQueue(await readReviewQueue(file,task.signal),documents,turns,reviews,task.signal);
        if(active()){setReady({input,queue});setPage(1);setFilter(initialFilter);setFeedback('Exact review queue replay matched.');}
      }
    }catch{if(active())setError('Unable to process this review queue. Check the current collection, saved questions and review annotations.');}
    finally{if(generation.current===token){controller.current=null;setBusy(false);setProgress('');}}
  }
  function pick(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(file)void run('verify',file);
  }
  return <details className="chat-collection-inspection" aria-label="Collection question review queue">
    <summary>Review unanswered and ambiguous saved questions</summary>
    <p className="chat-note">Diagnostics flag native retrieval limitations, not official errors, removals or verified answers.
      Saving an excerpt or marking it reviewed does not resolve the underlying search limitation.</p>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={disabled||busy||!turns.length} onClick={()=>void run('build')}>Build collection review queue</button>
      {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel review queue operation</button>}
    </div>
    {progress&&<p role="status">{progress}</p>}
    {ready&&!current&&<p className="chat-note">Collection work changed. Rebuild the queue before inspecting or exporting.</p>}
    {current&&<>
      <div className="chat-collection-budget">
        <div><strong>{current.queue.turns}</strong><span>Saved turns</span></div>
        <div><strong>{current.queue.searches}</strong><span>Independent question/PDF searches</span></div>
        <div><strong>{current.queue.items.length}</strong><span>Searches with review cues</span></div>
      </div>
      <div className="chat-collection-filter-grid">
        <label>Review queue reason<select value={filter.reason} onChange={event=>change({reason:event.target.value as QueueFilter['reason']})}>
          <option value="all">All reasons</option>
          {REVIEW_QUEUE_REASONS.map(reason=><option key={reason} value={reason}>{labels[reason]} ({current.queue.reasonCounts[reason]})</option>)}
        </select></label>
        <label>Review queue document<select value={filter.documentId} onChange={event=>change({documentId:event.target.value})}>
          <option value="all">All searched PDFs</option>
          {documents.map(doc=><option key={doc.id} value={doc.id}>{names.get(doc.id)}</option>)}
        </select></label>
        <label>Review queue saved evidence<select value={filter.review} onChange={event=>change({review:event.target.value as QueueFilter['review']})}>
          <option value="all">All</option><option value="unsaved">No displayed candidates saved</option>
          <option value="saved">At least one candidate saved</option>
        </select></label>
        <label>Find review queue question<input value={filter.query} maxLength={100} onChange={event=>change({query:event.target.value})}/></label>
      </div>
      <p role="status">{rows.length} of {current.queue.items.length} review cues match the filters.</p>
      {!rows.length&&<p>No matching review cue. This does not certify completeness or correctness.</p>}
      {shown.rows.map(item=><article key={item.key} className="chat-answer" aria-label={'Review queue turn '+(item.turnIndex+1)+' part '+(item.partIndex+1)+' '+names.get(item.documentId)}>
        <h5>{item.question}</h5><p>{names.get(item.documentId)} · turn {item.turnIndex+1}, part {item.partIndex+1}</p>
        <ul>{item.reasons.map(reason=><li key={reason}>{labels[reason]}</li>)}</ul>
        <p>{item.strictMatches} strict match(es) · {item.shownFragments} displayed fragment(s) · {item.savedEvidence} saved candidate(s)
          · {item.manuallyReviewed} manually reviewed annotation(s).</p>
        <div className="chat-toolbar">
          <button type="button" className="chat-button" onClick={()=>onTurn(item.turnIndex)}>Open saved question turn {item.turnIndex+1}</button>
          <button type="button" className="chat-button" disabled={draftDisabled||disabled} onClick={()=>onDraft(queueQuestionDraft(documents,turns,item))}>Draft question for this PDF</button>
        </div>
        {item.evidence.length>0&&<details><summary>Inspect queue source candidates</summary>
          {item.evidence.map(source=><div className="chat-citation" key={source.page+':'+source.ordinal}>
            <p>{source.text}</p>
            <button type="button" className="chat-button" onClick={event=>onInspect(item.documentId,
              queueSource(documents,current.queue,item,source),event.currentTarget)}>Inspect review candidate {source.page}:{source.ordinal}</button>
          </div>)}
        </details>}
      </article>)}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={activePage===1} onClick={()=>setPage(activePage-1)}>Previous review cues</button>
        <span>{shown.first}–{shown.last} of {rows.length}</span>
        <button type="button" className="chat-button" disabled={activePage===shown.pages} onClick={()=>setPage(activePage+1)}>Next review cues</button>
      </div>}
      <label className="chat-checkbox"><input type="checkbox" checked={consent===current} disabled={busy||disabled}
        onChange={event=>setConsent(event.target.checked?current:null)}/> I approve exporting private question text, fingerprints and diagnostic coordinates.</label>
      <button type="button" className="chat-button" disabled={busy||disabled||consent!==current} onClick={()=>void run('export')}>Export collection review queue</button>
    </>}
    <label className="chat-session-file">Verify saved collection review queue<input type="file" accept=".json,application/json"
      disabled={busy||disabled||!turns.length} onChange={pick}/></label>
    {feedback&&<p role="status">{feedback}</p>}{error&&<p role="alert" className="chat-error">{error}</p>}
  </details>;
}
