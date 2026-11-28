import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import type {CollectionReviewEntry} from './pdfChatCollectionReview';
import type {Passage} from './pdfChatCore';
import {buildEvidenceUsageAsync,filterEvidenceUsage,usagePage,inspectUsageSource,usageTurn,exportEvidenceUsage,verifyEvidenceUsage,
  MAX_USAGE_BYTES,USAGE_PAGE_SIZE,USAGE_LINK_PAGE_SIZE,type EvidenceUsage,type EvidenceUsageRow,type UsageFilter} from './pdfChatEvidenceUsage';
type Input={documents:readonly CollectionDocument[];turns:readonly CollectionTurn[];reviews:readonly CollectionReviewEntry[]};
type Props=Input&{names:Map<string,string>;onInspect:(id:string,source:Passage,target:HTMLElement)=>void;onTurn:(index:number)=>void};
const initial:UsageFilter={documentId:'all',usage:'all',annotation:'all',channel:'all',text:''};
type Ready={input:Input;result:EvidenceUsage};
function same(a:Input,b:Input){return a.documents===b.documents&&a.turns===b.turns&&a.reviews===b.reviews;}
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-citation-usage.json';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function UsageRow({row,result,documents,turns,names,onInspect,onTurn}:Omit<Props,'reviews'>&{row:EvidenceUsageRow;result:EvidenceUsage}){
  const [page,setPage]=useState(1),[open,setOpen]=useState(false);
  const shown=usagePage(row.uses,page,USAGE_LINK_PAGE_SIZE);
  return <article className="chat-citation">
    <h5>{names.get(row.documentId)} · page {row.source.page}, fragment {row.source.ordinal}</h5>
    <p>{row.source.text}</p>
    <p>{row.uses.length} citation use(s) in {row.turnCount} distinct turn(s); {row.strictUses} strict, {row.nearbyUses} nearby.</p>
    <p>{row.annotation?'Personal review: '+row.annotation.status.replaceAll('_',' '):'Not saved in the review notebook.'}</p>
    <button type="button" className="chat-button" onClick={event=>onInspect(row.documentId,inspectUsageSource(documents,result,row),event.currentTarget)}>
      Inspect indexed citation {row.source.page}:{row.source.ordinal}</button>
    {row.uses.length>0?<details onToggle={event=>setOpen(event.currentTarget.open)}>
      <summary>Question uses ({row.uses.length})</summary>
      {open&&<>
        {shown.rows.map(use=><div className="chat-answer" key={use.turnIndex+':'+use.partIndex+':'+use.rank}>
          <p>Turn {use.turnIndex+1}, part {use.partIndex+1}, citation [{use.rank}] · {use.channel}{use.printedField?' · printed field':''}</p>
          <p>{use.question}</p>
          <button type="button" className="chat-button" onClick={()=>onTurn(usageTurn(turns,result,row,use))}>Open citation question {use.turnIndex+1}</button>
        </div>)}
        {shown.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous citation uses</button>
          <span>{shown.first}–{shown.last} of {row.uses.length}</span>
          <button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next citation uses</button>
        </div>}
      </>}
    </details>:<p className="chat-muted">This saved annotation is not cited in the current conversation.</p>}
  </article>;
}
export default function PdfChatEvidenceUsage({documents,turns,reviews,names,onInspect,onTurn}:Props){
  const input={documents,turns,reviews};
  const latest=useRef(input);latest.current=input;
  const active=useRef<AbortController|null>(null);
  const [ready,setReady]=useState<Ready|null>(null),[approved,setApproved]=useState<Ready|null>(null);
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const [filter,setFilter]=useState(initial),[page,setPage]=useState(1);
  useEffect(()=>()=>active.current?.abort(),[]);
  useEffect(()=>{active.current?.abort();setApproved(null);setFeedback('');},[documents,turns,reviews]);
  const current=ready&&same(ready.input,input)?ready:null;
  const rows=current?filterEvidenceUsage(current.result,filter):[];
  const shown=usagePage(rows,Math.min(page,Math.max(1,Math.ceil(rows.length/USAGE_PAGE_SIZE))));
  function change(update:Partial<UsageFilter>){setFilter(old=>({...old,...update}));setPage(1);}
  async function run(mode:'build'|'export'|'verify',file?:File){
    if(active.current||!documents.length||mode==='export'&&(!current||approved!==current))return;
    const task=new AbortController();active.current=task;setBusy(true);setApproved(null);setError('');setFeedback('');
    const fresh=()=>!task.signal.aborted&&same(input,latest.current);
    try{
      if(mode==='build'){
        const result=await buildEvidenceUsageAsync(documents,turns,reviews,task.signal,(done,total)=>setProgress(done+'/'+total+' turns replayed'));
        if(fresh()){setReady({input,result});setFilter(initial);setPage(1);setFeedback('Citation usage recomputed.');}
      }else if(mode==='export'){
        const report=await exportEvidenceUsage(documents,turns,reviews,true,task.signal);
        if(fresh()){download(report);setFeedback('Private citation usage report exported.');}
      }else if(file){
        if(!file.size||file.size>MAX_USAGE_BYTES)throw Error('size');
        const bytes=await file.arrayBuffer();task.signal.throwIfAborted();
        if(bytes.byteLength!==file.size)throw Error('size');
        const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
        const result=await verifyEvidenceUsage(text,documents,turns,reviews,task.signal);
        if(fresh()){setReady({input,result});setFilter(initial);setPage(1);setFeedback('Exact citation usage replay matched.');}
      }
    }catch{if(fresh())setError('Unable to build or verify citation usage from the current exact saved work.');}
    finally{if(active.current===task){active.current=null;setBusy(false);setProgress('');}}
  }
  function choose(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void run('verify',file);
  }
  return <details className="chat-collection-inspection" aria-label="Collection citation usage index">
    <summary>Trace native citation usage across saved questions</summary>
    <p className="chat-note">A frequently returned fragment is not necessarily more relevant or authoritative.
      The index contains only strict and nearby-line citations in saved native answers plus explicitly saved review entries. It does not include optional model proposals.</p>
    <button type="button" className="chat-button" disabled={busy} onClick={()=>void run('build')}>Build citation usage index</button>
    {busy&&<button type="button" className="chat-button" onClick={()=>active.current?.abort()}>Cancel citation usage operation</button>}
    {progress&&<p role="status">{progress}</p>}{error&&<p role="alert" className="chat-error">{error}</p>}{feedback&&<p role="status">{feedback}</p>}
    {ready&&!current&&<p>Saved work changed. Rebuild the citation usage index.</p>}
    {current&&<>
      <div className="chat-collection-budget">
        <div><strong>{current.result.citations}</strong><span>Total citation uses</span></div>
        <div><strong>{current.result.distinctCitations}</strong><span>Distinct cited fragments</span></div>
        <div><strong>{current.result.reusedFragments}</strong><span>Cited in multiple turns</span></div>
        <div><strong>{current.result.uncitedAnnotations}</strong><span>Saved but not cited</span></div>
      </div>
      <p>{current.result.searches} independent searches; {current.result.unmatched} searches with no native citation.</p>
      <details><summary>Per-document citation usage</summary>{current.result.documents.map(doc=><p key={doc.id}>
        {names.get(doc.id)}: {doc.distinctCitations} distinct cited; {doc.annotatedCitations} saved cited;
        {' '}{doc.uncitedAnnotations} saved uncited; {doc.unmatched}/{doc.searches} searches without citations.</p>)}</details>
      <div className="chat-collection-filter-grid">
        <label>Citation PDF<select value={filter.documentId} onChange={event=>change({documentId:event.target.value})}>
          <option value="all">All PDFs</option>{documents.map(doc=><option key={doc.id} value={doc.id}>{names.get(doc.id)}</option>)}
        </select></label>
        <label>Citation reuse<select value={filter.usage} onChange={event=>change({usage:event.target.value as UsageFilter['usage']})}>
          <option value="all">All</option><option value="reused">Multiple question turns</option><option value="single">One question turn</option><option value="uncited">Uncited annotations</option>
        </select></label>
        <label>Citation annotation status<select value={filter.annotation} onChange={event=>change({annotation:event.target.value as UsageFilter['annotation']})}>
          <option value="all">All</option><option value="unsaved">Not saved</option><option value="unreviewed">Unreviewed</option>
          <option value="reviewed_manually">Reviewed manually</option><option value="needs_followup">Needs follow-up</option>
        </select></label>
        <label>Citation channel<select value={filter.channel} onChange={event=>change({channel:event.target.value as UsageFilter['channel']})}>
          <option value="all">All</option><option value="strict">Strict</option><option value="nearby">Nearby-line</option>
        </select></label>
        <label>Find citation or question<input maxLength={100} value={filter.text} onChange={event=>change({text:event.target.value})}/></label>
      </div>
      <p>{rows.length} matching fragment(s).</p>
      {shown.rows.map(row=><UsageRow key={row.key} row={row} result={current.result} documents={documents} turns={turns} names={names} onInspect={onInspect} onTurn={onTurn}/>)}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous citation fragments</button>
        <span>{shown.first}–{shown.last} of {rows.length}</span>
        <button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next citation fragments</button>
      </div>}
      <label className="chat-checkbox"><input type="checkbox" disabled={busy} checked={approved===current} onChange={event=>setApproved(event.target.checked?current:null)}/>
        I approve exporting private question text, PDF fingerprints, citation coordinates and review status (no excerpts or notes).</label>
      <button type="button" className="chat-button" disabled={busy||approved!==current} onClick={()=>void run('export')}>Export citation usage report</button>
    </>}
    <label className="chat-session-file">Verify saved citation usage report<input type="file" accept=".json,application/json" disabled={busy} onChange={choose}/></label>
  </details>;
}
