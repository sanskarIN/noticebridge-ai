import { lazy, Suspense, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { MAX_QUESTION, pageCoverage, type Passage } from './pdfChatCore';
import { readPdf } from './pdfChatExtract';
import { admitCollectionDocument, collectionCitation, collectionStats, runCollectionStep,
  MAX_COLLECTION_DOCUMENTS, MAX_COLLECTION_BYTES, MAX_COLLECTION_PASSAGES, MAX_COLLECTION_CHARS,
  MAX_COLLECTION_TURNS, CollectionError, type CollectionDocument, type CollectionPart, type CollectionTurn, type CollectionStep,
} from './pdfChatCollection';
import PdfChatCollectionExchange from './PdfChatCollectionExchange';
import PdfChatCollectionReviewQueue from './PdfChatCollectionReviewQueue';
import PdfChatCollectionReview from './PdfChatCollectionReview';
import PdfChatCollectionWorkspace from './PdfChatCollectionWorkspace';
import PdfChatCollectionHistory from './PdfChatCollectionHistory';
import PdfChatCollectionDates from './PdfChatCollectionDates';
import PdfChatCollectionFragments from './PdfChatCollectionFragments';
import PdfChatCollectionBatch from './PdfChatCollectionBatch';
import PdfChatCollectionRanking from './PdfChatCollectionRanking';
import PdfChatCollectionRecovery from './PdfChatCollectionRecovery';
import PdfChatCollectionRequirements from './PdfChatCollectionRequirements';
import PdfChatCollectionOutline from './PdfChatCollectionOutline';
import PdfChatCollectionReplay from './PdfChatCollectionReplay';
import PdfChatCollectionModels from './PdfChatCollectionModels';
import PdfChatCollectionEvaluation from './PdfChatCollectionEvaluation';
import PdfChatCollectionOcr from './PdfChatCollectionOcr';
import PdfChatCollectionPacket from './PdfChatCollectionPacket';
import { CollectionPageNavigator, CollectionTableExplorer, CollectionTableCandidates } from './PdfChatCollectionLayout';
import { resolveCollectionPage } from './pdfChatCollectionLayout';
import { collectionReviewKey, MAX_COLLECTION_REVIEW_ITEMS, pinCollectionEvidence, removeDocumentReviews, type CollectionReviewEntry } from './pdfChatCollectionReview';
import { CollectionEvidenceExplorer, CollectionFieldOverview, CollectionQuestionMatches } from './PdfChatCollectionTools';

import PdfChatCollectionOverlap from './PdfChatCollectionOverlap';
import PdfChatCollectionTableComparison from './PdfChatCollectionTableComparison';
import PdfChatCollectionAnswerSummary from './PdfChatCollectionAnswerSummary';
import PdfChatCollectionNavigation, { focusCollectionDestination } from './PdfChatCollectionNavigation';
import { collectionToolAnchor, type CollectionToolId } from './pdfChatCollectionNavigation';

const PdfEvidencePreview = lazy(() => import('./PdfEvidencePreview'));
type Preview = { documentId: string; page: number; source?: Passage };
type BatchFeedback = { accepted: number; errors: string[]; cancelled: boolean };
const MiB = 1024 * 1024;
const formatBytes = (bytes: number) => (bytes / MiB).toFixed(2) + ' MiB';
function displayName(doc: CollectionDocument, index: number): string {
  return 'Document ' + (index + 1) + ': ' + doc.file.name;
}
function errorText(error: unknown): string {
  return error instanceof CollectionError ? error.message : 'Unable to process this local PDF.';
}
const coverageText: Record<CollectionPart['coverage'], string> = {
  some_text: 'Some native text was indexed; completeness is not established.',
  partial: 'Native extraction is incomplete. Inspect the source directly.',
  no_indexed_text: 'No searchable native text was indexed here. Scanned or image-only material may be present.',
  not_present: 'This physical page does not exist in the PDF.',
  not_indexed: 'This physical page was not indexed within the local limits.',
};

function CollectionAnswer({ part, documents, documentId, onInspect, includeContext, onDraft, draftDisabled }: {
  part: CollectionPart; documents: readonly CollectionDocument[]; documentId: string;
  includeContext: boolean; onDraft: (step: CollectionStep) => void; draftDisabled: boolean;
  onInspect: (documentId: string, source: Passage, target: HTMLElement) => void;
}) {
  const { answer } = part;
  return <div className="chat-collection-part">
    <h5>{answer.question}</h5>
    {answer.pageFilter !== undefined && <p className="chat-muted">Physical page {answer.pageFilter} only.</p>}
    <p className={part.coverage === 'some_text' ? 'chat-muted' : 'chat-note'}>{coverageText[part.coverage]}</p>
    {answer.kind === 'insufficient' ? <p>No matching indexed evidence. This is not proof that the document lacks the information.</p> : <>
      <p className="chat-muted">{answer.matchedCounts.original} unique strict match(es);
        {' '}{answer.citations.length} displayed source fragment(s).</p>
      {answer.contextGroups.length > 0 && <p className="chat-note">Nearby-line leads are shown as separate
        quotations. They do not establish a combined statement.</p>}
      {answer.printedFields.length > 0 && <div className="chat-printed-fields">
        <h5>Literal printed fields in displayed matches</h5>
        {answer.printedFields.map(field => <p key={field.citation}>{field.label}: {field.value} [{field.citation}]</p>)}
      </div>}
      {answer.citations.map((source, index) => <div className="chat-citation" key={source.page + ':' + source.ordinal}>
        <p className="chat-muted">[{index + 1}] Physical page {source.page} · fragment {source.ordinal}</p>
        <blockquote>{source.text}</blockquote>
        <button type="button" className="chat-button"
          onClick={event => onInspect(documentId, source, event.currentTarget)}>Inspect collection source [{index + 1}]</button>
      </div>)}
      <CollectionQuestionMatches documents={documents} documentId={documentId} answer={answer} onInspect={onInspect} />
    </>}
    <PdfChatCollectionRanking documents={documents} documentId={documentId} part={part}
      includeContext={includeContext} onInspect={onInspect} />
    <CollectionTableCandidates documents={documents} documentId={documentId} answer={answer} onInspect={onInspect} />
    <PdfChatCollectionRecovery documents={documents} documentId={documentId} part={part} includeContext={includeContext}
      onInspect={onInspect} onDraft={onDraft} draftDisabled={draftDisabled} />
  </div>;
}

export default function PdfChatCollection() {
  const [documents, setDocuments] = useState<CollectionDocument[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [turns, setTurns] = useState<CollectionTurn[]>([]);
  const [reviews, setReviews] = useState<CollectionReviewEntry[]>([]);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [question, setQuestion] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const [loading, setLoading] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [batch, setBatch] = useState<BatchFeedback | null>(null);
  const [error, setError] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showNativeLocation, setShowNativeLocation] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const workspaceRoot = useRef<HTMLElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => () => {
    generation.current++;
    controller.current?.abort();
  }, []);
  useEffect(() => {
    setShowNativeLocation(false);
    if (preview) previewHeading.current?.focus();
  }, [preview]);

  const stats = collectionStats(documents);
  const busy = loading !== null;
  const currentTurn = activeTurn === null ? null : turns[activeTurn] ?? null;
  const previewDoc = preview ? documents.find(doc => doc.id === preview.documentId) : undefined;
  const canAsk = !busy && selected.length > 0 && !!question.trim() && turns.length < MAX_COLLECTION_TURNS;
  const names = new Map(documents.map((doc, index) => [doc.id, displayName(doc, index)]));

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!files.length || busy || controller.current) return;
    if (files.length > MAX_COLLECTION_DOCUMENTS) {
      setError('Select no more than six PDFs in one batch.');
      return;
    }
    const token = ++generation.current;
    const operation = new AbortController();
    controller.current = operation;
    setLoading('Preparing selected PDFs…');
    setCancelling(false);
    setBatch(null);
    setError('');
    setRemoveId(null);
    setConfirmClear(false);
    setPreview(null);
    let next = [...documents];
    let nextSelected = [...selected];
    let accepted = 0;
    const errors: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        operation.signal.throwIfAborted();
        if (token !== generation.current) return;
        setLoading('Indexing collection PDF ' + (i + 1) + ' of ' + files.length + '…');
        try {
          const doc = await admitCollectionDocument(next, files[i], operation.signal, readPdf);
          operation.signal.throwIfAborted();
          if (token !== generation.current) return;
          next = [...next, doc];
          nextSelected = [...nextSelected, doc.id];
          accepted++;
          setDocuments(next);
          setSelected(nextSelected);
        } catch (cause) {
          if (operation.signal.aborted) break;
          errors.push(files[i].name.slice(0, 180) + ': ' + errorText(cause));
        }
      }
    } catch (cause) {
      if (!operation.signal.aborted) errors.push(errorText(cause));
    } finally {
      if (token === generation.current) {
        controller.current = null;
        setLoading(null);
        setCancelling(false);
        setBatch({ accepted, errors, cancelled: operation.signal.aborted });
      }
    }
  }

  function clearHistory() {
    setTurns([]);
    setActiveTurn(null);
    setPreview(null);
    setError('');
  }
  function removeDocument(id: string) {
    if (busy) return;
    setDocuments(old => old.filter(doc => doc.id !== id));
    setReviews(old => removeDocumentReviews(old, id));
    setSelected(old => old.filter(key => key !== id));
    clearHistory();
    setRemoveId(null);
    setConfirmClear(false);
    setBatch(null);
  }
  function clearCollection() {
    if (busy) return;
    setDocuments([]);
    setReviews([]);
    setSelected([]);
    clearHistory();
    setQuestion('');
    setBatch(null);
    setRemoveId(null);
    setConfirmClear(false);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAsk) return;
    setError('');
    try {
      const step = { question: question.trim(),
        documentIds: documents.filter(doc => selected.includes(doc.id)).map(doc => doc.id), includeContext };
      const turn = runCollectionStep(documents, step);
      setTurns([...turns, turn]);
      setActiveTurn(turns.length);
      setQuestion('');
      setPreview(null);
    } catch (cause) { setError(errorText(cause)); }
  }
  function inspect(documentId: string, source: Passage, target: HTMLElement) {
    try {
      collectionCitation(documents, documentId, source);
      returnFocus.current = target;
      setPreview({ documentId, page: source.page, source });
    } catch (cause) { setError(errorText(cause)); }
  }
  function inspectPage(documentId: string, page: number, target: HTMLElement) {
    try {
      const selectedPage = resolveCollectionPage(documents, documentId, String(page));
      returnFocus.current = target;
      setPreview({ documentId: selectedPage.documentId, page: selectedPage.page });
    } catch (cause) { setError(errorText(cause)); }
  }
  function closePreview() {
    setPreview(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }
  function repeatQuestion() {
    if (!currentTurn) return;
    setQuestion(currentTurn.step.question);
    setSelected([...currentTurn.step.documentIds]);
    setIncludeContext(currentTurn.step.includeContext);
    questionRef.current?.focus();
  }

  return <details className="chat-session chat-collection" id="chat-collection">
    <summary>Search an independent PDF collection (up to six documents)</summary>
    <section ref={workspaceRoot} aria-label="Independent PDF collection" className="chat-collection-body">
      <h3>Search across multiple PDFs</h3>
      <p>Attach unrelated notices or reference PDFs, choose which documents to search, and inspect each matching source.
        Results are grouped by document; no version order, amendment or official applicability is inferred.</p>
      <p className="chat-note">This is a separate browser-local workspace. It does not upload files, automatically invoke AI
        models, or change your original/revised PDF conversation. Identical PDF bytes are deduplicated.</p>
      <PdfChatCollectionNavigation state={{documents:documents.length,selected:selected.length,turns:turns.length,
        preview:!!preview,busy}} onNavigate={id=>!!workspaceRoot.current&&focusCollectionDestination(workspaceRoot.current,id)} />
      <div className="chat-collection-budget" aria-label="Collection processing budget">
        <div><strong>{stats.documents} / {MAX_COLLECTION_DOCUMENTS}</strong><span>PDF documents</span></div>
        <div><strong>{formatBytes(stats.bytes)} / {formatBytes(MAX_COLLECTION_BYTES)}</strong><span>Local PDF bytes</span></div>
        <div><strong>{stats.passages} / {MAX_COLLECTION_PASSAGES}</strong><span>Native fragments</span></div>
        <div><strong>{stats.chars} / {MAX_COLLECTION_CHARS}</strong><span>Retained text units</span></div>
      </div>
      <div className="chat-file chat-collection-upload" id={collectionToolAnchor('sources')} tabIndex={-1}>
        <label>Attach collection PDFs
          <input type="file" accept=".pdf,application/pdf" multiple
            disabled={busy || documents.length >= MAX_COLLECTION_DOCUMENTS || stats.bytes >= MAX_COLLECTION_BYTES}
            onChange={event => void attach(event)} />
        </label>
        <p className="chat-muted">10 MiB per PDF. Files are fingerprinted and extracted sequentially.
          An invalid file does not replace other accepted documents.</p>
        {loading && <div className="chat-toolbar">
          <p role="status">{cancelling ? 'Cancelling collection indexing…' : loading}</p>
          <button type="button" className="chat-button" disabled={cancelling} onClick={() => {
            setCancelling(true); controller.current?.abort();
          }}>Cancel collection indexing</button>
        </div>}
        {batch && <div aria-label="Collection attachment result">
          <p role="status">{batch.accepted} collection PDF(s) accepted.{batch.cancelled ? ' Indexing cancelled; accepted PDFs retained.' : ''}</p>
          {batch.errors.length > 0 && <div className="chat-error" role="alert">
            <p>{batch.errors.length} file(s) were not admitted:</p>
            <ul>{batch.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>
          </div>}
        </div>}
      </div>
      {documents.length > 0 && <>
        <div className="chat-toolbar">
          <h4>Choose documents for the next question</h4>
          <div className="chat-collection-actions">
            <button type="button" className="chat-button" disabled={busy || selected.length === documents.length}
              onClick={() => setSelected(documents.map(doc => doc.id))}>Select all collection PDFs</button>
            <button type="button" className="chat-button" disabled={busy || !selected.length}
              onClick={() => setSelected([])}>Deselect all collection PDFs</button>
          </div>
        </div>
        <div className="chat-collection-documents">
          {documents.map((doc, index) => <section key={doc.id} className="chat-file" aria-label={displayName(doc, index)}>
            <div className="chat-toolbar">
              <label className="chat-checkbox">
                <input type="checkbox" disabled={busy} checked={selected.includes(doc.id)} onChange={event => {
                  const checked = event.target.checked;
                  setSelected(old => checked ? [...old, doc.id] : old.filter(id => id !== doc.id));
                }} /> Search document {index + 1}
              </label>
              <button type="button" className="chat-button" disabled={busy} onClick={() => {
                setConfirmClear(false);
                if (turns.length || reviews.some(entry => entry.documentId === doc.id)) setRemoveId(doc.id);
                else removeDocument(doc.id);
              }}>Remove document {index + 1}</button>
            </div>
            <h5 className="chat-filename">{doc.file.name}</h5>
            <p className="chat-muted">{formatBytes(doc.file.size)} · {doc.corpus.processedPages} of {doc.corpus.pageCount}
              {' '}physical pages indexed · {doc.corpus.passages.length} native fragments</p>
            <details className="chat-collection-fingerprint"><summary>Source SHA-256</summary><code>{doc.id}</code></details>
            {(doc.corpus.limited || doc.corpus.missingPages.length > 0) &&
              <p className="chat-note">Some pages or fragments may be missing from native search.</p>}
            {removeId === doc.id && <div className="chat-note" aria-label="Remove collection document confirmation">
              <p>Removing this PDF clears collection questions, source inspection and any review notes saved for this PDF. Notes for other attached PDFs remain.</p>
              <div className="chat-toolbar">
                <button type="button" className="chat-button" onClick={() => removeDocument(doc.id)}>Confirm document removal</button>
                <button type="button" className="chat-button" onClick={() => setRemoveId(null)}>Keep document</button>
              </div>
            </div>}
          </section>)}
        </div>
        <div className="chat-toolbar">
          <span className="chat-muted">{selected.length} of {documents.length} collection documents selected.</span>
          <button type="button" className="chat-button" disabled={busy} onClick={() => {
            setRemoveId(null); setConfirmClear(true);
          }}>Clear collection</button>
        </div>
        {confirmClear && <div className="chat-note" aria-label="Clear collection confirmation">
          <p>Remove all collection PDFs, question turns, saved review notes and source inspection? The original/revised chat will not change.</p>
          <div className="chat-toolbar">
            <button type="button" className="chat-button" disabled={busy} onClick={clearCollection}>Confirm clear collection</button>
            <button type="button" className="chat-button" onClick={() => setConfirmClear(false)}>Keep collection</button>
          </div>
        </div>}
      </>}
      <form className="chat-form" onSubmit={submit} id={collectionToolAnchor('question')} tabIndex={-1}>
        <label>Collection question
          <textarea aria-label="Collection question" ref={questionRef} value={question} maxLength={MAX_QUESTION}
            rows={3} placeholder="What is the application fee?" onChange={event => setQuestion(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                if (canAsk) event.currentTarget.form?.requestSubmit();
              }
            }} />
        </label>
        <p className="chat-muted">Ask up to four explicit question parts. Use “on page 2” to limit all selected PDFs
          to the same physical page number. Choose documents above instead of using original/revised routing phrases.</p>
        <label className="chat-checkbox"><input type="checkbox" checked={includeContext}
          onChange={event => setIncludeContext(event.target.checked)} /> Search nearby lines in each collection document</label>
        <div className="chat-toolbar">
          <span className="chat-muted">{question.length}/{MAX_QUESTION} · {turns.length}/{MAX_COLLECTION_TURNS} turns</span>
          <button type="submit" className="primary-button" disabled={!canAsk}>Ask collection</button>
        </div>
        {turns.length >= MAX_COLLECTION_TURNS && <p className="chat-note">Collection conversation limit reached. Export
          or clear the questions before continuing.</p>}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </form>
      {documents.length > 0 && !busy && <div id={collectionToolAnchor('batch' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionBatch key={'batch:' + documents.map(doc => doc.id).join(':')}
        documents={documents} selected={selected} turns={turns} names={names} onInspect={inspect}
        onApply={next => { setTurns(next); setActiveTurn(next.length - 1); setPreview(null); setError(''); }} /></div>}
      {turns.length > 0 && <section className="chat-collection-history" aria-label="Collection conversation" id={collectionToolAnchor('history')} tabIndex={-1}>
        <div className="chat-toolbar">
          <h4>Collection question history</h4>
          <button type="button" className="chat-button" disabled={busy} onClick={clearHistory}>Clear collection questions</button>
        </div>
        <label className="chat-collection-history-select">View collection question
          <select value={activeTurn ?? turns.length - 1} onChange={event => {
            setActiveTurn(Number(event.target.value)); setPreview(null);
          }}>
            {turns.map((turn, index) => <option key={index} value={index}>{index + 1}. {turn.step.question}</option>)}
          </select>
        </label>
        {currentTurn && <>
          <div className="chat-user"><strong>Question {activeTurn! + 1}</strong>{currentTurn.step.question}</div>
          <div className="chat-toolbar">
            <p className="chat-muted">{currentTurn.results.length} document result(s). Results are not a global ranking.</p>
            <button type="button" className="chat-button" disabled={busy} onClick={repeatQuestion}>Copy this collection question</button>
          </div>
          <PdfChatCollectionHistory key={activeTurn + ':' + turns.length + ':' + currentTurn.step.question + ':' +
            currentTurn.step.documentIds.join(',')} documents={documents} names={names} turns={turns} at={activeTurn!}
            disabled={busy} onDraft={step => {
              setQuestion(step.question); setSelected(step.documentIds); setIncludeContext(step.includeContext);
              questionRef.current?.focus();
            }} onChange={(next, active) => {
              setTurns(next); setActiveTurn(active); setPreview(null); setError('');
            }} />
          <div id={collectionToolAnchor('models' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionModels key={'models:' + activeTurn + ':' + turns.length + ':' + currentTurn.step.question + ':' + currentTurn.step.documentIds.join(',') + ':' + currentTurn.step.includeContext}
            documents={documents} turn={currentTurn} names={names} onInspect={inspect} /></div>
          <PdfChatCollectionAnswerSummary key={'summary:' + activeTurn + ':' + turns.length + ':' + currentTurn.step.question + ':' +
            currentTurn.step.documentIds.join(',') + ':' + currentTurn.step.includeContext}
            documents={documents} turn={currentTurn} names={names} onInspect={inspect} />
          <div className="chat-collection-results" aria-label="Collection results" id={collectionToolAnchor('results')} tabIndex={-1} key={activeTurn + ':' + turns.length + ':' +
            currentTurn.step.question + ':' + currentTurn.step.documentIds.join(',') + ':' + currentTurn.step.includeContext}>
            {currentTurn.results.map(result => <section key={result.documentId} className="chat-answer"
              aria-label={'Collection result: ' + names.get(result.documentId)}>
              <h4>{names.get(result.documentId)}</h4>
              {result.parts.map((part, index) => <CollectionAnswer key={index} part={part} documents={documents} documentId={result.documentId}
                onInspect={inspect} includeContext={currentTurn.step.includeContext} draftDisabled={busy || !!question.trim()}
                onDraft={step => { setQuestion(step.question); setSelected(step.documentIds); setIncludeContext(step.includeContext); questionRef.current?.focus(); }} />)}
            </section>)}
          </div>
        </>}
      </section>}
      {documents.length > 0 && !busy && <div className="chat-collection-tools"
        key={'tools:' + documents.map(doc => doc.id).join(':') + '/' + selected.join(':')}>
        <div id={collectionToolAnchor('fields' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><CollectionFieldOverview documents={documents} selected={selected} names={names} onInspect={inspect}
          onAsk={value => { setQuestion(value); questionRef.current?.focus(); }} /></div>
        <div id={collectionToolAnchor('literal' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><CollectionEvidenceExplorer documents={documents} selected={selected} names={names} onInspect={inspect} /></div>
        <div id={collectionToolAnchor('dates' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionDates documents={documents} selected={selected} names={names} onInspect={inspect} /></div>
        <div id={collectionToolAnchor('requirements' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionRequirements documents={documents} selected={selected} names={names} onInspect={inspect} /></div>
        <div id={collectionToolAnchor('outline' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionOutline documents={documents} selected={selected} names={names} onInspect={inspect} /></div>
        <div id={collectionToolAnchor('tables' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><CollectionTableExplorer documents={documents} selected={selected} names={names} onInspect={inspect}
          onAsk={(documentId, value) => { setSelected([documentId]); setQuestion(value); questionRef.current?.focus(); }} /></div>
        <div id={collectionToolAnchor('overlap')} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionOverlap documents={documents} selected={selected} names={names} onInspect={inspect}/></div>
        <div id={collectionToolAnchor('table-comparison')} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionTableComparison documents={documents} selected={selected} names={names} onInspect={inspect}/></div>
      </div>}
      {documents.length > 0 && !busy && <div id={collectionToolAnchor('pages' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><CollectionPageNavigator key={'coverage:' + documents.map(doc => doc.id).join(':')}
        documents={documents} names={names} onInspect={inspectPage} /></div>}
      {preview && previewDoc && <section className="chat-panel chat-collection-preview" aria-label="Collection source inspection" id={collectionToolAnchor('preview')} tabIndex={-1}>
        <div className="chat-toolbar">
          <h4 ref={previewHeading} tabIndex={-1}>{names.get(previewDoc.id)} · physical page {preview.page}</h4>
          <button type="button" className="chat-button" onClick={closePreview}>Close collection source</button>
        </div>
        {preview.source && <blockquote>{preview.source.text}</blockquote>}
        {preview.source && <button type="button" className="chat-button" disabled={busy ||
          reviews.length >= MAX_COLLECTION_REVIEW_ITEMS || reviews.some(entry =>
            collectionReviewKey(entry.documentId, entry.source) === collectionReviewKey(preview.documentId, preview.source!))}
          onClick={() => {
            if (!preview.source) return;
            try { setReviews(pinCollectionEvidence(documents, reviews, preview.documentId, preview.source)); }
            catch (cause) { setError(errorText(cause)); }
          }}>{reviews.some(entry => collectionReviewKey(entry.documentId, entry.source) ===
            collectionReviewKey(preview.documentId, preview.source!)) ? 'Saved in collection review' : 'Save collection evidence'}</button>}
        <p className="chat-muted">{coverageText[pageCoverage(previewDoc.corpus, preview.page) === 'limited'
          ? 'partial' : pageCoverage(previewDoc.corpus, preview.page) as Exclude<CollectionPart['coverage'], 'partial'>]}</p>
        <div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={preview.page <= 1}
            onClick={() => setPreview({ documentId: preview.documentId, page: preview.page - 1 })}>Previous collection page</button>
          <span>{preview.page} / {previewDoc.corpus.pageCount}</span>
          <button type="button" className="chat-button" disabled={preview.page >= previewDoc.corpus.pageCount}
            onClick={() => setPreview({ documentId: preview.documentId, page: preview.page + 1 })}>Next collection page</button>
        </div>
        <PdfChatCollectionFragments key={preview.documentId + ':' + preview.page + ':' + (preview.source?.ordinal ?? 'page')}
          documents={documents} documentId={preview.documentId} physicalPage={preview.page} selected={preview.source} onInspect={inspect} />
        <p className="chat-note">Manual source inspection. Native fragment positions do not establish verified highlight geometry.</p>
        {preview.source?.position && <label className="chat-checkbox">
          <input type="checkbox" checked={showNativeLocation} onChange={event=>setShowNativeLocation(event.target.checked)}/>
          Show independently reproduced candidate line location
        </label>}
        <Suspense fallback={<p role="status">Preparing collection PDF viewer…</p>}>
          <PdfEvidencePreview file={previewDoc.file} pageNumber={preview.page} inspectionOnly nativeSource={showNativeLocation ? preview.source : undefined} />
        </Suspense>
      </section>}
      {turns.length>0 && !busy && <div id={collectionToolAnchor('review-queue')} tabIndex={-1} className="chat-collection-destination">
        <PdfChatCollectionReviewQueue documents={documents} turns={turns} reviews={reviews} names={names}
          disabled={busy} draftDisabled={!!question.trim()} onInspect={inspect}
          onTurn={index=>{setActiveTurn(index);setPreview(null);workspaceRoot.current?.querySelector<HTMLElement>('#'+collectionToolAnchor('history'))?.focus();}}
          onDraft={step=>{setQuestion(step.question);setSelected(step.documentIds);setIncludeContext(step.includeContext);questionRef.current?.focus();}}/>
      </div>}
      {documents.length > 0 && !busy && <div id={collectionToolAnchor('review' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionReview key={'review:' + documents.map(doc => doc.id).join(':')}
        documents={documents} entries={reviews} names={names} onChange={setReviews} onInspect={inspect} /></div>}
      {documents.length > 0 && !busy && <div id={collectionToolAnchor('workspace' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionWorkspace key={'workspace:' + documents.map(doc => doc.id).join(':')}
        documents={documents} turns={turns} reviews={reviews} onApply={workspace => {
          setTurns(workspace.turns); setReviews(workspace.reviews);
          setActiveTurn(workspace.turns.length ? workspace.turns.length - 1 : null);
          setQuestion(''); setPreview(null); setError('');
        }} /></div>}
      {documents.length > 0 && !busy && <div id={collectionToolAnchor('ocr' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionOcr key={'ocr:' + documents.map(doc => doc.id).join(':')}
        documents={documents} turn={currentTurn} onInspect={inspectPage} /></div>}
      {documents.length > 0 && !busy && <div id={collectionToolAnchor('evaluation' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionEvaluation key={'evaluation:' + documents.map(doc => doc.id).join(':')}
        documents={documents} turns={turns} names={names} onInspect={inspect} /></div>}
      {documents.length > 0 && !busy && <div id={collectionToolAnchor('packet' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionPacket key={'packet:' + documents.map(doc => doc.id).join(':')}
        documents={documents} turns={turns} reviews={reviews} /></div>}
      {!busy && <div id={collectionToolAnchor('replay' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionReplay key={'replay:' + documents.map(doc => doc.id).join(':')} documents={documents} /></div>}
      {documents.length > 0 && <div id={collectionToolAnchor('exchange' as CollectionToolId)} tabIndex={-1} className="chat-collection-destination"><PdfChatCollectionExchange key={'exchange:' + documents.map(doc => doc.id).join(':')}
        documents={documents} turns={turns} disabled={busy}
        onApply={restored => {
          setTurns(restored); setActiveTurn(restored.length - 1); setQuestion(''); setPreview(null); setError('');
        }} /></div>}
    </section>
  </details>;
}
