import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionModelPlan} from './pdfChatCollectionModels';
import {readCollectionModelPreflightFile,verifyCollectionModelPreflight,
  type CollectionModelPreflight} from './pdfChatCollectionModelPreflight';

type Props={plan:CollectionModelPlan;names:Map<string,string>};
export default function PdfChatCollectionModelPreflight({plan,names}:Props){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [report,setReport]=useState<CollectionModelPreflight|null>(null);
  const controller=useRef<AbortController|null>(null);
  const generation=useRef(0);
  useEffect(()=>()=>{
    generation.current++;
    controller.current?.abort();
  },[]);
  async function importFile(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];
    event.currentTarget.value='';
    if(!file||controller.current)return;
    const operation=new AbortController();
    controller.current=operation;
    const token=++generation.current;
    const active=()=>token===generation.current&&!operation.signal.aborted;
    setBusy(true);setReport(null);setError('');
    try{
      const text=await readCollectionModelPreflightFile(file,operation.signal);
      const verified=await verifyCollectionModelPreflight(text,plan,operation.signal);
      if(active())setReport(verified);
    }catch{
      if(active())setError('Preflight report rejected. Use the current collection model plan and matching candidate files.');
    }finally{
      if(token===generation.current){
        controller.current=null;
        setBusy(false);
      }
    }
  }
  return <details className="chat-collection-inspection" aria-label="Collection model offline preflight">
    <summary>Check offline model input inventory before processing</summary>
    <p className="chat-note">Preflight checks all manifest entries and candidate files without invoking a model.
      Its report contains counts and identities, not excerpts. Replaying it here checks the exact browser plan,
      but does not authenticate a historical execution or certify the PDFs.</p>
    <p>Run this command from the directory containing the exported manifest and every independent request file:</p>
    <pre>python -m noticebridge.chat_collection_models_cli noticebridge-collection-model-manifest.json --request-directory . --output collection-preflight.json --preflight-only</pre>
    <label className="chat-session-file">Import collection model preflight inventory
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event=>void importFile(event)}/>
    </label>
    {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel preflight verification</button>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {report&&<section aria-label="Collection model preflight counts">
      <p role="status">Candidate inventory exactly matches the current model plan.</p>
      <p>{report.request_count} request(s), {report.total_candidate_fragments} candidate fragment(s),
        {' '}{report.total_baseline_fragments} baseline fragment(s), {report.total_request_bytes} UTF-8 bytes.</p>
      <p className="chat-muted">Mode: {report.mode}. Question part: {report.part+1}. No model proposal has been reviewed here.</p>
      {report.requests.map(row=><article key={row.document_id} className="chat-citation">
        <h5>{names.get(row.document_id)??'Attached PDF'}</h5>
        <p>{row.candidate_fragments} candidates · {row.baseline_fragments} baseline fragments · {row.request_bytes} bytes</p>
        <details><summary>Physical candidate pages ({row.physical_pages.length})</summary>
          <div className="chat-table-scroll"><table>
            <caption>Selected native candidate fragments, not full extraction coverage</caption>
            <thead><tr><th>Page</th><th>Candidate fragments</th></tr></thead>
            <tbody>{row.physical_pages.map(page=><tr key={page.page}>
              <th scope="row">{page.page}</th><td>{page.candidate_fragments}</td>
            </tr>)}</tbody>
          </table></div>
        </details>
      </article>)}
      {report.skipped_document_ids.length>0&&<p>Skipped PDFs without native candidates:
        {' '}{report.skipped_document_ids.map(id=>names.get(id)??'Attached PDF').join(', ')}.</p>}
    </section>}
  </details>;
}
