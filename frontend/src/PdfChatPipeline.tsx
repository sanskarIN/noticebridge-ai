import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Answer, Passage, SearchIndex } from './pdfChatCore';
import { requestHash } from './pdfChatEmbeddingBridge';
import { MAX_PIPELINE_RESULT_BYTES, preparePipeline, reviewPipeline,
  type PipelineRequest, type PipelineReview } from './pdfChatPipeline';

export default function PdfChatPipeline({ index, answer, onInspect }: {
  index: SearchIndex; answer: Answer; onInspect: (source: Passage) => void;
}) {
  const [mode, setMode] = useState<'full' | 'shortlist'>('shortlist');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<{ request: PipelineRequest; digest: string } | null>(null);
  const [review, setReview] = useState<PipelineReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  function reset() { epoch.current++; setPending(null); setReview(null); setError(''); }
  async function prepare() {
    if (!consent || busy) return;
    reset();
    const token = epoch.current;
    setBusy(true);
    try {
      const request = preparePipeline(index, answer, mode);
      const digest = await requestHash(request.text);
      if (token !== epoch.current) return;
      const url = URL.createObjectURL(new Blob([request.text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'noticebridge-pipeline-request.json';
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPending({ request, digest });
    } catch {
      if (token === epoch.current) setError('Unable to prepare a bounded local pipeline request.');
    } finally { if (token === epoch.current) setBusy(false); }
  }
  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !consent || !pending || busy) return;
    const token = ++epoch.current;
    setBusy(true); setReview(null); setError('');
    try {
      if (!file.size || file.size > MAX_PIPELINE_RESULT_BYTES) throw new Error('size');
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_PIPELINE_RESULT_BYTES) throw new Error('size');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const result = await reviewPipeline(text, pending.request, pending.digest);
      if (token === epoch.current) setReview(result);
    } catch {
      if (token === epoch.current) setError('Pipeline result rejected. Use the exact result for this request.');
    } finally { if (token === epoch.current) setBusy(false); }
  }
  return <details className="chat-session chat-embedding-panel">
    <summary>Experimental combined local AI workflow</summary>
    <p className="chat-note">One private file exchange runs semantic ranking followed by
      exact extractive proposals. No browser connection to a model service is made.
      Use only a trusted local-only installed runtime. This is not verified question answering.</p>
    <label className="chat-overview-filter">Combined workflow candidate mode
      <select value={mode} disabled={busy} onChange={event => {
        reset(); setMode(event.target.value as typeof mode);
      }}>
        <option value="shortlist">Bounded hybrid shortlist</option>
        <option value="full">All scoped fragments (maximum 512)</option>
      </select>
    </label>
    <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
      disabled={busy} onChange={event => { reset(); setConsent(event.target.checked); }} />
      I approve exporting private text for the combined local workflow.</label>
    <pre>python -m noticebridge.chat_pipeline_cli noticebridge-pipeline-request.json --output result.json --embedding-model MODEL:TAG --embedding-digest DIGEST --answer-model MODEL:TAG --answer-digest DIGEST --allow-local-processing</pre>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={!consent || busy}
        onClick={() => void prepare()}>Export combined workflow request</button>
      <label className="chat-session-file">Import combined workflow result
        <input type="file" accept=".json,application/json" disabled={!consent || !pending || busy}
          onChange={event => void load(event)} /></label>
    </div>
    {pending && <p className="chat-muted">{pending.request.embedding.allowed.size} indexed fragments exported.
      {pending.request.embedding.shortlistCoverage?.map(side => ' ' + side.role + ': ' +
        (side.eligible - side.selected) + ' excluded.').join('')}</p>}
    {busy && <p role="status">Checking combined workflow…</p>}
    {error && <p className="chat-error" role="alert">{error}</p>}
    {review && <section aria-label="Combined workflow review">
      <h4>{review.extractive.proposal.status === 'insufficient' ? 'Local model abstained' : 'Proposed source quotations'}</h4>
      <p className="chat-note">{review.selectionCount} fragments supplied to the answer model.
        Validated literal source offsets do not prove relevance, completeness, or authority.
        The original deterministic answer stays unchanged.</p>
      <p className="chat-muted">Reported models: {review.ranking.model} · {review.extractive.model}</p>
      {review.extractive.omittedBaseline.length > 0 && <p className="chat-note">
        {review.extractive.omittedBaseline.length} baseline fragments not quoted. Inspect the original answer.</p>}
      {review.extractive.missingRoles.length > 0 && <p className="chat-note">No quote from:
        {' '}{review.extractive.missingRoles.join(', ')}. This does not prove absence of evidence.</p>}
      {review.extractive.proposal.spans.map(span => <div className="chat-citation" key={span.id + ':' + span.start}>
        <p className="chat-muted">{span.source.role} · physical page {span.source.page} · fragment {span.source.ordinal}</p>
        <blockquote>{span.source.text.slice(0, span.start)}<mark>{span.text}</mark>{span.source.text.slice(span.end)}</blockquote>
        <button type="button" className="chat-button" onClick={() => onInspect(span.source)}>
          Inspect combined workflow source page {span.source.page}
        </button>
      </div>)}
    </section>}
  </details>;
}
