/** Explicit local exports and independently verified collection replay. */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { collectionSteps, loadCollectionEvidence, loadCollectionPlan, replayCollectionSteps,
  serializeCollectionEvidence, serializeCollectionPlan, CollectionError,
  type CollectionDocument, type CollectionTurn } from './pdfChatCollection';

type Feedback = { error: boolean; text: string };
type Pending = { turns: CollectionTurn[]; original: readonly CollectionTurn[] };
function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function failure(cause: unknown, fallback: string): string {
  return cause instanceof CollectionError ? cause.message : fallback;
}

export default function PdfChatCollectionExchange({ documents, turns, disabled, onApply }: {
  documents: readonly CollectionDocument[];
  turns: readonly CollectionTurn[];
  disabled: boolean;
  onApply: (turns: CollectionTurn[]) => void;
}) {
  const [planConsent, setPlanConsent] = useState(false);
  const [reportConsent, setReportConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => {
    generation.current++;
    controller.current?.abort();
  }, []);

  function exportFile(kind: 'plan' | 'report') {
    if (disabled || busy || !turns.length || (kind === 'plan' ? !planConsent : !reportConsent)) return;
    setFeedback(null);
    try {
      const steps = collectionSteps(turns);
      const text = kind === 'plan' ? serializeCollectionPlan(documents, steps)
        : serializeCollectionEvidence(documents, steps);
      download(text, kind === 'plan' ? 'noticebridge-collection-questions.json'
        : 'noticebridge-collection-evidence.json');
      setFeedback({ error: false, text: kind === 'plan'
        ? 'Private collection question plan exported locally.'
        : 'Private collection evidence report exported locally.' });
      // A new disclosure requires a new explicit approval.
      if (kind === 'plan') setPlanConsent(false);
      else setReportConsent(false);
    } catch (cause) {
      setFeedback({ error: true, text: failure(cause, 'Unable to export collection file.') });
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>, kind: 'plan' | 'report') {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || disabled || busy) return;
    const token = ++generation.current;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setPending(null);
    setFeedback(null);
    try {
      if (kind === 'plan') {
        const steps = await loadCollectionPlan(file, documents, operation.signal);
        const replayed = replayCollectionSteps(documents, steps);
        operation.signal.throwIfAborted();
        if (token === generation.current) setPending({ turns: replayed, original: turns });
      } else {
        const report = await loadCollectionEvidence(file, documents, operation.signal);
        operation.signal.throwIfAborted();
        if (token === generation.current) setFeedback({ error: false,
          text: 'Exact collection evidence replay matched ' + report.questions + ' question turn(s) across '
            + report.documents + ' attached PDF(s). No authority or answer-meaning verification is implied.' });
      }
    } catch (cause) {
      if (token === generation.current && !operation.signal.aborted) {
        setFeedback({ error: true, text: failure(cause, 'Collection file rejected. Current questions are unchanged.') });
      }
    } finally {
      if (token === generation.current) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  const unchanged = pending?.original === turns;
  return <details className="chat-collection-exchange">
    <summary>Save or verify private collection work</summary>
    <p className="chat-muted">Question plans contain questions, selected source fingerprints and settings only.
      Evidence reports additionally contain extracted quotations and coverage. Neither contains PDF bytes or filenames.
      Questions and quotations may contain private information.</p>
    <div className="chat-collection-exchange-grid">
      <section aria-label="Collection question plan">
        <h4>Question plan</h4>
        <label className="chat-checkbox"><input type="checkbox" checked={planConsent}
          disabled={disabled || busy} onChange={event => setPlanConsent(event.target.checked)} />
          I approve exporting private collection questions and fingerprints.</label>
        <button type="button" className="chat-button" disabled={disabled || busy || !planConsent || !turns.length}
          onClick={() => exportFile('plan')}>Export collection question plan</button>
        <label className="chat-session-file">Import collection question plan
          <input type="file" accept=".json,application/json" disabled={disabled || busy}
            onChange={event => void importFile(event, 'plan')} /></label>
      </section>
      <section aria-label="Collection evidence report">
        <h4>Evidence report</h4>
        <label className="chat-checkbox"><input type="checkbox" checked={reportConsent}
          disabled={disabled || busy} onChange={event => setReportConsent(event.target.checked)} />
          I approve exporting private collection excerpts and questions.</label>
        <button type="button" className="chat-button" disabled={disabled || busy || !reportConsent || !turns.length}
          onClick={() => exportFile('report')}>Export collection evidence report</button>
        <label className="chat-session-file">Verify collection evidence report
          <input type="file" accept=".json,application/json" disabled={disabled || busy}
            onChange={event => void importFile(event, 'report')} /></label>
      </section>
    </div>
    {busy && <div className="chat-toolbar"><p role="status">Recomputing private collection results…</p>
      <button type="button" className="chat-button" onClick={() => {
        controller.current?.abort();
        setFeedback({ error: false, text: 'Collection file verification cancelled.' });
      }}>Cancel collection file check</button></div>}
    {pending && <section className="chat-note" aria-label="Collection question restore confirmation">
      <p>Prepared {pending.turns.length} question turn(s), recomputed from the exact attached PDF set.
        Applying replaces the existing collection conversation.</p>
      {!unchanged && <p>The conversation changed during verification. Import again to avoid losing edits.</p>}
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={disabled || busy || !unchanged}
          onClick={() => {
            if (!unchanged || disabled || busy) return;
            onApply(pending.turns);
            setPending(null);
            setFeedback({ error: false, text: 'Collection questions restored from attached sources.' });
          }}>Apply saved collection questions</button>
        <button type="button" className="chat-button" onClick={() => setPending(null)}>Discard prepared collection questions</button>
      </div>
    </section>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'chat-error' : 'chat-note'}>
      {feedback.text}</p>}
  </details>;
}
