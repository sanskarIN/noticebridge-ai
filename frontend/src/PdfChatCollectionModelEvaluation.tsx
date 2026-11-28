import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import type {CollectionModelPlan,CollectionModelReview} from './pdfChatCollectionModels';
import {readCollectionEvalFile,type CollectionEvalMetrics,type CollectionEvalObservation} from './pdfChatCollectionEvaluation';
import {evaluateCollectionModels,serializeModelEvaluation,type CollectionModelEvaluation} from './pdfChatCollectionModelEvaluation';
import type {Passage} from './pdfChatCore';
type Props={documents:readonly CollectionDocument[];turn:CollectionTurn;plan:CollectionModelPlan;reviews:readonly CollectionModelReview[];
  names:Map<string,string>;onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
function metric(value:number|null){return value===null?'Not defined':(value*100).toFixed(1)+'%';}
function Summary({label,metrics}:{label:string;metrics:CollectionEvalMetrics}){
  return <article className="chat-overview-side"><h5>{label}</h5>
    <p>Micro precision: {metric(metrics.microPrecision)}</p><p>Micro recall: {metric(metrics.microRecall)}</p>
    <p>Mean reciprocal rank: {metric(metrics.meanReciprocalRank)}</p>
    <p>{metrics.correctFragments}/{metrics.expectedFragments} labelled fragment(s) retrieved · {metrics.retrievedFragments} total returned.</p>
    <p>{metrics.correctAbstentions} empty results in {metrics.abstentionCases} no-expected-match cases.</p>
  </article>;
}
function Detail({row,documentId,onInspect,label}:{row:CollectionEvalObservation;documentId:string;onInspect:Props['onInspect'];label:string}){
  return <details><summary>{label}: {row.correctCount}/{row.expectedCount} labelled fragments, {row.retrievedCount} retrieved</summary>
    <p>Recall {metric(row.recall)} · precision {metric(row.precision)}.</p>
    {([['Labelled fragment retrieved',row.expectedFound],['Labelled fragment missed',row.expectedMissed],['Returned but not labelled',row.unexpectedRetrieved]] as const).map(([title,rows])=><div key={title}>
      <h5>{title} ({rows.length})</h5>
      {rows.map(source=><div className="chat-citation" key={source.page+':'+source.ordinal}>
        <p>{source.text}</p><button type="button" className="chat-button" onClick={event=>onInspect(documentId,source,event.currentTarget)}>Inspect evaluation fragment {source.page}:{source.ordinal}</button>
      </div>)}
    </div>)}
  </details>;
}
function save(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-collection-model-evaluation.json';
  document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatCollectionModelEvaluation({documents,turn,plan,reviews,names,onInspect}:Props){
  const [result,setResult]=useState<CollectionModelEvaluation|null>(null);
  const [consent,setConsent]=useState<CollectionModelEvaluation|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  useEffect(()=>{controller.current?.abort();setResult(null);setConsent(null);setError('');},[documents,turn,plan,reviews]);
  async function evaluate(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file||controller.current)return;
    const task=new AbortController();controller.current=task;const token=++generation.current;
    const active=()=>generation.current===token&&!task.signal.aborted;
    setBusy(true);setResult(null);setConsent(null);setError('');
    try{
      const labels=await readCollectionEvalFile(file,task.signal);
      const value=await evaluateCollectionModels(documents,turn,plan,reviews,labels,task.signal);
      if(active())setResult(value);
    }catch{if(active())setError('Labels could not be matched to reviewed model requests. Use exact PDF fingerprints, question wording and context flags.');}
    finally{if(generation.current===token){controller.current=null;setBusy(false);}}
  }
  return <details className="chat-collection-inspection" aria-label="Evaluate reviewed collection model proposals">
    <summary>Evaluate local model proposals against supplied human labels</summary>
    <p className="chat-note">Create independent retrieval labels in the collection evaluation lab before examining model results.
      Only exactly matched question/PDF/context cases are scored. Returned but unlabelled fragments are not necessarily irrelevant.</p>
    <label className="chat-session-file">Import collection model evaluation labels<input type="file" accept=".json,application/json" disabled={busy}
      onChange={event=>void evaluate(event)}/></label>
    {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel model evaluation</button>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {result&&<section aria-label="Collection model evaluation metrics">
      <p>{result.cases.length} paired labelled case(s). {result.skipped.length} skipped requests or scopes. {result.otherLabelCases} labels outside the scored request set.</p>
      <p>Expected fragments present in request shortlist: {result.allowedExpectedFragments}/{result.expectedFragments} ({metric(result.shortlistRecall)}).</p>
      <div className="chat-collection-matrix">
        <Summary label={'Native displayed fragments (top '+result.topK+')'} metrics={result.baseline}/>
        <Summary label={'Fused model candidate ranking (top '+result.topK+')'} metrics={result.fused}/>
        <Summary label="Unique extractive proposal fragments" metrics={result.proposal}/>
      </div>
      <p className="chat-note">Fused ranking is a candidate channel, not an answer or an abstaining model. Proposal fragment agreement
        does not evaluate whether the selected substring actually answers the question. Model execution and accuracy remain unverified.</p>
      {result.skipped.map(row=><p key={row.documentId}>{names.get(row.documentId)}: {row.reason.replaceAll('_',' ')}.</p>)}
      {result.cases.map(row=><article key={row.target.documentId} className="chat-answer">
        <h5>{names.get(row.target.documentId)}</h5>
        <p>{row.embeddingModel} / {row.answerModel} · {row.allowedExpected.length} of {row.target.expected.length} labelled fragments in the request.</p>
        {row.notAllowedExpected.map(source=><div key={source.page+':'+source.ordinal} className="chat-citation">
          <p>Outside request: {source.text}</p><button type="button" className="chat-button"
            onClick={event=>onInspect(row.target.documentId,source,event.currentTarget)}>Inspect omitted shortlist fragment</button>
        </div>)}
        <Detail row={row.baseline} documentId={row.target.documentId} onInspect={onInspect} label="Native baseline"/>
        <Detail row={row.fused} documentId={row.target.documentId} onInspect={onInspect} label="Fused candidates"/>
        <Detail row={row.proposal} documentId={row.target.documentId} onInspect={onInspect} label="Extractive proposal"/>
      </article>)}
      <label className="chat-checkbox"><input type="checkbox" checked={consent===result} onChange={event=>setConsent(event.target.checked?result:null)}/>
        I approve exporting private question text, model metadata, fingerprints and evaluation coordinates.</label>
      <button type="button" className="chat-button" disabled={consent!==result} onClick={()=>{
        try{save(serializeModelEvaluation(result,true));setConsent(null);}catch{setError('Unable to export the bounded evaluation report.');}
      }}>Export collection model evaluation</button>
    </section>}
  </details>;
}
