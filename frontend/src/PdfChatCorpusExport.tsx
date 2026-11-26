import { useEffect, useRef, useState } from 'react';
import { serializeCorpusSnapshot } from './pdfChatCorpusSnapshot';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';

export default function PdfChatCorpusExport({ files, corpora }: {
  files: AttachedFiles; corpora: ChatCorpora;
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function save() {
    if (!consent || busy) return;
    const token = ++generation.current;
    setBusy(true); setError('');
    try {
      const pins = await fingerprintSources(files);
      const text = serializeCorpusSnapshot(pins, corpora);
      if (token !== generation.current) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'noticebridge-native-corpus.json';
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (token === generation.current) setError('The native corpus could not be exported within the evaluation limits.');
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  return <details className="chat-session chat-embedding-panel">
    <summary>Research: export private native index</summary>
    <p className="chat-note">For independent retrieval annotation only. This file includes all
      indexed native text, extraction coverage, PDF fingerprints and optional layout hints.
      It does not contain PDF bytes, OCR review data or model results. Keep it private; do
      not export confidential documents to a public dataset.</p>
    <p className="chat-muted">Index identities are role, physical page and fragment ordinal.
      Reviewers must inspect the actual PDFs before labeling evidence. The snapshot itself
      is not proof of extraction completeness or authority.</p>
    <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
      disabled={busy} onChange={event => setConsent(event.target.checked)} />
      I approve exporting the full private native index for offline evaluation.</label>
    <button type="button" className="chat-button" disabled={!consent || busy}
      onClick={() => void save()}>Export native evaluation corpus</button>
    {busy && <p role="status">Preparing private corpus…</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
  </details>;
}
