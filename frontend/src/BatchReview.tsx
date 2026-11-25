import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  BatchReadError, checkManifest, coverageNames, inspectReport, readIndex,
  statuses, statusNames, type BatchIndex, type CaseSummary, type FindingPreview,
  type ReportPreview, type Status,
} from './batchIndex';
import './batchReview.css';

const messages: Record<BatchReadError['code'], string> = {
  format: 'This file does not match the supported local batch format.',
  size: 'This file is empty or exceeds the local viewer size limit.',
  hash: 'The selected bytes do not match the saved fingerprint.',
  counts: 'The saved totals and individual records disagree.',
  crypto: 'Local SHA-256 checking requires a secure browser context (HTTPS or localhost).',
  source: 'The document roles or saved source fingerprints disagree.',
};

function errorMessage(error: unknown): string {
  return error instanceof BatchReadError ? messages[error.code] : 'Unable to read the local file.';
}

function Hash({ value }: { value: string }) {
  return <code className="batch-hash">{value}</code>;
}

function SourceQuote({ title, quote }: {
  title: string; quote: FindingPreview['original'];
}) {
  return <div className="batch-quote">
    <h4>{title}</h4>
    {quote ? <><p className="batch-muted">Saved page reference: {quote.page}</p>
      <blockquote>{quote.text}</blockquote></> : <p className="batch-muted">No saved passage.</p>}
  </div>;
}

function CaseDetails({ row, manifestMatched }: { row: CaseSummary; manifestMatched: boolean }) {
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  async function selectReport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const token = ++generation.current;
    setPreview(null);
    setFeedback('');
    setFilter('all');
    setLoading(true);
    try {
      const result = await inspectReport(file, row);
      if (token === generation.current) setPreview(result);
    } catch (error) {
      if (token === generation.current) setFeedback(errorMessage(error));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }

  function clearReport() {
    generation.current++;
    setPreview(null);
    setFeedback('');
    setLoading(false);
  }

  const displayed = preview?.findings.filter(finding => filter === 'all' || finding.status === filter);
  return <section className="batch-panel" aria-labelledby="batch-case-title">
    <h2 id="batch-case-title">Case {row.number}</h2>
    <p className="batch-muted">Expected report: {row.reportName}</p>
    <dl className="batch-details">
      <div><dt>Original PDF fingerprint</dt><dd><Hash value={row.sources.original} /></dd></div>
      <div><dt>Revised PDF fingerprint</dt><dd><Hash value={row.sources.revised} /></dd></div>
      <div><dt>Report fingerprint</dt><dd><Hash value={row.reportHash} /></dd></div>
    </dl>
    <p>{manifestMatched ? 'Manifest bytes match the saved index.'
      : 'Manifest not checked. Fingerprints above are claims from the saved index.'}</p>
    <div className="batch-file-row">
      <label className="batch-file-control">Select saved case report (up to 8 MiB)
        <input type="file" accept=".json,application/json" onChange={selectReport} />
      </label>
      <button type="button" className="batch-secondary" onClick={clearReport}
        disabled={!loading && !preview && !feedback}>Clear report</button>
    </div>
    {loading && <p role="status">Checking report bytes and saved counters…</p>}
    {feedback && <p role="alert" className="batch-error">{feedback}</p>}
    {preview && <div className="batch-report">
      <p role="status" className="batch-note">
        Report bytes match the saved digest and the checked counters agree. The PDF sources
        and engine results have not been independently replayed in this browser.
      </p>
      <div className="batch-toolbar">
        <label>Saved finding type
          <select value={filter} onChange={event => setFilter(event.target.value as Status | 'all')}>
            <option value="all">All findings</option>
            {statuses.map(name => <option key={name} value={name}>{statusNames[name]}</option>)}
          </select>
        </label>
        <span className="batch-muted">{displayed?.length ?? 0} shown of {preview.count} saved</span>
      </div>
      {preview.truncated && <p className="batch-note">Only the first 100 saved findings are
        available in this preview. Use the offline tools for the full report.</p>}
      {!displayed?.length && <p>No saved findings in this view.</p>}
      <div className="batch-finding-list">
        {displayed?.map(finding => <article className="batch-finding" key={finding.number}>
          <h3>Finding {finding.number} · {statusNames[finding.status]}</h3>
          <p className="batch-muted">Saved category: {finding.category}</p>
          <div className="batch-quote-grid">
            {finding.supporting.length ? finding.supporting.map((quote, i) =>
              <SourceQuote key={i} quote={quote}
                title={quote.role === 'original' ? 'Original notice' : 'Updated notice'} />) :
              <>
                <SourceQuote title="Original notice" quote={finding.original} />
                <SourceQuote title="Updated notice" quote={finding.revised} />
              </>}
          </div>
        </article>)}
      </div>
    </div>}
  </section>;
}

