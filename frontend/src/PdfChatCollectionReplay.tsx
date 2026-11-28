import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {readPdf} from './pdfChatExtract';
import type {CollectionDocument} from './pdfChatCollection';
import {loadCollectionSnapshot,parseCollectionSnapshot,serializeCollectionSnapshot,replayCollectionSources,
  verifyCollectionSourceReplay,MAX_COLLECTION_REPLAY_BYTES,type CollectionReplayReport,
  type CollectionReplayProgress} from './pdfChatCollectionReplay';

function save(text:string,name:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=name;
  document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const states={exact_replay:'Exact native extraction replay',different_extraction:'Different extraction',
  missing_pdf:'Expected PDF not selected',extraction_failed:'Native extraction failed',unexpected_pdf:'Unexpected PDF selected'};
type ReplayResult={report:CollectionReplayReport;text:string};
export default function PdfChatCollectionReplay({documents}: {documents:readonly CollectionDocument[]}){
  const [approved,setApproved]=useState<readonly CollectionDocument[]|null>(null);
  const [snapshot,setSnapshot]=useState<File|null>(null);
  const [candidate,setCandidate]=useState<File|null>(null);
  const [files,setFiles]=useState<File[]>([]);
  const [progress,setProgress]=useState<CollectionReplayProgress|null>(null);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<ReplayResult|null>(null);
  const [feedback,setFeedback]=useState('');
  const [error,setError]=useState('');
  const [expected,setExpected]=useState<number|null>(null);
  const [reportConsent,setReportConsent]=useState(false);
  const generation=useRef(0),controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  function reset(){setResult(null);setReportConsent(false);setFeedback('');setError('');setExpected(null);}
  function pick(event:ChangeEvent<HTMLInputElement>,kind:'snapshot'|'candidate'|'pdfs'){
    const list=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';
    if(busy)return;
    reset();
    if(kind==='snapshot')setSnapshot(list[0]??null);
    else if(kind==='candidate')setCandidate(list[0]??null);
    else setFiles(list);
  }
  function exportSnapshot(){
    if(approved!==documents||!documents.length)return;
    setApproved(null);setError('');setFeedback('');
    try{save(serializeCollectionSnapshot(documents),'noticebridge-collection-snapshot.json');setFeedback('Private native collection snapshot exported.');}
    catch{setError('Unable to export the native snapshot within its processing budget.');}
  }
  async function run(){
    if(!snapshot||controller.current)return;
    const operation=new AbortController();controller.current=operation;
    const token=++generation.current;
    setBusy(true);reset();
    const active=()=>token===generation.current&&!operation.signal.aborted;
    try{
      const text=await loadCollectionSnapshot(snapshot,operation.signal);
      if(active())setExpected(parseCollectionSnapshot(text).sources.length);
      const options={signal:operation.signal,extract:readPdf,onProgress:(value:CollectionReplayProgress)=>{
        if(active())setProgress(value);
      }};
      let replay:ReplayResult;
      if(candidate){
        if(!candidate.size||candidate.size>MAX_COLLECTION_REPLAY_BYTES)throw new Error('report size');
        const bytes=await candidate.arrayBuffer();operation.signal.throwIfAborted();
        if(bytes.byteLength!==candidate.size)throw new Error('report size');
        const report=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
        replay=await verifyCollectionSourceReplay(report,text,files,options);
      }else replay=await replayCollectionSources(text,files,options);
      if(active()){setResult(replay);setFeedback(candidate?'Saved replay report exactly reproduced.':'Independent source replay completed.');}
    }catch{
      if(token===generation.current){
        if(operation.signal.aborted)setFeedback('Collection source replay cancelled.');
        else setError('Snapshot, selected sources or replay report could not be validated.');
      }
    }finally{
      if(token===generation.current){controller.current=null;setBusy(false);setProgress(null);}
    }
  }
  return <details className="chat-collection-inspection" aria-label="Independent collection source replay">
    <summary>Export native collection snapshot or independently replay sources</summary>
    <p className="chat-note">Snapshot files contain private extracted text and geometry, not PDF bytes or filenames.
      Replay checks exact byte fingerprints and native extraction; it cannot establish completeness, official authority or answer accuracy.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={approved===documents} disabled={!documents.length}
      onChange={event=>setApproved(event.target.checked?documents:null)}/> I approve exporting the private native collection text.</label>
    <button type="button" className="chat-button" disabled={approved!==documents||!documents.length}
      onClick={exportSnapshot}>Export native collection snapshot</button>
    <h4>Independent source replay</h4>
    <p>Choose a previously exported snapshot and independently select the actual PDF files. The order and filenames do not determine matching.</p>
    <label className="chat-session-file">Collection replay snapshot file
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event=>pick(event,'snapshot')}/>
    </label>
    {snapshot&&<p className="chat-muted">Snapshot selected: {snapshot.name}</p>}
    <label className="chat-session-file">Collection replay source PDFs
      <input type="file" accept=".pdf,application/pdf" multiple disabled={busy} onChange={event=>pick(event,'pdfs')}/>
    </label>
    <p className="chat-muted">{files.length} independently selected PDF(s).</p>
    {files.length>0&&<button type="button" className="chat-button" disabled={busy} onClick={()=>{setFiles([]);reset();}}>Clear replay PDFs</button>}
    <label className="chat-session-file">Optional saved collection replay report
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event=>pick(event,'candidate')}/>
    </label>
    {candidate&&<button type="button" className="chat-button" disabled={busy} onClick={()=>{setCandidate(null);reset();}}>Remove saved replay report</button>}
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={!snapshot||busy} onClick={()=>void run()}>Run independent collection source replay</button>
      {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel collection source replay</button>}
    </div>
    {expected!==null&&<p>{expected} source fingerprint(s) expected by the snapshot.</p>}
    {progress&&<p role="status">{progress.stage} · {progress.completed}/{progress.total} source operations</p>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {feedback&&<p role="status" className="chat-note">{feedback}</p>}
    {result&&<section aria-label="Collection source replay results">
      <h4>{result.report.status==='exact_replay'?'All native extractions exactly reproduced':'Collection not fully reproduced'}</h4>
      <p>PDF byte set: {result.report.all_pdf_bytes_match?'exact match':'not matched'}.
        Native extraction: {result.report.all_native_extractions_match?'exact match':'not matched'}.</p>
      {result.report.sources.map(source=><article key={source.id} className="chat-citation">
        <p><strong>{states[source.state]}</strong></p><code className="chat-filename">{source.id}</code>
        {source.coverage&&<p>Coverage metadata: {source.coverage.matches?'matching':'different'}.
          {' '}{source.coverage.expected_processed_pages} expected / {source.coverage.observed_processed_pages} observed processed pages.</p>}
        {source.fragments&&<p>{source.fragments.identical_fragments} identical fragments · {source.fragments.changed_text} changed text ·
          {' '}{source.fragments.changed_geometry} changed geometry · {source.fragments.expected_only} expected only ·
          {' '}{source.fragments.observed_only} observed only.</p>}
      </article>)}
      <label className="chat-checkbox"><input type="checkbox" checked={reportConsent}
        onChange={event=>setReportConsent(event.target.checked)}/> I approve exporting the collection replay fingerprints and counts.</label>
      <button type="button" className="chat-button" disabled={!reportConsent} onClick={()=>{
        if(!reportConsent)return;save(result.text,'noticebridge-collection-source-replay.json');setReportConsent(false);
      }}>Export collection source replay report</button>
    </section>}
  </details>;
}
