import { useEffect, useMemo, useRef, useState } from 'react';
import type { Passage } from './pdfChatCore';
import { MAX_COLLECTION_TURNS, type CollectionDocument, type CollectionTurn } from './pdfChatCollection';
import { MAX_BATCH_QUESTIONS, MAX_BATCH_TEXT, MAX_BATCH_SEARCHES, BATCH_RESULTS_PAGE_SIZE,
  prepareCollectionBatch, runCollectionBatch, summarizeCollectionBatch, appendCollectionBatch,
  batchCitation, batchPage, CollectionBatchError, type BatchStage, type BatchProgress, type BatchRow } from './pdfChatCollectionBatch';

const states = { all_matched: 'Matching evidence in every question part',
  some_matched: 'Matching evidence in some question parts', no_match: 'No matching indexed evidence' };
function pause(): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, 0)); }
function explain(error: unknown): string {
  return error instanceof CollectionBatchError ? error.message : 'Unable to prepare the batch. Existing questions are unchanged.';
}
type Inspect = (id: string, source: Passage, target: HTMLElement) => void;
function BatchQuestion({ row, documents, names, onInspect }: {
  row: BatchRow; documents: readonly CollectionDocument[]; names: Map<string, string>; onInspect: Inspect;
}) {
  return <article className="chat-answer">
    <h5>{row.index + 1}. {row.question}</h5>
    <p>{states[row.state]}.</p>
    {row.limited && <p className="chat-note">Some physical pages or native extraction scopes are incomplete.</p>}
    <div className="chat-collection-matrix">
      {row.cells.map(cell => <section key={cell.documentId} className="chat-overview-side"
        aria-label={'Batch result: ' + names.get(cell.documentId)}>
        <h5>{names.get(cell.documentId)}</h5>
        <p>{states[cell.state]} · {cell.matchCount}/{cell.parts.length} parts.</p>
        {cell.parts.map((part, index) => <details key={index}>
          <summary>{part.answer.question} · {part.answer.kind === 'insufficient' ? 'no match' : 'matching fragments'}</summary>
          <p className="chat-muted">Native coverage: {part.coverage.replaceAll('_', ' ')}.
            {' '}{part.answer.matchedCounts.original} unique strict match(es).</p>
          {part.answer.citations.map((source, citation) => <div className="chat-citation" key={source.page + ':' + source.ordinal}>
            <p>{source.text}</p>
            <button type="button" className="chat-button" onClick={event => onInspect(cell.documentId,
              batchCitation(documents, cell, index, citation), event.currentTarget)}>
              Inspect batch source page {source.page}, fragment {source.ordinal}</button>
          </div>)}
        </details>)}
      </section>)}
    </div>
  </article>;
}

