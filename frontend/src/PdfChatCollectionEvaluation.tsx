import {useEffect,useMemo,useRef,useState,type ChangeEvent} from 'react';
import type {Passage} from './pdfChatCore';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import {collectionEvalTarget,collectionEvalCaseKey,upsertCollectionEvalCase,removeCollectionEvalCase,
  resolveCollectionEvalFragment,evaluateCollection,collectionEvalPage,COLLECTION_EVAL_PAGE_SIZE,
  MAX_COLLECTION_EVAL_CASES,MAX_COLLECTION_EVAL_EXPECTED,MAX_COLLECTION_EVAL_NOTE,
  serializeCollectionEvalLabels,parseCollectionEvalLabels,serializeCollectionEvalReport,verifyCollectionEvalReport,
  readCollectionEvalFile,type CollectionEvalCase,type CollectionEvalObservation} from './pdfChatCollectionEvaluation';

type Inspect=(id:string,source:Passage,target:HTMLElement)=>void;
function save(text:string,name:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);
  link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function percent(value:number|null){return value===null?'Not defined':(100*value).toFixed(1)+'%';}
const outcomes={
  all_expected:'All labelled fragments retrieved',some_expected:'Some labelled fragments retrieved',
  no_expected_retrieved:'No labelled fragment retrieved',expected_abstention:'Matches labelled abstention',
  unexpected_match:'Matching fragments despite labelled abstention',
};
function Observation({row,names,onInspect}:{row:CollectionEvalObservation;names:Map<string,string>;onInspect:Inspect}){
  return <article className="chat-citation">
    <h5>{names.get(row.target.documentId)} · {row.target.question}</h5>
    <p>{outcomes[row.outcome]}. Native coverage: {row.part.coverage.replaceAll('_',' ')}.</p>
    <p className="chat-muted">Precision: {percent(row.precision)} · Recall: {percent(row.recall)} ·
      Reciprocal rank: {row.reciprocalRank===null?'not defined':row.reciprocalRank.toFixed(3)}.</p>
    {([['Expected and retrieved',row.expectedFound],['Expected but not retrieved',row.expectedMissed],
      ['Retrieved but not labelled',row.unexpectedRetrieved]] as const).map(([label,sources])=>
      <details key={label}><summary>{label} ({sources.length})</summary>
        {sources.map(source=><div className="chat-citation" key={source.page+':'+source.ordinal}>
          <p>{source.text}</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(row.target.documentId,source,event.currentTarget)}>
            Inspect evaluation source {source.page}:{source.ordinal}</button>
        </div>)}
      </details>)}
  </article>;
}
export default function PdfChatCollectionEvaluation({documents,turns,names,onInspect}:{
  documents:readonly CollectionDocument[];turns:CollectionTurn[];names:Map<string,string>;onInspect:Inspect;
}){
  const [cases,setCases]=useState<CollectionEvalCase[]>([]);
  const [turnIndex,setTurnIndex]=useState(0);
  const [documentId,setDocumentId]=useState('');
  const [part,setPart]=useState(0);
  const [draft,setDraft]=useState<CollectionEvalCase|null>(null);
  const [physicalPage,setPhysicalPage]=useState('');
  const [ordinal,setOrdinal]=useState('');
  const [result,setResult]=useState<ReturnType<typeof evaluateCollection>|null>(null);
  const [filter,setFilter]=useState<'all'|'missed'|'abstention'>('all');
  const [page,setPage]=useState(1);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [feedback,setFeedback]=useState('');
  const [approval,setApproval]=useState<readonly CollectionEvalCase[]|null>(null);
  const [pending,setPending]=useState<{cases:CollectionEvalCase[];previous:CollectionEvalCase[]}|null>(null);
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  const latest=useRef(cases);latest.current=cases;
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  const selectedTurn=turns[Math.min(turnIndex,Math.max(0,turns.length-1))];
  const chosenId=selectedTurn?.step.documentIds.includes(documentId)?documentId:selectedTurn?.step.documentIds[0]??'';
  const parts=selectedTurn?.results[0]?.parts??[];
  const rows=useMemo(()=>result?.observations.filter(row=>filter==='all'||(filter==='missed'?
    row.expectedMissed.length>0:row.target.label==='no_expected_match'))??[],[result,filter]);
  const current=Math.min(page,Math.max(1,Math.ceil(rows.length/COLLECTION_EVAL_PAGE_SIZE)));
  const shown=collectionEvalPage(rows,current);
  function changed(next:CollectionEvalCase[]){
    setCases(next);setResult(null);setApproval(null);setFeedback('');setPage(1);setError('');
  }
  function newDraft(){
    if(!selectedTurn)return;
    try{
      const target=collectionEvalTarget(documents,selectedTurn,chosenId,Math.min(part,parts.length-1));
      const existing=cases.find(row=>collectionEvalCaseKey(row)===collectionEvalCaseKey(target));
      setDraft(existing?{...existing,expected:[...existing.expected]}:{...target,expected:[],label:'evidence',note:''});
      setPhysicalPage('');setOrdinal('');setError('');
    }catch{setError('Choose an existing collection question part and source PDF.');}
  }
  function addExpected(){
    if(!draft)return;
    try{
      if(!/^[1-9][0-9]{0,5}$/.test(physicalPage)||!/^[1-9][0-9]{0,5}$/.test(ordinal))throw Error('identity');
      const source=resolveCollectionEvalFragment(documents,draft.documentId,Number(physicalPage),Number(ordinal));
      if(draft.expected.some(row=>row.source===source)||draft.expected.length>=MAX_COLLECTION_EVAL_EXPECTED)throw Error('duplicate');
      setDraft({...draft,expected:[...draft.expected,{source}]});setPhysicalPage('');setOrdinal('');setError('');
    }catch{setError('Choose a unique existing native fragment using its physical page and ordinal.');}
  }
  function saveDraft(){
    if(!draft)return;
    try{changed(upsertCollectionEvalCase(documents,cases,draft));setDraft(null);}
    catch{setError('The label is invalid, outside the question scope, duplicated or exceeds the budget.');}
  }
  function run(){
    try{setResult(evaluateCollection(documents,cases));setFilter('all');setPage(1);setError('');}
    catch{setResult(null);setError('Unable to evaluate the source-bound labels.');}
  }
  async function exchange(action:'labels'|'report'|'import'|'verify',file?:File){
    if(controller.current)return;
    if((action==='labels'||action==='report')&&approval!==cases)return;
    const operation=new AbortController();controller.current=operation;
    const token=++generation.current;setBusy(true);setError('');setFeedback('');setPending(null);setApproval(null);
    const active=()=>token===generation.current&&!operation.signal.aborted;
    try{
      if(action==='labels'||action==='report'){
        const text=action==='labels'?await serializeCollectionEvalLabels(documents,cases,operation.signal):
          await serializeCollectionEvalReport(documents,cases,operation.signal);
        if(active()&&latest.current===cases){save(text,action==='labels'?'noticebridge-collection-retrieval-labels.json':'noticebridge-collection-retrieval-evaluation.json');
          setFeedback('Private retrieval evaluation file exported.');}
      }else{
        if(!file)throw Error('file');
        const text=await readCollectionEvalFile(file,operation.signal);
        if(action==='import'){
          const value=await parseCollectionEvalLabels(text,documents,operation.signal);
          if(active())setPending({cases:value,previous:cases});
        }else{
          const metrics=await verifyCollectionEvalReport(text,documents,cases,operation.signal);
          if(active())setFeedback('Exact evaluation report replay matched '+metrics.cases+' human-labelled case(s).');
        }
      }
    }catch{if(active())setError('Retrieval evaluation file rejected or export failed. Existing labels remain unchanged.');}
    finally{if(token===generation.current){controller.current=null;setBusy(false);}}
  }
  function pick(event:ChangeEvent<HTMLInputElement>,action:'import'|'verify'){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(file)void exchange(action,file);
  }
  return <details className="chat-collection-inspection" aria-label="Collection retrieval evaluation lab">
    <summary>Evaluate collection retrieval against human labels</summary>
    <p className="chat-note">Manually select expected native fragments after inspecting the PDF, or explicitly label a case
      as expecting no match. These labels are not automatically derived from retrieved answers. Scores measure agreement
      with your labels, not truth, coverage of all relevant text or official notice authority.</p>
    {selectedTurn&&<div className="chat-collection-filter-grid">
      <label>Evaluation collection question turn
        <select value={Math.min(turnIndex,turns.length-1)} disabled={busy} onChange={event=>{
          setTurnIndex(Number(event.target.value));setDocumentId('');setPart(0);
        }}>
          {turns.map((turn,index)=><option key={index} value={index}>{index+1}. {turn.step.question}</option>)}
        </select>
      </label>
      <label>Evaluation collection PDF
        <select value={chosenId} disabled={busy} onChange={event=>setDocumentId(event.target.value)}>
          {selectedTurn.step.documentIds.map(id=><option key={id} value={id}>{names.get(id)}</option>)}
        </select>
      </label>
      <label>Evaluation question part
        <select value={Math.min(part,parts.length-1)} disabled={busy} onChange={event=>setPart(Number(event.target.value))}>
          {parts.map((row,index)=><option key={index} value={index}>{row.answer.question}</option>)}
        </select>
      </label>
      <button type="button" className="chat-button" disabled={busy} onClick={newDraft}>Prepare human retrieval label</button>
    </div>}
    {!selectedTurn&&<p>Ask a collection question first, or import existing source-bound labels below.</p>}
    {draft&&<section className="chat-answer" aria-label="Collection retrieval label draft">
      <h4>{names.get(draft.documentId)} · {draft.question}</h4>
      <p className="chat-muted">Nearby search: {draft.includeContext?'enabled':'disabled'}.</p>
      <label>Human retrieval label type
        <select value={draft.label} disabled={busy} onChange={event=>setDraft({...draft,
          label:event.target.value as CollectionEvalCase['label'],expected:event.target.value==='evidence'?draft.expected:[]})}>
          <option value="evidence">Expected native evidence</option><option value="no_expected_match">Expect no matching fragment</option>
        </select>
      </label>
      {draft.label==='evidence'&&<>
        <p>Use the source-fragment browser or physical PDF inspection to identify the expected fragments independently.</p>
        <div className="chat-collection-filter-grid">
          <label>Expected physical page<input inputMode="numeric" maxLength={2} value={physicalPage}
            onChange={event=>setPhysicalPage(event.target.value)}/></label>
          <label>Expected fragment ordinal<input inputMode="numeric" maxLength={6} value={ordinal}
            onChange={event=>setOrdinal(event.target.value)}/></label>
          <button type="button" className="chat-button" disabled={busy||!physicalPage||!ordinal} onClick={addExpected}>Add expected retrieval fragment</button>
        </div>
        {draft.expected.map(({source})=><div className="chat-citation" key={source.page+':'+source.ordinal}>
          <p>Page {source.page} · fragment {source.ordinal}: {source.text}</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(draft.documentId,source,event.currentTarget)}>Inspect labelled evidence</button>
          <button type="button" className="chat-button" disabled={busy} onClick={()=>setDraft({...draft,expected:draft.expected.filter(row=>row.source!==source)})}>Remove expected fragment</button>
        </div>)}
      </>}
      <label>Human retrieval annotation note
        <textarea rows={2} maxLength={MAX_COLLECTION_EVAL_NOTE} disabled={busy} value={draft.note}
          onChange={event=>setDraft({...draft,note:event.target.value})}/>
      </label>
      <button type="button" className="chat-button" disabled={busy||(draft.label==='evidence'&&!draft.expected.length)}
        onClick={saveDraft}>Save human retrieval label</button>
      <button type="button" className="chat-button" onClick={()=>setDraft(null)}>Discard retrieval label draft</button>
    </section>}
    <p>{cases.length}/{MAX_COLLECTION_EVAL_CASES} human-labelled collection case(s).</p>
    {cases.map(row=><div className="chat-citation" key={collectionEvalCaseKey(row)}>
      <p>{names.get(row.documentId)} · {row.question} · {row.label==='evidence'?row.expected.length+' expected fragment(s)':'labelled abstention'}</p>
      <button type="button" className="chat-button" disabled={busy} onClick={()=>setDraft({...row,expected:[...row.expected]})}>Edit saved retrieval label</button>
      <button type="button" className="chat-button" disabled={busy} onClick={()=>changed(removeCollectionEvalCase(cases,collectionEvalCaseKey(row)))}>Remove saved retrieval label</button>
    </div>)}
    <button type="button" className="chat-button" disabled={busy||!cases.length} onClick={run}>Run labelled collection retrieval evaluation</button>
    {result&&<section aria-label="Collection retrieval evaluation results">
      <div className="chat-collection-budget">
        <div><strong>{percent(result.metrics.microPrecision)}</strong><span>Micro precision</span></div>
        <div><strong>{percent(result.metrics.microRecall)}</strong><span>Micro recall</span></div>
        <div><strong>{result.metrics.meanReciprocalRank?.toFixed(3)??'Not defined'}</strong><span>Mean reciprocal rank</span></div>
        <div><strong>{result.metrics.correctAbstentions}/{result.metrics.abstentionCases}</strong><span>Labelled abstentions matched</span></div>
        <div><strong>{result.metrics.incompleteCoverageCases}</strong><span>Incomplete coverage cases</span></div>
      </div>
      <p className="chat-muted">{result.metrics.correctFragments} labelled retrieved of {result.metrics.retrievedFragments}
        {' '}displayed fragments and {result.metrics.expectedFragments} expected fragments.
        Unlabelled retrieved evidence may still be relevant.</p>
      <label>Collection evaluation result filter
        <select value={filter} onChange={event=>{setFilter(event.target.value as typeof filter);setPage(1);}}>
          <option value="all">All cases</option><option value="missed">Missed labelled evidence</option><option value="abstention">Labelled abstention cases</option>
        </select>
      </label>
      {shown.rows.map(row=><Observation key={collectionEvalCaseKey(row.target)} row={row} names={names} onInspect={onInspect}/>)}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={current===1} onClick={()=>setPage(current-1)}>Previous evaluation cases</button>
        <span>Page {current} of {shown.pages}</span>
        <button type="button" className="chat-button" disabled={current===shown.pages} onClick={()=>setPage(current+1)}>Next evaluation cases</button>
      </div>}
    </section>}
    <h4>Private evaluation files</h4>
    <p>Labels contain questions, notes, fingerprints, source locations and text hashes. Reports contain question identities and metrics, not automatic quotations.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={approval===cases} disabled={busy}
      onChange={event=>setApproval(event.target.checked?cases:null)}/> I approve exporting private collection retrieval evaluation data.</label>
    <button type="button" className="chat-button" disabled={busy||approval!==cases||!cases.length} onClick={()=>void exchange('labels')}>Export collection retrieval labels</button>
    <button type="button" className="chat-button" disabled={busy||approval!==cases||!cases.length} onClick={()=>void exchange('report')}>Export collection retrieval evaluation report</button>
    <label className="chat-session-file">Import collection retrieval labels<input type="file" accept=".json,application/json"
      disabled={busy} onChange={event=>pick(event,'import')}/></label>
    <label className="chat-session-file">Verify collection retrieval evaluation report<input type="file" accept=".json,application/json"
      disabled={busy||!cases.length} onChange={event=>pick(event,'verify')}/></label>
    {pending&&<section className="chat-note" aria-label="Collection retrieval label restore confirmation">
      <p>Prepared {pending.cases.length} labels matching the current attached source bytes and native text hashes.</p>
      <button type="button" className="chat-button" disabled={busy||pending.previous!==cases} onClick={()=>{
        if(pending.previous===cases){changed(pending.cases);setPending(null);setDraft(null);}
      }}>Apply imported collection retrieval labels</button>
      <button type="button" className="chat-button" onClick={()=>setPending(null)}>Discard imported retrieval labels</button>
    </section>}
    {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel collection evaluation file operation</button>}
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {feedback&&<p role="status" className="chat-note">{feedback}</p>}
  </details>;
}
