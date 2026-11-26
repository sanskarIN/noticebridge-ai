import { useState } from 'react';
import type { Answer, Passage, Role, SearchIndex } from './pdfChatCore';
import { canSearchCrossPage, crossPageLeads, type CrossPageResult } from './pdfChatCrossPage';

const names: Record<Role, string> = {
  original: 'Original / first PDF', revised: 'Updated / second PDF',
};

export default function PdfChatCrossPage({ index, answer, onInspect }: {
  index: SearchIndex; answer: Answer; onInspect: (source: Passage) => void;
}) {
  const [results, setResults] = useState<CrossPageResult[] | null>(null);
  if (!canSearchCrossPage(index, answer)) return null;
  return <section className="chat-context-results" aria-label="Cross-page evidence exploration">
    <h4>Explore separate pages</h4>
    <p className="chat-muted">Look for query words in two separate passages of the same PDF.
      This optional search does not change the answer above or establish a connection between pages.</p>
    {results === null ? <button className="chat-button" type="button"
      onClick={() => setResults(crossPageLeads(index, answer))}>Search across pages</button>
      : <>
        <p className="chat-note">These are lexical review leads only, not verified answers.
          Separate pages may describe unrelated applicants, conditions or events.
          Inspect the source before interpreting either passage.</p>
        {!results.some(result => result.leads.length) && <p>No qualifying two-passage lead was selected
          within the search limits. This does not establish that evidence is absent.</p>}
        {results.map(result => <div key={result.role} className="chat-direct-side">
          <h4>{names[result.role]}</h4>
          {result.leads.map(lead => <div className="chat-citation"
            key={lead.source.page + ':' + lead.source.ordinal}>
            <p className="chat-muted">Physical page {lead.source.page} · fragment {lead.source.ordinal}</p>
            <p>“{lead.source.text}”</p>
            <p className="chat-muted">Matched query terms: {lead.matchedTerms.join(', ')}</p>
            <button className="chat-button" type="button" onClick={() => onInspect(lead.source)}>
              Inspect cross-page lead on page {lead.source.page}
            </button>
          </div>)}
          {result.limited && <p className="chat-note">Candidate limit reached. Other passages may
            have been omitted from this exploratory search.</p>}
        </div>)}
        <button className="chat-button" type="button" onClick={() => setResults(null)}>Hide cross-page leads</button>
      </>}
  </section>;
}
