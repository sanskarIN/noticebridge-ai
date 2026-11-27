import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { MAX_CHECKLIST_REPORT_BYTES } from './pdfChatChecklistExchange';
import { MAX_CORPUS_SNAPSHOT_BYTES } from './pdfChatCorpusSnapshot';
import { compareChecklistRuns, replayChecklistComparison, MAX_CHECKLIST_COMPARISON_BYTES,
  type ChecklistComparison, type ChecklistComparisonInput, type QuestionComparison,
  type RoleComparison } from './pdfChatChecklistComparison';

type InputKey = 'leftReport' | 'leftSnapshot' | 'rightReport' | 'rightSnapshot' | 'comparison';
type Selection = Partial<Record<InputKey, File>>;
type Prepared = { text: string; comparison: ChecklistComparison; replayed: boolean };
const inputs: { key: InputKey; label: string; maximum: number }[] = [
  { key: 'leftReport', label: 'First checklist report JSON', maximum: MAX_CHECKLIST_REPORT_BYTES },
  { key: 'leftSnapshot', label: 'First native snapshot JSON', maximum: MAX_CORPUS_SNAPSHOT_BYTES },
  { key: 'rightReport', label: 'Second checklist report JSON', maximum: MAX_CHECKLIST_REPORT_BYTES },
  { key: 'rightSnapshot', label: 'Second native snapshot JSON', maximum: MAX_CORPUS_SNAPSHOT_BYTES },
  { key: 'comparison', label: 'Existing checklist comparison JSON (optional)', maximum: MAX_CHECKLIST_COMPARISON_BYTES },
];
const roleName = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
const className = {
  unchanged_observation: 'Unchanged retrieval observation',
  coverage_or_source_changed: 'Source fingerprint or coverage changed',
  retrieval_observation_changed: 'Retrieved observations changed',
};
const PAGE_SIZE = 8;

