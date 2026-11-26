import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { SearchIndex } from './pdfChatCore';
import { fingerprintSources, type AttachedFiles, type ChatTurn } from './pdfChatSession';
import type { ReviewEntry } from './pdfChatReviewWorkspace';
import { loadWorkspace, serializeWorkspace, type Workspace } from './pdfChatWorkspace';

export default function PdfChatWorkspace({ files, index, turns, entries, onRestore }: {
  files: AttachedFiles; index: SearchIndex; turns: ChatTurn[]; entries: ReviewEntry[];
  onRestore: (workspace: Workspace) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ workspace: Workspace; turns: ChatTurn[]; entries: ReviewEntry[] } | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function exportFile() {
    if (!consent || busy || (!turns.length && !entries.length)) return;
    const token = ++generation.current;
    setBusy(true); setPending(null); setFeedback(null);
    try {
      const text = await serializeWorkspace(index, await fingerprintSources(files), { turns, entries });
      if (token !== generation.current) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'noticebridge-private-workspace.json';
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback({ error: false, text: 'Private workspace exported locally.' });
    } catch {
      if (token === generation.current) setFeedback({ error: true, text: 'Workspace export failed.' });
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
    const token = ++generation.current;
    setBusy(true); setFeedback(null); setPending(null);
    try {
      const workspace = await loadWorkspace(file, index, await fingerprintSources(files));
      if (token === generation.current) setPending({ workspace, turns, entries });
    } catch {
      if (token === generation.current) setFeedback({ error: true,
        text: 'Workspace rejected. Attach exactly matching PDF bytes and roles; current work has not changed.' });
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  const unchanged = pending?.turns === turns && pending?.entries === entries;
  return <details className="chat-session chat-embedding-panel">
    <summary>Save or restore complete private workspace</summary>
    <p className="chat-note">Save your questions, search settings, review notes, statuses, and
      source fingerprints in one file. No PDF bytes, extracted quotes, model results or OCR
      transcriptions are automatically included. Questions and notes may contain personal
      information; keep the file private.</p>
    <p className="chat-muted">Restore recomputes answers from the attached index and verifies every
      saved fragment hash. Both components are staged together before confirmation.</p>
    <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
      disabled={busy} onChange={event => setConsent(event.target.checked)} />
      I approve exporting my private questions and evidence-review notes together.</label>
    <div className="chat-toolbar">
      <button type="button" className="chat-button"
        disabled={!consent || busy || (!turns.length && !entries.length)}
        onClick={() => void exportFile()}>Export complete private workspace</button>
      <label className="chat-session-file">Restore complete private workspace
        <input type="file" accept=".json,application/json" disabled={busy}
          onChange={event => void importFile(event)} /></label>
    </div>
    {busy && <p role="status">Checking workspace source bindings…</p>}
    {pending && <section className="chat-note" aria-label="Complete workspace restore confirmation">
      <p>Prepared {pending.workspace.turns.length} recomputed turns and
        {' '}{pending.workspace.entries.length} review entries. This will replace all current turns and review entries.</p>
      {!unchanged && <p>Your workspace changed during validation. Import again to avoid losing edits.</p>}
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={!unchanged}
          onClick={() => {
            if (!unchanged) return;
            onRestore(pending.workspace); setPending(null);
            setFeedback({ error: false, text: 'Private workspace restored with recomputed answers.' });
          }}>Apply complete workspace</button>
        <button type="button" className="chat-button" onClick={() => setPending(null)}>Cancel workspace restore</button>
      </div>
    </section>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'}
      className={feedback.error ? 'chat-error' : 'chat-note'}>{feedback.text}</p>}
  </details>;
}
