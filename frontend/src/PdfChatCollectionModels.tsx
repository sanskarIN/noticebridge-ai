import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {Passage} from './pdfChatCore';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import {emptyLocalPipelineConfig,validLocalPipelineConfig} from './pdfChatLocalPipeline';
import {isLocalChatOrigin} from './pdfChatLocalTransport';
import {prepareCollectionModelPlan,reviewCollectionModelResult,bundleCollectionModelResults,runCollectionLocalModels,
  loadCollectionModelResultFile,type CollectionModelPlan,type CollectionModelReview} from './pdfChatCollectionModels';

function save(text:string,name:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);
  link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
type Inspect=(id:string,source:Passage,target:HTMLElement)=>void;
function ModelReview({value,name,onInspect}:{value:CollectionModelReview;name:string;onInspect:Inspect}){
  const review=value.review;
  return <article className="chat-answer" aria-label={'Collection model review: '+name}>
    <h4>{name}</h4>
    <p>{review.extractive.proposal.status==='insufficient'?'Local model abstained':'Proposed literal source quotations'}</p>
    <p className="chat-muted">{review.selectionCount} fragments supplied to the answer model. Reported models:
      {' '}{review.ranking.model} · {review.extractive.model}.</p>
    {review.extractive.omittedBaseline.length>0&&<p className="chat-note">{review.extractive.omittedBaseline.length}
      {' '}baseline fragments were not quoted by the model. The baseline answer remains unchanged.</p>}
    {review.extractive.proposal.spans.map(span=><div className="chat-citation" key={span.id+':'+span.start}>
      <p>Physical page {span.source.page} · fragment {span.source.ordinal}</p>
      <p>{span.source.text.slice(0,span.start)}<mark>{span.text}</mark>{span.source.text.slice(span.end)}</p>
      <button type="button" className="chat-button" onClick={event=>onInspect(value.documentId,span.source,event.currentTarget)}>Inspect collection model quote</button>
    </div>)}
    <details><summary>Inspect ranked collection model candidates</summary>
      {review.ranking.candidates.map(row=><div className="chat-citation" key={row.passage.page+':'+row.passage.ordinal}>
        <p>{row.passage.text}</p><p className="chat-muted">{row.ranks.map(rank=>rank.channel+': '+rank.rank).join(' · ')}</p>
        <button type="button" className="chat-button" onClick={event=>onInspect(value.documentId,row.passage,event.currentTarget)}>Inspect collection model candidate</button>
      </div>)}
    </details>
  </article>;
}
export default function PdfChatCollectionModels({documents,turn,names,onInspect}:{
  documents:readonly CollectionDocument[];turn:CollectionTurn;names:Map<string,string>;onInspect:Inspect;
}){
  const [part,setPart]=useState(0);
  const [selection,setSelection]=useState(()=>[...turn.step.documentIds]);
  const [mode,setMode]=useState<'full'|'shortlist'>('shortlist');
  const [plan,setPlan]=useState<CollectionModelPlan|null>(null);
  const [review,setReview]=useState<CollectionModelReview[]>([]);
  const [inputs,setInputs]=useState<Record<string,string>>({});
  const [exportConsent,setExportConsent]=useState(false);
  const [localConsent,setLocalConsent]=useState(false);
  const [bundleConsent,setBundleConsent]=useState(false);
  const [config,setConfig]=useState(emptyLocalPipelineConfig);
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState('');
  const [error,setError]=useState('');
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  const local=isLocalChatOrigin(globalThis.location?.origin??'');
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  function reset(){setPlan(null);setReview([]);setInputs({});setExportConsent(false);setLocalConsent(false);setBundleConsent(false);setError('');}
  function start(){
    if(controller.current)return null;
    const operation=new AbortController();controller.current=operation;setBusy(true);setError('');
    const token=++generation.current;
    return {operation,token};
  }
  function active(token:number,operation:AbortController){return token===generation.current&&!operation.signal.aborted;}
  function finish(token:number){if(token===generation.current){controller.current=null;setBusy(false);setProgress('');}}
  async function prepare(){
    const task=start();if(!task)return;
    reset();
    const {operation,token}=task;
    try{
      const value=await prepareCollectionModelPlan(documents,turn,part,selection,mode,operation.signal);
      if(active(token,operation))setPlan(value);
    }catch{if(active(token,operation))setError('Unable to prepare a bounded model plan. Narrow the question or physical scope.');}
    finally{finish(token);}
  }
  async function importResult(event:ChangeEvent<HTMLInputElement>,documentId:string){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(!file||!plan)return;
    const entry=plan.requests.find(row=>row.documentId===documentId);if(!entry)return;
    const task=start();if(!task)return;
    const {operation,token}=task;
    setReview(old=>old.filter(row=>row.documentId!==documentId));
    setInputs(old=>Object.fromEntries(Object.entries(old).filter(([id])=>id!==documentId)));
    setBundleConsent(false);
    try{
      const text=await loadCollectionModelResultFile(file);
      const value=await reviewCollectionModelResult(documents,entry,text);
      if(active(token,operation)){
        setInputs(old=>({...old,[documentId]:text}));
        setReview(old=>[...old,value]);
      }
    }catch{if(active(token,operation))setError('Model result rejected. Select the exact result for this PDF and request.');}
    finally{finish(token);}
  }
  async function direct(){
    if(!plan||!local||!localConsent||!validLocalPipelineConfig(config))return;
    const task=start();if(!task)return;
    const {operation,token}=task;
    setReview([]);setInputs({});setLocalConsent(false);setBundleConsent(false);
    try{
      const result=await runCollectionLocalModels(documents,plan,config,operation.signal,true,(done,total)=>{
        if(active(token,operation))setProgress(done+'/'+total+' independent local model requests completed.');
      });
      if(active(token,operation))setReview(result);
    }catch{if(active(token,operation))setError('Local model batch failed or was rejected. No partial proposals were applied.');}
    finally{finish(token);}
  }
  async function bundle(){
    if(!plan||!bundleConsent)return;
    const task=start();if(!task)return;
    const {operation,token}=task;setBundleConsent(false);
    try{
      const text=await bundleCollectionModelResults(documents,plan,Object.entries(inputs).map(([documentId,text])=>({documentId,text})));
      if(active(token,operation))save(text,'noticebridge-collection-model-results.json');
    }catch{if(active(token,operation))setError('Unable to export the reviewed result bundle.');}
    finally{finish(token);}
  }
  return <details className="chat-collection-inspection" aria-label="Collection local model experiments">
    <summary>Optional independent collection AI proposals</summary>
    <p className="chat-note">Optional local semantic ranking and extractive proposals are not verified answers.
      Model processing is separate for each PDF and never replaces the baseline or infers notice relationships.</p>
    <label>Collection model question part
      <select value={part} disabled={busy} onChange={event=>{reset();setPart(Number(event.target.value));}}>
        {turn.results[0].parts.map((row,i)=><option key={i} value={i}>{row.answer.question}</option>)}
      </select>
    </label>
    <fieldset><legend>Collection model experiment PDFs</legend>
      {turn.step.documentIds.map(id=><label key={id} className="chat-checkbox">
        <input type="checkbox" disabled={busy} checked={selection.includes(id)} onChange={event=>{
          reset();setSelection(old=>event.target.checked?[...old,id]:old.filter(value=>value!==id));
        }}/> {names.get(id)}
      </label>)}
    </fieldset>
    <label>Collection model candidate mode
      <select value={mode} disabled={busy} onChange={event=>{reset();setMode(event.target.value as typeof mode);}}>
        <option value="shortlist">Bounded hybrid shortlist</option><option value="full">All scoped fragments (maximum 512 per PDF)</option>
      </select>
    </label>
    <button type="button" className="chat-button" disabled={busy||!selection.length} onClick={()=>void prepare()}>Prepare independent collection model plan</button>
    {plan&&<>
      <p>{plan.requests.length} independent request(s) · {plan.bytes} UTF-8 request bytes.</p>
      {plan.skipped.map(row=><p key={row.documentId}>{names.get(row.documentId)}: no indexed native candidates in this scope; skipped.</p>)}
      <p className="chat-muted">Preparation alone sends no data. The files contain private question and source text. Keep them local.</p>
      <label className="chat-checkbox"><input type="checkbox" checked={exportConsent} disabled={busy}
        onChange={event=>setExportConsent(event.target.checked)}/> I approve exporting this collection model plan and private request text.</label>
      <button type="button" className="chat-button" disabled={!exportConsent||busy} onClick={()=>save(plan.manifest,'noticebridge-collection-model-manifest.json')}>Export collection model manifest</button>
      {plan.requests.map(entry=><section key={entry.documentId} className="chat-citation" aria-label={'Collection model request: '+names.get(entry.documentId)}>
        <h5>{names.get(entry.documentId)}</h5>
        <p>{entry.request.embedding.allowed.size} native candidates · {entry.bytes} UTF-8 bytes.</p>
        <code>{entry.digest}</code>
        <button type="button" className="chat-button" disabled={!exportConsent||busy} onClick={()=>save(entry.request.text,
          'noticebridge-collection-model-'+entry.documentId+'.json')}>Export this collection model request</button>
        <label className="chat-session-file">Import this collection model result
          <input type="file" accept=".json,application/json" disabled={busy} onChange={event=>void importResult(event,entry.documentId)}/>
        </label>
      </section>)}
      {Object.keys(inputs).length===plan.requests.length&&<>
        <label className="chat-checkbox"><input type="checkbox" checked={bundleConsent} disabled={busy}
          onChange={event=>setBundleConsent(event.target.checked)}/> I approve exporting the reviewed collection model result bundle.</label>
        <button type="button" className="chat-button" disabled={!bundleConsent||busy} onClick={()=>void bundle()}>Export reviewed collection model bundle</button>
      </>}
      {local&&<section aria-label="Collection direct local AI">
        <h4>Opt-in loopback backend</h4>
        <p>Requires the trusted local backend and installed runtime. Model requests include private source text.
          The browser cannot attest to runtime privacy or model correctness.</p>
        {([['embeddingModel','Collection embedding model tag',96],['embeddingDigest','Collection embedding model digest',64],
          ['answerModel','Collection answer model tag',96],['answerDigest','Collection answer model digest',64]] as const).map(([key,label,max])=>
          <label key={key}>{label}<input value={config[key]} maxLength={max} autoComplete="off" spellCheck={false} disabled={busy}
            onChange={event=>{setConfig(old=>({...old,[key]:event.target.value}));setLocalConsent(false);setReview([]);setInputs({});setBundleConsent(false);}}/></label>)}
        <label className="chat-checkbox"><input type="checkbox" checked={localConsent} disabled={busy}
          onChange={event=>setLocalConsent(event.target.checked)}/> I approve sending these scoped private collection requests to the loopback backend.</label>
        <button type="button" className="chat-button" disabled={busy||!localConsent||!validLocalPipelineConfig(config)}
          onClick={()=>void direct()}>Run independent collection local models</button>
      </section>}
    </>}
    {busy&&<div className="chat-toolbar"><p role="status">{progress||'Preparing or checking collection model requests…'}</p>
      <button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel collection model operation</button></div>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {review.length>0&&<section aria-label="Collection model proposals">
      <p className="chat-note">Literal source offsets were checked against local fragments, not relevance or completeness.
        These proposals are not part of native answer replay.</p>
      {review.map(value=><ModelReview key={value.documentId} value={value} name={names.get(value.documentId)??value.documentId} onInspect={onInspect}/>)}
    </section>}
  </details>;
}
