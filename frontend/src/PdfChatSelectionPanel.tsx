import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Answer, Passage, SearchIndex } from './pdfChatCore';
import { requestHash, type CandidateReview } from './pdfChatEmbeddingBridge';
import { MAX_SELECTION_RESULT_BYTES, prepareSelection, reviewSelection,
  type SelectionExperiment, type SelectionReview } from './pdfChatSelectionBridge';

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'noticebridge-selection-request.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PdfChatSelectionPanel({ index, answer, candidates, onInspect }: {
  index: SearchIndex; answer: Answer; candidates: CandidateReview | null;
  onInspect: (passage: Passage) => void;
}) {
  const generation = useRef(0);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<{ experiment: SelectionExperiment; digest: string } | null>(null);
  const [review, setReview] = useState<SelectionReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  const hasCandidates = answer.citations.length > 0 || Boolean(candidates?.candidates.length);

  async function prepare() {
    if (!consent || !hasCandidates) return;
    const token = ++generation.current;
    setBusy(true); setPending(null); setReview(null); setError('');
    try {
      const experiment = prepareSelection(index, answer, candidates);
      const digest = await requestHash(experiment.text);
      if (generation.current !== token) return;
      download(experiment.text);
      setPending({ experiment, digest });
    } catch {
      if (generation.current === token) setError('Unable to prepare a bounded evidence request.');
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !pending || !consent) return;
    const token = ++generation.current;
    setBusy(true); setReview(null); setError('');
    try {
      if (!file.size || file.size > MAX_SELECTION_RESULT_BYTES) throw new Error('size');
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_SELECTION_RESULT_BYTES) throw new Error('size');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const result = reviewSelection(text, pending.experiment, pending.digest);
      if (generation.current === token) setReview(result);
    } catch {
      if (generation.current === token) setError('Evidence selection rejected. Use the exact result for this request.');
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  return <section className="chat-session" aria-label="Experimental local AI evidence selection">
    <h3>Local AI evidence selection</h3>
    <p className="chat-note">The optional model selects complete source passages or abstains. It cannot
      produce verified answer prose. The original answer remains unchanged. Export includes the question
      and candidate text, which may be private. Use a trusted local-only runtime.</p>
    {!hasCandidates && <p className="chat-muted">No candidate evidence yet. Try the semantic retrieval experiment first.</p>}
    <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
      disabled={busy || !hasCandidates} onChange={event => {
        generation.current++;
        setConsent(event.target.checked); setPending(null); setReview(null); setError('');
      }} /> I approve exporting candidate text for local AI selection.</label>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={!consent || busy || !hasCandidates}
        onClick={() => void prepare()}>Export evidence selection request</button>
      <label className="chat-session-file">Import local AI selection
        <input type="file" accept=".json,application/json" disabled={!consent || !pending || busy}
          onChange={event => void load(event)} /></label>
    </div>
    {pending && <p className="chat-muted">Exported {pending.experiment.allowed.size} complete candidate fragments.
      {pending.experiment.omittedCandidates > 0 && <> {pending.experiment.omittedCandidates} additional candidate
        fragments excluded by the budget; all baseline evidence retained.</>}
      {' '}Run the local selection CLI, then import its result.</p>}
    {busy && <p role="status">Checking evidence selection…</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {review && <section aria-label="Local AI selection review">
      <h4>{review.status === 'insufficient' ? 'Local model abstained' : 'Model-selected source passages'}</h4>
      <p className="chat-note">Unverified model relevance suggestions only. Matching request and source
        identifiers do not prove that passages support an answer, that the model identity is authentic,
        or that any condition or contradiction has been resolved.</p>
      <p className="chat-muted">Reported model: {review.model}</p>
      {review.omittedBaseline.length > 0 && <p className="chat-note">
        The model did not select {review.omittedBaseline.length} baseline evidence fragments.
        Those fragments remain available in the original answer. Do not assume they are irrelevant.
      </p>}
      {review.selected.map(passage => <div className="chat-citation" key={passage.role + ':' + passage.page + ':' + passage.ordinal}>
        <p className="chat-muted">{passage.role} · physical page {passage.page}</p>
        <blockquote>{passage.text}</blockquote>
        <button className="chat-button" type="button" onClick={() => onInspect(passage)}>Inspect selected source</button>
      </div>)}
    </section>}
  </section>;
}
