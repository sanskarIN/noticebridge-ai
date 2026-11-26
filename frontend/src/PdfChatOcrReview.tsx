import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { Answer, Passage, Role } from './pdfChatCore';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { parseOcrReview, readOcrReview, searchOcrReviews, type OcrReview } from './pdfChatOcrReview';
import { isLocalChatOrigin } from './pdfChatLocalTransport';
import { localOcrPages, MAX_LOCAL_OCR_SELECTION, requestLocalOcr } from './pdfChatLocalOcr';

export default function PdfChatOcrReview({ files, corpora, answer, onInspect }: {
  files: AttachedFiles; corpora: ChatCorpora; answer: Answer | null;
  onInspect: (source: Passage) => void;
}) {
  const generation = useRef(0);
  const [reviews, setReviews] = useState<OcrReview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [localRole, setLocalRole] = useState<Role>(files.original ? 'original' : 'revised');
  const [localPages, setLocalPages] = useState('');
  const [localConsent, setLocalConsent] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const localAvailable = isLocalChatOrigin(globalThis.location?.origin ?? '');
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const matches = useMemo(() => answer ? searchOcrReviews(reviews, answer) : [], [reviews, answer]);

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy || localBusy) return;
    const token = ++generation.current;
    setBusy(true); setError(false);
    try {
      const pins = await fingerprintSources(files);
      const counts: Partial<Record<Role, number>> = {};
      for (const role of ['original', 'revised'] as const) {
        if (corpora[role]) counts[role] = corpora[role]!.pageCount;
      }
      const result = parseOcrReview(await readOcrReview(file), pins, counts);
      if (generation.current === token) setReviews(old => [
        ...old.filter(review => review.role !== result.role), result,
      ]);
    } catch {
      if (generation.current === token) setError(true);
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  async function runLocal() {
    if (!localAvailable || !localConsent || busy || localBusy) return;
    const file = files[localRole], corpus = corpora[localRole];
    if (!file || !corpus) return;
    let pages: number[];
    try { pages = localOcrPages(localPages, corpus.pageCount); }
    catch { setLocalError('Select up to 12 physical pages in a PDF with at most 80 pages.'); return; }
    const token = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setLocalBusy(true); setLocalError(''); setError(false);
    try {
      const pins = await fingerprintSources(files);
      const result = await requestLocalOcr(file, localRole, pages, corpus.pageCount, pins, abort.signal, true);
      if (generation.current === token) setReviews(old => [
        ...old.filter(review => review.role !== result.role), result,
      ]);
    } catch {
      if (generation.current === token) setLocalError(
        'Local OCR failed or is disabled. Enable the trusted loopback backend or use the file workflow.');
    } finally {
      if (generation.current === token) { setLocalBusy(false); controller.current = null; }
    }
  }
  function cancelLocal() {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    setLocalBusy(false);
    setLocalError('Local OCR result discarded. The backend worker may finish within its bounded deadline.');
  }

  return <details className="chat-session chat-embedding-panel">
    <summary>Experimental scanned PDF review (local OCR)</summary>
    <p className="chat-note">OCR may misread numbers, names or negation. Imported transcriptions
      are unverified review leads, not native text or factual answers. Source fingerprints bind
      the report to the selected PDF, but cannot authenticate the OCR output.</p>
    <p className="chat-muted">On a trusted local computer with the NoticeBridge backend and
      English Tesseract data installed, run the following command with your own PDF,
      matching role and selected physical pages:</p>
    <pre>python -m noticebridge.chat_ocr_cli source.pdf --role original --pages 1,3 --output ocr.json --allow-local-processing</pre>
    <p className="chat-muted">Import the resulting private JSON here. No PDF is sent to a
      server when using the file import. A new report replaces only the previous report for the same source.</p>
    <label className="chat-session-file">Import local OCR review report
      <input type="file" accept=".json,application/json" disabled={busy || localBusy}
        onChange={event => void load(event)} />
    </label>
    {localAvailable && <section className="chat-session" aria-label="Direct loopback OCR">
      <h3>Direct local OCR (development only)</h3>
      <p className="chat-note">This optional route sends the selected complete PDF to the local
        NoticeBridge backend through the loopback development origin. It is disabled by default.
        Start the backend with NOTICEBRIDGE_ENABLE_LOCAL_CHAT_OCR=1 only on a trusted local computer.
        It does not send PDF data to a hosted service.</p>
      <label className="chat-overview-filter">Direct OCR source
        <select value={localRole} disabled={busy || localBusy} onChange={event => {
          setLocalRole(event.target.value as Role); setLocalError(''); setLocalPages('');
        }}>
          {(['original', 'revised'] as const).filter(role => files[role]).map(role =>
            <option key={role} value={role}>{role}</option>)}
        </select>
      </label>
      <label className="chat-overview-filter">Direct OCR physical pages
        <input type="text" maxLength={MAX_LOCAL_OCR_SELECTION} value={localPages}
          disabled={busy || localBusy} onChange={event => setLocalPages(event.target.value)}
          placeholder="1,3-5" />
      </label>
      <p className="chat-muted">Select at most 12 physical pages. OCR currently supports PDFs up to 80 pages.</p>
      <label className="chat-embedding-consent"><input type="checkbox" checked={localConsent}
        disabled={busy || localBusy} onChange={event => setLocalConsent(event.target.checked)} />
        I approve sending the selected PDF to my trusted local OCR backend.</label>
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={!localConsent || busy || localBusy || !localPages.trim()}
          onClick={() => void runLocal()}>Run selected-page local OCR</button>
        {localBusy && <button type="button" className="chat-button" onClick={cancelLocal}>Discard local OCR result</button>}
      </div>
      {localBusy && <p role="status">Local OCR processing…</p>}
      {localError && <p className="chat-error" role="alert">{localError}</p>}
    </section>}
    {busy && <p role="status">Checking OCR source fingerprint…</p>}
    {error && <p role="alert" className="chat-error">OCR report is invalid or belongs to a
      different PDF. Existing review data is unchanged.</p>}
    {reviews.map(review => <div key={review.role} className="chat-direct-side">
      <p>{review.role}: selected physical pages {review.pages.map(page => page.page).join(', ')}.</p>
      <p className="chat-muted">{review.pages.map(page => 'Page ' + page.page + ': ' + page.status).join(' · ')}</p>
      <button type="button" className="chat-button" disabled={busy || localBusy}
        onClick={() => setReviews(old => old.filter(item => item.role !== review.role))}>
        Remove {review.role} OCR report
      </button>
    </div>)}
    {reviews.length > 0 && answer && <section className="chat-context-results" aria-label="OCR review matches">
      <h4>Machine-transcribed matches for the latest question</h4>
      <p className="chat-muted">The strict native-text answer remains unchanged. These matches
        search selected OCR pages only; no match is not proof of absence.</p>
      {!matches.length && <p>No matching OCR review lines were found.</p>}
      {matches.map(source => <div className="chat-citation"
        key={source.role + ':' + source.page + ':' + source.ordinal}>
        <p className="chat-muted">{source.role} · physical page {source.page} · OCR transcription</p>
        <p>“{source.text}”</p>
        <button type="button" className="chat-button" onClick={() => onInspect(source)}>
          Inspect {source.role} OCR page {source.page}
        </button>
      </div>)}
    </section>}
    {reviews.length > 0 && !answer && <p className="chat-muted">Ask one question to search the imported OCR text.</p>}
  </details>;
}