export default function PdfChatCollectionBatch({ documents, selected, turns, names, onApply, onInspect }: {
  documents: readonly CollectionDocument[];
  selected: string[];
  turns: CollectionTurn[];
  names: Map<string, string>;
  onApply: (turns: CollectionTurn[]) => void;
  onInspect: Inspect;
}) {
  const [text, setText] = useState('');
  const [context, setContext] = useState(false);
  const [stage, setStage] = useState<BatchStage | null>(null);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'no_match'>('all');
  const [page, setPage] = useState(1);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latest = useRef({ documents, turns });
  latest.current = { documents, turns };
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const busy = progress !== null;
  const capacity = MAX_COLLECTION_TURNS - turns.length;
  const summary = useMemo(() => stage ? summarizeCollectionBatch(stage.result) : null, [stage]);
  const rows = (summary?.rows ?? []).filter(row => filter === 'all' ||
    (filter === 'attention' ? row.limited || row.state !== 'all_matched' : row.state === 'no_match'));
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / BATCH_RESULTS_PAGE_SIZE)));
  const shown = batchPage(rows, current);
  const fresh = stage?.documents === documents && stage?.history === turns &&
    stage?.result.turns.every(turn => turn.step.documentIds.join(':') === selected.join(':'));
  function reset() { setStage(null); setError(''); setFeedback(''); setPage(1); }
  async function prepare() {
    if (controller.current || !selected.length || !capacity) return;
    reset();
    let steps;
    try { steps = prepareCollectionBatch(documents, text, selected, context, capacity); }
    catch (cause) { setError(explain(cause)); return; }
    const operation = new AbortController();
    controller.current = operation;
    const token = ++generation.current;
    setProgress({ completed: 0, total: steps.length });
    try {
      const result = await runCollectionBatch(documents, steps, capacity, {
        signal: operation.signal, yieldControl: pause,
        onProgress: value => { if (token === generation.current) setProgress(value); },
      });
      if (token !== generation.current || operation.signal.aborted) return;
      if (latest.current.documents !== documents || latest.current.turns !== turns) {
        setError('Collection or conversation changed during the run. Prepare the batch again.');
        return;
      }
      setStage({ documents, history: turns, result });
      setFilter('all');
    } catch (cause) {
      if (token === generation.current) {
        if (operation.signal.aborted) setFeedback('Batch cancelled. No questions were appended.');
        else setError(explain(cause));
      }
    } finally {
      if (token === generation.current) { controller.current = null; setProgress(null); }
    }
  }
  function apply() {
    if (!stage || !fresh || busy) return;
    try {
      const next = appendCollectionBatch(documents, turns, stage);
      onApply(next);
      setFeedback(stage.result.turns.length + ' independent collection questions appended.');
      setStage(null); setText(''); setError('');
    } catch (cause) { setError(explain(cause)); }
  }
  return <details className="chat-collection-inspection" aria-label="Collection batch question workbench">
    <summary>Prepare a collection question batch</summary>
    <p>Enter one independent question per line. The selected PDFs above are used for every question.
      No question is added to history until the entire batch is prepared and explicitly applied.</p>
    <label>Collection batch questions
      <textarea rows={6} maxLength={MAX_BATCH_TEXT} value={text} disabled={busy} onChange={event => { setText(event.target.value); reset(); }}
        placeholder={'What is the application fee?\nWhat is the eligibility?\nWhat is the deadline on page 2?'} />
    </label>
    <p className="chat-muted">{MAX_BATCH_QUESTIONS} questions maximum · {MAX_BATCH_SEARCHES} document/question-part searches maximum · {capacity} history slots available.</p>
    <p className="chat-muted">Selected PDFs: {selected.map(id => names.get(id)).join('; ') || 'none'}.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={context} disabled={busy}
      onChange={event => { setContext(event.target.checked); reset(); }} /> Search nearby lines in batch questions</label>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={busy || !text.trim() || !selected.length || !capacity}
        onClick={() => void prepare()}>Run collection question batch</button>
      {busy && <button type="button" className="chat-button" onClick={() => controller.current?.abort()}>Cancel collection question batch</button>}
    </div>
    {progress && <div role="status">Prepared {progress.completed} of {progress.total} question turns.
      <progress max={progress.total} value={progress.completed} /></div>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {feedback && <p role="status" className="chat-note">{feedback}</p>}
    {stage && summary && <section aria-label="Prepared collection batch">
      <h4>Prepared batch results</h4>
      <p className="chat-note">Matching indexed fragments are not verified answers. Missing matches do not establish absence.
        No result implies eligibility or official validity.</p>
      <div className="chat-collection-budget">
        <div><strong>{summary.questions}</strong><span>Question turns</span></div>
        <div><strong>{summary.searches}</strong><span>Independent searches</span></div>
        <div><strong>{summary.matched}</strong><span>Searches with matches</span></div>
        <div><strong>{summary.unmatched}</strong><span>Searches without matches</span></div>
        <div><strong>{summary.limited}</strong><span>Incomplete coverage searches</span></div>
      </div>
      <label>Collection batch result filter
        <select value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setPage(1); }}>
          <option value="all">All prepared questions</option>
          <option value="attention">Needs inspection</option>
          <option value="no_match">No matching evidence anywhere</option>
        </select>
      </label>
      {shown.rows.map(row => <BatchQuestion key={row.index} row={row} documents={documents} names={names} onInspect={onInspect} />)}
      {!rows.length && <p>No prepared question matches this filter.</p>}
      {shown.pages > 1 && <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous batch questions</button>
        <span>Page {current} of {shown.pages}</span>
        <button type="button" className="chat-button" disabled={current === shown.pages} onClick={() => setPage(current + 1)}>Next batch questions</button>
      </div>}
      {!fresh && <p className="chat-note">The collection, selection or history changed. This batch must be prepared again.</p>}
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={!fresh || busy} onClick={apply}>Append prepared collection questions</button>
        <button type="button" className="chat-button" onClick={reset}>Discard prepared collection batch</button>
      </div>
    </section>}
  </details>;
}
