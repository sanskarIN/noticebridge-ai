import ReviewFindings from './ReviewFindings';
import ReviewRestore from './ReviewRestore';
import type { DocumentRole, Evidence, Report } from './comparison';
import { serializeReviewCsv } from './exportCsv';
import { revisionTableReviews } from './tableReview';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';

const PdfEvidencePreview = lazy(() => import('./PdfEvidencePreview'));

type SourcePage = Pick<Evidence, 'document_id' | 'filename' | 'page'> & { uncheckedImage?: boolean };
type Preview = { url: string; file: File; source: SourcePage; evidence?: Evidence };
type ComparisonSource = 'live_upload' | 'live_demo' | 'showcase';
type CompareOptions = {
  enableOcr: boolean;
  ocrPages: Record<DocumentRole, string>;
  enableSemantic: boolean;
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SHOWCASE_ONLY = import.meta.env.MODE === 'showcase';
const DEFAULT_OPTIONS: CompareOptions = {
  enableOcr: false, ocrPages: { original: '', revised: '' }, enableSemantic: false,
};
const t = {
  title: 'Know when a notice changes.',
  detail: 'Compare two PDFs, see which deadlines and requirements changed, and open the exact source passages before you act.',
  original: 'Original notice', revised: 'Updated notice', drop: 'Select a PDF (up to 10 MiB)',
  comparisonHeading: 'Document comparison', replaceFile: '↻ Replace', browseFile: '+ Browse file',
  button: 'Compare documents', comparing: 'Comparing source passages…',
  note: 'Your PDFs are sent to this backend. Uploads may use temporary OS storage while processing; the app does not intentionally retain them permanently.',
  findings: 'Findings', confirmed: 'Matched text changes', possible: 'Possible changes',
  noFindings: 'No wording differences were identified in extractable text. This does not prove that the PDFs are equivalent.',
  insufficient: 'Comparison is inconclusive because one or both PDFs have no extractable text. Enable OCR for scanned pages or supply text-based PDFs.',
  page: 'Page', verify: 'Verify against the issuing organization before acting on a deadline or eligibility change.',
  authority: 'Authority not verified', warnings: 'Processing warnings',
  closePreview: 'Close preview', newTab: 'Open PDF in new tab', pairedPreview: 'Compare source pages',
  export: 'Export evidence report (JSON)', exportCsv: 'Export review CSV',
  invalidFile: 'Select a PDF no larger than 10 MiB.',
  ocr: 'Enable local OCR for scanned pages',
  ocrNote: 'Requires Tesseract and the configured language data on the server. Check OCR quotations against the PDF. The limit is 12 pages per PDF.',
  ocrRecovery: 'Recover text on selected pages with OCR',
  ocrRecoveryHelp: 'Use PDF page numbers such as 1, 3–5 when the embedded text is garbled or incomplete. Selected pages use OCR only and take priority within the 12-page limit per PDF.',
  ocrOriginalPages: 'Original notice OCR pages',
  ocrRevisedPages: 'Updated notice OCR pages',
  ocrSelected: 'Selected for OCR',
  ocrRecovered: 'Text extracted by OCR',
  coverageTitle: 'Text extraction coverage',
  coverageFull: 'Every PDF page yielded some text, but this does not prove every statement was captured.',
  coveragePartial: 'Some PDF pages yielded no text. Changes on those pages may be missed.',
  coverageInconclusive: 'One or both PDFs yielded no text. The comparison is inconclusive.',
  coveragePages: 'pages yielded text',
  uncovered: 'Open pages with no extracted text',
  uncheckedImages: 'Review pages with large images',
  uncheckedImageHelp: 'These pages contain some selectable text. The large images may contain more notice text.',
  openOcrSettings: 'Open selected-page OCR settings',
  fuzzyLimited: 'The comparison skipped some candidate pairings because the matching limit was reached. Check the source before interpreting unmatched statements.',
  tableReviewHeading: 'Revision tables need source review',
  tableReviewHelp: 'Earlier and revised columns were preserved as printed. These are not confirmed amendments. Check each notice against the issuer before acting.',
  tableReviewPage: 'Open source page',
  previewLoading: 'Preparing PDF viewer…',
  semantic: 'Suggest matches with local AI (experimental)',
  semanticNote: 'Optional: sends selected unmatched text excerpts to Ollama running on the backend computer (127.0.0.1:11434). This feature does not call cloud APIs. Suggestions are unverified.',
  semanticAdded: 'Local AI suggested possible passage pairings. None are verified.',
  semanticNoCandidates: 'No unmatched category-labeled passages were eligible for local AI review.',
  semanticUnavailable: 'Local AI was unavailable; deterministic findings remain available.',
  semanticRejected: 'No local AI suggestions passed source verification.',
};

async function requestComparison(
  original: File, revised: File, options: CompareOptions, signal: AbortSignal,
): Promise<Report> {
  const body = new FormData();
  body.append('original', original);
  body.append('revised', revised);
  body.append('enable_ocr', String(options.enableOcr));
  body.append('original_ocr_pages', options.ocrPages.original);
  body.append('revised_ocr_pages', options.ocrPages.revised);
  body.append('enable_semantic', String(options.enableSemantic));
  const response = await fetch('/api/compare', { method: 'POST', body, signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(typeof payload?.detail === 'string'
      ? payload.detail : `Request failed (${response.status})`);
  }
  return await response.json() as Report;
}

export default function App() {
  const [original, setOriginal] = useState<File | null>(null);
  const [revised, setRevised] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [comparisonSource, setComparisonSource] = useState<ComparisonSource>('live_upload');
  const [pending, setPending] = useState(false);
  const [enableOcr, setEnableOcr] = useState(false);
  const [ocrPages, setOcrPages] = useState<Record<DocumentRole, string>>({
    original: '', revised: '',
  });
  const [enableSemantic, setEnableSemantic] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [activePreview, setPreview] = useState<Preview[] | null>(null);
  const preview = activePreview?.length === 1 ? activePreview[0] : null;
  const comparedSources = activePreview?.length === 2 ? activePreview : null;
  const controllerRef = useRef<AbortController | null>(null);
  const closePreviewRef = useRef<HTMLButtonElement | null>(null);
  const previewDialogRef = useRef<HTMLElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const ocrRecoveryRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    return () => { activePreview?.forEach(item => URL.revokeObjectURL(item.url)); };
  }, [activePreview]);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    if (report) resultsHeadingRef.current?.focus();
  }, [report]);

  useEffect(() => {
    if (!activePreview) return;
    // Opening the dialog makes its opener inert before this effect runs.
    // Capture that element at click time, not after React updates the DOM.
    const previousFocus = previewReturnFocusRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closePreviewRef.current?.focus();

    function onPreviewKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPreview(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = previewDialogRef.current;
      if (!dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )).filter(element => element.getClientRects().length > 0);
      if (!controls.length) {
        event.preventDefault();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first ||
          !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last ||
          !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onPreviewKeyDown);
    return () => {
      document.removeEventListener('keydown', onPreviewKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [activePreview]);

  function clearComparison() {
    // Reports are valid only for the exact pair of files AND the options used
    // at submission. Prevent stale OCR/AI findings from being re-exported
    // after the user changes any comparison input.
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPending(false);
    setReport(null);
    setChecked(new Set());
    setPreview(null);
    setError('');
  }

  function setSource(role: DocumentRole, file: File | null) {
    clearComparison();
    setOcrPages(pages => ({ ...pages, [role]: '' }));
    if (file && (!file.name.toLowerCase().endsWith('.pdf') || file.size > MAX_FILE_BYTES)) {
      setError(t.invalidFile);
      if (role === 'original') setOriginal(null); else setRevised(null);
      return;
    }
    if (role === 'original') setOriginal(file); else setRevised(file);
  }

  function openSource(...sources: [SourcePage | Evidence] | [Evidence, Evidence]) {
    const selected = sources.flatMap(source => {
      const file = source.document_id === 'original' ? original : revised;
      return file ? [{ file, source }] : [];
    });
    if (selected.length !== sources.length) return;
    previewReturnFocusRef.current = document.activeElement instanceof HTMLElement ?
      document.activeElement : null;
    setPreview(selected.map(({ file, source }) => ({
      url: URL.createObjectURL(file), file, source,
      evidence: 'bbox' in source ? source : undefined,
    })));
  }

  function openSelectedPageOcr(role: DocumentRole) {
    const settings = ocrRecoveryRef.current;
    if (!settings) return;
    settings.open = true;
    settings.querySelector<HTMLInputElement>(`#ocr-${role}-pages`)?.focus();
  }

  function setReviewed(id: string, selected: boolean) {
    setChecked(previous => {
      const next = new Set(previous);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function downloadLocal(filename: string, type: string, contents: string) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportReport() {
    if (!report) return;
    const payload = {
      ...report, comparison_source: comparisonSource, review: [...checked],
      exported_at: new Date().toISOString(),
    };
    downloadLocal(
      'noticebridge-evidence-report.json', 'application/json',
      JSON.stringify(payload, null, 2),
    );
  }

  function exportReviewCsv() {
    if (!report) return;
    downloadLocal(
      'noticebridge-review.csv', 'text/csv;charset=utf-8',
      serializeReviewCsv(report, checked),
    );
  }

  async function runComparison(
    source: ComparisonSource, getReport: (signal: AbortSignal) => Promise<Report>,
  ) {
    clearComparison();
    const controller = new AbortController();
    controllerRef.current = controller;
    setComparisonSource(source);
    setPending(true);
    try {
      const result = await getReport(controller.signal);
      if (controllerRef.current === controller) setReport(result);
    } catch (cause) {
      if (controllerRef.current === controller && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Could not compare documents');
      }
    } finally {
      if (controllerRef.current === controller) {
        setPending(false);
        controllerRef.current = null;
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!original || !revised) return;
    void runComparison('live_upload', signal => requestComparison(
      original, revised, { enableOcr, ocrPages, enableSemantic }, signal,
    ));
  }

  function startDemo() {
    void runComparison(SHOWCASE_ONLY ? 'showcase' : 'live_demo', async signal => {
      const { loadShowcase } = await import('./showcase/load');
      const fixture = loadShowcase();
      signal.throwIfAborted();
      setOriginal(fixture.original);
      setRevised(fixture.revised);
      setEnableOcr(false);
      setOcrPages(DEFAULT_OPTIONS.ocrPages);
      setEnableSemantic(false);
      return SHOWCASE_ONLY
        ? fixture.report
        : requestComparison(fixture.original, fixture.revised, DEFAULT_OPTIONS, signal);
    });
  }

  const tableReviews = report ? revisionTableReviews(report) : [];

  return <div className="app-shell">
    <header className="topbar" inert={Boolean(activePreview)}>
      <div className="brand"><span className="brand-mark">N<span>↗</span></span><span>NoticeBridge <b>AI</b></span></div>
      <a className="repo-link" href="https://github.com/sanskarIN/noticebridge-ai">View source code</a>
    </header>
    <main inert={Boolean(activePreview)}>
      <section className="hero">
        <h1>{t.title}</h1>
        <p className="hero-copy">{t.detail}</p>
        <div className="showcase-actions">
          <button type="button" className="primary-button" disabled={pending} onClick={startDemo}>
            {pending && comparisonSource !== 'live_upload' ? 'Loading example…' : 'Try a fictional notice'}
            <span aria-hidden="true">→</span>
          </button>
          {!SHOWCASE_ONLY && <a href="#upload-notices">Compare your own PDFs</a>}
        </div>
        <p className="showcase-intro">
          {SHOWCASE_ONLY
            ? 'Explore a saved comparison of two fictional notices, including the source PDFs.'
            : 'See how a moved deadline, a changed fee, and an ambiguous date appear in a live comparison.'}
        </p>
        {(SHOWCASE_ONLY || comparisonSource === 'live_demo') && pending &&
          <p role="status" className="showcase-intro">Loading the fictional notices and evidence…</p>}
        {SHOWCASE_ONLY && error && <p role="alert" className="error-banner">{error}</p>}
      </section>
      {!SHOWCASE_ONLY && <section id="upload-notices" className="workspace" aria-label="PDF comparison workspace">
        <div className="section-heading"><h2>{t.comparisonHeading}</h2></div>
        <form onSubmit={submit}>
          <div className="upload-grid">
            {([['original', original, t.original], ['revised', revised, t.revised]] as const).map(([id, file, label], i) =>
              <label className="upload-card" key={id} htmlFor={id}>
                <span className="upload-icon">{i === 0 ? '01' : '02'}</span><strong>{label}</strong>
                <span className="upload-detail">{file ? file.name : t.drop}</span>
                <span className="upload-action">{file ? t.replaceFile : t.browseFile}</span>
                <input id={id} type="file" accept=".pdf,application/pdf" onChange={event => {
                  const selected = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (selected) setSource(id, selected);
                }} />
              </label>)}
          </div>
          <label className="ocr-option"><input type="checkbox" checked={enableOcr} onChange={(e) => { clearComparison(); setEnableOcr(e.target.checked); }} /><span><strong>{t.ocr}</strong><small>{t.ocrNote}</small></span></label>
          <details className="ocr-recovery" ref={ocrRecoveryRef}>
            <summary>{t.ocrRecovery}</summary>
            <p id="ocr-recovery-help">{t.ocrRecoveryHelp}</p>
            <div className="ocr-recovery-fields">
              {([['original', t.ocrOriginalPages], ['revised', t.ocrRevisedPages]] as const).map(([role, label]) =>
                <label key={role}>
                  {label}
                  <input id={`ocr-${role}-pages`} type="text" value={ocrPages[role]} maxLength={160}
                    aria-describedby="ocr-recovery-help" autoComplete="off" spellCheck={false}
                    onChange={event => {
                      clearComparison();
                      setOcrPages({ ...ocrPages, [role]: event.target.value });
                    }} />
                </label>)}
            </div>
          </details>
          <label className="ocr-option"><input type="checkbox" checked={enableSemantic} onChange={(e) => { clearComparison(); setEnableSemantic(e.target.checked); }} /><span><strong>{t.semantic}</strong><small>{t.semanticNote}</small></span></label>
          <div className="upload-footer"><p>{t.note}</p><button type="submit" disabled={!original || !revised || pending} className="primary-button">{pending ? t.comparing : t.button}<span>→</span></button></div>
          {error && <p role="alert" className="error-banner">{error}</p>}
        </form>
      </section>}
      {report && <section className="results" aria-labelledby="results-heading">
        <div className="section-heading"><div><h2 id="results-heading" ref={resultsHeadingRef} tabIndex={-1}>{t.findings}</h2></div><div className="export-actions"><button type="button" className="export-button" onClick={exportReport}>{t.export} ↓</button><button type="button" className="export-button" onClick={exportReviewCsv}>{t.exportCsv} ↓</button></div></div>
        {comparisonSource !== 'live_upload' && <p className="showcase-provenance">
          {comparisonSource === 'showcase'
            ? 'Saved comparison from the NoticeBridge engine · Fictional notices'
            : 'Live comparison · Fictional notices'}
        </p>}
        <div className="metrics">
          <div><b>{report.findings.length}</b><span>{t.findings}</span></div>
          <div><b>{report.findings.filter(f => f.status === 'confirmed_change').length}</b><span>{t.confirmed}</span></div>
          <div><b>{report.findings.filter(f => f.status === 'possible_change').length}</b><span>{t.possible}</span></div>
        </div>
        <div className="caution"><span>!</span><p>{t.verify} <strong>{t.authority}.</strong></p></div>
        {tableReviews.length > 0 && <section className="table-review-panel"
          aria-labelledby="table-review-heading">
          <h3 id="table-review-heading">{t.tableReviewHeading}</h3>
          <p>{t.tableReviewHelp}</p>
          <ul>{tableReviews.map(item => <li key={`${item.role}-${item.page}-${item.kind}`}>
            <span><strong>{t[item.role]}</strong> · {t.page} {item.page}
              {' · '}{item.kind === 'date-and-time' ? 'Date and time' : item.kind}
            </span>
            <button className="review-button" type="button"
              aria-label={`Open ${item.role} notice page ${item.page}`}
              onClick={() => openSource({
                document_id: item.role, filename: item.filename, page: item.page,
              })}>{t.tableReviewPage}</button>
          </li>)}</ul>
        </section>
        {report.semantic_assistance !== 'not_requested' && <p className="ai-feedback" role="status">
          {report.semantic_assistance === 'proposals_added' ? t.semanticAdded :
            report.semantic_assistance === 'no_candidates' ? t.semanticNoCandidates :
            report.semantic_assistance === 'unavailable' ? t.semanticUnavailable :
            t.semanticRejected}
        </p>}
        <div className={`coverage-report ${report.text_coverage}`} role="status">
          <strong>{t.coverageTitle}</strong>
          <p>{report.text_coverage === 'all_pages_have_text' ? t.coverageFull :
            report.text_coverage === 'partial' ? t.coveragePartial : t.coverageInconclusive}</p>
          <ul className="coverage-documents">{report.documents.map(d => <li key={d.id}>
            <span>{t[d.id]} · {d.filename} · {d.pages_with_text}/{d.page_count} {t.coveragePages}</span>
            {!!d.ocr_override_pages?.length && <p>{t.ocrSelected} · {d.ocr_override_pages.join(', ')}</p>}
            {!!d.ocr_pages?.length && <p>{t.ocrRecovered} · {d.ocr_pages.join(', ')}</p>}
            {d.pages_without_text.length > 0 && <details>
              <summary>{t.uncovered} ({d.pages_without_text.length})</summary>
              <div className="coverage-page-links">
                {d.pages_without_text.map(page => <button className="review-button" type="button" key={page}
                  onClick={() => openSource({ document_id: d.id, filename: d.filename, page })}>
                  {t.page} {page}
                </button>)}
              </div>
            </details>}
            {!!d.pages_with_unchecked_images?.length && <details>
              <summary>{t.uncheckedImages} ({d.pages_with_unchecked_images.length})</summary>
              <p>{t.uncheckedImageHelp}</p>
              <div className="coverage-page-links">
                {d.pages_with_unchecked_images.map(page => <button
                  className="review-button" type="button" key={page}
                  onClick={() => openSource({
                    document_id: d.id, filename: d.filename, page, uncheckedImage: true,
                  })}>
                  {t.page} {page}
                </button>)}
                {!SHOWCASE_ONLY && <button className="review-button" type="button"
                  onClick={() => openSelectedPageOcr(d.id)}>{t.openOcrSettings}</button>}
              </div>
            </details>}
          </li>)}</ul>
        </div>
        {report.fuzzy_matching_limited && <p className="coverage-report partial" role="status">{t.fuzzyLimited}</p>}
        {report.findings.length === 0 && <p className="no-findings" role="status">{report.documents.some(d => !d.has_extractable_text) ? t.insufficient : t.noFindings}</p>}
        {report.checklist.length > 0 && <ReviewRestore report={report}
          onRestore={ids => setChecked(previous => new Set([...previous, ...ids]))} />}
        {report.findings.length > 0 && <ReviewFindings
          report={report} checked={checked} onCheck={setReviewed} onOpen={openSource}
          onCompareSources={openSource}
        />}
        {report.warnings.length > 0 && <aside className="warnings"><h3>{t.warnings}</h3>{report.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</aside>}
      </section>}
    </main>
    {preview && <div className="preview-backdrop" role="presentation">
      <section ref={previewDialogRef} className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-heading">
        <div className="preview-top"><strong id="preview-heading">{preview.source.filename} · {t.page} {preview.source.page}</strong><button type="button" ref={closePreviewRef} onClick={() => setPreview(null)}>{t.closePreview} ×</button></div>
        <Suspense fallback={<p role="status">{t.previewLoading}</p>}>
          <PdfEvidencePreview file={preview.file} pageNumber={preview.source.page}
            evidence={preview.evidence} uncheckedImage={preview.source.uncheckedImage} />
        </Suspense>
        {preview.evidence && <p className="preview-quote">{preview.evidence.text}</p>}
        <a href={`${preview.url}#page=${preview.source.page}`} target="_blank" rel="noopener noreferrer">{t.newTab} ↗</a>
      </section>
    </div>}
    {comparedSources && <div className="preview-backdrop" role="presentation">
      <section ref={previewDialogRef} className="preview-dialog paired-preview"
        role="dialog" aria-modal="true" aria-labelledby="preview-heading">
        <div className="preview-top">
          <strong id="preview-heading">{t.pairedPreview}</strong>
          <button type="button" ref={closePreviewRef} onClick={() => setPreview(null)}>{t.closePreview} ×</button>
        </div>
        <div className="preview-sources">
          {comparedSources.map(({ source, file, evidence, url }) => {
            const headingId = `preview-${source.document_id}-heading`;
            return <section key={source.document_id} className="preview-source" aria-labelledby={headingId}>
              <h3 id={headingId}>
                {t[source.document_id]} · {source.filename} · {t.page} {source.page}
              </h3>
              <Suspense fallback={<p role="status">{t.previewLoading}</p>}>
                <PdfEvidencePreview file={file} pageNumber={source.page} evidence={evidence} />
              </Suspense>
              {evidence && <p className="preview-quote">{evidence.text}</p>}
              <a href={`${url}#page=${source.page}`} target="_blank" rel="noopener noreferrer"
                aria-label={`${t.newTab} · ${t[source.document_id]}`}>
                {t.newTab} ↗
              </a>
            </section>;
          })}
        </div>
      </section>
    </div>}
    <footer inert={Boolean(activePreview)}><span>NoticeBridge AI · Open-source / Apache-2.0</span><span>Understand change. Verify evidence.</span></footer>
  </div>;
}
