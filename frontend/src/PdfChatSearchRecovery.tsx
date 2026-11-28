import { useState } from 'react';
import type { Answer, Passage, Role, SearchIndex } from './pdfChatCore';
import { analyzeSearchRecovery, recoveryPage, type RoleRecovery, type SearchRecovery } from './pdfChatSearchRecovery';

const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
const explanations: Record<RoleRecovery['state'], string> = {
  no_indexed_text: 'No native fragments are indexed in this search scope.',
  no_search_terms: 'No searchable terms remain after query normalization.',
  query_budget: 'This question exceeds the lexical term budget. Ask one more specific question.',
  full_match_available: 'At least one full lexical match or recognized printed field exists. That is not proof of an answer.',
  missing_terms: 'Some normalized search terms do not occur in the selected indexed text.',
  terms_separated: 'All terms occur somewhere, but no individual fragment matches all of them.',
  no_term_overlap: 'None of the normalized search terms occur in the selected indexed text.',
};
function RecoverySide({ side, onInspect, onDraft, draftDisabled }: {
  side: RoleRecovery; onInspect: (source: Passage) => void;
  onDraft: (question: string) => void; draftDisabled: boolean;
}) {
  const [page, setPage] = useState(1);
  const [minimum, setMinimum] = useState(1);
  const filtered = side.leads.filter(lead => lead.matchedTerms.length >= minimum);
  const shown = recoveryPage(filtered, page);
  return <section className="chat-recovery-side" aria-label={'Search diagnostics ' + side.role}>
    <h5>{names[side.role]}</h5>
    <p>{explanations[side.state]}</p>
    <p className="chat-muted">{side.indexedFragments} indexed fragments across {side.indexedPages} physical page(s) in this search.</p>
    {!!side.coverage.length && <>
      <div className="chat-recovery-table">
        <table>
          <caption>Normalized term coverage (not literal text offsets)</caption>
          <thead><tr><th scope="col">Term</th><th scope="col">Fragments</th><th scope="col">Pages</th></tr></thead>
          <tbody>{side.coverage.map(term => <tr key={term.term}>
            <th scope="row">{term.term}</th>
            <td>{term.fragments || '0 — not found'}</td><td>{term.pages}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="chat-muted">{side.fullLexicalFragments} full lexical fragments · {side.recognizedFieldFragments}
        {' '}recognized field fragments (counts may overlap).</p>
    </>}
    {side.suggestions.length > 0 && <section className="chat-context-results" aria-label={'Possible spelling matches ' + side.role}>
      <h5>Possible spelling matches in the normalized vocabulary</h5>
      <p className="chat-note">These normalized terms differ by one spelling edit. Similar spelling does not establish equivalent
        meaning, particularly for names or categories. Check the wording and explicitly choose whether to use it.</p>
      {side.suggestions.map(suggestion => <div className="chat-recovery-suggestion" key={suggestion.term + ':' + suggestion.candidate}>
        <p><strong>{suggestion.term} → {suggestion.candidate}</strong> · {suggestion.fragments} indexed fragment(s)</p>
        <p className="chat-muted">{suggestion.question}</p>
        <button type="button" className="chat-button" disabled={draftDisabled} onClick={() => onDraft(suggestion.question)}>
          Draft alternative: {suggestion.candidate}
        </button>
      </div>)}
      {draftDisabled && <p className="chat-muted">Finish or clear your existing draft before copying an alternative.</p>}
    </section>}
    {side.spellingLimited && <p className="chat-note">Spelling comparison skipped because the scoped vocabulary exceeded its processing budget.</p>}
    {side.partialFragments > 0 && <section className="chat-context-results" aria-label={'Partial evidence leads ' + side.role}>
      <h5>Partial lexical matches — inspection only</h5>
      <p className="chat-note">These fragments omit one or more search terms. They may refer to different conditions.
        They are not added to the answer or its citations.</p>
      <p className="chat-muted">{side.partialFragments} partial fragments across {side.partialPages} physical pages.
        {side.leadsTruncated && <> Only the first {side.leads.length} ranked leads are available; narrow the question to inspect others.</>}</p>
      <label className="chat-overview-filter">Minimum matched terms for {side.role} leads
        <select value={minimum} onChange={event => { setMinimum(Number(event.target.value)); setPage(1); }}>
          {Array.from({ length: Math.max(1, side.coverage.length - 1) }, (_, i) => i + 1)
            .map(count => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>
      <p className="chat-muted">{filtered.length} visible candidates after filtering retained leads.</p>
      {shown.leads.map(lead => <article className="chat-citation" key={lead.source.page + ':' + lead.source.ordinal}>
        <p className="chat-muted">Physical page {lead.source.page} · fragment {lead.source.ordinal}</p>
        <p><strong>Matches:</strong> {lead.matchedTerms.join(', ')}</p>
        <p><strong>Missing:</strong> {lead.missingTerms.join(', ')}</p>
        <p className="chat-recovery-quote">{lead.source.text}</p>
        <button type="button" className="chat-button" onClick={() => onInspect(lead.source)}>
          Inspect partial lead {side.role}:{lead.source.page}:{lead.source.ordinal}
        </button>
      </article>)}
      {!shown.leads.length && <p>No retained partial leads match this filter.</p>}
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={shown.page === 1}
          onClick={() => setPage(shown.page - 1)}>Previous {side.role} partial leads</button>
        <span>Page {shown.page} of {shown.pages}</span>
        <button type="button" className="chat-button" disabled={shown.page === shown.pages}
          onClick={() => setPage(shown.page + 1)}>Next {side.role} partial leads</button>
      </div>
    </section>}
  </section>;
}
export default function PdfChatSearchRecovery({ index, answer, onInspect, onDraft, draftDisabled }: {
  index: SearchIndex; answer: Answer; onInspect: (source: Passage) => void;
  onDraft: (question: string) => void; draftDisabled: boolean;
}) {
  const [result, setResult] = useState<SearchRecovery | null>(null);
  const [error, setError] = useState(false);
  function open() {
    if (result) return;
    try { setResult(analyzeSearchRecovery(index, answer)); setError(false); }
    catch { setError(true); }
  }
  return <details className="chat-context-results chat-recovery" onToggle={event => {
    if (event.currentTarget.open) open();
  }}>
    <summary>{answer.missingRoles.length ? 'Troubleshoot missing matching evidence' : 'Inspect search term coverage'}</summary>
    <p>Explore how the local lexical search interpreted this question, without changing its original answer.
      Search stays within {answer.scope === 'both' ? 'both selected PDFs' : names[answer.scope]}
      {answer.pageFilter === undefined ? '.' : ' on physical page ' + answer.pageFilter + ' only.'}</p>
    {error && <p role="alert" className="chat-error">Search diagnostics unavailable for this question.</p>}
    {result && <>
      <p className="chat-muted">Normalized search terms: {result.terms.join(', ') || 'none'}.</p>
      {result.normalizedField && <p className="chat-muted">Recognized printed-field alias matching is also enabled for this query.</p>}
      {result.sides.map(side => <RecoverySide key={side.role} side={side} onInspect={onInspect}
        onDraft={onDraft} draftDisabled={draftDisabled} />)}
      <p className="chat-muted">Counts apply only to native indexed text, not the entire PDF. This panel does not certify absence or interpret notice requirements.</p>
    </>}
  </details>;
}
