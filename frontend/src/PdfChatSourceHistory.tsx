import {useMemo,useState} from 'react';
import type {CollectionDocument,CollectionTurn,CollectionStep} from './pdfChatCollection';
import type {CollectionReviewEntry} from './pdfChatCollectionReview';
import type {Passage} from './pdfChatCore';
import {sourceHistory,filterSourceHistory,sourceHistoryPage,validateSourceHistoryUse,sourceHistoryDraft,
  SOURCE_HISTORY_PAGE_SIZE,type SourceHistoryFilter} from './pdfChatSourceHistory';

type Props={documents:readonly CollectionDocument[];turns:readonly CollectionTurn[];reviews:readonly CollectionReviewEntry[];
  documentId:string;source:Passage;disabled:boolean;draftDisabled:boolean;onTurn:(index:number)=>void;onDraft:(step:CollectionStep)=>void};
export default function PdfChatSourceHistory({documents,turns,reviews,documentId,source,disabled,draftDisabled,onTurn,onDraft}:Props){
  const [open,setOpen]=useState(false),[filter,setFilter]=useState<SourceHistoryFilter>('all'),[query,setQuery]=useState('');
  const [page,setPage]=useState(1),[scope,setScope]=useState<'this_pdf'|'original_selection'>('this_pdf');
  const result=useMemo(()=>{
    if(!open)return null;
    try{return {history:sourceHistory(documents,turns,reviews,documentId,source),error:false};}
    catch{return {history:null,error:true};}
  },[open,documents,turns,reviews,documentId,source]);
  const history=result?.history;
  const rows=history?filterSourceHistory(history,filter,query):[];
  const currentPage=Math.min(page,Math.max(1,Math.ceil(rows.length/SOURCE_HISTORY_PAGE_SIZE)));
  const current=sourceHistoryPage(rows,currentPage);
  return <details className="chat-collection-inspection" aria-label="Citation history for inspected source"
    onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Find saved questions that cited this exact fragment</summary>
    <p>Only displayed native citations in the saved conversation are counted. Identical excerpts from other PDFs and optional model proposals are excluded.</p>
    {result?.error&&<p role="alert" className="chat-error">Unable to resolve the current citation history.</p>}
    {history&&<>
      <p>{history.uses.length} citation use(s) in {history.distinctTurns} saved turn(s) · {history.strictUses} strict · {history.nearbyUses} nearby.</p>
      <p>Personal annotation: {history.annotation?history.annotation.status.replaceAll('_',' '):'not saved'}. Review status does not establish correctness.</p>
      {!history.uses.length?<p>No saved question cited this exact native fragment.</p>:<>
        <label>Inspected fragment citation channel<select value={filter} onChange={event=>{setFilter(event.target.value as SourceHistoryFilter);setPage(1);}}>
          <option value="all">All uses</option><option value="strict">Strict</option><option value="nearby">Nearby</option>
          <option value="printed">Literal printed field</option>
        </select></label>
        <label>Find related saved question<input value={query} maxLength={100} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></label>
        <label>Draft scope for a historical question<select value={scope} onChange={event=>setScope(event.target.value as typeof scope)}>
          <option value="this_pdf">Only this PDF</option><option value="original_selection">Original PDF selection</option>
        </select></label>
        {draftDisabled&&<p className="chat-muted">Clear the current unsent question before drafting a historical part.</p>}
        {!rows.length&&<p>No citation use matches these filters.</p>}
        {current.rows.map(use=><article className="chat-citation" key={use.turn+':'+use.part+':'+use.rank}>
          <p className="chat-muted">Turn {use.turn+1} · part {use.part+1} · citation [{use.rank}] · {use.channel}
            {use.printedField?' · literal printed field':''}</p>
          <p>{use.question}</p>
          <p>{use.physicalPage===null?'All indexed physical pages':'Physical page '+use.physicalPage} · {use.selectedDocuments} PDF(s) originally searched.</p>
          <button type="button" className="chat-button" disabled={disabled} onClick={()=>{
            validateSourceHistoryUse(documents,turns,history,use);onTurn(use.turn);
          }}>Open citing question {use.turn+1}, part {use.part+1}</button>
          <button type="button" className="chat-button" disabled={disabled||draftDisabled} onClick={()=>
            onDraft(sourceHistoryDraft(documents,turns,history,use,scope))}>Draft citing question {use.turn+1}, part {use.part+1}</button>
        </article>)}
        {current.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={currentPage===1} onClick={()=>setPage(currentPage-1)}>Previous citing questions</button>
          <span>{current.first}–{current.last} of {rows.length}</span>
          <button type="button" className="chat-button" disabled={currentPage===current.pages} onClick={()=>setPage(currentPage+1)}>Next citing questions</button>
        </div>}
      </>}
    </>}
  </details>;
}
