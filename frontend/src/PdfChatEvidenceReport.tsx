import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { SearchIndex } from './pdfChatCore';
import { ChatSessionError, fingerprintSources, type AttachedFiles, type ChatTurn } from './pdfChatSession';
import { EvidenceReportError, exportEvidenceReport, readEvidenceReport, verifyEvidenceReport,
  type ChatCorpora, type EvidenceReplaySummary } from './pdfChatEvidenceReport';

function message(error: unknown): string {
  if (error instanceof ChatSessionError) {
    if (error.code === 'different') return 'The report requires exactly the same PDF bytes and source roles.';
    if (error.code === 'crypto') return 'Source fingerprinting requires HTTPS or localhost.';
  }
  if (error instanceof EvidenceReportError) {
    if (error.code === 'size') return 'The evidence report exceeds the local file limit.';
    if (error.code === 'mismatch') return 'Evidence or extraction coverage differs from the current deterministic replay.';
  }
  return 'The evidence report is invalid or could not be replayed.';
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'noticebridge-chat-evidence.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PdfChatEvidenceReport({ files, corpora, index, turns }: {
  files: AttachedFiles; corpora: ChatCorpora; index: SearchIndex; turns: ChatTurn[];
}) {
  const generation = useRef(0);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [summary, setSummary] = useState<EvidenceReplaySummary | null>(null);
  useEffect(() => () => { generation.current++; }, []);

  async function save() {
    if (!consent || busy || !turns.length) return;
    const token = ++generation.current;
    setBusy(true); setFeedback(null); setSummary(null);
    try {
      const pins = await fingerprintSources(files);
      const text = exportEvidenceReport(pins, corpora, index, turns);
      if (generation.current === token) download(text);
    } catch (error) {
      if (generation.current === token) setFeedback(message(error));
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  async function verify(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
    const token = ++generation.current;
    setBusy(true); setFeedback(null); setSummary(null);
    try {
      const text = await readEvidenceReport(file);
      const pins = await fingerprintSources(files);
      const result = verifyEvidenceReport(text, pins, corpora, index);
      if (generation.current === token) setSummary(result);
    } catch (error) {
      if (generation.current === token) setFeedback(message(error));
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  return <details className="chat-session chat-embedding-panel">
    <summary>Export or verify a private evidence report</summary>
    <p className="chat-note">Unlike a question plan, this report contains exact extracted quotations,
      questions and PDF fingerprints. It may contain sensitive information. Keep it private.
      No PDF bytes are included and no data is sent to a server.</p>
    <p className="chat-muted">Only deterministic search citations, printed fields and extraction
      coverage are replayed. Concise field summaries, category tables, cross-page leads and optional
      model results are excluded. Verification is reproducibility, not proof of correctness,
      document authenticity or official authority.</p>
    <label className="chat-embedding-consent">
      <input type="checkbox" checked={consent} disabled={busy}
        onChange={event => setConsent(event.target.checked)} />
      I understand this export includes source quotations.
    </label>
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={!consent || busy || !turns.length}
        onClick={() => void save()}>Export evidence report JSON</button>
      <label className="chat-session-file">Verify saved evidence report
        <input type="file" accept=".json,application/json" disabled={busy}
          onChange={event => void verify(event)} />
      </label>
    </div>
    {busy && <p role="status">Replaying deterministic evidence locally…</p>}
    {feedback && <p role="alert" className="chat-error">{feedback} The conversation is unchanged.</p>}
    {summary && <div role="status" className="chat-note">
      <strong>Exact deterministic replay matched.</strong>
      <p>{summary.turns} turns, {summary.questions} questions, {summary.citations} citations,
        {' '}{summary.insufficient} insufficient-evidence results.</p>
      <p>No stored answer was imported. Current conversation unchanged.</p>
    </div>}
  </details>;
}
