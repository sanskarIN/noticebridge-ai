import {useEffect,useMemo,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import {readOcrReview} from './pdfChatOcrReview';
import {isLocalChatOrigin} from './pdfChatLocalTransport';
import {MAX_LOCAL_OCR_SELECTION} from './pdfChatLocalOcr';
import {parseCollectionOcr,replaceCollectionOcr,removeCollectionOcr,collectionOcrStats,collectionOcrPage,
  collectionOcrPageList,collectionOcrSearch,runCollectionOcr,OCR_COLLECTION_PAGE_SIZE,
  type CollectionOcrEntry} from './pdfChatCollectionOcr';

type Inspect=(id:string,page:number,target:HTMLElement)=>void;
const stateLabels={ok:'OCR text available',empty:'No OCR lines returned',unavailable:'OCR unavailable',limited:'OCR output limited'};
export default function PdfChatCollectionOcr({documents,turn,onInspect}:{
  documents:readonly CollectionDocument[];turn:CollectionTurn|null;onInspect:Inspect;
}){
  const [entries,setEntries]=useState<CollectionOcrEntry[]>([]);
  const [documentId,setDocumentId]=useState(documents[0].id);
  const [pages,setPages]=useState('');
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [feedback,setFeedback]=useState('');
  const [pending,setPending]=useState<CollectionOcrEntry|null>(null);
  const [browse,setBrowse]=useState<{id:string;page:number}|null>(null);
  const [listPage,setListPage]=useState(1);
  const [filter,setFilter]=useState('');
  const [part,setPart]=useState(0);
  const [searchOpen,setSearchOpen]=useState(false);
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  const local=isLocalChatOrigin(globalThis.location?.origin??'');
  const doc=documents.find(row=>row.id===documentId)??documents[0];
  const name=(id:string)=>{const index=documents.findIndex(row=>row.id===id);return 'Document '+(index+1)+': '+documents[index]?.file.name;};
  const stats=useMemo(()=>collectionOcrStats(documents,entries),[documents,entries]);
  const activeEntry=entries.find(row=>row.documentId===browse?.id);
  const detail=useMemo(()=>browse&&activeEntry?collectionOcrPage(documents,activeEntry,browse.page):null,[documents,activeEntry,browse]);
  const visible=detail?.lines.filter(row=>row.text.toLowerCase().includes(filter.trim().toLowerCase()))??[];
  const current=Math.min(listPage,Math.max(1,Math.ceil(visible.length/OCR_COLLECTION_PAGE_SIZE)));
  const shown=collectionOcrPageList(visible,current);
  const chosenPart=Math.min(part,Math.max(0,(turn?.results[0]?.parts.length??1)-1));
  const results=useMemo(()=>searchOpen&&turn?collectionOcrSearch(documents,entries,turn,chosenPart):[],
    [searchOpen,documents,entries,turn,chosenPart]);
  function start(){
    if(controller.current)return null;
    const operation=new AbortController();controller.current=operation;setBusy(true);setConsent(false);setPending(null);setError('');setFeedback('');
    return {operation,token:++generation.current};
  }
  function active(token:number,operation:AbortController){return token===generation.current&&!operation.signal.aborted;}
  function finish(token:number){if(token===generation.current){controller.current=null;setBusy(false);}}
  async function importReport(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file)return;
    const task=start();if(!task)return;
    const {token,operation}=task;
    try{
      const text=await readOcrReview(file);
      operation.signal.throwIfAborted();
      const entry=parseCollectionOcr(documents,doc.id,text);
      replaceCollectionOcr(documents,entries,entry);
      if(active(token,operation))setPending(entry);
    }catch{if(active(token,operation))setError('OCR report rejected. Choose the exact PDF and canonical report for the original role.');}
    finally{finish(token);}
  }
  async function direct(){
    if(!local||!consent)return;
    const task=start();if(!task)return;
    const {token,operation}=task;
    try{
      const entry=await runCollectionOcr(documents,doc.id,pages,operation.signal,true);
      replaceCollectionOcr(documents,entries,entry);
      if(active(token,operation))setPending(entry);
    }catch{if(active(token,operation))setError('Local OCR failed or is disabled. Select up to 12 physical pages in a PDF of at most 80 pages.');}
    finally{finish(token);}
  }
  function apply(){
    if(!pending||busy)return;
    try{
      setEntries(replaceCollectionOcr(documents,entries,pending));
      setBrowse(null);setPending(null);setFeedback('Unverified OCR review applied to the selected PDF only.');
    }catch{setError('OCR review exceeds the collection budget.');}
  }
  return <details className="chat-collection-inspection" aria-label="Collection scanned PDF review">
    <summary>Review scanned collection PDFs with optional local OCR</summary>
    <p className="chat-note">Machine-transcribed text can misread names, numbers and conditions. It never becomes native
      answer evidence or a saved native fragment. Inspect the actual rendered PDF page.</p>
    <p className="chat-muted">Use a trusted local runtime with English OCR data. A fingerprint identifies source bytes,
      not the accuracy or authenticity of an OCR report.</p>
    <label>Collection OCR source PDF
      <select value={doc.id} disabled={busy} onChange={event=>{setDocumentId(event.target.value);setConsent(false);setPages('');setPending(null);setError('');}}>
        {documents.map(row=><option key={row.id} value={row.id}>{name(row.id)}</option>)}
      </select>
    </label>
    <p>{doc.corpus.pageCount} physical pages. OCR supports documents with at most 80 physical pages.</p>
    <pre>python -m noticebridge.chat_ocr_cli source.pdf --role original --pages 1,3 --output ocr.json --allow-local-processing</pre>
    <label className="chat-session-file">Import collection OCR review for selected PDF
      <input type="file" accept=".json,application/json" disabled={busy||doc.corpus.pageCount>80} onChange={event=>void importReport(event)}/>
    </label>
    {local&&<section aria-label="Collection direct loopback OCR">
      <p>The optional loopback route sends the complete selected PDF to the trusted local backend, not just the requested pages.
        It requires explicit approval and backend opt-in.</p>
      <label>Collection OCR physical pages
        <input value={pages} maxLength={MAX_LOCAL_OCR_SELECTION} disabled={busy} placeholder="1,3-5"
          onChange={event=>{setPages(event.target.value);setConsent(false);setPending(null);}}/>
      </label>
      <label className="chat-checkbox"><input type="checkbox" checked={consent} disabled={busy||doc.corpus.pageCount>80}
        onChange={event=>setConsent(event.target.checked)}/> I approve sending this selected collection PDF to my trusted local OCR backend.</label>
      <button type="button" className="chat-button" disabled={busy||!consent||!pages.trim()||doc.corpus.pageCount>80}
        onClick={()=>void direct()}>Run selected collection PDF OCR</button>
    </section>}
    {busy&&<div className="chat-toolbar"><p role="status">Checking collection OCR review…</p>
      <button type="button" className="chat-button" onClick={()=>{controller.current?.abort();setFeedback('Collection OCR operation cancelled.');}}>Cancel collection OCR operation</button></div>}
    {pending&&<section className="chat-note" aria-label="Collection OCR review confirmation">
      <p>{name(pending.documentId)} · {pending.review.pages.length} reviewed physical page(s).
        Applying replaces the previous OCR report for this PDF only.</p>
      <button type="button" className="chat-button" disabled={busy} onClick={apply}>Apply unverified collection OCR review</button>
      <button type="button" className="chat-button" onClick={()=>setPending(null)}>Discard prepared collection OCR review</button>
    </section>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {feedback&&<p role="status" className="chat-note">{feedback}</p>}
    <p>{stats.documents} PDF(s), {stats.pages} reviewed pages, {stats.lines} machine-transcribed lines.</p>
    {entries.map(entry=><article className="chat-citation" key={entry.documentId}>
      <h4>{name(entry.documentId)}</h4>
      <button type="button" className="chat-button" disabled={busy} onClick={()=>{
        setEntries(old=>removeCollectionOcr(old,entry.documentId));setBrowse(null);setPending(null);
      }}>Remove this collection OCR report</button>
      <div className="chat-toolbar">
        {entry.review.pages.map(page=><button type="button" className="chat-button" key={page.page} onClick={()=>{
          setBrowse({id:entry.documentId,page:page.page});setFilter('');setListPage(1);
        }}>Browse OCR page {page.page} · {stateLabels[page.status]}</button>)}
      </div>
    </article>)}
    {detail&&<section className="chat-answer" aria-label="Collection OCR page lines">
      <h4>{name(detail.documentId)} · physical page {detail.page}</h4>
      <p>{stateLabels[detail.status]} · {detail.nativeFragments} indexed native fragments on this page.</p>
      <button type="button" className="chat-button" onClick={event=>onInspect(detail.documentId,detail.page,event.currentTarget)}>Inspect rendered collection OCR page</button>
      <label>Find machine-transcribed text
        <input value={filter} maxLength={120} onChange={event=>{setFilter(event.target.value);setListPage(1);}}/>
      </label>
      {shown.rows.map(line=><div key={line.ordinal} className="chat-citation">
        <p className="chat-muted">OCR line {line.ordinal} · {line.nativeExact?'exact native text also indexed':'no exact native fragment on this page'}</p>
        <p>{line.text}</p>
      </div>)}
      {!visible.length&&<p>No matching machine-transcribed line.</p>}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={current===1} onClick={()=>setListPage(current-1)}>Previous OCR lines</button>
        <span>Page {current} of {shown.pages}</span>
        <button type="button" className="chat-button" disabled={current===shown.pages} onClick={()=>setListPage(current+1)}>Next OCR lines</button>
      </div>}
    </section>}
    {entries.length>0&&turn&&<details onToggle={event=>setSearchOpen(event.currentTarget.open)}>
      <summary>Search OCR review for the selected collection question</summary>
      <p className="chat-note">This searches the reviewed machine-transcribed pages only. Native answers and citations remain unchanged.</p>
      <label>Collection OCR question part
        <select value={chosenPart} onChange={event=>setPart(Number(event.target.value))}>
          {turn.results[0].parts.map((row,i)=><option value={i} key={i}>{row.answer.question}</option>)}
        </select>
      </label>
      {results.map(side=><section key={side.documentId} className="chat-citation" aria-label={'Collection OCR matches: '+name(side.documentId)}>
        <h5>{name(side.documentId)}</h5>
        {side.state==='missing_review'?<p>No OCR report for this PDF.</p>:side.state==='page_not_reviewed'?<p>The requested physical page was not reviewed.</p>:<>
          <p>Reviewed pages: {side.reviewedPages.join(', ')}. {side.incompletePages.length>0&&'Incomplete OCR pages: '+side.incompletePages.join(', ')+'.'}</p>
          {!side.matches.length&&<p>No matching OCR review line. This is not proof of absence.</p>}
          {side.matches.map(row=><div className="chat-citation" key={row.source.page+':'+row.source.ordinal}>
            <p className="chat-muted">Physical page {row.source.page} · OCR line {row.source.ordinal}</p>
            <p>{row.source.text}</p>
            <button type="button" className="chat-button" onClick={event=>onInspect(row.documentId,row.source.page,event.currentTarget)}>Inspect collection OCR match page {row.source.page}</button>
          </div>)}
        </>}
      </section>)}
    </details>}
  </details>;
}
