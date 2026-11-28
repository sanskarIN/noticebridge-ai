import { useMemo, useState, type FormEvent } from 'react';
import { explorerPage, highlightedSegments, MAX_LITERAL_CHARS, type ExplorerHit } from './pdfChatEvidenceExplorer';
import { collectionFieldMatrix, collectionFieldPage, collectionQuestionEvidence,
  filterCollectionFields, parseCollectionEvidencePage, searchCollectionEvidence,
  type CollectionCoverage, type CollectionField, type CollectionEvidenceResult, type MatrixFilter } from './pdfChatCollectionTools';
import type { Answer, Passage } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';

type Inspect = (documentId: string, source: Passage, target: HTMLElement) => void;
type Props = { documents: readonly CollectionDocument[]; selected: string[]; names: Map<string, string>; onInspect: Inspect };
const statusText: Record<CollectionField['status'], string> = {
  one_document: 'Recognized field in the selected document',
  missing_in_selected_documents: 'No recognized field in one or more selected documents',
  same_literal_value: 'Same single literal value in all selected documents',
  different_literal_values: 'Different single literal values',
  multiple_values_within_document: 'Multiple distinct literal values in at least one document',
};
const pageStateText: Record<NonNullable<CollectionCoverage['pageState']>, string> = {
  not_present: 'Physical page does not exist.',
  not_indexed: 'Physical page was not indexed.',
  no_indexed_text: 'Physical page has no indexed native text.',
  limited: 'Physical page was only partially indexed.',
  some_text: 'Some native text was indexed on this physical page.',
};
function Coverage({ value }: { value: CollectionCoverage }) {
  return <p className="chat-muted">
    {value.pageState ? pageStateText[value.pageState] :
      value.processedPages + '/' + value.pageCount + ' physical pages processed.'}
    {' '}{value.limited || value.missingPages.length ? 'Some native coverage is incomplete.' : 'Complete transcription is not established.'}
  </p>;
}
function ResultList({ hits, documentId, onInspect }: { hits: ExplorerHit[]; documentId: string; onInspect: Inspect }) {
  const [page, setPage] = useState(1);
  const current = explorerPage(hits, page);
  return <div className="chat-collection-evidence-hits">
    <p role="status">{hits.length} indexed fragment match(es).</p>
    {!hits.length && <p className="chat-muted">No indexed match. This is not proof of absence from the PDF.</p>}
    {current.hits.map(hit => <div className="chat-citation" key={hit.source.page + ':' + hit.source.ordinal}>
      <p className="chat-muted">Physical page {hit.source.page} · fragment {hit.source.ordinal}</p>
      {hit.startsWithReference !== undefined && <p className="chat-muted">{hit.startsWithReference
        ? 'Fragment starts with reference.' : 'Reference appears within fragment.'} Not a verified clause definition.</p>}
      <p>{highlightedSegments(hit.source.text, hit.ranges).map(segment => segment.match
        ? <mark key={segment.start}>{segment.text}</mark> : <span key={segment.start}>{segment.text}</span>)}</p>
      <button type="button" className="chat-button" onClick={event => onInspect(documentId, hit.source, event.currentTarget)}>
        Inspect collection evidence page {hit.source.page}, fragment {hit.source.ordinal}</button>
    </div>)}
    {current.pages > 1 && <div className="chat-toolbar" aria-label="Collection evidence pagination">
      <button type="button" className="chat-button" disabled={page === 1}
        onClick={() => setPage(old => old - 1)}>Previous collection matches</button>
      <span>{current.first}–{current.last} of {hits.length} · page {page} of {current.pages}</span>
      <button type="button" className="chat-button" disabled={page === current.pages}
        onClick={() => setPage(old => old + 1)}>Next collection matches</button>
    </div>}
  </div>;
}

