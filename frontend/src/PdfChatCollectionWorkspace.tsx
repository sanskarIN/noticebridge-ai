import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { CollectionDocument, CollectionTurn } from './pdfChatCollection';
import type { CollectionReviewEntry } from './pdfChatCollectionReview';
import { loadCollectionWorkspace, serializeCollectionWorkspace, type CollectionWorkspace } from './pdfChatCollectionWorkspace';

type Feedback = { error: boolean; message: string };
type Pending = { workspace: CollectionWorkspace; turns: CollectionTurn[]; reviews: CollectionReviewEntry[] };
function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'noticebridge-private-collection-workspace.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PdfChatCollectionWorkspace({ documents, turns, reviews, onApply }: {
  documents: readonly CollectionDocument[];
  turns: CollectionTurn[];
  reviews: CollectionReviewEntry[];
  onApply: (workspace: CollectionWorkspace) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef({ turns, reviews });
  latest.current = { turns, reviews };
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { setConsent(false); }, [turns, reviews]);
  const unchanged = pending?.turns === turns && pending?.reviews === reviews;
  function start() {
    if (controller.current || busy) return null;
    const operation = new AbortController();
    controller.current = operation;
    const token = ++generation.current;
    setBusy(true);
    setConsent(false);
    setPending(null);
    setFeedback(null);
    return { operation, token };
  }
  function current(token: number, operation: AbortController) {
    return token === generation.current && !operation.signal.aborted;
  }
  function finish(token: number) {
    if (token === generation.current) { controller.current = null; setBusy(false); }
  }
  async function exportFile() {
    if (!consent || (!turns.length && !reviews.length)) return;
    const task = start();
    if (!task) return;
    const { operation, token } = task;
    try {
      const text = await serializeCollectionWorkspace(documents, { turns, reviews }, operation.signal);
      if (!current(token, operation)) return;
      if (latest.current.turns !== turns || latest.current.reviews !== reviews) {
        setFeedback({ error: true, message: 'Collection work changed during export. Approve the current workspace again.' });
        return;
      }
      download(text);
      setFeedback({ error: false, message: 'Complete private collection workspace exported locally.' });
    } catch {
      if (current(token, operation)) setFeedback({ error: true, message: 'Unable to export private collection workspace.' });
    } finally { finish(token); }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const task = start();
    if (!task) return;
    const { operation, token } = task;
    try {
      const workspace = await loadCollectionWorkspace(file, documents, operation.signal);
      if (current(token, operation)) setPending({ workspace, turns, reviews });
    } catch {
      if (current(token, operation)) setFeedback({ error: true,
        message: 'Collection workspace rejected. Exact PDF fingerprints and review text must match; current work is unchanged.' });
    } finally { finish(token); }
  }
  return <details className="chat-collection-inspection" aria-label="Complete private collection workspace">
    <summary>Save or restore complete collection workspace</summary>
    <p className="chat-note">This file contains your private questions and review annotations, selected PDF
      fingerprints, settings and source text hashes. It contains no PDF bytes, filenames, automatic source quotes or saved model answers.</p>
    <p className="chat-muted">Import recomputes questions and verifies review text independently. Both are
      staged together; no partial replacement is applied.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={consent} disabled={busy}
      onChange={event => setConsent(event.target.checked)} /> I approve exporting private collection questions and review notes together.</label>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={!consent || busy || (!turns.length && !reviews.length)}
        onClick={() => void exportFile()}>Export complete collection workspace</button>
      <label className="chat-session-file">Import complete collection workspace
        <input type="file" accept=".json,application/json" disabled={busy} onChange={event => void importFile(event)} />
      </label>
    </div>
    {busy && <div className="chat-toolbar"><p role="status">Checking complete collection workspace…</p>
      <button type="button" className="chat-button" onClick={() => {
        controller.current?.abort();
        setFeedback({ error: false, message: 'Collection workspace operation cancelled.' });
      }}>Cancel collection workspace operation</button></div>}
    {pending && <section className="chat-note" aria-label="Complete collection workspace restore confirmation">
      <p>Prepared {pending.workspace.turns.length} question turn(s) and {pending.workspace.reviews.length} review annotation(s).
        Applying replaces the complete current collection conversation and review.</p>
      {!unchanged && <p>Collection questions or review annotations changed during validation. Import again before applying.</p>}
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={!unchanged || busy} onClick={() => {
          if (!unchanged || busy) return;
          onApply(pending.workspace); setPending(null);
          setFeedback({ error: false, message: 'Complete collection workspace restored from attached PDFs.' });
        }}>Apply complete collection workspace</button>
        <button type="button" className="chat-button" onClick={() => setPending(null)}>Discard prepared collection workspace</button>
      </div>
    </section>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'chat-error' : 'chat-note'}>
      {feedback.message}</p>}
  </details>;
}
