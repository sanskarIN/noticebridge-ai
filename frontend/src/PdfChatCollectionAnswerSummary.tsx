import {useMemo,useState} from 'react';
import type {Passage} from './pdfChatCore';
import type {CollectionDocument,CollectionTurn,CollectionPart} from './pdfChatCollection';
import {collectionAnswerSummary,filterCollectionAnswerRows,collectionSharedAnswerQuotes,
  type CollectionAnswerCell,type CollectionAnswerRow,type SummaryFilter} from './pdfChatCollectionAnswerSummary';
type Inspect=(id:string,source:Passage,target:HTMLElement)=>void;
const coverage:Record<CollectionPart['coverage'],string>={
  some_text:'Some native text indexed',partial:'Incomplete native coverage',
  no_indexed_text:'No native text indexed',not_present:'Physical page does not exist',not_indexed:'Physical page not indexed',
};
const printed:Record<CollectionAnswerRow['printedState'],string>={
  not_recognized:'No concise recognized printed-field answer',
  missing:'At least one PDF has no recognized printed value',
  multiple:'At least one PDF has multiple distinct printed values',
  single:'One PDF has one recognized printed value',
  same_text:'All PDFs have the same literal printed value',
  different_text:'PDFs have different literal printed values',
};
function Cell({cell,name,onInspect}:{cell:CollectionAnswerCell;name:string;onInspect:Inspect}){
  const {part,direct}=cell;
  return <article className="chat-overview-side">
    <h5>{name}</h5>
    <p>{part.answer.kind==='insufficient'?'No matching indexed evidence':
      part.answer.matchedCounts.original+' strict match(es) · '+part.answer.citations.length+' displayed fragments'}</p>
    <p className={part.coverage==='some_text'?'chat-muted':'chat-note'}>{coverage[part.coverage]}.</p>
    {direct&&<>
      {direct.values.map(group=><div key={group.value} className="chat-citation">
        <p>Printed <strong>{group.value}</strong> under “{group.sources[0].label}”.</p>
        {group.sources.map(value=><button key={value.source.page+':'+value.source.ordinal}
          type="button" className="chat-button" onClick={event=>onInspect(cell.documentId,value.source,event.currentTarget)}>
          Inspect printed value page {value.source.page}:{value.source.ordinal}</button>)}
        {group.occurrences>group.sources.length&&<p className="chat-muted">{group.occurrences-group.sources.length} further occurrences not displayed.</p>}
      </div>)}
      {direct.distinctValues>direct.values.length&&<p className="chat-note">{direct.distinctValues-direct.values.length}
        {' '}additional distinct values not displayed. No single value is chosen.</p>}
      {direct.reviewPassages.length>0&&<details>
        <summary>Additional matching or nearby text to review</summary>
        <p className="chat-note">Conditions and exceptions may be present. Proximity does not verify a relationship.</p>
        {direct.reviewPassages.map(row=><div key={row.source.page+':'+row.source.ordinal} className="chat-citation">
          <p className="chat-muted">{row.reason==='query_match'?'Matching text':'Nearby text'}</p><p>{row.source.text}</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(cell.documentId,row.source,event.currentTarget)}>Inspect additional text page {row.source.page}:{row.source.ordinal}</button>
        </div>)}
        {direct.otherMatchingPassages+direct.nearbyPassages>direct.reviewPassages.length&&<p>Further review candidates are not displayed here.</p>}
      </details>}
    </>}
    {!direct&&part.answer.citations.slice(0,1).map(source=><div key={source.page+':'+source.ordinal} className="chat-citation">
      <p>{source.text}</p>
      <button type="button" className="chat-button" onClick={event=>onInspect(cell.documentId,source,event.currentTarget)}>Inspect leading collection fragment</button>
    </div>)}
  </article>;
}
function Shared({documents,row,names,onInspect}:{documents:readonly CollectionDocument[];row:CollectionAnswerRow;names:Map<string,string>;onInspect:Inspect}){
  const [open,setOpen]=useState(false);
  const [limit,setLimit]=useState(4);
  const quotes=useMemo(()=>open?collectionSharedAnswerQuotes(documents,row):[],[documents,row,open]);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Inspect exact shared displayed quotations</summary>
    <p className="chat-muted">Identical text is not proof that rules apply to the same people, dates or circumstances.</p>
    {open&&!quotes.length&&<p>No identical quotation among displayed fragments from distinct PDFs.</p>}
    {quotes.slice(0,limit).map(quote=><article key={quote.text} className="chat-citation">
      <p>{quote.text}</p><p>{quote.documents.length} distinct PDFs display this text.</p>
      {quote.documents.map(group=><div key={group.documentId}>
        <h5>{names.get(group.documentId)}</h5>
        {group.sources.map(source=><button key={source.page+':'+source.ordinal} type="button" className="chat-button"
          onClick={event=>onInspect(group.documentId,source,event.currentTarget)}>Inspect shared fragment {source.page}:{source.ordinal}</button>)}
      </div>)}
    </article>)}
    {quotes.length>limit&&<button type="button" className="chat-button" onClick={()=>setLimit(old=>old+4)}>Show more shared quotations</button>}
  </details>;
}
export default function PdfChatCollectionAnswerSummary({documents,turn,names,onInspect}:{
  documents:readonly CollectionDocument[];turn:CollectionTurn;names:Map<string,string>;onInspect:Inspect;
}){
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState<SummaryFilter>('all');
  const result=useMemo(()=>open?collectionAnswerSummary(documents,turn):null,[open,documents,turn]);
  const rows=result?filterCollectionAnswerRows(result,filter):[];
  return <details className="chat-collection-inspection" aria-label="Collection question at a glance" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>At a glance: collection question evidence</summary>
    <p className="chat-note">This overview groups independent native searches by question part. Printed labels and quotations
      are not certified answers, equivalent values, legal conclusions or changes between versions.</p>
    {result&&<>
      <div className="chat-collection-budget">
        <div><strong>{result.documents}</strong><span>Selected PDFs in this saved question</span></div>
        <div><strong>{result.searches}</strong><span>Independent searches</span></div>
        <div><strong>{result.matchingSearches}</strong><span>Searches with displayed evidence</span></div>
        <div><strong>{result.limitedSearches}</strong><span>Searches with incomplete coverage</span></div>
      </div>
      <label>Collection answer overview filter<select value={filter} onChange={event=>setFilter(event.target.value as SummaryFilter)}>
        <option value="all">All question parts</option><option value="review">Parts needing review</option>
        <option value="no_match">No indexed matches anywhere</option><option value="printed">Recognized printed fields</option>
      </select></label>
      {rows.map(row=><section className="chat-answer" key={row.question} aria-label={'Collection overview: '+row.question}>
        <h4>{row.question}</h4>
        {row.page!==undefined&&<p>Physical page {row.page} only in each PDF.</p>}
        <p>{row.matchingDocuments} of {row.cells.length} PDFs have matching indexed evidence.</p>
        {row.field&&<p>{row.field.label}: {printed[row.printedState]}.</p>}
        {row.limitedDocuments>0&&<p className="chat-note">{row.limitedDocuments} PDF scope(s) have incomplete or unavailable native coverage.</p>}
        <div className="chat-collection-matrix">
          {row.cells.map(cell=><Cell key={cell.documentId} cell={cell} name={names.get(cell.documentId)??'Attached PDF'} onInspect={onInspect}/>)}
        </div>
        <Shared documents={documents} row={row} names={names} onInspect={onInspect}/>
      </section>)}
      {!rows.length&&<p>No question part matches this overview filter.</p>}
    </>}
  </details>;
}
