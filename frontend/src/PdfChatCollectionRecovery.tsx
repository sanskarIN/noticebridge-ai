import { useMemo, useState } from 'react';
import type { Passage } from './pdfChatCore';
import type { CollectionDocument, CollectionPart, CollectionStep } from './pdfChatCollection';
import { collectionRecovery, collectionRecoveryDraft, collectionRecoveryLead } from './pdfChatCollectionRecovery';
import { recoveryPage, type RoleRecovery } from './pdfChatSearchRecovery';

const explanations: Record<RoleRecovery['state'], string> = {
  no_indexed_text: 'No indexed native fragments in this physical scope.',
  no_search_terms: 'No searchable terms remained after normalization.',
  query_budget: 'The normalized query exceeds the diagnostic term budget.',
  full_match_available: 'Full lexical matches or recognized field labels are indexed.',
  missing_terms: 'One or more normalized search terms are not indexed in this scope.',
  terms_separated: 'Terms occur separately, with no individual full lexical match.',
  no_term_overlap: 'None of the normalized search terms occur in this scope.',
};
export default function PdfChatCollectionRecovery({ documents, documentId, part, includeContext, onInspect, onDraft, draftDisabled }: {
  documents: readonly CollectionDocument[];
  documentId: string;
  part: CollectionPart;
  includeContext: boolean;
  onInspect: (id: string, source: Passage, target: HTMLElement) => void;
  onDraft: (step: CollectionStep) => void;
  draftDisabled: boolean;
}) {
  const [open,setOpen]=useState(false);
  const [minimum,setMinimum]=useState(1);
  const [page,setPage]=useState(1);
  const result=useMemo(()=>{
    if(!open)return null;
    try{return collectionRecovery(documents,documentId,part);}catch{return null;}
  },[open,documents,documentId,part]);
  const side=result?.recovery.sides[0];
  const filtered=side?.leads.filter(lead=>lead.matchedTerms.length>=minimum)??[];
  const shown=recoveryPage(filtered,page);
  return <details className="chat-collection-inspection" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Diagnose collection search coverage</summary>
    <p className="chat-note">Partial matches and spelling candidates are inspection aids only. The original
      answer, citations, selected PDF and physical page scope are not changed.</p>
    {open&&!result&&<p role="alert" className="chat-error">Unable to compute scoped search diagnostics.</p>}
    {side&&result&&<>
      <p>{explanations[side.state]}</p>
      <p className="chat-muted">{side.indexedFragments} indexed fragments in {side.indexedPages} physical page(s).
        {' '}{side.fullLexicalFragments} full lexical match(es), {side.recognizedFieldFragments} recognized field fragment(s).
        Counts may overlap.</p>
      {side.coverage.length>0&&<div className="chat-recovery-table"><table>
        <caption>Normalized term coverage in this PDF</caption>
        <thead><tr><th scope="col">Term</th><th scope="col">Fragments</th><th scope="col">Pages</th></tr></thead>
        <tbody>{side.coverage.map(term=><tr key={term.term}>
          <th scope="row">{term.term}</th><td>{term.fragments}</td><td>{term.pages}</td>
        </tr>)}</tbody>
      </table></div>}
      {side.suggestions.length>0&&<section aria-label="Collection spelling alternatives">
        <h5>Possible spelling alternatives</h5>
        <p className="chat-muted">Similar spelling does not establish equivalent meaning. Copying a draft selects
          only this PDF; inspect the wording before submitting.</p>
        {side.suggestions.map(suggestion=><div key={suggestion.term+':'+suggestion.candidate}>
          <p>{suggestion.term} → {suggestion.candidate} · {suggestion.fragments} indexed fragment(s)</p>
          <p>{suggestion.question}</p>
          <button type="button" className="chat-button" disabled={draftDisabled}
            onClick={()=>onDraft(collectionRecoveryDraft(documents,result,suggestion,includeContext))}>
            Draft collection alternative: {suggestion.candidate}</button>
        </div>)}
        {draftDisabled&&<p className="chat-muted">Clear the current question draft before copying an alternative.</p>}
      </section>}
      {side.spellingLimited&&<p className="chat-note">Spelling analysis exceeded the bounded vocabulary budget.</p>}
      {side.partialFragments>0&&<section aria-label="Collection partial lexical leads">
        <h5>Partial matches — inspect only</h5>
        <p>{side.partialFragments} partial fragment(s) in {side.partialPages} physical page(s).
          {side.leadsTruncated&&' Only the bounded ranked sample is available.'}</p>
        <label>Minimum matched collection terms
          <select value={minimum} onChange={event=>{setMinimum(Number(event.target.value));setPage(1);}}>
            {Array.from({length:Math.max(1,side.coverage.length-1)},(_,i)=>i+1).map(count=>
              <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        {shown.leads.map(lead=><article className="chat-citation" key={lead.source.page+':'+lead.source.ordinal}>
          <p className="chat-muted">Physical page {lead.source.page} · fragment {lead.source.ordinal}</p>
          <p>Matches: {lead.matchedTerms.join(', ')} · Missing: {lead.missingTerms.join(', ')}</p>
          <p>{lead.source.text}</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(documentId,
            collectionRecoveryLead(documents,result,lead),event.currentTarget)}>
            Inspect collection partial lead page {lead.source.page}, fragment {lead.source.ordinal}</button>
        </article>)}
        {!filtered.length&&<p>No retained partial lead matches the filter.</p>}
        {shown.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={shown.page===1} onClick={()=>setPage(shown.page-1)}>Previous collection partial leads</button>
          <span>Page {shown.page} of {shown.pages}</span>
          <button type="button" className="chat-button" disabled={shown.page===shown.pages} onClick={()=>setPage(shown.page+1)}>Next collection partial leads</button>
        </div>}
      </section>}
      <p className="chat-muted">Diagnostics describe native extraction only. They do not establish absence from the PDF or answer accuracy.</p>
    </>}
  </details>;
}
