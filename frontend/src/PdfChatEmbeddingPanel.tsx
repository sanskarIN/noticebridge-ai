import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import type { Answer, Passage, SearchIndex } from './pdfChatCore';
import PdfChatSelectionPanel from './PdfChatSelectionPanel';
import PdfChatExtractivePanel from './PdfChatExtractivePanel';
import PdfChatPipeline from './PdfChatPipeline';
import type { LocalPipelineConfig } from './pdfChatLocalPipeline';
import { MAX_RANK_FILE, prepareExperiment, requestHash, reviewRanking, type Experiment, type CandidateReview } from './pdfChatEmbeddingBridge';

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'noticebridge-embedding-request.json';
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PdfChatEmbeddingPanel({ index, answer, onInspect, config, setConfig }: {
  index: SearchIndex; answer: Answer; onInspect: (passage: Passage) => void;
  config: LocalPipelineConfig; setConfig: Dispatch<SetStateAction<LocalPipelineConfig>>;
}) {
  const generation = useRef(0);
  const [approved, setApproved] = useState(false);
  const [mode, setMode] = useState<'full' | 'shortlist'>('full');
  const [pending, setPending] = useState<{ experiment: Experiment; digest: string } | null>(null);
  const [review, setReview] = useState<CandidateReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => { generation.current++; }, []);

  async function prepare() {
    if (!approved) return;
    const token = ++generation.current;
    setBusy(true); setError(''); setPending(null); setReview(null);
    try {
      const experiment = prepareExperiment(index, answer, mode);
      const digest = await requestHash(experiment.text);
      if (generation.current !== token) return;
      download(experiment.text);
      setPending({ experiment, digest });
    } catch {
      if (generation.current === token) setError('Unable to export. Use HTTPS or localhost, narrow the search, or choose the bounded hybrid shortlist.');
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }
  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !pending || !approved) return;
    const token = ++generation.current;
    setBusy(true); setReview(null); setError('');
    try {
      if (!file.size || file.size > MAX_RANK_FILE) throw new Error('size');
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_RANK_FILE) throw new Error('size');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const result = reviewRanking(text, pending.experiment, pending.digest);
      if (generation.current === token) setReview(result);
    } catch {
      if (generation.current === token) setError('Ranking file rejected. Use the exact unmodified result for this exported request.');
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }
  return <>
  <details className="chat-session chat-embedding-panel">
    <summary>Experimental semantic retrieval (local file workflow)</summary>
    <p className="chat-note">Optional research experiment for the last single question. Export includes the
      question and complete indexed passages within its selected source/page scope. The file may contain
      private document text. Use only a trusted local-only model runtime; no browser model connection is made.</p>
    <label className="chat-overview-filter">Semantic candidate mode
      <select value={mode} disabled={busy} onChange={event => {
        generation.current++; setMode(event.target.value as typeof mode);
        setPending(null); setReview(null); setError('');
      }}>
        <option value="full">All scoped indexed fragments (maximum 512)</option>
        <option value="shortlist">Bounded hybrid shortlist (maximum 512)</option>
      </select>
    </label>
    {mode === 'shortlist' && <p className="chat-note">The shortlist reserves space for baseline
      citations, strict and partial lexical matches, and page-diverse samples. It can exclude
      relevant evidence. Dense ranking is limited to the exported candidates.</p>}
    <label className="chat-embedding-consent"><input type="checkbox" checked={approved}
      disabled={busy} onChange={event => {
        generation.current++; setApproved(event.target.checked); setPending(null); setReview(null); setError('');
      }} /> I understand that the exported request contains document text.</label>
    <div className="chat-toolbar">
      <button className="chat-button" type="button" disabled={!approved || busy}
        onClick={() => void prepare()}>Export semantic retrieval request</button>
      <label className="chat-session-file">Import local candidate ranking
        <input type="file" accept=".json,application/json" disabled={!pending || !approved || busy}
          onChange={event => void load(event)} /></label>
    </div>
    {pending && <p className="chat-muted">Request prepared. Run the local embedding CLI documented in the
      repository, then import its result while this question remains selected.</p>}
    {pending?.experiment.shortlistCoverage && <section aria-label="Hybrid shortlist coverage">
      <h4>Exported candidate coverage</h4>
      {pending.experiment.shortlistCoverage.map(side => <div key={side.role} className="chat-note">
        <p>{side.role}: {side.selected} of {side.eligible} scoped indexed fragments exported;
          {' '}{side.eligible - side.selected} excluded.</p>
        <p>{side.selectedPages} of {side.eligiblePages} indexed pages represented.
          {' '}{side.strictSelected} of {side.strict} strict matching fragments included.</p>
        <p className="chat-muted">Baseline {side.reasons.baseline} · strict {side.reasons.strict}
          {' '}· partial {side.reasons.partial} · page samples {side.reasons.page_sample}</p>
      </div>)}
      <p className="chat-muted">Counts describe indexed fragments only. The model cannot recover
        excluded fragments and no relevance or complete coverage is guaranteed.</p>
    </section>}
    {busy && <p role="status">Checking request or ranking…</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {review && <section aria-label="Experimental candidate review">
      <h3>Additional review candidates</h3>
      <p className="chat-note">Imported ranking metadata is untrusted. The request fingerprint and candidate
        identities match, but the model identity and relevance are not independently attested. These are
        suggestions only; they do not replace the deterministic answer or establish authority.</p>
      <p className="chat-muted">Reported model: {review.model} · {review.dimension} dimensions</p>
      {review.candidates.map(({ passage, ranks }) => <div className="chat-citation" key={passage.role + ':' + passage.page + ':' + passage.ordinal}>
        <p className="chat-muted">{passage.role} · physical page {passage.page} · {ranks.map(rank => rank.channel + ' #' + rank.rank).join(' / ')}</p>
        <blockquote>{passage.text}</blockquote>
        <button className="chat-button" type="button" onClick={() => onInspect(passage)}>Inspect candidate source</button>
      </div>)}
    </section>}
  </details>
  <details className="chat-session chat-embedding-panel">
    <summary>Experimental local AI selection (local file workflow)</summary>
    <PdfChatSelectionPanel key={review ? JSON.stringify(review.candidates.map(row => [row.passage.role, row.passage.page, row.passage.ordinal])) : 'baseline'}
      index={index} answer={answer} candidates={review} onInspect={onInspect} />
  </details>
  <details className="chat-session chat-embedding-panel">
    <summary>Experimental local AI extractive answer (local file workflow)</summary>
    <PdfChatExtractivePanel key={review ? JSON.stringify(review.candidates.map(row =>
      [row.passage.role, row.passage.page, row.passage.ordinal])) : 'baseline'}
      index={index} answer={answer} candidates={review} onInspect={onInspect} />
  </details>
  <PdfChatPipeline index={index} answer={answer} onInspect={onInspect} config={config} setConfig={setConfig} />
  </>;
}