async function fileText(file: File | undefined, maximum: number): Promise<string> {
  if (!file || !file.size || file.size > maximum) throw new Error('Missing or oversized local input.');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size || buffer.byteLength > maximum) throw new Error('Input size mismatch.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}
async function readPair(selection: Selection, side: 'left' | 'right'): Promise<ChecklistComparisonInput> {
  return {
    report: await fileText(selection[side === 'left' ? 'leftReport' : 'rightReport'], MAX_CHECKLIST_REPORT_BYTES),
    snapshot: await fileText(selection[side === 'left' ? 'leftSnapshot' : 'rightSnapshot'], MAX_CORPUS_SNAPSHOT_BYTES),
  };
}
function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'noticebridge-checklist-observation-comparison.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function human(value: string): string { return value.replace(/_/g, ' '); }
function CountDelta({ label, value }: {
  label: string; value: RoleComparison['strict_text'];
}) {
  return <tr><th scope="row">{label}</th><td>{value.identical_observations}</td>
    <td>{value.left_only_observations}</td><td>{value.right_only_observations}</td></tr>;
}
function RoleDetails({ source }: { source: RoleComparison }) {
  return <section className="chat-comparison-role" aria-label={'Comparison for ' + roleName[source.role]}>
    <h5>{roleName[source.role]}</h5>
    <p><strong>{className[source.classification]}</strong></p>
    <p className="chat-muted">PDF fingerprint changed: {source.pdf_pin_changed ? 'Yes' : 'No'}.
      {' '}Coverage changed: {source.coverage_changed ? 'Yes' : 'No'}.</p>
    <div className="chat-table-scroll">
      <table>
        <caption>Source retrieval and coverage observations</caption>
        <thead><tr><th scope="col">Observation</th><th scope="col">First run</th><th scope="col">Second run</th></tr></thead>
        <tbody>
          <tr><th scope="row">Retrieval state</th><td>{human(source.left.state)}</td><td>{human(source.right.state)}</td></tr>
          <tr><th scope="row">Coverage</th><td>{human(source.left.coverage)}</td><td>{human(source.right.coverage)}</td></tr>
          <tr><th scope="row">Strict matches</th><td>{source.left.strict_matches}</td><td>{source.right.strict_matches}</td></tr>
          <tr><th scope="row">Displayed fragments</th><td>{source.left.displayed_fragments}</td><td>{source.right.displayed_fragments}</td></tr>
          <tr><th scope="row">Omitted strict matches</th><td>{source.left.omitted_strict_matches}</td><td>{source.right.omitted_strict_matches}</td></tr>
        </tbody>
      </table>
    </div>
    <div className="chat-table-scroll">
      <table>
        <caption>Exact displayed observation counts (not policy additions or removals)</caption>
        <thead><tr><th scope="col">Observation type</th><th scope="col">Identical</th>
          <th scope="col">First only</th><th scope="col">Second only</th></tr></thead>
        <tbody>
          <CountDelta label="Strict text" value={source.strict_text} />
          <CountDelta label="Strict text and location" value={source.strict_locations} />
          <CountDelta label="Nearby groups" value={source.context_text} />
          <CountDelta label="Nearby groups and locations" value={source.context_locations} />
        </tbody>
      </table>
    </div>
  </section>;
}
function QuestionDetails({ row }: { row: QuestionComparison }) {
  return <article className="chat-checklist-result" aria-label={'Observation comparison ' + row.question_id}>
    <div className="chat-checklist-result-header">
      <h4>{row.question_id}</h4>
      <span className="chat-checklist-state">{row.changed ? 'Different observation' : 'Unchanged observation'}</span>
    </div>
    <p className="chat-muted">Scope: {row.scope} · {row.physical_page === null ? 'All indexed physical pages' : 'Physical page ' + row.physical_page}
      {' · '}{row.nearby_fallback ? 'Nearby fallback enabled' : 'Strict only'}</p>
    <p>First run: {human(row.left_state)} · Second run: {human(row.right_state)}</p>
    {row.sources.map(source => <RoleDetails key={source.role} source={source} />)}
  </article>;
}
function SourceBindings({ comparison }: { comparison: ChecklistComparison }) {
  return <details className="chat-context-results">
    <summary>Exact input fingerprints and source coverage</summary>
    <p className="chat-muted">Fingerprints bind the supplied bytes; they do not authenticate the notice issuer.</p>
    <dl className="chat-comparison-fingerprints">
      <dt>First report SHA-256</dt><dd>{comparison.left.report_sha256}</dd>
      <dt>First snapshot SHA-256</dt><dd>{comparison.left.snapshot_sha256}</dd>
      <dt>Second report SHA-256</dt><dd>{comparison.right.report_sha256}</dd>
      <dt>Second snapshot SHA-256</dt><dd>{comparison.right.snapshot_sha256}</dd>
    </dl>
    {comparison.sources.map(source => <section key={source.role} className="chat-comparison-role">
      <h4>{roleName[source.role]}</h4>
      <p>Snapshot observation: {source.changed ? 'Different' : 'Identical'}</p>
      <dl className="chat-comparison-fingerprints">
        <dt>First PDF SHA-256</dt><dd>{source.left_pdf_sha256 ?? 'Unattached'}</dd>
        <dt>Second PDF SHA-256</dt><dd>{source.right_pdf_sha256 ?? 'Unattached'}</dd>
        <dt>First processed / physical pages</dt><dd>{source.left_processed_pages ?? '—'} / {source.left_physical_pages ?? '—'}</dd>
        <dt>Second processed / physical pages</dt><dd>{source.right_processed_pages ?? '—'} / {source.right_physical_pages ?? '—'}</dd>
        <dt>First extraction limited</dt><dd>{source.left_limited === null ? 'Unattached' : source.left_limited ? 'Yes' : 'Not flagged'}</dd>
        <dt>Second extraction limited</dt><dd>{source.right_limited === null ? 'Unattached' : source.right_limited ? 'Yes' : 'Not flagged'}</dd>
      </dl>
    </section>)}
  </details>;
}
export default function PdfChatChecklistCompare() {
  const [selection, setSelection] = useState<Selection>({});
  const [inputEpoch, setInputEpoch] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [page, setPage] = useState(1);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const ready = inputs.slice(0, 4).every(input => Boolean(selection[input.key]));
  const rows = prepared?.comparison.questions.filter(row => !onlyChanged || row.changed) ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const activePage = Math.min(page, pages);
  const displayed = rows.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);

  function reset() {
    generation.current++;
    setSelection({}); setInputEpoch(value => value + 1);
    setPrepared(null); setBusy(false); setError(''); setConsent(false); setPage(1);
  }
  function choose(event: ChangeEvent<HTMLInputElement>, key: InputKey, maximum: number) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    generation.current++;
    setPrepared(null); setBusy(false); setConsent(false); setError(''); setPage(1);
    if (file && (!file.size || file.size > maximum)) {
      setSelection(old => ({ ...old, [key]: undefined }));
      setError('The selected local file is empty or exceeds the input size limit.');
      return;
    }
    setSelection(old => ({ ...old, [key]: file }));
  }
  async function run(verify: boolean) {
    if (busy || !ready || (verify && !selection.comparison)) return;
    const token = ++generation.current;
    setBusy(true); setPrepared(null); setConsent(false); setError(''); setPage(1);
    try {
      const left = await readPair(selection, 'left');
      const right = await readPair(selection, 'right');
      let result: Prepared;
      if (verify) {
        const text = await fileText(selection.comparison, MAX_CHECKLIST_COMPARISON_BYTES);
        const comparison = await replayChecklistComparison(text, left, right);
        result = { text, comparison, replayed: true };
      } else {
        const output = await compareChecklistRuns(left, right);
        result = { ...output, replayed: false };
      }
      if (token === generation.current) setPrepared(result);
    } catch {
      if (token === generation.current) setError('Comparison rejected. Both reports must replay against their exact native snapshots and use identical questions, scopes and fallback settings.');
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  const summary = prepared?.comparison.summary;
  return <details className="chat-panel chat-checklist-comparison">
    <summary>Compare saved checklist runs offline</summary>
    <p>Choose two private checklist reports and their exact native snapshot files.
      No PDF attachment, remote service, or chat history is needed.</p>
    <p className="chat-note">This compares retrieval observations, not official requirements. A missing match does not establish absence.
      A matching excerpt does not certify an answer. Personal review notes are excluded from comparisons.</p>
    <fieldset className="chat-checklist-fieldset" disabled={busy}>
      <legend>Local input files</legend>
      <div className="chat-comparison-inputs" key={inputEpoch}>
        {inputs.map(input => <label key={input.key} className="chat-session-file">{input.label}
          <input type="file" accept=".json,application/json" onChange={event => choose(event, input.key, input.maximum)} />
          <span className="chat-muted">{selection[input.key] ? 'Local file selected · ' + selection[input.key]!.size + ' bytes' : 'No file selected'}</span>
        </label>)}
      </div>
      <div className="chat-toolbar">
        <button type="button" className="primary-button" disabled={!ready} onClick={() => void run(false)}>Compare saved checklists</button>
        <button type="button" className="chat-button" disabled={!ready || !selection.comparison}
          onClick={() => void run(true)}>Verify saved comparison</button>
      </div>
    </fieldset>
    <button type="button" className="chat-button" disabled={!Object.values(selection).some(Boolean) && !busy && !error}
      onClick={reset}>Clear comparison inputs and results</button>
    {busy && <p role="status">Replaying both local reports independently…</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {prepared && summary && <section aria-label="Saved checklist comparison results">
      <h3>{prepared.replayed ? 'Saved comparison replay verified' : 'Both checklist runs replayed'}</h3>
      <div className="chat-checklist-counts">
        {[
          [summary.questions, 'Questions'],
          [summary.changed_questions, 'Different observations'],
          [summary.unchanged_questions, 'Unchanged observations'],
          [summary.coverage_or_source_changes, 'Source or coverage changes (role pairs)'],
        ].map(([count, label]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}
      </div>
      <p className="chat-muted">{summary.retrieval_observation_changes} role pairs changed retrieval observations without a changed PDF pin or coverage.
        {' '}{summary.unchanged_role_observations} role pairs remained unchanged.</p>
      <SourceBindings comparison={prepared.comparison} />
      <label className="chat-embedding-consent"><input type="checkbox" checked={onlyChanged}
        onChange={event => { setOnlyChanged(event.target.checked); setPage(1); }} /> Show only different observations</label>
      <p className="chat-muted">{rows.length} question comparisons · page {activePage} of {pages}</p>
      {!rows.length && <p>No question comparisons match this filter.</p>}
      {displayed.map(row => <QuestionDetails key={row.question_id} row={row} />)}
      <div className="chat-toolbar">
        <button className="chat-button" type="button" disabled={activePage === 1}
          onClick={() => setPage(activePage - 1)}>Previous comparison page</button>
        <button className="chat-button" type="button" disabled={activePage === pages}
          onClick={() => setPage(activePage + 1)}>Next comparison page</button>
      </div>
      <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
        onChange={event => setConsent(event.target.checked)} /> I approve exporting private comparison identifiers and fingerprints.</label>
      <button type="button" className="chat-button" disabled={!consent} onClick={() => download(prepared.text)}>Export checklist comparison</button>
      <p className="chat-muted">The comparison JSON contains question identifiers, input fingerprints and observation counts.
        It does not include question wording, evidence quotes, or personal notes.</p>
    </section>}
  </details>;
}