export default function BatchReview() {
  const [index, setIndex] = useState<BatchIndex | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [manifestMatched, setManifestMatched] = useState(false);
  const [indexLoading, setIndexLoading] = useState(false);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [indexError, setIndexError] = useState('');
  const [manifestError, setManifestError] = useState('');
  const [coverageFilter, setCoverageFilter] = useState<'all' | 'limited'>('all');
  const generation = useRef(0);
  const manifestGeneration = useRef(0);
  useEffect(() => () => { generation.current++; manifestGeneration.current++; }, []);

  function clear() {
    generation.current++;
    manifestGeneration.current++;
    setIndex(null);
    setSelected(null);
    setManifestMatched(false);
    setIndexLoading(false);
    setManifestLoading(false);
    setIndexError('');
    setManifestError('');
    setCoverageFilter('all');
  }

  async function selectIndex(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    clear();
    const token = generation.current;
    setIndexLoading(true);
    try {
      const result = await readIndex(file);
      if (token !== generation.current) return;
      setIndex(result);
      setSelected(result.cases[0]?.number ?? null);
    } catch (error) {
      if (token === generation.current) setIndexError(errorMessage(error));
    } finally {
      if (token === generation.current) setIndexLoading(false);
    }
  }

  async function selectManifest(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !index) return;
    const token = ++manifestGeneration.current;
    const indexToken = generation.current;
    const current = () => token === manifestGeneration.current && indexToken === generation.current;
    setManifestMatched(false);
    setManifestError('');
    setManifestLoading(true);
    try {
      await checkManifest(file, index);
      if (current()) setManifestMatched(true);
    } catch (error) {
      if (current()) setManifestError(errorMessage(error));
    } finally {
      if (current()) setManifestLoading(false);
    }
  }

  const selectedRow = index?.cases.find(row => row.number === selected);
  const visibleRows = index?.cases.filter(
    row => coverageFilter === 'all' || row.coverage !== 'all_pages_have_text',
  );

  return <div className="app-shell batch-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">N</span><span>NoticeBridge <b>AI</b></span></div>
      <a className="repo-link" href="?">Return to comparison</a>
    </header>
    <main className="batch-main">
      <section className="batch-intro">
        <p className="batch-eyebrow">LOCAL REVIEW WORKSPACE</p>
        <h1>Inspect a saved batch</h1>
        <p>Open the index produced by the offline batch command, inspect saved counts
          and optionally check the manifest and individual report fingerprints.</p>
        <p className="batch-note">Files selected here stay in this browser session. Saved counts and
          quotations are not proof of accuracy, PDF authenticity or official authority.
          Use the offline verify command to independently replay a complete batch.</p>
      </section>
      <section className="batch-panel" aria-labelledby="batch-input-title">
        <h2 id="batch-input-title">1. Choose index.json</h2>
        <div className="batch-file-row">
          <label className="batch-file-control">Batch index (up to 128 KiB)
            <input type="file" accept=".json,application/json" onChange={selectIndex} />
          </label>
          <button className="batch-secondary" type="button" onClick={clear}
            disabled={!index && !indexLoading && !indexError}>Clear workspace</button>
        </div>
        {indexLoading && <p role="status">Reading saved index…</p>}
        {indexError && <p role="alert" className="batch-error">{indexError}</p>}
      </section>
      {index && <>
        <section className="batch-panel" aria-labelledby="batch-summary-title">
          <h2 id="batch-summary-title">2. Saved batch summary</h2>
          <p role="status" className={index.complete ? 'batch-note' : 'batch-error'}>
            {index.complete ? 'Index records a completed batch.' :
              'Incomplete batch: the index records only a completed prefix.'}
            {' '}{index.completed} of {index.total} cases saved. Issuer authority not verified.
          </p>
          <dl className="batch-metrics">
            {statuses.map(name => <div key={name}>
              <dt>{statusNames[name]}</dt><dd>{index.counts[name]}</dd>
            </div>)}
          </dl>
          <p className="batch-muted">Saved counts are not accuracy metrics. Pages yielding some
            text may still omit image-based or incorrectly encoded content.</p>
          <h3>Optional manifest check</h3>
          <p className="batch-muted">Expected manifest fingerprint:</p>
          <Hash value={index.manifestHash} />
          <label className="batch-file-control">Pinned manifest JSON (up to 64 KiB)
            <input type="file" accept=".json,application/json" onChange={selectManifest} />
          </label>
          {manifestLoading && <p role="status">Checking manifest bytes…</p>}
          {manifestMatched && <p role="status" className="batch-note">
            Manifest bytes and listed source pins match the saved index. PDF bytes not checked.
          </p>}
          {manifestError && <p role="alert" className="batch-error">{manifestError}</p>}
        </section>
        <section className="batch-panel" aria-labelledby="batch-list-title">
          <div className="batch-toolbar">
            <h2 id="batch-list-title">3. Completed cases</h2>
            <label>Text coverage filter
              <select value={coverageFilter}
                onChange={e => setCoverageFilter(e.target.value as 'all' | 'limited')}>
                <option value="all">All completed cases</option>
                <option value="limited">Partial or inconclusive only</option>
              </select>
            </label>
          </div>
          {!visibleRows?.length ? <p>No completed cases match this view.</p> :
            <div className="batch-table-wrap">
              <table className="batch-table">
                <caption>Saved case counts and extraction coverage</caption>
                <thead><tr><th scope="col">Case</th><th scope="col">Findings</th>
                  <th scope="col">Review tasks</th><th scope="col">Warnings</th>
                  <th scope="col">Text coverage</th><th scope="col">Inspect</th></tr></thead>
                <tbody>{visibleRows.map(row => <tr key={row.number}>
                  <th scope="row">{row.number}</th><td>{row.findings}</td>
                  <td>{row.reviewTasks}</td><td>{row.warnings}</td>
                  <td>{coverageNames[row.coverage]}</td>
                  <td><button type="button" className="batch-secondary"
                    aria-pressed={selected === row.number}
                    onClick={() => setSelected(row.number)}>Case {row.number} details</button></td>
                </tr>)}</tbody>
              </table>
            </div>}
        </section>
        {selectedRow && <CaseDetails key={selectedRow.number + ':' + selectedRow.reportHash}
          row={selectedRow} manifestMatched={manifestMatched} />}
      </>}
      <footer className="batch-footer">Local file inspection only · No issuer authentication · No engine replay</footer>
    </main>
  </div>;
}
