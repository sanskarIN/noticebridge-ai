import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Answer, Passage, SearchIndex } from './pdfChatCore';
import { requestHash, type CandidateReview } from './pdfChatEmbeddingBridge';
import { prepareSelection, type SelectionExperiment } from './pdfChatSelectionBridge';
import { MAX_EXTRACTIVE_RESULT_BYTES, reviewExtractive, type ExtractiveReview } from './pdfChatExtractiveBridge';

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'noticebridge-extractive-request.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PdfChatExtractivePanel({ index, answer, candidates, onInspect }: {
  index: SearchIndex; answer: Answer; candidates: CandidateReview | null;
  onInspect: (source: Passage) => void;
}) {
  const generation = useRef(0);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<{ experiment: SelectionExperiment; digest: string } | null>(null);
  const [review, setReview] = useState<ExtractiveReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  const available = answer.citations.length > 0 || Boolean(candidates?.candidates.length);

  async function prepare() {
    if (!consent || !available || busy) return;
    const token = ++generation.current;
    setBusy(true); setPending(null); setReview(null); setError('');
    try {
      const experiment = prepareSelection(index, answer, candidates);
      const digest = await requestHash(experiment.text);
      if (token !== generation.current) return;
      download(experiment.text);
      setPending({ experiment, digest });
    } catch {
      if (token === generation.current) setError('Unable to prepare a bounded extractive request.');
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !pending || !consent || busy) return;
    const token = ++generation.current;
    setBusy(true); setReview(null); setError('');
    try {
      if (!file.size || file.size > MAX_EXTRACTIVE_RESULT_BYTES) throw new Error('size');
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_EXTRACTIVE_RESULT_BYTES) throw new Error('size');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const result = reviewExtractive(text, pending.experiment, pending.digest);
      if (token === generation.current) setReview(result);
    } catch {
      if (token === generation.current) setError('Extractive result rejected. Use the exact result for this request.');
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  return <section aria-label="Experimental local extractive answer">
    <h3>Local AI extractive answer proposal</h3>
    <p className="chat-note">The model may suggest exact quotations only. The browser reconstructs
      each quote from its local source and shows the entire passage. Quoting text does not prove
      relevance, completeness, eligibility or authority. The deterministic answer remains unchanged.</p>
    <p className="chat-muted">Use a trusted local-only installed model and the repository's
      extractive CLI. Request files include private questions and source text.</p>
    <pre>python -m noticebridge.chat_extractive_cli noticebridge-extractive-request.json --output proposal.json --model MODEL:TAG --digest EXACT_DIGEST --allow-local-processing</pre>
    {!available && <p>No candidate evidence. Try semantic retrieval first.</p>}
    <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
      disabled={busy || !available} onChange={event => {
        generation.current++; setConsent(event.target.checked); setPending(null); setReview(null); setError('');
      }} /> I approve exporting candidate text for local extractive proposals.</label>
    <div className="chat-toolbar">
      <button className="chat-button" type="button" disabled={!consent || busy || !available}
        onClick={() => void prepare()}>Export extractive proposal request</button>
      <label className="chat-session-file">Import local extractive proposal
        <input type="file" accept=".json,application/json" disabled={!consent || !pending || busy}
          onChange={event => void load(event)} /></label>
    </div>
    {pending && <p className="chat-muted">Exported {pending.experiment.allowed.size} complete fragments.
      {pending.experiment.omittedCandidates > 0 && <> {pending.experiment.omittedCandidates} additional
        candidates excluded by the budget.</>} Import the result for this exact request.</p>}
    {busy && <p role="status">Checking extractive proposal…</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {review && <section aria-label="Extractive proposal review">
      <h4>{review.proposal.status === 'insufficient' ? 'Local model abstained' : 'Model-proposed quotations'}</h4>
      <p className="chat-note">Unverified review suggestions. Read every complete passage and inspect
        the original PDF. A valid quote can omit a crucial condition.</p>
      <p className="chat-muted">Reported model: {review.model}</p>
      {review.omittedBaseline.length > 0 && <p className="chat-note">
        {review.omittedBaseline.length} baseline fragments were not quoted by the model.
        They remain in the deterministic answer; do not assume they are irrelevant.</p>}
      {review.missingRoles.length > 0 && <p className="chat-note">No model quote for:
        {' '}{review.missingRoles.join(', ')}. This does not establish absence of evidence.</p>}
      {review.proposal.spans.map(span => <div className="chat-citation" key={span.id + ':' + span.start}>
        <p className="chat-muted">{span.source.role} · physical page {span.source.page} · fragment {span.source.ordinal}</p>
        <p><strong>Proposed quote:</strong> “{span.text}”</p>
        <p className="chat-muted">Complete source fragment:</p>
        <blockquote>{span.source.text.slice(0, span.start)}<mark>{span.text}</mark>{span.source.text.slice(span.end)}</blockquote>
        <button className="chat-button" type="button" onClick={() => onInspect(span.source)}>
          Inspect extractive source page {span.source.page}
        </button>
      </div>)}
    </section>}
  </section>;
}
