import PdfChatVariantPlan from './PdfChatVariantPlan';
import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import {MAX_QUESTION,type Passage} from './pdfChatCore';
import {collectionEvalCaseKey,parseCollectionEvalLabels,readCollectionEvalFile,type CollectionEvalCase,type CollectionEvalMetrics} from './pdfChatCollectionEvaluation';
import {evaluateVariants,validateVariantDraft,variantPage,inspectVariantSource,serializeVariantEvaluation,verifyVariantEvaluation,
  MAX_VARIANT_CASES,MAX_VARIANT_REPORT_BYTES,type VariantDraft,type VariantCase,type VariantEvaluation} from './pdfChatQuestionVariants';
type Props={documents:readonly CollectionDocument[];names:Map<string,string>;onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
type Labels={text:string;cases:CollectionEvalCase[]};
function ratio(value:number|null){return value===null?'Not defined':(100*value).toFixed(1)+'%';}
function Metrics({name,value}:{name:string;value:CollectionEvalMetrics}){
  return <article className="chat-overview-side"><h5>{name}</h5>
    <p>Precision {ratio(value.microPrecision)} · Recall {ratio(value.microRecall)}</p>
    <p>Mean reciprocal rank {ratio(value.meanReciprocalRank)}</p>
    <p>{value.correctFragments}/{value.expectedFragments} labelled fragments found; {value.retrievedFragments} returned.</p>
    <p>{value.correctAbstentions}/{value.abstentionCases} labelled no-match cases abstained.</p>
  </article>;
}
function Detail({documents,names,onInspect,row,result}:Props&{row:VariantCase;result:VariantEvaluation}){
  return <article className="chat-answer">
    <h5>{names.get(row.target.documentId)} — {row.outcome}</h5>
    <p>Baseline: {row.target.question} ({row.target.includeContext?'nearby enabled':'strict only'})</p>
    <p>Alternative: {row.draft.question} ({row.draft.includeContext?'nearby enabled':'strict only'})</p>
    <p>{row.baseline.correctCount} → {row.alternative.correctCount} labelled fragments found; {row.baseline.unexpectedRetrieved.length} → {row.alternative.unexpectedRetrieved.length} unlabelled returns.</p>
    <p>Coverage remains {row.baseline.part.coverage.replaceAll('_',' ')}.</p>
    {([['Newly retrieved fragments',row.added],['Removed retrieval fragments',row.removed],['Shared retrieval fragments',row.shared],
      ['Newly retrieved labelled evidence',row.expectedAdded],['Lost labelled evidence',row.expectedRemoved]] as const).map(([label,sources])=>
      <details key={label}><summary>{label} ({sources.length})</summary>
        {sources.map(source=><div className="chat-citation" key={source.page+':'+source.ordinal}>
          <p>{source.text}</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(row.target.documentId,
            inspectVariantSource(documents,result,row,source),event.currentTarget)}>Inspect variant evidence {source.page}:{source.ordinal}</button>
        </div>)}
      </details>)}
  </article>;
}
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-question-variants.json';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatQuestionVariants({documents,names,onInspect}:Props){
  const [labels,setLabels]=useState<Labels|null>(null),[drafts,setDrafts]=useState<VariantDraft[]>([]);
  const [result,setResult]=useState<VariantEvaluation|null>(null),[approved,setApproved]=useState<VariantEvaluation|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState(''),[feedback,setFeedback]=useState('');
  const [choice,setChoice]=useState(''),[page,setPage]=useState(1);
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  function change(next:VariantDraft[]){setDrafts(next);setResult(null);setApproved(null);setError('');setFeedback('');setPage(1);}
  const chosen=labels?.cases.find(row=>collectionEvalCaseKey(row)===choice);
  const available=labels?.cases.filter(row=>!drafts.some(draft=>draft.caseKey===collectionEvalCaseKey(row)))??[];
  const targets=new Map(labels?.cases.map(row=>[collectionEvalCaseKey(row),row])??[]);
  const valid=(draft:VariantDraft)=>{
    try{const target=targets.get(draft.caseKey);if(!target)return false;validateVariantDraft(documents,target,draft);return true;}catch{return false;}
  };
  function edit(key:string,patch:Partial<Omit<VariantDraft,'caseKey'>>){
    change(drafts.map(draft=>draft.caseKey===key?{...draft,...patch}:draft));
  }
  async function run(mode:'labels'|'evaluate'|'verify',file?:File){
    if(active.current||mode!=='labels'&&!labels)return;
    const task=new AbortController();active.current=task;setBusy(true);setError('');setFeedback('');setProgress('');setResult(null);setApproved(null);
    try{
      if(mode==='labels'&&file){
        setLabels(null);setDrafts([]);setChoice('');
        const text=await readCollectionEvalFile(file,task.signal),cases=await parseCollectionEvalLabels(text,documents,task.signal);
        task.signal.throwIfAborted();setLabels({text,cases});setChoice(collectionEvalCaseKey(cases[0]));setFeedback('Exact source-bound human labels loaded.');
      }else if(mode==='evaluate'&&labels){
        const value=await evaluateVariants(documents,labels.text,drafts,task.signal,(done,total)=>setProgress(done+'/'+total+' pairs evaluated'));
        task.signal.throwIfAborted();setResult(value);setPage(1);setFeedback('Paired question experiment completed.');
      }else if(mode==='verify'&&labels&&file){
        if(!file.size||file.size>MAX_VARIANT_REPORT_BYTES)throw Error('size');
        const bytes=await file.arrayBuffer();task.signal.throwIfAborted();
        if(bytes.byteLength!==file.size)throw Error('size');
        const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
        const value=await verifyVariantEvaluation(text,documents,labels.text,task.signal);
        task.signal.throwIfAborted();setDrafts(value.cases.map(row=>row.draft));setResult(value);setPage(1);
        setFeedback('Saved paired experiment exactly reproduced.');
      }
    }catch{if(!task.signal.aborted)setError('Question experiment rejected. Check exact label sources, equivalent wording, physical page and result report.');}
    finally{if(active.current===task){active.current=null;setBusy(false);setProgress('');}}
  }
  function choose(event:ChangeEvent<HTMLInputElement>,mode:'labels'|'verify'){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void run(mode,file);
  }
  const shown=variantPage(result?.cases??[],result?page:1);
  return <details className="chat-collection-inspection" aria-label="Paired collection question experiments">
    <summary>Evaluate alternate question wording and nearby-line retrieval</summary>
    <p className="chat-note">Import independently authored labels, then explicitly confirm that each alternative asks the same question.
      No automatic paraphrase is created. Comparing against the same labels is meaningful only if the information need is unchanged.
      Physical page and PDF scope cannot change.</p>
    <label className="chat-session-file">Import human labels for paired experiments<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>choose(event,'labels')}/></label>
    {labels&&<>
      <p>{labels.cases.length} independent labels loaded. Select at most {MAX_VARIANT_CASES} paired cases.</p>
      <label>Labelled baseline question<select value={available.some(row=>collectionEvalCaseKey(row)===choice)?choice:''} disabled={busy}
        onChange={event=>setChoice(event.target.value)}>
        <option value="">Choose a case</option>{available.map(row=><option key={collectionEvalCaseKey(row)} value={collectionEvalCaseKey(row)}>
          {names.get(row.documentId)} · {row.question} · {row.includeContext?'nearby':'strict'}
        </option>)}
      </select></label>
      <button type="button" className="chat-button" disabled={busy||!chosen||drafts.length>=MAX_VARIANT_CASES||!available.includes(chosen)} onClick={()=>{
        if(chosen){change([...drafts,{caseKey:choice,question:chosen.question,includeContext:!chosen.includeContext,equivalenceConfirmed:false}]);setChoice('');}
      }}>Add paired question case</button>
      {drafts.map((draft,i)=>{
        const target=targets.get(draft.caseKey)!;
        return <fieldset key={draft.caseKey} className="chat-citation" disabled={busy}>
          <legend>Experiment {i+1}</legend>
          <p>{names.get(target.documentId)}: {target.question} · {target.includeContext?'nearby enabled':'strict only'}.</p>
          <p>{target.expected.length} independently labelled fragment(s).</p>
          <label>Alternative wording {i+1}<textarea maxLength={MAX_QUESTION} value={draft.question} rows={2}
            onChange={event=>edit(draft.caseKey,{question:event.target.value,equivalenceConfirmed:false})}/></label>
          <label className="chat-checkbox"><input type="checkbox" checked={draft.includeContext}
            onChange={event=>edit(draft.caseKey,{includeContext:event.target.checked,equivalenceConfirmed:false})}/> Enable nearby lines in alternative {i+1}</label>
          <label className="chat-checkbox"><input type="checkbox" checked={draft.equivalenceConfirmed}
            onChange={event=>edit(draft.caseKey,{equivalenceConfirmed:event.target.checked})}/> I confirm this alternative retains the labelled information need and physical scope.</label>
          {!valid(draft)&&<p className="chat-muted">Confirm equivalence, make a real wording or context change, and retain one valid question on the same physical page.</p>}
          <button type="button" className="chat-button" onClick={()=>change(drafts.filter(row=>row!==draft))}>Remove paired case {i+1}</button>
        </fieldset>;
      })}
      <button type="button" className="chat-button" disabled={busy||!drafts.length||!drafts.every(valid)} onClick={()=>void run('evaluate')}>Run paired question experiments</button>
      <PdfChatVariantPlan documents={documents} labelsText={labels.text} drafts={drafts} valid={drafts.length>0&&drafts.every(valid)}
        disabled={busy} onImport={change}/>
      <label className="chat-session-file">Verify saved paired experiment<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>choose(event,'verify')}/></label>
    </>}
    {busy&&<button type="button" className="chat-button" onClick={()=>active.current?.abort()}>Cancel paired experiment</button>}
    {progress&&<p role="status">{progress}</p>}{feedback&&<p role="status">{feedback}</p>}{error&&<p role="alert" className="chat-error">{error}</p>}
    {result&&<section aria-label="Paired question experiment results">
      <div className="chat-collection-matrix"><Metrics name="Baseline wording and context" value={result.baseline}/>
        <Metrics name="Alternative wording and context" value={result.alternative}/></div>
      <p>{result.outcomes.improved} improved · {result.outcomes.regressed} regressed · {result.outcomes.tradeoff} tradeoff · {result.outcomes.unchanged} unchanged under supplied labels.</p>
      <p>{result.changedOrder} pairs changed displayed rank order without adding or removing fragments.</p>
      <p className="chat-note">A gained label and a gained unlabelled return can be a tradeoff. Unlabelled is not necessarily irrelevant; this is not answer accuracy.</p>
      {shown.rows.map(row=><Detail key={row.draft.caseKey} documents={documents} names={names} onInspect={onInspect} result={result} row={row}/>)}
      {shown.pages>1&&<div className="chat-toolbar"><button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous paired cases</button>
        <span>Page {page} of {shown.pages}</span><button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next paired cases</button></div>}
      <label className="chat-checkbox"><input type="checkbox" checked={approved===result} onChange={event=>setApproved(event.target.checked?result:null)}/>
        I approve exporting private question wording, labels fingerprint and citation coordinates.</label>
      <button type="button" className="chat-button" disabled={approved!==result} onClick={()=>{
        try{download(serializeVariantEvaluation(result,true));setApproved(null);}catch{setError('Unable to export the paired experiment.');}
      }}>Export paired question experiment</button>
    </section>}
  </details>;
}
