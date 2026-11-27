import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { MAX_CORPUS_SNAPSHOT_BYTES } from './pdfChatCorpusSnapshot';
import { MAX_CHECKLIST_REPORT_BYTES } from './pdfChatChecklistExchange';
import { readPdf } from './pdfChatExtract';
import { MAX_REPLAY_PDF_BYTES, MAX_SOURCE_REPLAY_REPORT_BYTES,
  replayNativeSources, verifyNativeSourceReplay, type RoleReplay, type ReplayProgress,
  type SourceReplayResult } from './pdfChatSourceReplay';
import type { AttachedFiles } from './pdfChatSession';

type Slot = 'snapshot' | 'original' | 'revised' | 'checklist' | 'replay';
type Selection = Partial<Record<Slot, File>>;
const fields: { key: Slot; label: string; maximum: number; accept: string }[] = [
  { key: 'snapshot', label: 'Native snapshot to reproduce', maximum: MAX_CORPUS_SNAPSHOT_BYTES, accept: '.json,application/json' },
  { key: 'original', label: 'Replay original PDF', maximum: MAX_REPLAY_PDF_BYTES, accept: '.pdf,application/pdf' },
  { key: 'revised', label: 'Replay revised PDF', maximum: MAX_REPLAY_PDF_BYTES, accept: '.pdf,application/pdf' },
  { key: 'checklist', label: 'Associated private checklist (optional)', maximum: MAX_CHECKLIST_REPORT_BYTES, accept: '.json,application/json' },
  { key: 'replay', label: 'Existing source replay report (optional)', maximum: MAX_SOURCE_REPLAY_REPORT_BYTES, accept: '.json,application/json' },
];
const states: Record<RoleReplay['state'], string> = {
  exact_replay: 'PDF bytes and native extraction reproduced',
  different_pdf_bytes: 'PDF fingerprint differs',
  different_extraction: 'Matching PDF bytes, different native extraction',
  missing_pdf: 'Required PDF was not selected',
  unexpected_pdf: 'PDF selected for a role absent from the snapshot',
  extraction_failed: 'Matching PDF bytes, extraction unavailable',
};
const roleLabels = { original: 'Original / first role', revised: 'Updated / second role' };
async function localText(file: File, limit: number): Promise<string> {
  if (!file.size || file.size > limit) throw new Error('Invalid file size.');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size || buffer.byteLength > limit) throw new Error('Invalid file size.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}
function pageList(values: number[]): string { return values.length ? values.join(', ') : 'None recorded'; }
function yes(value: boolean): string { return value ? 'Yes' : 'No'; }
function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'noticebridge-native-source-replay.json';
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function RoleResult({ row }: { row: RoleReplay }) {
  return <section className="chat-comparison-role" aria-label={'Replay result ' + row.role}>
    <h4>{roleLabels[row.role]}</h4>
    <p><strong>{states[row.state]}</strong></p>
    <dl className="chat-comparison-fingerprints">
      <dt>Expected PDF SHA-256</dt><dd>{row.expected_sha256 ?? 'Not in snapshot'}</dd>
      <dt>Observed PDF SHA-256</dt><dd>{row.observed_sha256 ?? 'Not selected'}</dd>
      <dt>Observed bytes</dt><dd>{row.byte_count ?? 'Not selected'}</dd>
    </dl>
    {row.coverage && <div className="chat-table-scroll">
      <table>
        <caption>Native extraction coverage (not a completeness certificate)</caption>
        <thead><tr><th scope="col">Measure</th><th scope="col">Snapshot</th><th scope="col">Fresh extraction</th></tr></thead>
        <tbody>
          <tr><th scope="row">Physical pages</th><td>{row.coverage.expected_physical_pages}</td><td>{row.coverage.observed_physical_pages}</td></tr>
          <tr><th scope="row">Processed pages</th><td>{row.coverage.expected_processed_pages}</td><td>{row.coverage.observed_processed_pages}</td></tr>
          <tr><th scope="row">Limit flagged</th><td>{yes(row.coverage.expected_limited)}</td><td>{yes(row.coverage.observed_limited)}</td></tr>
          <tr><th scope="row">Missing text pages</th><td>{pageList(row.coverage.expected_missing_pages)}</td><td>{pageList(row.coverage.observed_missing_pages)}</td></tr>
          <tr><th scope="row">Limited pages</th><td>{pageList(row.coverage.expected_limited_pages)}</td><td>{pageList(row.coverage.observed_limited_pages)}</td></tr>
        </tbody>
      </table>
    </div>}
    {row.fragments && <dl className="chat-comparison-fingerprints">
      <dt>Expected / fresh fragments</dt><dd>{row.fragments.expected_fragments} / {row.fragments.observed_fragments}</dd>
      <dt>Identical text and layout</dt><dd>{row.fragments.identical_fragments}</dd>
      <dt>Different text at same identity</dt><dd>{row.fragments.changed_text}</dd>
      <dt>Different layout at same identity</dt><dd>{row.fragments.changed_geometry}</dd>
      <dt>Snapshot-only identities</dt><dd>{row.fragments.expected_only}</dd>
      <dt>Fresh-only identities</dt><dd>{row.fragments.observed_only}</dd>
    </dl>}
    {row.fragments && <p className="chat-muted">Text and layout difference counts may overlap.
      Fragment identity changes are not proof of added or removed requirements.</p>}
  </section>;
}

export default function PdfChatSourceReplay() {
  const [selection, setSelection] = useState<Selection>({});
  const [result, setResult] = useState<SourceReplayResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [stage, setStage] = useState<ReplayProgress | null>(null);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; active.current?.abort(); }, []);
  function invalidate() {
    generation.current++;
    active.current?.abort();
    active.current = null;
    setBusy(false); setResult(null); setVerified(false); setConsent(false); setStage(null); setError('');
  }
  function choose(event: ChangeEvent<HTMLInputElement>, key: Slot, maximum: number) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    invalidate();
    if (file && (!file.size || file.size > maximum ||
      ((key === 'original' || key === 'revised') && !file.name.toLowerCase().endsWith('.pdf')))) {
      setSelection(old => ({ ...old, [key]: undefined }));
      setError('Selected file is empty, oversized, or not a PDF for the selected role.');
      return;
    }
    setSelection(old => ({ ...old, [key]: file }));
  }
  function clear(key: Slot) {
    invalidate();
    setSelection(old => ({ ...old, [key]: undefined }));
  }
  async function run(verify: boolean) {
    if (!selection.snapshot || busy || (verify && !selection.replay)) return;
    invalidate();
    const token = generation.current;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const snapshot = await localText(selection.snapshot, MAX_CORPUS_SNAPSHOT_BYTES);
      controller.signal.throwIfAborted();
      const checklistReport = selection.checklist
        ? await localText(selection.checklist, MAX_CHECKLIST_REPORT_BYTES) : undefined;
      controller.signal.throwIfAborted();
      const files: AttachedFiles = { original: selection.original, revised: selection.revised };
      const options = { signal: controller.signal, extract: readPdf, checklistReport,
        onProgress: (next: ReplayProgress) => { if (token === generation.current) setStage(next); } };
      const replayed = verify
        ? await verifyNativeSourceReplay(await localText(selection.replay!, MAX_SOURCE_REPLAY_REPORT_BYTES),
          snapshot, files, options)
        : await replayNativeSources(snapshot, files, options);
      if (token === generation.current) {
        setResult(replayed);
        setVerified(verify);
      }
    } catch {
      if (token === generation.current && !controller.signal.aborted) {
        setError('Source replay rejected. Check the exact local files, JSON format, role selection, and browser processing limits.');
      }
    } finally {
      if (token === generation.current) {
        setBusy(false); setStage(null); active.current = null;
      }
    }
  }
  const report = result?.report;
  return <details className="chat-panel chat-source-replay">
    <summary>Reproduce a native snapshot from actual PDFs</summary>
    <p>Select the saved native snapshot and the corresponding PDF files for their original roles.
      Each PDF is hashed locally, then freshly extracted only when its fingerprint matches.
      This does not modify your attached chat documents, or call a remote service.</p>
    <p className="chat-note">Matching PDF bytes and native extraction do not prove official authority, complete text,
      correct reading order, or answer accuracy. A missing or different PDF cannot be substituted with another role.</p>
    <fieldset className="chat-checklist-fieldset" disabled={busy}>
      <legend>Independently selected local files</legend>
      <div className="chat-comparison-inputs">
        {fields.map(field => <div className="chat-context-results" key={field.key}>
          <label className="chat-session-file">{field.label}
            <input type="file" accept={field.accept} onChange={event => choose(event, field.key, field.maximum)} />
          </label>
          <p className="chat-muted">{selection[field.key] ? 'Selected · ' + selection[field.key]!.size + ' bytes' : 'No file selected'}</p>
          <button className="chat-button" type="button" disabled={!selection[field.key]} onClick={() => clear(field.key)}>
            Remove {field.label.toLowerCase()}
          </button>
        </div>)}
      </div>
      <div className="chat-toolbar">
        <button type="button" className="primary-button" disabled={!selection.snapshot} onClick={() => void run(false)}>
          Reproduce native snapshot
        </button>
        <button type="button" className="chat-button" disabled={!selection.snapshot || !selection.replay}
          onClick={() => void run(true)}>Verify existing source replay report</button>
      </div>
    </fieldset>
    <div className="chat-toolbar">
      {busy && <button type="button" className="chat-button" onClick={invalidate}>Cancel source replay</button>}
      <button type="button" className="chat-button" disabled={!Object.values(selection).some(Boolean) && !error}
        onClick={() => { invalidate(); setSelection({}); }}>Clear source replay files and results</button>
    </div>
    {busy && <p role="status">{stage ? roleLabels[stage.role] + ' · ' + stage.stage : 'Reading local snapshot…'}</p>}
    {error && <p className="chat-error" role="alert">{error}</p>}
    {report && <section aria-label="Native source replay results">
      <h3>{report.status === 'exact_replay' ? 'Exact source replay reproduced' : 'Source replay not fully reproduced'}</h3>
      {verified && <p className="chat-note">The supplied replay report exactly matches this fresh run.
        A reproduced failure report still describes a failure.</p>}
      <dl className="chat-comparison-fingerprints">
        <dt>Snapshot SHA-256</dt><dd>{report.snapshot_sha256}</dd>
        <dt>Source roles match</dt><dd>{yes(report.source_roles_match)}</dd>
        <dt>Every PDF fingerprint matches</dt><dd>{yes(report.all_pdf_bytes_match)}</dd>
        <dt>Every native extraction matches</dt><dd>{yes(report.all_native_extractions_match)}</dd>
        <dt>Official authority verified</dt><dd>No</dd>
        <dt>Extraction completeness verified</dt><dd>No</dd>
        <dt>Answer accuracy verified</dt><dd>No</dd>
      </dl>
      {report.sources.map(row => <RoleResult key={row.role} row={row} />)}
      {report.checklist && <section className="chat-context-results" aria-label="Associated checklist replay">
        <h4>Associated checklist</h4>
        <p>Replays from saved native snapshot: {yes(report.checklist.snapshot_replay_matches)}</p>
        <p>Also bound to reproduced PDF bytes and extraction: {yes(report.checklist.actual_pdf_replay_matches)}</p>
        {report.checklist.summary && <p>{report.checklist.summary.questions} questions · {report.checklist.summary.citations} displayed fragments</p>}
        <p className="chat-muted">No source quotations or review notes are displayed in this diagnostic.</p>
      </section>}
      <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
        onChange={event => setConsent(event.target.checked)} /> I approve exporting private source fingerprints and extraction diagnostics.</label>
      <button type="button" className="chat-button" disabled={!consent} onClick={() => result && download(result.text)}>
        Export native source replay report
      </button>
    </section>}
  </details>;
}
