import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {collectionOverlap,filterCollectionOverlap,inspectOverlapSource,overlapPage,serializeCollectionOverlap,
  verifyCollectionOverlap,readOverlapFile,OVERLAP_PAGE_SIZE,OVERLAP_SOURCE_PAGE_SIZE,
  type CollectionOverlap,type OverlapGroup,type OverlapFilter,type OverlapScope} from './pdfChatCollectionOverlap';
type Props={documents:readonly CollectionDocument[];selected:string[];names:Map<string,string>;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
const initialFilter:OverlapFilter={presence:'shared',documentId:'all',query:''};
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-collection-literal-overlap.json';
  document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function Occurrences({documents,names,result,group,onInspect}:Omit<Props,'selected'>&{result:CollectionOverlap;group:OverlapGroup}){
  const [pages,setPages]=useState<Record<string,number>>({});
  return <details><summary>Inspect physical occurrences</summary>
    {group.sources.map(source=>{
      const current=pages[source.documentId]??1;
      const shown=overlapPage(source.fragments,current,OVERLAP_SOURCE_PAGE_SIZE);
      return <section className="chat-citation" key={source.documentId}>
        <h5>{names.get(source.documentId)}</h5><p>{source.fragments.length} native occurrence(s).</p>
        <div className="chat-toolbar">
          {shown.rows.map(fragment=><button type="button" key={fragment.page+':'+fragment.ordinal} className="chat-button"
            onClick={event=>onInspect(source.documentId,inspectOverlapSource(documents,result,group,source.documentId,fragment),event.currentTarget)}>
            Inspect occurrence {fragment.page}:{fragment.ordinal}</button>)}
        </div>
        {shown.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={current===1}
            onClick={()=>setPages(old=>({...old,[source.documentId]:current-1}))}>Previous occurrences</button>
          <span>{shown.first}–{shown.last} of {source.fragments.length}</span>
          <button type="button" className="chat-button" disabled={current===shown.pages}
            onClick={()=>setPages(old=>({...old,[source.documentId]:current+1}))}>Next occurrences</button>
        </div>}
      </section>;
    })}
  </details>;
}
export default function PdfChatCollectionOverlap({documents,selected,names,onInspect}:Props){
  const [minimum,setMinimum]=useState('12');
  const [physical,setPhysical]=useState('');
  const [result,setResult]=useState<CollectionOverlap|null>(null);
  const [filter,setFilter]=useState(initialFilter);
  const [page,setPage]=useState(1);
  const [consent,setConsent]=useState<CollectionOverlap|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [feedback,setFeedback]=useState('');
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  const rows=result?filterCollectionOverlap(result,filter):[];
  const current=Math.min(page,Math.max(1,Math.ceil(rows.length/OVERLAP_PAGE_SIZE)));
  const shown=overlapPage(rows,current);
  function reset(){setResult(null);setConsent(null);setError('');setFeedback('');}
  function scope():OverlapScope{
    if(!/^\d+$/.test(minimum)||physical&&!/^\d+$/.test(physical))throw Error('scope');
    return {documentIds:selected,minimumLength:Number(minimum),physicalPage:physical?Number(physical):null};
  }
  function apply(value:CollectionOverlap){
    setResult(value);setFilter(initialFilter);setPage(1);setConsent(null);
  }
  function build(){
    try{apply(collectionOverlap(documents,scope()));setError('');setFeedback('Literal native overlap computed.');}
    catch{reset();setError('Select at least two PDFs and enter a minimum length from 1–900 and an optional physical page from 1–80.');}
  }
  async function exchange(file?:File){
    if(controller.current||!file&&(!result||consent!==result))return;
    const task=new AbortController();controller.current=task;const token=++generation.current;
    const active=()=>token===generation.current&&!task.signal.aborted;
    setBusy(true);setConsent(null);setError('');setFeedback('');
    try{
      if(file){
        const value=await verifyCollectionOverlap(await readOverlapFile(file,task.signal),documents,task.signal);
        if(value.scope.documentIds.join(',')!==selected.join(','))throw Error('selection');
        if(active()){setMinimum(String(value.scope.minimumLength));setPhysical(value.scope.physicalPage===null?'':String(value.scope.physicalPage));
          apply(value);setFeedback('Exact literal overlap report replay matched.');}
      }else{
        const text=await serializeCollectionOverlap(documents,result!.scope,true,task.signal);
        if(active()){download(text);setFeedback('Private literal overlap report exported.');}
      }
    }catch{if(active())setError('Unable to verify or export the overlap report for these exact selected PDFs.');}
    finally{if(token===generation.current){controller.current=null;setBusy(false);}}
  }
  function change(value:Partial<OverlapFilter>){setFilter(old=>({...old,...value}));setPage(1);}
  function pick(event:ChangeEvent<HTMLInputElement>){const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void exchange(file);}
  return <details className="chat-collection-inspection" aria-label="Literal collection text overlap">
    <summary>Inspect identical native fragments across PDFs</summary>
    <p className="chat-note">Exact extracted text only, preserving case, whitespace and punctuation. Exclusive text means not
      observed in another selected indexed scope; it does not establish a deletion or new rule. Headers and boilerplate may repeat.</p>
    <div className="chat-collection-filter-grid">
      <label>Minimum overlap text length<input value={minimum} inputMode="numeric" maxLength={3} disabled={busy}
        onChange={event=>{setMinimum(event.target.value);reset();}}/></label>
      <label>Overlap physical page (optional)<input value={physical} inputMode="numeric" maxLength={2} disabled={busy}
        onChange={event=>{setPhysical(event.target.value);reset();}}/></label>
    </div>
    <button type="button" className="chat-button" disabled={busy||selected.length<2} onClick={build}>Compute selected PDF literal overlap</button>
    {result&&<>
      <div className="chat-collection-budget">
        <div><strong>{result.sharedGroups}</strong><span>Texts in multiple PDFs</span></div>
        <div><strong>{result.exclusiveGroups}</strong><span>Texts in one selected PDF only</span></div>
        <div><strong>{result.occurrences}</strong><span>Physical native occurrences</span></div>
      </div>
      <div className="chat-collection-matrix">{result.documents.map(doc=><article className="chat-overview-side" key={doc.documentId}>
        <h5>{names.get(doc.documentId)}</h5><p>{doc.distinctTexts} distinct text(s), {doc.sharedTexts} shared, {doc.exclusiveTexts} exclusive.</p>
        <p>{doc.coverage.replaceAll('_',' ')}; completeness not established.</p>
      </article>)}</div>
      <details><summary>Inspect pairwise literal overlap counts</summary>
        {result.pairs.map(pair=><article className="chat-citation" key={pair.left+pair.right}>
          <p>{names.get(pair.left)} / {names.get(pair.right)}</p>
          <p>{pair.sharedTexts} common distinct texts · {pair.leftOnly} only in first indexed scope · {pair.rightOnly} only in second.</p>
        </article>)}
      </details>
      <div className="chat-collection-filter-grid">
        <label>Overlap presence<select value={filter.presence} onChange={event=>change({presence:event.target.value as OverlapFilter['presence']})}>
          <option value="shared">Multiple PDFs</option><option value="all">All exact texts</option>
          <option value="exclusive">One PDF only</option><option value="every">Every selected PDF</option>
        </select></label>
        <label>Overlap document<select value={filter.documentId} onChange={event=>change({documentId:event.target.value})}>
          <option value="all">All selected PDFs</option>
          {result.scope.documentIds.map(id=><option key={id} value={id}>{names.get(id)}</option>)}
        </select></label>
        <label>Find overlap text<input value={filter.query} maxLength={100} onChange={event=>change({query:event.target.value})}/></label>
      </div>
      <p role="status">{rows.length} distinct native text(s) match.</p>
      {shown.rows.map(group=><article key={group.text} className="chat-answer">
        <p>{group.text}</p><p>{group.sources.length} selected PDF(s), {group.occurrences} physical occurrence(s).</p>
        <Occurrences documents={documents} names={names} result={result} group={group} onInspect={onInspect}/>
      </article>)}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={current===1} onClick={()=>setPage(current-1)}>Previous overlap texts</button>
        <span>{shown.first}–{shown.last} of {rows.length}</span>
        <button type="button" className="chat-button" disabled={current===shown.pages} onClick={()=>setPage(current+1)}>Next overlap texts</button>
      </div>}
      <label className="chat-checkbox"><input type="checkbox" checked={consent===result} disabled={busy}
        onChange={event=>setConsent(event.target.checked?result:null)}/> I approve exporting private PDF fingerprints and native occurrence coordinates.</label>
      <button type="button" className="chat-button" disabled={busy||consent!==result} onClick={()=>void exchange()}>Export collection literal overlap</button>
    </>}
    <label className="chat-session-file">Verify saved collection literal overlap<input type="file" accept=".json,application/json"
      disabled={busy||selected.length<2} onChange={pick}/></label>
    {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel overlap file operation</button>}
    {error&&<p role="alert" className="chat-error">{error}</p>}{feedback&&<p role="status">{feedback}</p>}
  </details>;
}
