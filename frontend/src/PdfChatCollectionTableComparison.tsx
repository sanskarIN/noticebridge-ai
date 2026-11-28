import {useEffect,useMemo,useRef,useState,type ChangeEvent} from 'react';
import type {Passage} from './pdfChatCore';
import type {CollectionDocument} from './pdfChatCollection';
import {collectionTableInventory} from './pdfChatCollectionLayout';
import {fieldDefinitions} from './pdfChatOverview';
import {compareCollectionTables,filterTableComparison,tableComparisonPage,inspectTableComparisonCell,
  serializeTableComparison,verifyTableComparison,readTableComparison,TABLE_COMPARISON_PAGE_SIZE,
  type CollectionTableComparison,type TableChoice,type TableComparisonFilter,type TableComparisonCell,
  type TableComparisonRow} from './pdfChatCollectionTableComparison';
type Inspect=(id:string,source:Passage,target:HTMLElement)=>void;
type Props={documents:readonly CollectionDocument[];selected:string[];names:Map<string,string>;onInspect:Inspect};
const states={same_text:'Same literal cell text',different_text:'Different literal cell text',missing:'Missing cell candidate in one or more selected tables'};
const missing={missing_category:'Category not aligned in this selected table',missing_field:'Field not present in this selected table',
  missing_both:'Neither category nor field aligned in this selected table'};
