import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {Passage} from './pdfChatCore';
import type {CollectionDocument} from './pdfChatCollection';
import {collectionEvalPage,COLLECTION_EVAL_PAGE_SIZE,type CollectionEvalCase} from './pdfChatCollectionEvaluation';
import {captureCollectionRegressionRun,compareCollectionRegressionFile,readCollectionRegressionFile,
  type RegressionComparison,type RegressionChange,type RegressionCase,type RegressionMetricName} from './pdfChatCollectionRegression';

type Props={
  documents:readonly CollectionDocument[];
  cases:readonly CollectionEvalCase[];
  names:Map<string,string>;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void;
};
const labels:Record<RegressionMetricName,string>={
  microPrecision:'Micro precision',microRecall:'Micro recall',meanReciprocalRank:'Mean reciprocal rank',
  exactCoverageCases:'All expected evidence retrieved',correctAbstentions:'Correct labelled abstentions',
  unexpectedMatches:'Unexpected matches',incompleteCoverageCases:'Incomplete native coverage',
};
const changes:Record<RegressionChange,string>={
  improved:'Improved label agreement',regressed:'Regressed label agreement',mixed:'Mixed metric changes',
  unchanged:'Unchanged',different_retrieval:'Different retrieval, same label scores',
};
function display(name:RegressionMetricName,value:number|null,delta=false){
  if(value===null)return 'Not defined';
  const rate=name==='microPrecision'||name==='microRecall';
  const number=rate?(value*100).toFixed(1):name==='meanReciprocalRank'?value.toFixed(3):String(value);
  return (delta&&value>0?'+':'')+number+(rate?(delta?' pp':'%'):'');
}
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;
  link.download='noticebridge-collection-retrieval-run.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function CaseReview({row,names,onInspect}:Pick<Props,'names'|'onInspect'>&{row:RegressionCase}){
  return <article className="chat-citation">
    <h5>{names.get(row.target.documentId)??'Attached PDF'} · {row.target.question}</h5>
    <p>{changes[row.change]}. {row.orderChanged?'Shared evidence rank order changed.':''}</p>
    <p>Expected fragments retrieved: {row.baseline.correctCount} → {row.current.correctCount} of {row.current.expectedCount}.
      {' '}Total retrieved: {row.baseline.retrievedCount} → {row.current.retrievedCount}.</p>
    <p className="chat-muted">Baseline outcome: {row.baseline.outcome.replaceAll('_',' ')}.
      {' '}Current outcome: {row.current.outcome.replaceAll('_',' ')}.</p>
    {([
      ['Newly retrieved labelled fragments',row.gainedExpected],
      ['Previously retrieved labelled fragments now missed',row.lostExpected],
      ['All newly retrieved fragments',row.added],
      ['All previously retrieved fragments no longer returned',row.removed],
    ] as const).map(([title,sources])=><details key={title}>
      <summary>{title} ({sources.length})</summary>
      {sources.map(source=><div key={source.page+':'+source.ordinal} className="chat-citation">
        <p>{source.text}</p>
        <button type="button" className="chat-button" onClick={event=>onInspect(row.target.documentId,source,event.currentTarget)}>
          Inspect regression source {source.page}:{source.ordinal}</button>
      </div>)}
    </details>)}
  </article>;
}
export default function PdfChatCollectionRegression({documents,cases,names,onInspect}:Props){
  const [approval,setApproval]=useState<readonly CollectionEvalCase[]|null>(null);
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState('');
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  const [result,setResult]=useState<{cases:readonly CollectionEvalCase[];comparison:RegressionComparison}|null>(null);
  const [filter,setFilter]=useState<'all'|RegressionChange>('all');
  const [page,setPage]=useState(1);
  const controller=useRef<AbortController|null>(null);
  const generation=useRef(0);
  const latest=useRef(cases);latest.current=cases;
  useEffect(()=>()=>{
    generation.current++;
    controller.current?.abort();
  },[]);
  useEffect(()=>{
    controller.current?.abort();
    setResult(null);setApproval(null);setStatus('');setError('');setPage(1);
  },[cases]);
  const comparison=result?.cases===cases?result.comparison:null;
  const rows=comparison?.cases.filter(row=>filter==='all'||row.change===filter)??[];
  const current=Math.min(page,Math.max(1,Math.ceil(rows.length/COLLECTION_EVAL_PAGE_SIZE)));
  const shown=collectionEvalPage(rows,current);
  async function execute(file?:File){
    if(controller.current||!cases.length||(!file&&approval!==cases))return;
    const operation=new AbortController();
    controller.current=operation;
    const token=++generation.current;
    setBusy(true);setError('');setStatus('');setProgress('Checking labels and extraction identity');
    setApproval(null);setResult(null);
    const active=()=>token===generation.current&&!operation.signal.aborted&&latest.current===cases;
    const onProgress=(done:number,total:number)=>{
      if(active())setProgress('Evaluating '+done+' of '+total+' labelled cases');
    };
    try{
      if(file){
        const text=await readCollectionRegressionFile(file,operation.signal);
        const comparison=await compareCollectionRegressionFile(text,documents,cases,operation.signal,onProgress);
        if(active()){
          setResult({cases,comparison});setFilter('all');setPage(1);
          setStatus('Historical coordinates checked against matching labels and extraction; current run recomputed.');
        }
      }else{
        const captured=await captureCollectionRegressionRun(documents,cases,operation.signal,onProgress);
        if(active()){download(captured.text);setStatus('Private retrieval run exported.');}
      }
    }catch{
      if(active())setError('Regression run rejected or failed. Check the exact attached PDFs, native extraction and human labels.');
    }finally{
      if(token===generation.current){controller.current=null;setBusy(false);setProgress('');}
    }
  }
  function pick(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];
    event.currentTarget.value='';
    if(file)void execute(file);
  }
  return <details className="chat-collection-inspection" aria-label="Collection retrieval regression comparison">
    <summary>Compare retrieval across software runs</summary>
    <p className="chat-note">Export a coordinate-only run on the present extraction and human labels. After a retrieval
      update, attach the same PDFs, restore the same labels, and import the previous run to compare freshly computed results.
      The historical run is not signed and its actual execution is not authenticated.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={approval===cases} disabled={busy||!cases.length}
      onChange={event=>setApproval(event.target.checked?cases:null)}/> I approve exporting private retrieval run identities and coordinates.</label>
    <button type="button" className="chat-button" disabled={busy||approval!==cases||!cases.length}
      onClick={()=>void execute()}>Export collection regression baseline</button>
    <label className="chat-session-file">Compare historical collection retrieval run
      <input type="file" accept=".json,application/json" disabled={busy||!cases.length} onChange={pick}/>
    </label>
    {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel regression measurement</button>}
    {progress&&<p role="status">{progress}</p>}
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {comparison&&<section aria-label="Collection regression results">
      <p>Inputs match the full native extraction and exact labelled case set. Changes describe retrieval agreement only,
        not factual correctness or completeness.</p>
      <div className="chat-collection-budget">
        {(Object.keys(changes) as RegressionChange[]).map(change=><div key={change}>
          <strong>{comparison.counts[change]}</strong><span>{changes[change]}</span>
        </div>)}
      </div>
      <div className="chat-table-scroll">
        <table><caption>Reconstructed baseline and current metrics</caption>
          <thead><tr><th>Metric</th><th>Recorded baseline</th><th>Current</th><th>Delta</th></tr></thead>
          <tbody>{comparison.metrics.map(row=><tr key={row.name}>
            <th scope="row">{labels[row.name]}</th><td>{display(row.name,row.baseline)}</td>
            <td>{display(row.name,row.current)}</td><td>{display(row.name,row.delta,true)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <label>Collection regression case filter<select value={filter} onChange={event=>{
        setFilter(event.target.value as typeof filter);setPage(1);
      }}>
        <option value="all">All comparisons</option>
        {(Object.keys(changes) as RegressionChange[]).map(change=><option value={change} key={change}>{changes[change]}</option>)}
      </select></label>
      <p>{rows.length} matching case(s).</p>
      {shown.rows.map(row=><CaseReview key={row.key} row={row} names={names} onInspect={onInspect}/>)}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" disabled={current===1} className="chat-button" onClick={()=>setPage(current-1)}>Previous regression cases</button>
        <span>Page {current} of {shown.pages}</span>
        <button type="button" disabled={current===shown.pages} className="chat-button" onClick={()=>setPage(current+1)}>Next regression cases</button>
      </div>}
    </section>}
  </details>;
}
