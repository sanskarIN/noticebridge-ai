import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { Answer, Passage, Role } from './pdfChatCore';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { parseOcrReview, readOcrReview, searchOcrReviews, type OcrReview } from './pdfChatOcrReview';

export default function PdfChatOcrReview({ files, corpora, answer, onInspect }: {
  files: AttachedFiles; corpora: ChatCorpora; answer: Answer | null;
  onInspect: (source: Passage) => void;
}) {
  const generation = useRef(0);
  const [reviews, setReviews] = useState<OcrReview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => () => { generation.current++; }, []);
  const matches = useMemo(() => answer ? searchOcrReviews(reviews, answer) : [], [reviews, answer]);

  async function load(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
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
      server. A new report replaces only the previous report for the same source.</p>
    <label className="chat-session-file">Import local OCR review report
      <input type="file" accept=".json,application/json" disabled={busy}
        onChange={event => void load(event)} />
    </label>
    {busy && <p role="status">Checking OCR source fingerprint…</p>}
    {error && <p role="alert" className="chat-error">OCR report is invalid or belongs to a
      different PDF. Existing review data is unchanged.</p>}
    {reviews.map(review => <div key={review.role} className="chat-direct-side">
      <p>{review.role}: selected physical pages {review.pages.map(page => page.page).join(', ')}.</p>
      <p className="chat-muted">{review.pages.map(page => 'Page ' + page.page + ': ' + page.status).join(' · ')}</p>
      <button type="button" className="chat-button" disabled={busy}
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
