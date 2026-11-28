import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {loadCollectionSnapshot} from './pdfChatCollectionReplay';
import {compareCollectionSnapshots,serializeSnapshotDifference,verifySnapshotDifference,filterSnapshotDifferences,snapshotDifferencePage,
  SNAPSHOT_DIFF_PAGE_SIZE,MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES,type SnapshotDifference,type SourceDifference,type DifferenceKind} from './pdfChatSnapshotDifference';
import type {Passage} from './pdfChatCore';
const labels:Record<DifferenceKind,string>={identical:'Identical',text:'Text differs',geometry:'Geometry differs',
  text_and_geometry:'Text and geometry differ',left_only:'Left coordinate only',right_only:'Right coordinate only'};
function display(source:Passage|null){
  if(!source)return <p>No fragment at this coordinate.</p>;
  return <><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{source.text}</p>
    <p className="chat-muted">{source.position?'x0 '+source.position.x0+' · x1 '+source.position.x1+' · y '+source.position.y+' · height '+source.position.height:'Geometry unavailable'}</p></>;
}
function Source({source}:{source:SourceDifference}){
  const [kind,setKind]=useState<DifferenceKind|'all'|'changed'>('changed');
  const [physical,setPhysical]=useState<number|null>(null),[page,setPage]=useState(1);
  const rows=filterSnapshotDifferences(source,{page:physical,kind});
  const shown=snapshotDifferencePage(rows,page),pages=Math.max(1,Math.ceil(rows.length/SNAPSHOT_DIFF_PAGE_SIZE));
  return <article className="chat-citation">
    <h5>{source.status.replaceAll('_',' ')}</h5><code className="chat-filename">{source.id}</code>
    <p>{source.leftFragments} left / {source.rightFragments} right native fragments.</p>
    {source.coverage&&<p>Coverage metadata: {source.coverage.matches?'matching':'different'}; {source.coverage.expected_processed_pages} / {source.coverage.observed_processed_pages} processed pages.</p>}
    <div className="chat-toolbar">{Object.entries(source.counts).map(([key,value])=><span key={key}>{labels[key as DifferenceKind]}: {value}</span>)}</div>
    <details><summary>Inspect individual snapshot coordinates</summary>
      <p className="chat-note">Coordinates are extraction identities, not semantic alignment. Text comes from imported snapshots, not independently reopened PDFs.</p>
      <label>Fragment difference filter<select value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setPage(1);}}>
        <option value="changed">All differences</option><option value="all">All fragments</option>
        {Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Physical page<select value={physical??''} onChange={event=>{setPhysical(event.target.value?Number(event.target.value):null);setPage(1);}}>
        <option value="">All pages</option>{source.pages.map(row=><option key={row.page} value={row.page}>Page {row.page}</option>)}
      </select></label>
      <p>{rows.length} coordinate(s) · page {page} of {pages}</p>
      {shown.map(row=><section key={row.page+':'+row.ordinal}>
        <h5>Physical page {row.page} · fragment {row.ordinal} · {labels[row.kind]}</h5>
        <div className="chat-collection-matrix"><div className="chat-overview-side"><strong>Left snapshot</strong>{display(row.left)}</div>
          <div className="chat-overview-side"><strong>Right snapshot</strong>{display(row.right)}</div></div>
      </section>)}
      <div className="chat-toolbar"><button type="button" disabled={page===1} onClick={()=>setPage(value=>value-1)}>Previous coordinates</button>
        <button type="button" disabled={page===pages} onClick={()=>setPage(value=>value+1)}>Next coordinates</button></div>
    </details>
  </article>;
}
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-snapshot-difference.json';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatSnapshotDifference(){
  const [left,setLeft]=useState<File|null>(null),[right,setRight]=useState<File|null>(null),[candidate,setCandidate]=useState<File|null>(null);
  const [result,setResult]=useState<SnapshotDifference|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [approved,setApproved]=useState<SnapshotDifference|null>(null),[feedback,setFeedback]=useState('');
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  function choose(event:ChangeEvent<HTMLInputElement>,side:'left'|'right'|'candidate'){
    const file=event.target.files?.[0]??null;event.target.value='';
    if(busy)return;
    setResult(null);setApproved(null);setFeedback('');setError('');
    (side==='left'?setLeft:side==='right'?setRight:setCandidate)(file);
  }
  async function compare(){
    if(!left||!right||active.current)return;
    const operation=new AbortController();active.current=operation;setBusy(true);setResult(null);setApproved(null);setError('');setFeedback('');
    try{
      const a=await loadCollectionSnapshot(left,operation.signal),b=await loadCollectionSnapshot(right,operation.signal);
      let report:SnapshotDifference;
      if(candidate){
        if(!candidate.size||candidate.size>MAX_SNAPSHOT_DIFFERENCE_REPORT_BYTES)throw Error('report size');
        const bytes=await candidate.arrayBuffer();operation.signal.throwIfAborted();
        if(bytes.byteLength!==candidate.size)throw Error('report size');
        report=await verifySnapshotDifference(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),a,b,operation.signal);
      }else report=await compareCollectionSnapshots(a,b,operation.signal);
      operation.signal.throwIfAborted();setResult(report);setFeedback(candidate?'Saved difference report exactly reproduced.':'Snapshot comparison completed.');
    }catch{if(!operation.signal.aborted)setError('Unable to validate the selected snapshots or reproduce the saved difference report.');}
    finally{if(active.current===operation){active.current=null;setBusy(false);}}
  }
  return <details className="chat-collection-inspection" aria-label="Compare native collection snapshots">
    <summary>Compare two native snapshots without reopening PDFs</summary>
    <p className="chat-note">Use snapshots from separate PDF.js runs to investigate extraction variability. No actual PDF bytes are read here. Matching fingerprint strings and extracted text do not establish official authority or completeness.</p>
    {([['left','Left collection snapshot',left],['right','Right collection snapshot',right],['candidate','Optional saved snapshot difference report',candidate]] as const).map(([side,label,file])=><div key={side}>
      <label className="chat-session-file">{label}<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>choose(event,side)}/></label>
      {file&&<p className="chat-muted">{file.name}</p>}
    </div>)}
    {candidate&&<button type="button" className="chat-button" disabled={busy} onClick={()=>{setCandidate(null);setResult(null);setApproved(null);setFeedback('');setError('');}}>Remove saved difference report</button>}
    <button type="button" className="chat-button" disabled={!left||!right||busy} onClick={()=>void compare()}>Compare collection snapshots</button>
    {busy&&<button type="button" className="chat-button" onClick={()=>active.current?.abort()}>Cancel snapshot comparison</button>}
    {error&&<p role="alert" className="chat-error">{error}</p>}{feedback&&<p role="status">{feedback}</p>}
    {result&&<section aria-label="Native snapshot difference results">
      <p>Fingerprint strings: {result.sameFingerprintSet?'same set':'different sets'}. Canonical snapshot bytes: {result.exactSnapshotMatch?'identical':'different'}.</p>
      {result.sources.map(source=><Source key={source.id} source={source}/>)}
      <label className="chat-checkbox"><input type="checkbox" checked={approved===result} onChange={event=>setApproved(event.target.checked?result:null)}/> I approve exporting snapshot fingerprints, counts and changed coordinates.</label>
      <button type="button" className="chat-button" disabled={approved!==result} onClick={()=>{if(approved===result){download(serializeSnapshotDifference(result));setApproved(null);}}}>Export snapshot difference report</button>
    </section>}
  </details>;
}