export function CollectionQuestionMatches({ documents, documentId, answer, onInspect }: {
  documents: readonly CollectionDocument[]; documentId: string; answer: Answer; onInspect: Inspect;
}) {
  const [hits, setHits] = useState<ExplorerHit[] | null>(null);
  const [error, setError] = useState(false);
  if (answer.matchedCounts.original <= 4) return null;
  return <div className="chat-collection-inspection">
    <p className="chat-note">The answer displays only a subset of strict matches. Inspect all indexed matches
      before deciding whether the displayed values are sufficient.</p>
    <button type="button" className="chat-button" onClick={() => {
      if (hits) { setHits(null); return; }
      try {
        setHits(collectionQuestionEvidence(documents, documentId, answer).hits);
        setError(false);
      } catch { setError(true); }
    }}>{hits ? 'Hide all collection question matches' : 'Show all collection question matches'}</button>
    {error && <p role="alert" className="chat-error">Unable to reconstruct the selected collection matches.</p>}
    {hits && <ResultList hits={hits} documentId={documentId} onInspect={onInspect} />}
  </div>;
}

export function CollectionFieldOverview({ documents, selected, names, onInspect, onAsk }: Props & {
  onAsk: (question: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<MatrixFilter>('all');
  const [needle, setNeedle] = useState('');
  const [page, setPage] = useState(1);
  const fields = useMemo(() => open && selected.length ? collectionFieldMatrix(documents, selected) : [],
    [open, documents, selected]);
  const visible = filterCollectionFields(fields, filter, needle);
  const current = collectionFieldPage(visible, Math.min(page, Math.max(1, Math.ceil(visible.length / 6))));
  return <details className="chat-collection-inspection" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Compare recognized printed fields across selected collection PDFs</summary>
    <p className="chat-muted">This is a literal field inventory, not a verified summary, revision relationship,
      or decision about which document applies. Unrecognized fields and scanned text may be missed.</p>
    {open && <>
      {!selected.length ? <p className="chat-note">Select collection documents above.</p> : <>
        <div className="chat-collection-filter-grid">
          <label>Collection field filter
            <select value={filter} onChange={event => { setFilter(event.target.value as MatrixFilter); setPage(1); }}>
              <option value="all">All recognized fields</option><option value="review">Fields needing inspection</option>
            </select>
          </label>
          <label>Find collection field
            <input value={needle} maxLength={100} onChange={event => { setNeedle(event.target.value); setPage(1); }}
              placeholder="Fee, deadline, eligibility…" />
          </label>
        </div>
        <p role="status">{visible.length} of {fields.length} recognized field categories across {selected.length} selected PDF(s).</p>
        {!visible.length && <p>No recognized fields match this filter.</p>}
        {current.rows.map(field => <article className="chat-field-pair" key={field.definition.id}>
          <div className="chat-toolbar">
            <h4>{field.definition.label}</h4>
            <button type="button" className="chat-button" onClick={() => onAsk(field.definition.query)}>
              Ask collection about {field.definition.label.toLowerCase()}</button>
          </div>
          <p className={field.status === 'multiple_values_within_document' ? 'chat-note' : 'chat-muted'}>{statusText[field.status]}.</p>
          {field.missingDocuments > 0 && <p className="chat-muted">{field.missingDocuments} selected document(s)
            lack a recognized indexed field. That is not proof of absence.</p>}
          <div className="chat-collection-matrix">
            {field.sides.map(side => <section className="chat-overview-side" key={side.documentId}
              aria-label={'Printed field: ' + names.get(side.documentId)}>
              <h5>{names.get(side.documentId)}</h5>
              <Coverage value={side.coverage} />
              {!side.values.length && <p className="chat-muted">No recognized indexed value.</p>}
              {side.values.map(value => <div className="chat-overview-value" key={value.value}>
                <p><strong>{value.value}</strong></p>
                {value.citations.map(citation => <div key={citation.source.page + ':' + citation.source.ordinal}>
                  <p className="chat-muted">Printed label: {citation.label}</p>
                  <button type="button" className="chat-button" onClick={event =>
                    onInspect(side.documentId, citation.source, event.currentTarget)}>
                    Inspect collection field page {citation.source.page}</button>
                </div>)}
                {value.occurrences > value.citations.length &&
                  <p className="chat-muted">{value.occurrences - value.citations.length} additional fragments not displayed.</p>}
              </div>)}
              {side.distinctValues > side.values.length && <p className="chat-note">
                {side.distinctValues - side.values.length} additional distinct literal values not displayed.</p>}
            </section>)}
          </div>
        </article>)}
        {current.pages > 1 && <div className="chat-toolbar" aria-label="Collection field pagination">
          <button type="button" className="chat-button" disabled={current.page === 1}
            onClick={() => setPage(current.page - 1)}>Previous collection fields</button>
          <span>{current.first}–{current.last} of {visible.length} · page {current.page} of {current.pages}</span>
          <button type="button" className="chat-button" disabled={current.page === current.pages}
            onClick={() => setPage(current.page + 1)}>Next collection fields</button>
        </div>}
      </>}
    </>}
  </details>;
}

export function CollectionEvidenceExplorer({ documents, selected, names, onInspect }: Props) {
  const [mode, setMode] = useState<'literal' | 'reference'>('literal');
  const [text, setText] = useState('');
  const [page, setPage] = useState('');
  const [ignoreAsciiCase, setIgnoreAsciiCase] = useState(true);
  const [result, setResult] = useState<CollectionEvidenceResult | null>(null);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  function clear() { setResult(null); setError(''); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clear();
    try {
      const data = searchCollectionEvidence(documents, { mode, text, documentIds: selected,
        page: parseCollectionEvidencePage(page), ignoreAsciiCase });
      setResult(data);
      setEpoch(old => old + 1);
    } catch { setError('Enter a valid literal phrase or explicit reference, select documents, and use an optional physical page from 1 to 80.'); }
  }
  return <details className="chat-collection-inspection">
    <summary>Explore exact text and references across collection PDFs</summary>
    <p className="chat-muted">Search selected PDFs independently, without adding a chat turn.
      Highlights are offsets in native extracted text, not verified PDF-coordinate highlights.</p>
    <form className="chat-form" onSubmit={submit}>
      <div className="chat-collection-filter-grid">
        <label>Collection evidence mode
          <select value={mode} onChange={event => { setMode(event.target.value as typeof mode); clear(); }}>
            <option value="literal">Literal phrase</option><option value="reference">Explicit reference</option>
          </select>
        </label>
        <label>Collection evidence physical page (optional)
          <input value={page} inputMode="numeric" maxLength={2} onChange={event => { setPage(event.target.value); clear(); }} />
        </label>
      </div>
      <label>Collection evidence search text
        <input value={text} maxLength={MAX_LITERAL_CHARS} onChange={event => { setText(event.target.value); clear(); }}
          placeholder={mode === 'literal' ? 'Application fee' : 'Clause 4.2(a)'} />
      </label>
      {mode === 'literal' && <label className="chat-checkbox"><input type="checkbox" checked={ignoreAsciiCase}
        onChange={event => { setIgnoreAsciiCase(event.target.checked); clear(); }} /> Ignore ASCII case in collection evidence</label>}
      <button type="submit" className="chat-button" disabled={!selected.length || !text.trim()}>Search collection evidence</button>
    </form>
    {error && <p role="alert" className="chat-error">{error}</p>}
    {result && <div aria-label="Collection evidence search results">
      <p role="status">{result.total} total native fragment match(es) across {result.sides.length} selected PDF(s).</p>
      {result.sides.map(side => <section className="chat-answer" key={side.documentId + ':' + epoch}
        aria-label={'Collection evidence: ' + names.get(side.documentId)}>
        <h4>{names.get(side.documentId)}</h4>
        <Coverage value={side.coverage} />
        <ResultList hits={side.hits} documentId={side.documentId} onInspect={onInspect} />
      </section>)}
    </div>}
  </details>;
}
