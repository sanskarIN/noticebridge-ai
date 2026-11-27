import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import type { Answer, Passage, SearchIndex } from './pdfChatCore';
import { isLocalChatOrigin } from './pdfChatLocalTransport';
import { requestLocalPipeline, validLocalPipelineConfig, emptyLocalPipelineConfig, type LocalPipelineConfig } from './pdfChatLocalPipeline';
import { requestLocalModelInventory, inventoryChoice, selectedInventoryTag, type LocalModelInventory } from './pdfChatModelInventory';
import { requestHash } from './pdfChatEmbeddingBridge';
import { MAX_PIPELINE_RESULT_BYTES, preparePipeline, reviewPipeline,
  type PipelineRequest, type PipelineReview } from './pdfChatPipeline';

export default function PdfChatPipeline({ index, answer, onInspect, config, setConfig }: {
  index: SearchIndex; answer: Answer; onInspect: (source: Passage) => void;
  config: LocalPipelineConfig; setConfig: Dispatch<SetStateAction<LocalPipelineConfig>>;
}) {
  const [mode, setMode] = useState<'full' | 'shortlist'>('shortlist');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<{ request: PipelineRequest; digest: string } | null>(null);
  const [review, setReview] = useState<PipelineReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localConsent, setLocalConsent] = useState(false);
  const [inventory, setInventory] = useState<LocalModelInventory | null>(null);
  const [inventoryRunning, setInventoryRunning] = useState(false);
  const [inventoryError, setInventoryError] = useState('');
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  const [localRunning, setLocalRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const loopback = isLocalChatOrigin(globalThis.location?.origin ?? '');
  useEffect(() => () => { epoch.current++; controller.current?.abort(); }, []);
  function reset() {
    epoch.current++; setPending(null); setReview(null); setError(''); setLocalSummary(null);
  }
  async function loadInventory() {
    if (!loopback || busy) return;
    const token = ++epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setInventoryRunning(true); setInventoryError(''); setInventory(null);
    try {
      const result = await requestLocalModelInventory(abort.signal, true);
      if (token === epoch.current) setInventory(result);
    } catch {
      if (token === epoch.current) setInventoryError('Unable to read the local model inventory. Check the opt-in backend and installed runtime.');
    } finally {
      if (token === epoch.current) { setBusy(false); setInventoryRunning(false); controller.current = null; }
    }
  }
  function cancelInventory() {
    epoch.current++; controller.current?.abort(); controller.current = null;
    setBusy(false); setInventoryRunning(false); setInventory(null);
    setInventoryError('Inventory request discarded.');
  }
  async function runLocal() {
    if (!loopback || !localConsent || busy || !validLocalPipelineConfig(config)) return;
    reset();
    const token = epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setLocalRunning(true);
    try {
      const request = preparePipeline(index, answer, mode);
      const summary = request.embedding.allowed.size + ' scoped fragments sent to the local backend.' +
        (request.embedding.shortlistCoverage?.map(side => ' ' + side.role + ': ' +
          (side.eligible - side.selected) + ' excluded.').join('') ?? '');
      const result = await requestLocalPipeline(request, config, abort.signal, localConsent);
      if (token === epoch.current) { setReview(result); setLocalSummary(summary); }
    } catch {
      if (token === epoch.current) setError('Local AI request rejected or unavailable. Check the opt-in backend, model tags and digests.');
    } finally {
      if (token === epoch.current) { setBusy(false); setLocalRunning(false); controller.current = null; }
    }
  }
  function cancelLocal() {
    epoch.current++; controller.current?.abort(); controller.current = null;
    setBusy(false); setLocalRunning(false); setReview(null); setLocalSummary(null);
    setError('Local result discarded. The backend may still be finishing its bounded request.');
  }
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
    <p className="chat-note">One private file exchange, or an explicitly approved loopback request,
      runs semantic ranking followed by exact extractive proposals. No direct browser connection to a model service is made.
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
    {loopback && <section aria-label="Direct local AI workflow">
      <h4>Direct local backend (optional)</h4>
      <p className="chat-note">Requires NOTICEBRIDGE_ENABLE_LOCAL_CHAT_AI=1 on the trusted loopback backend.
        Scoped private question and fragment text will be sent to that backend, which invokes the
        installed local model runtime. The browser cannot attest how the runtime processes data.
        Model settings are kept in memory for this chat page only. Each question requires fresh consent.</p>
      <section className="chat-context-results" aria-label="Installed local model inventory">
        <h5>Choose installed models</h5>
        <p className="chat-muted">Reading the inventory sends no question or document text. It returns only
          runtime-reported local model tags and digests. This does not verify their capabilities or offline behavior.</p>
        <div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={busy}
            onClick={() => void loadInventory()}>Read installed local models</button>
          {inventoryRunning && <button type="button" className="chat-button" onClick={cancelInventory}>Discard inventory request</button>}
        </div>
        {inventoryError && <p role="alert" className="chat-error">{inventoryError}</p>}
        {inventory && <>
          <p className="chat-muted">{inventory.models.length} eligible reported tags; {inventory.excluded_count} excluded
            because their metadata was invalid, ambiguous or remote.</p>
          {inventory.models.length === 0 && <p>No eligible local tags were reported. You can still enter a tag and digest manually.</p>}
          {inventory.models.length > 0 && (['embedding', 'answer'] as const).map(purpose => <label
            className="chat-overview-filter" key={purpose}>Select installed {purpose} model
            <select disabled={busy} value={selectedInventoryTag(inventory, config, purpose)}
              onChange={event => {
                const tag = event.target.value;
                if (!tag) return;
                reset();
                setConfig(previous => inventoryChoice(inventory, previous, purpose, tag));
                setLocalConsent(false);
              }}>
              <option value="" disabled>Choose an installed tag</option>
              {inventory.models.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
            </select>
          </label>)}
        </>}
      </section>
      {([
        ['embeddingModel', 'Local embedding model tag', 96],
        ['embeddingDigest', 'Local embedding model digest', 64],
        ['answerModel', 'Local answer model tag', 96],
        ['answerDigest', 'Local answer model digest', 64],
      ] as const).map(([key, label, maximum]) => <label className="chat-overview-filter" key={key}>
        {label}<input value={config[key]} maxLength={maximum} autoComplete="off" spellCheck={false}
          disabled={busy} onChange={event => { reset(); setConfig(previous => ({
            ...previous, [key]: event.target.value,
          })); setLocalConsent(false); }} />
      </label>)}
      <button type="button" className="chat-button" disabled={busy ||
        !Object.values(config).some(Boolean)} onClick={() => {
        reset(); setConfig(emptyLocalPipelineConfig()); setLocalConsent(false);
      }}>Clear local model settings</button>
      <label className="chat-embedding-consent"><input type="checkbox" checked={localConsent}
        disabled={busy} onChange={event => { reset(); setLocalConsent(event.target.checked); }} />
        I approve sending scoped private text to the loopback AI backend.</label>
      <div className="chat-toolbar">
        <button type="button" className="chat-button"
          disabled={busy || !localConsent || !validLocalPipelineConfig(config)}
          onClick={() => void runLocal()}>Run direct local AI workflow</button>
        {localRunning && <button type="button" className="chat-button"
          onClick={cancelLocal}>Discard local AI request</button>}
      </div>
      {localSummary && <p className="chat-muted">{localSummary}</p>}
    </section>}
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
