import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {compareSavedParts,filterTurnDiff,turnDiffPage,inspectTurnDiff,exportTurnDifference,verifyTurnDifference,
  MAX_TURN_DIFF_BYTES,type PartPointer,type TurnDifference,type DocumentTurnDiff,type TurnDiffFilter,type PartSide} from './pdfChatTurnDifference';
type Props={documents:readonly CollectionDocument[];turns:readonly CollectionTurn[];names:Map<string,string>;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void;onTurn:(index:number)=>void};
const filters:Record<TurnDiffFilter,string>={all:'All displayed fragments',shared:'Shared coordinates',left_only:'Only in left return',
  right_only:'Only in right return',rank_changed:'Shared with rank change',channel_changed:'Shared with channel change'};
function side(value:PartSide|null){
  if(!value)return <p>Not searched on this side.</p>;
  return <><p>{value.kind==='insufficient'?'No displayed matching evidence':value.displayed+' displayed native fragments'}.</p>
    <p>{value.coverage.replaceAll('_',' ')} · {value.strictMatches} strict matches · {value.contextGroups} nearby groups.</p></>;
}
function DocumentRow({row,result,documents,names,onInspect}:Pick<Props,'documents'|'names'|'onInspect'>&{row:DocumentTurnDiff;result:TurnDifference}){
  const [filter,setFilter]=useState<TurnDiffFilter>('all'),[page,setPage]=useState(1),[open,setOpen]=useState(false);
  const rows=filterTurnDiff(row,filter),shown=turnDiffPage(rows,page);
  return <article className="chat-answer">
    <h5>{names.get(row.id)}</h5>
    <div className="chat-collection-matrix"><div className="chat-overview-side"><strong>Left search</strong>{side(row.left)}</div>
      <div className="chat-overview-side"><strong>Right search</strong>{side(row.right)}</div></div>
    {row.state==='both'?<p>{row.shared} shared · {row.leftOnly} only left · {row.rightOnly} only right · {row.rankChanges} rank changes · {row.channelChanges} channel changes.</p>:
      <p className="chat-note">Only one saved search included this PDF. Its fragments do not count as gained or lost evidence.</p>}
    <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>Inspect displayed citation differences</summary>
      <label>Returned fragment filter<select value={filter} onChange={event=>{setFilter(event.target.value as TurnDiffFilter);setPage(1);}}>
        {Object.entries(filters).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></label>
      {open&&<>
        {shown.rows.map(item=><article className="chat-citation" key={item.source.page+':'+item.source.ordinal}>
          <p>Page {item.source.page}, fragment {item.source.ordinal} · {filters[item.state]}</p>
          <p>{item.source.text}</p>
          <p>Left: {item.leftRank===null?'not displayed':'['+item.leftRank+'] '+item.leftChannel} · Right: {item.rightRank===null?'not displayed':'['+item.rightRank+'] '+item.rightChannel}.</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(row.id,inspectTurnDiff(documents,result,row,item),event.currentTarget)}>
            Inspect compared citation {item.source.page}:{item.source.ordinal}</button>
        </article>)}
        {!rows.length&&<p>No displayed citation matches this filter.</p>}
        {shown.pages>1&&<div className="chat-toolbar"><button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous compared citations</button>
          <span>Page {page} of {shown.pages}</span><button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next compared citations</button></div>}
      </>}
    </details>
  </article>;
}
function save(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-saved-question-difference.json';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function encode(pointer:PartPointer){return pointer.turn+':'+pointer.part;}
function decode(value:string):PartPointer{const [turn,part]=value.split(':').map(Number);return {turn,part};}
export default function PdfChatTurnDifference({documents,turns,names,onInspect,onTurn}:Props){
  const choices=turns.flatMap((turn,i)=>turn.results[0].parts.map((part,j)=>({value:encode({turn:i,part:j}),label:(i+1)+'.'+(j+1)+' '+part.answer.question})));
  const [left,setLeft]=useState(choices[0]?.value??''),[right,setRight]=useState(choices[1]?.value??'');
  const [result,setResult]=useState<TurnDifference|null>(null),[approved,setApproved]=useState<TurnDifference|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  function reset(){setResult(null);setApproved(null);setError('');setFeedback('');}
  async function process(mode:'export'|'verify',file?:File){
    if(active.current||mode==='export'&&(!result||approved!==result))return;
    const operation=new AbortController();active.current=operation;setBusy(true);setApproved(null);setError('');setFeedback('');
    try{
      if(mode==='export'&&result){
        const text=await exportTurnDifference(documents,turns,result.left.pointer,result.right.pointer,true,operation.signal);
        operation.signal.throwIfAborted();save(text);setFeedback('Private saved question difference exported.');
      }else if(file){
        reset();
        if(!file.size||file.size>MAX_TURN_DIFF_BYTES)throw Error('size');
        const bytes=await file.arrayBuffer();operation.signal.throwIfAborted();
        if(bytes.byteLength!==file.size)throw Error('size');
        const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
        const value=await verifyTurnDifference(text,documents,turns,operation.signal);operation.signal.throwIfAborted();
        setLeft(encode(value.left.pointer));setRight(encode(value.right.pointer));setResult(value);setFeedback('Exact saved question difference reproduced.');
      }
    }catch{if(!operation.signal.aborted)setError('Unable to export or reproduce the saved question comparison.');}
    finally{if(active.current===operation){active.current=null;setBusy(false);}}
  }
  function pick(event:ChangeEvent<HTMLInputElement>){const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void process('verify',file);}
  return <details className="chat-collection-inspection" aria-label="Compare saved question searches">
    <summary>Compare evidence returned by two saved question parts</summary>
    <p className="chat-note">This compares retrieval outputs only. Different questions, page scopes and nearby-line settings can produce different
      results even though the actual PDF has not changed. A PDF searched on one side only is not scored as a gained or lost match.</p>
    <label>Left saved question part<select value={left} disabled={busy} onChange={event=>{reset();setLeft(event.target.value);}}>
      {choices.map(row=><option key={row.value} value={row.value}>{row.label}</option>)}
    </select></label>
    <label>Right saved question part<select value={right} disabled={busy} onChange={event=>{reset();setRight(event.target.value);}}>
      {choices.map(row=><option key={row.value} value={row.value}>{row.label}</option>)}
    </select></label>
    <button type="button" className="chat-button" disabled={busy||!left||!right||left===right} onClick={()=>{
      reset();try{setResult(compareSavedParts(documents,turns,decode(left),decode(right)));}catch{setError('Unable to compare the exact saved question parts.');}
    }}>Compare selected saved searches</button>
    {result&&<section aria-label="Saved question search comparison results">
      <div className="chat-collection-matrix">
        {([['Left',result.left],['Right',result.right]] as const).map(([label,selection])=><div key={label} className="chat-overview-side">
          <h5>{label}: {selection.question}</h5><p>{selection.page===null?'All indexed pages':'Physical page '+selection.page} · {selection.context?'Nearby enabled':'Strict only'}</p>
          <button type="button" className="chat-button" onClick={()=>onTurn(selection.pointer.turn)}>Open {label.toLowerCase()} saved turn {selection.pointer.turn+1}</button>
        </div>)}
      </div>
      <p>Wording: {result.sameWording?'same':'different'} · Page scope: {result.samePhysicalPage?'same':'different'} · Context: {result.sameContext?'same':'different'} · PDF set: {result.sameDocumentSet?'same':'different'}.</p>
      <p>{result.commonDocuments} PDF(s) searched on both sides. In common PDFs: {result.shared} shared, {result.leftOnly} only left,
        {' '}{result.rightOnly} only right, {result.rankChanges} rank changes, {result.channelChanges} channel changes.</p>
      {result.documents.map(row=><DocumentRow key={row.id} row={row} result={result} documents={documents} names={names} onInspect={onInspect}/>)}
      <label className="chat-checkbox"><input type="checkbox" checked={approved===result} disabled={busy} onChange={event=>setApproved(event.target.checked?result:null)}/>
        I approve exporting private question steps, source fingerprints and citation coordinates.</label>
      <button type="button" className="chat-button" disabled={busy||approved!==result} onClick={()=>void process('export')}>Export saved search comparison</button>
    </section>}
    <label className="chat-session-file">Verify saved search comparison<input type="file" accept=".json,application/json" disabled={busy} onChange={pick}/></label>
    {busy&&<button type="button" className="chat-button" onClick={()=>active.current?.abort()}>Cancel saved search comparison operation</button>}
    {error&&<p role="alert" className="chat-error">{error}</p>}{feedback&&<p role="status">{feedback}</p>}
  </details>;
}
