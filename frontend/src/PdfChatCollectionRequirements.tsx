import { useMemo, useState } from 'react';
import type { Passage } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';
import { requirementKinds, REQUIREMENT_KEYWORD_LIMIT, type RequirementKind } from './pdfChatRequirements';
import { collectionRequirements, collectionRequirementPage, collectionRequirementSource,
  collectionRequirementCounterparts, COLLECTION_REQUIREMENT_PAGE_SIZE, type CollectionRequirementFilter,
  type CollectionRequirements, type CollectionRequirementHit } from './pdfChatCollectionRequirements';
import { collectionDatePageFilter } from './pdfChatCollectionDates';

const namesOfKinds: Record<RequirementKind,string> = {mandatory:'Mandatory cue',prohibited:'Prohibition cue',
  exception:'Exception cue',permission:'Permission cue',recommendation:'Recommendation cue'};
type Inspect=(id:string,source:Passage,target:HTMLElement)=>void;
function Candidate({documents,result,hit,names,onInspect}:{
  documents:readonly CollectionDocument[];result:CollectionRequirements;hit:CollectionRequirementHit;
  names:Map<string,string>;onInspect:Inspect;
}) {
  const [expanded,setExpanded]=useState(false);
  const [limit,setLimit]=useState(6);
  const matches=useMemo(()=>expanded?collectionRequirementCounterparts(documents,result,hit):[],[expanded,documents,result,hit]);
  return <article className="chat-citation">
    <h5>{names.get(hit.documentId)}</h5>
    <p className="chat-muted">Physical page {hit.source.page} · fragment {hit.source.ordinal}</p>
    <p>{hit.source.text}</p>
    <p className="chat-muted">{hit.cues.map(cue=>namesOfKinds[cue.kind]+': '+cue.text).join(' · ')}
      {hit.totalCues>hit.cues.length&&' · additional cues not displayed'}</p>
    <button type="button" className="chat-button" onClick={event=>onInspect(hit.documentId,
      collectionRequirementSource(documents,result,hit),event.currentTarget)}>Inspect collection requirement source</button>
    <p>{hit.matchingDocumentIds.length?hit.matchingDocumentIds.length+' other selected PDF(s) have exact indexed wording.':
      'No exact counterpart indexed in the other selected PDFs.'}</p>
    {hit.matchingDocumentIds.length>0&&<details onToggle={event=>setExpanded(event.currentTarget.open)}>
      <summary>Inspect exact collection requirement counterparts</summary>
      {matches.slice(0,limit).map(row=><div key={row.documentId+':'+row.source.page+':'+row.source.ordinal}>
        <p>{names.get(row.documentId)} · physical page {row.source.page} · fragment {row.source.ordinal}</p>
        <button type="button" className="chat-button" onClick={event=>onInspect(row.documentId,row.source,event.currentTarget)}>
          Inspect exact counterpart</button>
      </div>)}
      {matches.length>limit&&<button type="button" className="chat-button" onClick={()=>setLimit(old=>old+6)}>Show more exact counterparts</button>}
    </details>}
  </article>;
}
export default function PdfChatCollectionRequirements({documents,selected,names,onInspect}:{
  documents:readonly CollectionDocument[];selected:string[];names:Map<string,string>;onInspect:Inspect;
}) {
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState<CollectionRequirementFilter>({kind:'all',keyword:'',wording:'all'});
  const [page,setPage]=useState(1);
  const [pageText,setPageText]=useState('');
  const [error,setError]=useState(false);
  const result=useMemo(()=>open&&selected.length?collectionRequirements(documents,selected,filter):null,
    [open,documents,selected,filter]);
  const current=Math.min(page,Math.max(1,Math.ceil((result?.hits.length??0)/COLLECTION_REQUIREMENT_PAGE_SIZE)));
  const shown=collectionRequirementPage(result?.hits??[],current);
  function change(value:Partial<CollectionRequirementFilter>){setFilter(old=>({...old,...value}));setPage(1);}
  return <details className="chat-collection-inspection" aria-label="Collection requirement inspection"
    onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Inspect requirement wording across collection PDFs</summary>
    <p className="chat-note">Literal cue discovery is not legal interpretation. It does not establish applicant
      eligibility, rule completeness, changes, removal or official authority. Verify each statement in its source.</p>
    {open&&<>
      {!selected.length&&<p>Select at least one collection PDF.</p>}
      <div className="chat-collection-filter-grid">
        <label>Collection requirement cue
          <select value={filter.kind} onChange={event=>change({kind:event.target.value as CollectionRequirementFilter['kind']})}>
            <option value="all">All cues</option>
            {requirementKinds.map(kind=><option key={kind} value={kind}>{namesOfKinds[kind]}</option>)}
          </select>
        </label>
        <label>Collection requirement keyword
          <input value={filter.keyword} maxLength={REQUIREMENT_KEYWORD_LIMIT} onChange={event=>change({keyword:event.target.value})}/>
        </label>
        <label>Collection requirement physical page
          <input value={pageText} inputMode="numeric" maxLength={2} onChange={event=>{
            setPageText(event.target.value);
            try{change({page:collectionDatePageFilter(event.target.value)});setError(false);}catch{setError(true);}
          }}/>
        </label>
        <label>Collection requirement wording
          <select value={filter.wording} onChange={event=>change({wording:event.target.value as CollectionRequirementFilter['wording']})}>
            <option value="all">All indexed candidates</option><option value="shared">Exact wording in another selected PDF</option>
            <option value="unshared">No exact counterpart indexed</option>
          </select>
        </label>
      </div>
      {error&&<p role="alert" className="chat-error">Enter a physical page from 1 to 80. The prior valid filter remains active.</p>}
      {result&&<>
        <div className="chat-collection-budget">
          {requirementKinds.map(kind=><div key={kind}><strong>{result.counts[kind]}</strong><span>{namesOfKinds[kind]}</span></div>)}
        </div>
        <p className="chat-muted">A fragment can contain several cues. Totals may overlap. Exact wording does not establish equivalent applicability.</p>
        {result.sides.map(side=><p key={side.documentId} className="chat-muted">{names.get(side.documentId)}:
          {' '}{side.displayedHits} displayed of {side.results.hits.length} cue-filtered fragments;
          {' '}{side.sharedHits} have exact counterparts. {side.results.scopedFragments} native fragments in scope.</p>)}
        <p role="status">{result.hits.length} collection requirement fragment(s) match.</p>
        {shown.rows.map(hit=><Candidate key={hit.documentId+':'+hit.source.page+':'+hit.source.ordinal}
          documents={documents} result={result} hit={hit} names={names} onInspect={onInspect}/>)}
        {!result.hits.length&&<p>No matching indexed cue. Inspect the PDF directly for unrecognized wording.</p>}
        {shown.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={current===1} onClick={()=>setPage(current-1)}>Previous collection requirements</button>
          <span>{shown.first}–{shown.last} of {result.hits.length} · page {current} of {shown.pages}</span>
          <button type="button" className="chat-button" disabled={current===shown.pages} onClick={()=>setPage(current+1)}>Next collection requirements</button>
        </div>}
      </>}
    </>}
  </details>;
}
