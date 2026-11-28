import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { SearchIndex } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';
import type { ReviewEntry } from './pdfChatReviewWorkspace';
import { buildEvidencePacket, readEvidencePacket, renderPacketHtml, type EvidencePacket } from './pdfChatReviewPacket';
import { serializeCorpusSnapshot } from './pdfChatCorpusSnapshot';

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function PdfChatReviewPacket({ index, files, corpora, entries }: {
  index: SearchIndex; files: AttachedFiles; corpora: ChatCorpora; entries: ReviewEntry[];
}) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<{ packet: EvidencePacket; entries: ReviewEntry[] } | null>(null);
  const [verified, setVerified] = useState<EvidencePacket | null>(null);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  async function prepare() {
    if (!consent || busy || !entries.length) return;
    const token = ++epoch.current;
    setBusy(true); setError(''); setPrepared(null); setVerified(null);
    try {
      const pins = await fingerprintSources(files);
      const packet = await buildEvidencePacket(index, pins, corpora, entries, consent);
      if (epoch.current === token) setPrepared({ packet, entries });
    } catch {
      if (epoch.current === token) setError('Unable to create a consistent private evidence packet.');
    } finally { if (epoch.current === token) setBusy(false); }
  }
  async function verify(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
    const token = ++epoch.current;
    setBusy(true); setError(''); setVerified(null); setPrepared(null);
    try {
      const snapshot = serializeCorpusSnapshot(await fingerprintSources(files), corpora);
      const result = await readEvidencePacket(file, snapshot);
      if (epoch.current === token) setVerified(result.packet);
    } catch {
      if (epoch.current === token) setError('Packet rejected. Its text, metadata and source binding must match the attached PDF index.');
    } finally { if (epoch.current === token) setBusy(false); }
  }
  const ready = consent && prepared && prepared.entries === entries;
  return <details className="chat-session chat-embedding-panel">
    <summary>Export or verify private evidence review packet</summary>
    <p className="chat-note">Unlike the editable review notebook, this packet includes exact
      native source excerpts, review statuses, notes, source fingerprints and coverage.
      Export only when you intend to retain these private excerpts. The printable copy
      contains no active scripts, links or external resources.</p>
    <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
      disabled={busy} onChange={event => { setConsent(event.target.checked); setPrepared(null); }} />
      I approve exporting selected private source excerpts and personal notes.</label>
    <button type="button" className="chat-button" disabled={!consent || busy || !entries.length}
      onClick={() => void prepare()}>Prepare private evidence packet</button>
    {prepared && !ready && <p className="chat-note">The review changed. Prepare a new packet before exporting.</p>}
    {ready && <section aria-label="Prepared private evidence packet">
      <p>{prepared.packet.entries.length} source-bound review entries prepared.</p>
      <div className="chat-toolbar">
        <button className="chat-button" type="button" onClick={() => download(JSON.stringify(prepared.packet, null, 2) + '\n',
          'noticebridge-evidence-packet.json', 'application/json')}>Download verifiable evidence packet</button>
        <button className="chat-button" type="button" onClick={() => {
          try { download(renderPacketHtml(prepared.packet), 'noticebridge-evidence-packet.html', 'text/html'); }
          catch { setError('Unable to produce the bounded printable copy.'); }
        }}>Download printable evidence packet</button>
      </div>
      <p className="chat-muted">The JSON is the consistency-checkable artifact. The HTML is a reading copy.
        Save the exact native corpus separately using the research export if offline verification is needed.</p>
    </section>}
    <label className="chat-session-file">Verify evidence packet against attached PDFs
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event => void verify(event)} />
    </label>
    {verified && <section className="chat-note" aria-label="Evidence packet consistency result">
      <p>All {verified.entries.length} packet entries match the exact local extraction and PDF fingerprints.</p>
      <p>This verifies internal source binding, not official authority or the correctness of personal notes.
        The current review workspace has not been modified.</p>
    </section>}
    {busy && <p role="status">Checking packet source fingerprints…</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
  </details>;
}
