import { useState } from 'react';
import type { Passage, SearchIndex } from './pdfChatCore';
import { highlightedSegments, type Reference } from './pdfChatEvidenceExplorer';
import { followSourceReference, referencePage, sourceReferences, type ReferenceReview } from './pdfChatReferenceReview';

export default function PdfChatReferenceReview({ source, index, onInspect }: {
  source: Passage; index: SearchIndex; onInspect: (source: Passage) => void;
}) {
  const [review, setReview] = useState<ReferenceReview | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  const inventory = sourceReferences(source);
  if (!inventory.references.length) return null;
  function search(reference: Reference) {
    try {
      setReview(followSourceReference(index, source, reference));
      setPage(1); setError(false);
    } catch { setReview(null); setError(true); }
  }
  const results = review ? referencePage(review, page) : null;
  return <section className="chat-context-results" aria-label="Follow printed source references">
    <h3>Follow references in this fragment</h3>
    <p className="chat-muted">Search explicit printed references anywhere in this same PDF.
      This manual inspection may go beyond the question's physical page filter.
      It does not widen or change the answer itself.</p>
    <div className="chat-toolbar">
      {inventory.references.map(item => <button type="button" className="chat-button"
        key={item.reference.kind + ':' + item.reference.identifier}
        onClick={() => search(item.reference)}>Find other mentions of {item.printed}</button>)}
    </div>
    {inventory.total > inventory.references.length && <p className="chat-note">
      {inventory.total - inventory.references.length} additional references are not shown.
      Use the indexed evidence explorer to inspect them.</p>}
    {error && <p className="chat-error" role="alert">Unable to inspect that printed reference.</p>}
    {review && results && <>
      <h4>Other occurrences of {review.reference.printed}</h4>
      <p role="status">{review.hits.length} other indexed fragments: {review.samePage} on this page,
        {' '}{review.otherPages} on other pages.</p>
      <p className="chat-note">{review.startsWithReference} fragments begin with this reference.
        They may be headings or mentions, not verified definitions. The reference may point to
        another document; this lookup cannot establish that it resolves within this PDF.</p>
      {!results.hits.length && <p>No other indexed occurrence. Check unindexed text and the full source.</p>}
      {results.hits.map(hit => <div className="chat-citation"
        key={hit.source.page + ':' + hit.source.ordinal}>
        <p className="chat-muted">Physical page {hit.source.page} · fragment {hit.source.ordinal}
          {' '}· {hit.startsWithReference ? 'Starts with reference' : 'Reference mention'}</p>
        <p>{highlightedSegments(hit.source.text, hit.ranges).map(segment => segment.match
          ? <mark key={segment.start}>{segment.text}</mark>
          : <span key={segment.start}>{segment.text}</span>)}</p>
        <button className="chat-button" type="button" onClick={() => onInspect(hit.source)}>
          Inspect reference on page {hit.source.page}, fragment {hit.source.ordinal}
        </button>
      </div>)}
      {results.pages > 1 && <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={page === 1}
          onClick={() => setPage(old => old - 1)}>Previous reference results</button>
        <p>{results.first}–{results.last} of {review.hits.length}</p>
        <button type="button" className="chat-button" disabled={page === results.pages}
          onClick={() => setPage(old => old + 1)}>Next reference results</button>
      </div>}
      <button type="button" className="chat-button" onClick={() => setReview(null)}>Hide reference results</button>
    </>}
  </section>;
}