function Cell({documents,result,row,cell,names,onInspect}:Pick<Props,'documents'|'names'|'onInspect'>&{
  result:CollectionTableComparison;row:TableComparisonRow;cell:TableComparisonCell;
}){
  return <article className="chat-overview-side">
    <h5>{names.get(cell.documentId)}</h5>
    <p>{cell.state==='present'?cell.value!.text:missing[cell.state]}</p>
    <p className="chat-muted">Physical table page {cell.categoryHeader.page}.</p>
    <details><summary>Inspect table cell evidence</summary>
      {([['Category header',cell.categoryHeader],['Field header',cell.fieldHeader],['Printed category',cell.category],['Cell text',cell.value]] as const)
        .map(([label,source])=><div key={label} className="chat-citation">
          <p>{label}: {source?.text??'Not aligned'}</p>
          {source&&<button type="button" className="chat-button" onClick={event=>onInspect(cell.documentId,
            inspectTableComparisonCell(documents,result,row,cell,source),event.currentTarget)}>Inspect {label.toLowerCase()} page {source.page}:{source.ordinal}</button>}
        </div>)}
    </details>
  </article>;
}
function download(text:string){
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='noticebridge-collection-table-comparison.json';
  document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export default function PdfChatCollectionTableComparison({documents,selected,names,onInspect}:Props){
  const [open,setOpen]=useState(false);
  const [choices,setChoices]=useState<TableChoice[]>([]);
  const [result,setResult]=useState<CollectionTableComparison|null>(null);
  const [filter,setFilter]=useState<TableComparisonFilter>({state:'all',field:'all',category:''});
  const [page,setPage]=useState(1);
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [status,setStatus]=useState('');
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  const sides=useMemo(()=>open&&selected.length?collectionTableInventory(documents,selected):[],[open,documents,selected]);
  const rows=result?filterTableComparison(result,filter):[];
  const current=Math.min(page,Math.max(1,Math.ceil(rows.length/TABLE_COMPARISON_PAGE_SIZE)));
  const shown=tableComparisonPage(rows,current);
  function choose(id:string,key:string){
    setChoices(old=>[...old.filter(row=>row.documentId!==id),...(key?[{documentId:id,key}]:[])]);
    setResult(null);setConsent(false);setStatus('');setError('');
  }
  function run(){
    try{
      const ordered=selected.flatMap(id=>choices.filter(row=>row.documentId===id));
      setResult(compareCollectionTables(documents,ordered));setPage(1);
      setFilter({state:'all',field:'all',category:''});setError('');setStatus('');
    }catch{setError('Select one existing table from each of at least two different PDFs.');setResult(null);}
  }
  async function exchange(file?:File){
    if(controller.current||!file&&(!result||!consent))return;
    const operation=new AbortController();controller.current=operation;
    const token=++generation.current;
    const active=()=>token===generation.current&&!operation.signal.aborted;
    setBusy(true);setConsent(false);setError('');setStatus('');
    try{
      if(file){
        const text=await readTableComparison(file,operation.signal);
        const verified=await verifyTableComparison(text,documents,operation.signal);
        if(verified.choices.some(row=>!selected.includes(row.documentId)))throw Error('selection');
        if(active()){setChoices(verified.choices);setResult(verified);setPage(1);
          setFilter({state:'all',field:'all',category:''});setStatus('Exact table comparison report replay matched.');}
      }else{
        const text=await serializeTableComparison(documents,result!.choices,true,operation.signal);
        if(active()){download(text);setStatus('Private collection table comparison exported.');}
      }
    }catch{if(active())setError('Table comparison artifact rejected or export failed. Check the exact attached and selected PDFs.');}
    finally{if(token===generation.current){controller.current=null;setBusy(false);}}
  }
  function pick(event:ChangeEvent<HTMLInputElement>){
    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
    if(file)void exchange(file);
  }
  function update(value:Partial<TableComparisonFilter>){setFilter(old=>({...old,...value}));setPage(1);}
  return <details className="chat-collection-inspection" aria-label="Compare explicitly selected collection tables"
    onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Compare explicitly selected aligned table candidates</summary>
    <p className="chat-note">Choose a physical table from each PDF. This aligns recognized field keys and normalized
      complete printed categories, not inferred applicant equivalence or a version relationship. Missing cells are not proof of removal.</p>
    {open&&<>
      {sides.map(side=><section key={side.documentId} className="chat-citation">
        <h5>{names.get(side.documentId)}</h5>
        <p>{side.tables.length} table candidate(s). {side.limited?'Candidate budget reached.':''}
          {side.skippedPages.length>0?' Some native pages skipped.':''}</p>
        <label>Select comparison table in {names.get(side.documentId)}
          <select disabled={busy||!side.tables.length} value={choices.find(row=>row.documentId===side.documentId)?.key??''}
            onChange={event=>choose(side.documentId,event.target.value)}>
            <option value="">Do not include this PDF</option>
            {side.tables.map(row=><option key={row.key} value={row.key}>
              Page {row.table.page} · fragment {row.table.headers[0].ordinal} · {row.table.headers.map(header=>header.text).join(' / ')}</option>)}
          </select>
        </label>
      </section>)}
      <button type="button" className="chat-button" disabled={busy||choices.length<2} onClick={run}>Compare chosen collection tables</button>
      {result&&<section aria-label="Selected collection table comparison results">
        <h4>Literal candidate matrix</h4>
        <div className="chat-collection-budget">
          {(Object.keys(states) as (keyof typeof states)[]).map(state=><div key={state}><strong>{result.counts[state]}</strong><span>{states[state]}</span></div>)}
        </div>
        {result.limited&&<p className="chat-note">Some selected documents have incomplete extraction or layout coverage.</p>}
        <div className="chat-collection-filter-grid">
          <label>Collection table comparison state<select value={filter.state} onChange={event=>update({state:event.target.value as TableComparisonFilter['state']})}>
            <option value="all">All cells</option>
            {(Object.keys(states) as (keyof typeof states)[]).map(state=><option key={state} value={state}>{states[state]}</option>)}
          </select></label>
          <label>Collection table comparison field<select value={filter.field} onChange={event=>update({field:event.target.value as TableComparisonFilter['field']})}>
            <option value="all">All fields</option>
            {fieldDefinitions.map(field=><option key={field.id} value={field.id}>{field.label}</option>)}
          </select></label>
          <label>Find aligned category<input maxLength={100} value={filter.category} onChange={event=>update({category:event.target.value})}/></label>
        </div>
        <p role="status">{rows.length} aligned category/field candidate(s).</p>
        {shown.rows.map(row=><article className="chat-answer" key={row.categoryKey+':'+row.field}>
          <h5>{row.categoryKey} · {fieldDefinitions.find(field=>field.id===row.field)?.label}</h5>
          <p>{states[row.state]}.</p>
          {(row.differentCategoryLabels||row.differentFieldLabels)&&<p className="chat-note">Printed labels differ.
            Inspect every header and category before treating the cell candidates as comparable.</p>}
          <div className="chat-collection-matrix">{row.cells.map(cell=><Cell key={cell.documentId}
            documents={documents} result={result} row={row} cell={cell} names={names} onInspect={onInspect}/>)}</div>
        </article>)}
        {shown.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={current===1} onClick={()=>setPage(current-1)}>Previous compared cells</button>
          <span>{shown.first}–{shown.last} of {rows.length} · page {current} of {shown.pages}</span>
          <button type="button" className="chat-button" disabled={current===shown.pages} onClick={()=>setPage(current+1)}>Next compared cells</button>
        </div>}
        <label className="chat-checkbox"><input type="checkbox" checked={consent} disabled={busy}
          onChange={event=>setConsent(event.target.checked)}/> I approve exporting these private table labels, cells and source fingerprints.</label>
        <button type="button" className="chat-button" disabled={busy||!consent} onClick={()=>void exchange()}>Export collection table comparison</button>
      </section>}
      <label className="chat-session-file">Verify saved collection table comparison<input type="file" accept=".json,application/json"
        disabled={busy} onChange={pick}/></label>
      {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel table comparison file operation</button>}
      {error&&<p role="alert" className="chat-error">{error}</p>}
      {status&&<p role="status" className="chat-note">{status}</p>}
    </>}
  </details>;
}
