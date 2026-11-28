import {useMemo,useState} from 'react';
import type {Passage} from './pdfChatCore';
import type {CollectionDocument,CollectionPart} from './pdfChatCollection';
import {explainCollectionRanking,filterCollectionRanking,collectionRankingPage,collectionRankingTermScores,
  inspectCollectionRanking,COLLECTION_RANK_PAGE_SIZE,type CollectionRankingFilter,type CollectionRankingRow,
  type CollectionRankingTrace} from './pdfChatCollectionRanking';

const modeLabels={lexical:'Every normalized term matches',field:'Recognized field alias',lexical_and_field:'Both lexical and field alias'};
function Detail({row,trace}:{row:CollectionRankingRow;trace:CollectionRankingTrace}){
  const [open,setOpen]=useState(false);
  const scores=useMemo(()=>open?collectionRankingTermScores(trace,row):[],[open,row,trace]);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Explain local ranking weight</summary>
    {open&&<>
      <p className="chat-muted">These BM25 contributions are ranking weights, not confidence or probabilities.
        Document frequency uses the whole indexed PDF, even with a page-scoped question.</p>
      <table className="chat-table"><thead><tr><th>Term</th><th>In fragment</th><th>Indexed fragments</th><th>Weight</th></tr></thead>
        <tbody>{scores.map(term=><tr key={term.term}><td>{term.term}</td><td>{term.tf}</td><td>{term.df}</td>
          <td>{term.contribution.toFixed(4)}</td></tr>)}</tbody></table>
      <p>Total local weight: {row.score.toFixed(4)}.</p>
    </>}
  </details>;
}

export default function PdfChatCollectionRanking({documents,documentId,part,includeContext,onInspect}:{
  documents:readonly CollectionDocument[];documentId:string;part:CollectionPart;includeContext:boolean;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void;
}){
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState<CollectionRankingFilter>({mode:'all',display:'all',query:''});
  const [page,setPage]=useState(1);
  const trace=useMemo(()=>open?explainCollectionRanking(documents,documentId,part,includeContext):null,
    [open,documents,documentId,part,includeContext]);
  const rows=trace?filterCollectionRanking(trace,filter):[];
  const current=collectionRankingPage(rows,Math.min(page,Math.max(1,Math.ceil(rows.length/COLLECTION_RANK_PAGE_SIZE))));
  function change(next:Partial<CollectionRankingFilter>){setFilter(old=>({...old,...next}));setPage(1);}
  return <details className="chat-collection-inspection" aria-label="Collection retrieval ranking trace"
    onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Explain retrieval and inspect ranked candidates</summary>
    <p className="chat-note">This is a deterministic explanation of the native search, not a model rationale or a confidence score.
      Inspecting another ranked fragment does not add it to the saved answer.</p>
    {trace&&<>
      <p>Normalized query terms: {trace.terms.length?trace.terms.join(', '):'(None)'}</p>
      <p>Recognized field: {trace.field?.replaceAll('_',' ')??'None'}.</p>
      <p>{trace.scopedFragments} in-scope native fragments out of {trace.indexedFragments} indexed in this PDF.</p>
      {trace.physicalPage!==undefined&&<p>Physical page {trace.physicalPage} only.</p>}
      <div className="chat-collection-budget">
        <div><strong>{trace.strictMatches}</strong><span>Unique strict matches</span></div>
        <div><strong>{trace.shownStrictMatches}</strong><span>Displayed strict matches</span></div>
        <div><strong>{trace.collapsedDuplicates}</strong><span>Repeated same-page wording</span></div>
      </div>
      {trace.state==='no_terms'&&<p>No searchable terms remained after normalization.</p>}
      {trace.state==='term_limit'&&<p>More than 16 distinct normalized terms exceed the bounded query budget.</p>}
      {trace.state==='no_match'&&<p>No strict or enabled adjacent-line match. Review source coverage and separate diagnostic leads.</p>}
      {trace.state==='contextual'&&<div className="chat-note">
        <p>No strict match. The adjacent-line fallback displayed {trace.context.length} minimal candidate window(s).
          These fragments do not establish a combined statement.</p>
        {trace.context.map((window,i)=><div key={i}>
          <h5>Window {i+1}</h5>
          {window.map(source=><button type="button" className="chat-button" key={source.ordinal}
            onClick={event=>onInspect(documentId,source,event.currentTarget)}>Inspect page {source.page}, fragment {source.ordinal}</button>)}
        </div>)}
      </div>}
      {!!trace.rows.length&&<>
        <div className="chat-collection-filter-grid">
          <label>Match mechanism<select value={filter.mode} onChange={event=>change({mode:event.target.value as CollectionRankingFilter['mode']})}>
            <option value="all">All mechanisms</option>
            <option value="lexical">Lexical only</option><option value="field">Field alias only</option>
            <option value="lexical_and_field">Both</option>
          </select></label>
          <label>Candidate visibility<select value={filter.display} onChange={event=>change({display:event.target.value as CollectionRankingFilter['display']})}>
            <option value="all">All candidates</option><option value="shown">Already displayed</option><option value="omitted">Not displayed</option>
          </select></label>
          <label>Find ranked text<input value={filter.query} maxLength={100} onChange={event=>change({query:event.target.value})}/></label>
        </div>
        <p role="status">{rows.length} ranked candidates match the filters.</p>
        {current.rows.map(row=><article className="chat-citation" key={row.passage.page+':'+row.passage.ordinal}>
          <p><strong>Local rank {row.rank}</strong> · {modeLabels[row.mode]} · {row.displayed?'Displayed in answer':'Not displayed in answer'}</p>
          <p className="chat-muted">Physical page {row.passage.page} · fragment {row.passage.ordinal}
            {row.duplicates>0?' · '+row.duplicates+' repeated same-page occurrence(s)':''}</p>
          <p>{row.passage.text}</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(documentId,
            inspectCollectionRanking(documents,trace,row),event.currentTarget)}>Inspect ranked source {row.rank}</button>
          <Detail row={row} trace={trace}/>
        </article>)}
        {current.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous ranked candidates</button>
          <span>{current.first}–{current.last} of {rows.length}</span>
          <button type="button" className="chat-button" disabled={page===current.pages} onClick={()=>setPage(page+1)}>Next ranked candidates</button>
        </div>}
      </>}
    </>}
  </details>;
}
