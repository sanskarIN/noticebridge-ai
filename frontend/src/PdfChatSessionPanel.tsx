import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Role, SearchIndex } from './pdfChatCore';
import {
  ChatSessionError, fingerprintSources, loadQuestionPlan, replayQuestions,
  serializeQuestionPlan, stepsFromTurns, type AttachedFiles, type ChatTurn,
} from './pdfChatSession';

function message(error: unknown): string {
  if (error instanceof ChatSessionError) {
    if (error.code === 'different') return 'The question plan requires the exact same attached PDF bytes and roles.';
    if (error.code === 'size') return 'The question plan or source file exceeds its size limit.';
    if (error.code === 'crypto') return 'Source fingerprints require HTTPS or localhost.';
  }
  return 'Invalid question plan or replay failed. Existing conversation has not been changed.';
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'noticebridge-questions.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PdfChatSessionPanel({ files, index, turns, onRestore }: {
  files: AttachedFiles; index: SearchIndex; turns: ChatTurn[]; onRestore: (turns: ChatTurn[]) => void;
}) {
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<ChatTurn[] | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => () => { generation.current++; }, []);

  async function save() {
    const token = ++generation.current;
    setBusy(true);
    setCandidate(null);
    setFeedback(null);
    try {
      const pins = await fingerprintSources(files);
      const text = serializeQuestionPlan(pins, stepsFromTurns(turns));
      if (token === generation.current) {
        download(text);
        setFeedback({ text: 'Question plan exported locally.', error: false });
      }
    } catch (error) {
      if (token === generation.current) setFeedback({ text: message(error), error: true });
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  async function restore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const token = ++generation.current;
    setBusy(true);
    setCandidate(null);
    setFeedback(null);
    try {
      const pins = await fingerprintSources(files);
      const steps = await loadQuestionPlan(file, pins);
      const attached = Object.keys(pins) as Role[];
      const recomputed = replayQuestions(index, steps, attached);
      if (token === generation.current) setCandidate(recomputed);
    } catch (error) {
      if (token === generation.current) setFeedback({ text: message(error), error: true });
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  return <section className="chat-session" aria-label="Local question plan">
    <h3>Save or replay your questions</h3>
    <p className="chat-muted">Exports contain your question text, search settings and PDF fingerprints,
      but not the PDF files, extracted quotes or stored answers. Keep the file private if questions
      contain personal details. Replay requires exactly matching source bytes and recomputes every answer.</p>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={!turns.length || busy}
        onClick={() => void save()}>Export question plan JSON</button>
      <label className="chat-session-file">Replay saved question plan
        <input type="file" accept=".json,application/json" disabled={busy} onChange={event => void restore(event)} />
      </label>
    </div>
    {busy && <p role="status">Checking local source fingerprints…</p>}
    {candidate && <div className="chat-note" role="region" aria-label="Replay confirmation">
      <p>Recomputed {candidate.length} saved questions or turns. Applying them replaces the
        current {turns.length} turns. No PDF or saved answer has been imported.</p>
      <div className="chat-toolbar">
        <button type="button" className="chat-button" onClick={() => {
          onRestore(candidate);
          setCandidate(null);
          setFeedback({ text: 'Replayed question plan applied.', error: false });
        }}>Apply replayed conversation</button>
        <button type="button" className="chat-button" onClick={() => setCandidate(null)}>Cancel replay</button>
      </div>
    </div>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'}
      className={feedback.error ? 'chat-error' : 'chat-note'}>{feedback.text}</p>}
  </section>;
}
