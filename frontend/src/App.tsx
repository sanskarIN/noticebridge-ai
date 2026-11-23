import ReviewFindings from './ReviewFindings';
import ReviewRestore from './ReviewRestore';
import type { DocumentRole, Evidence, Language, Report } from './comparison';
import { serializeReviewCsv } from './exportCsv';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';

const PdfEvidencePreview = lazy(() => import('./PdfEvidencePreview'));

type SourcePage = Pick<Evidence, 'document_id' | 'filename' | 'page'>;
type Preview = { url: string; file: File; source: SourcePage; evidence?: Evidence };

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const translations = {
  en: {
    eyebrow: 'EVIDENCE-FIRST DOCUMENT INTELLIGENCE',
    title: 'Understand what changed.', subtitle: 'Know what to do. Verify the evidence.',
    detail: 'Compare two official PDFs and inspect the original passages behind every finding. No invented citations. No automatic authority claims.',
    original: 'Original notice', revised: 'Updated notice', drop: 'Select a PDF (up to 10 MiB)',
    comparisonHeading: 'Document comparison', replaceFile: '↻ Replace', browseFile: '+ Browse file',
    button: 'Compare documents', comparing: 'Comparing source passages…',
    note: 'Your PDFs are sent to this backend. Uploads may use temporary OS storage while processing; the app does not intentionally retain them permanently.',
    findings: 'Findings', confirmed: 'Matched text changes', possible: 'Possible changes',
    noFindings: 'No wording differences were identified in extractable text. This does not prove that the PDFs are equivalent.',
    insufficient: 'Comparison is inconclusive because one or both PDFs have no extractable text. Enable OCR for scanned pages or supply text-based PDFs.',
    page: 'Page', verify: 'Verify against the issuing organization before acting on a deadline or eligibility change.',
    authority: 'Authority not verified', warnings: 'Processing warnings',
    closePreview: 'Close preview', newTab: 'Open PDF in new tab',
    export: 'Export evidence report (JSON)', exportCsv: 'Export review CSV',
    invalidFile: 'Select a PDF no larger than 10 MiB.',
    ocr: 'Enable local OCR for scanned pages (English + Hindi)',
    ocrNote: 'Optional. Tesseract and the eng/hin language packs must be installed on the server. OCR text can be wrong; it never establishes an authoritative change. Up to 12 scanned pages per PDF.',
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
    fuzzyLimited: 'The comparison skipped some candidate pairings because the matching limit was reached. Check the source before interpreting unmatched statements.',
    previewLoading: 'Preparing PDF viewer…',
    semantic: 'Suggest matches with local AI (experimental)',
    semanticNote: 'Optional: sends selected unmatched text excerpts to Ollama running on the backend computer (127.0.0.1:11434). This feature does not call cloud APIs. Suggestions are unverified.',
    semanticAdded: 'Local AI suggested possible passage pairings. None are verified.',
    semanticNoCandidates: 'No unmatched category-labeled passages were eligible for local AI review.',
    semanticUnavailable: 'Local AI was unavailable; deterministic findings remain available.',
    semanticRejected: 'No local AI suggestions passed source verification.',
  },
  hi: {
    eyebrow: 'स्रोत-आधारित दस्तावेज़ विश्लेषण',
    title: 'जानें, क्या बदला।', subtitle: 'अगला कदम समझें। प्रमाण जाँचें।',
    detail: 'दो आधिकारिक PDF की तुलना करें और हर निष्कर्ष के मूल प्रमाण देखें। कोई काल्पनिक संदर्भ या स्वतः आधिकारिक दावा नहीं।',
    original: 'मूल सूचना', revised: 'संशोधित सूचना', drop: 'PDF चुनें (अधिकतम 10 MiB)',
    comparisonHeading: 'दस्तावेज़ तुलना', replaceFile: '↻ बदलें', browseFile: '+ फ़ाइल चुनें',
    button: 'दस्तावेज़ों की तुलना करें', comparing: 'स्रोत अंशों की तुलना जारी…',
    note: 'PDF इस बैकएंड पर भेजी जाती हैं। प्रोसेसिंग के दौरान अस्थायी सिस्टम स्टोरेज उपयोग हो सकता है; ऐप इन्हें स्थायी रूप से रखने का उद्देश्य नहीं रखता।',
    findings: 'निष्कर्ष', confirmed: 'मिलते अंशों में बदलाव', possible: 'संभावित बदलाव',
    noFindings: 'निकाले जा सकने वाले पाठ में अंतर नहीं मिला। इससे दोनों PDF एक जैसी सिद्ध नहीं होतीं।',
    insufficient: 'तुलना अधूरी है क्योंकि किसी एक या दोनों PDF से पाठ नहीं मिला। स्कैन किए पन्नों के लिए OCR चालू करें या पाठ वाली PDF चुनें।',
    page: 'पृष्ठ', verify: 'तिथि या पात्रता में बदलाव के आधार पर कदम उठाने से पहले जारीकर्ता से पुष्टि करें।',
    authority: 'आधिकारिक प्राथमिकता अप्रमाणित', warnings: 'प्रोसेसिंग चेतावनियाँ',
    closePreview: 'पूर्वावलोकन बंद करें', newTab: 'नए टैब में PDF खोलें',
    export: 'प्रमाण रिपोर्ट डाउनलोड करें (JSON)', exportCsv: 'समीक्षा CSV डाउनलोड करें',
    invalidFile: 'केवल 10 MiB तक की PDF चुनें।',
    ocr: 'स्कैन किए गए पन्नों के लिए स्थानीय OCR चालू करें (हिंदी + अंग्रेज़ी)',
    ocrNote: 'वैकल्पिक। सर्वर पर Tesseract और eng/hin भाषा डेटा आवश्यक है। OCR में गलतियाँ हो सकती हैं। प्रत्येक PDF के अधिकतम 12 पन्ने।',
    ocrRecovery: 'चुने हुए पृष्ठों का पाठ OCR से निकालें',
    ocrRecoveryHelp: 'PDF का पाठ बिगड़ा या अधूरा हो तो १, ३–५ जैसे PDF पृष्ठ नंबर दें। चुने हुए पृष्ठों पर केवल OCR चलेगा। हर PDF की 12 पृष्ठों की सीमा में इन्हें प्राथमिकता मिलेगी।',
    ocrOriginalPages: 'मूल सूचना के OCR पृष्ठ',
    ocrRevisedPages: 'संशोधित सूचना के OCR पृष्ठ',
    ocrSelected: 'OCR के लिए चुने गए पृष्ठ',
    ocrRecovered: 'OCR से पाठ मिले पृष्ठ',
    coverageTitle: 'पाठ निष्कर्षण की स्थिति',
    coverageFull: 'हर PDF पृष्ठ से कुछ पाठ मिला, लेकिन इससे सभी कथन निकलने की पुष्टि नहीं होती।',
    coveragePartial: 'कुछ PDF पृष्ठों से पाठ नहीं मिला। उन पृष्ठों के बदलाव छूट सकते हैं।',
    coverageInconclusive: 'एक या दोनों PDF से कोई पाठ नहीं मिला। तुलना अनिर्णायक है।',
    coveragePages: 'पृष्ठों से पाठ मिला',
    uncovered: 'बिना निकाले गए पाठ वाले पृष्ठ खोलें',
    fuzzyLimited: 'मिलान की सीमा पूरी होने पर कुछ संभावित मिलान छूट गए। बेमेल कथनों की व्याख्या करने से पहले मूल स्रोत जाँचें।',
    previewLoading: 'PDF व्यूअर तैयार हो रहा है…',
    semantic: 'स्थानीय AI से संभावित मिलान सुझाएँ (प्रयोगात्मक)',
    semanticNote: 'वैकल्पिक: कुछ बेमेल पाठ अंश बैकएंड पर चल रहे Ollama (127.0.0.1:11434) को भेजे जाएँगे। यह सुविधा क्लाउड API का उपयोग नहीं करती। सुझाव अप्रमाणित हैं।',
    semanticAdded: 'स्थानीय AI ने संभावित अंश मिलान सुझाए हैं। कोई भी सत्यापित नहीं है।',
    semanticNoCandidates: 'स्थानीय AI समीक्षा के लिए उपयुक्त बेमेल अंश नहीं मिले।',
    semanticUnavailable: 'स्थानीय AI उपलब्ध नहीं था; नियम-आधारित निष्कर्ष उपलब्ध हैं।',
    semanticRejected: 'स्थानीय AI का कोई सुझाव स्रोत जाँच में सफल नहीं हुआ।',
  },
};

export default function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [original, setOriginal] = useState<File | null>(null);
  const [revised, setRevised] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);
  const [enableOcr, setEnableOcr] = useState(false);
  const [ocrPages, setOcrPages] = useState<Record<DocumentRole, string>>({
    original: '', revised: '',
  });
  const [enableSemantic, setEnableSemantic] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const closePreviewRef = useRef<HTMLButtonElement | null>(null);
  const previewDialogRef = useRef<HTMLElement | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const t = translations[language];

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview.url); };
  }, [preview]);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);

  useEffect(() => {
    if (!preview) return;
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
  }, [preview]);

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

  function openSource(source: SourcePage | Evidence) {
    const file = source.document_id === 'original' ? original : revised;
    if (!file) return;
    previewReturnFocusRef.current = document.activeElement instanceof HTMLElement ?
      document.activeElement : null;
    setPreview({
      url: URL.createObjectURL(file), file, source,
      evidence: 'bbox' in source ? source : undefined,
    });
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
    const payload = { ...report, review: [...checked], exported_at: new Date().toISOString() };
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!original || !revised) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true); setError(''); setReport(null); setChecked(new Set()); setPreview(null);
    try {
      const body = new FormData();
      body.append('original', original); body.append('revised', revised);
      body.append('enable_ocr', String(enableOcr));
      body.append('original_ocr_pages', ocrPages.original);
      body.append('revised_ocr_pages', ocrPages.revised);
      body.append('enable_semantic', String(enableSemantic));
      const response = await fetch('/api/compare', { method: 'POST', body, signal: controller.signal });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(typeof payload?.detail === 'string' ? payload.detail : `Request failed (${response.status})`);
      }
      const result = await response.json() as Report;
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

  return <div className="app-shell">
    <header className="topbar" inert={Boolean(preview)}>
      <div className="brand"><span className="brand-mark">N<span>↗</span></span><span>NoticeBridge <b>AI</b></span></div>
      <div className="top-actions">
        <span className="privacy-tag">● Local development MVP</span>
        <div className="language-switch" role="group" aria-label={language === 'hi' ? 'व्याख्या की भाषा' : 'Explanation language'}>
          <button lang="en" aria-pressed={language === 'en'} className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')} type="button">EN</button>
          <button lang="hi" aria-pressed={language === 'hi'} className={language === 'hi' ? 'active' : ''} onClick={() => setLanguage('hi')} type="button">हिंदी</button>
        </div>
      </div>
    </header>
    <main inert={Boolean(preview)}>
      <section className="hero">
        <div className="pill"><span className="pill-dot" />{t.eyebrow}</div>
        <h1>{t.title}<br /><em>{t.subtitle}</em></h1>
        <p className="hero-copy">{t.detail}</p>
        <div className="hero-visual" aria-hidden="true"><span className="spark s1">✦</span><span className="spark s2">✧</span><span className="spark s3">✦</span></div>
      </section>
      <section className="workspace" aria-label="PDF comparison workspace">
        <div className="section-heading"><div><span className="section-number">{language === 'hi' ? '०१ / विश्लेषण' : '01 / ANALYZE'}</span><h2>{t.comparisonHeading}</h2></div><div className="section-hint">PDF → EVIDENCE → FINDINGS</div></div>
        <form onSubmit={submit}>
          <div className="upload-grid">
            {([['original', original, t.original], ['revised', revised, t.revised]] as const).map(([id, file, label], i) =>
              <label className="upload-card" key={id} htmlFor={id}>
                <span className="upload-icon">{i === 0 ? '01' : '02'}</span><strong>{label}</strong>
                <span className="upload-detail">{file ? file.name : t.drop}</span>
                <span className="upload-action">{file ? t.replaceFile : t.browseFile}</span>
                <input id={id} type="file" accept=".pdf,application/pdf" onChange={(e) => setSource(id, e.target.files?.[0] ?? null)} />
              </label>)}
          </div>
          <label className="ocr-option"><input type="checkbox" checked={enableOcr} onChange={(e) => { clearComparison(); setEnableOcr(e.target.checked); }} /><span><strong>{t.ocr}</strong><small>{t.ocrNote}</small></span></label>
          <details className="ocr-recovery">
            <summary>{t.ocrRecovery}</summary>
            <p id="ocr-recovery-help">{t.ocrRecoveryHelp}</p>
            <div className="ocr-recovery-fields">
              {([['original', t.ocrOriginalPages], ['revised', t.ocrRevisedPages]] as const).map(([role, label]) =>
                <label key={role}>
                  {label}
                  <input type="text" value={ocrPages[role]} maxLength={160}
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
      </section>
      {report && <section className="results" aria-labelledby="results-heading">
        <div className="section-heading"><div><span className="section-number">{language === 'hi' ? '०२ / समीक्षा' : '02 / REVIEW'}</span><h2 id="results-heading">{t.findings}</h2></div><div className="export-actions"><button type="button" className="export-button" onClick={exportReport}>{t.export} ↓</button><button type="button" className="export-button" onClick={exportReviewCsv}>{t.exportCsv} ↓</button></div></div>
        <div className="metrics">
          <div><b>{report.findings.length}</b><span>{t.findings}</span></div>
          <div><b>{report.findings.filter(f => f.status === 'confirmed_change').length}</b><span>{t.confirmed}</span></div>
          <div><b>{report.findings.filter(f => f.status === 'possible_change').length}</b><span>{t.possible}</span></div>
        </div>
        <div className="caution"><span>!</span><p>{t.verify} <strong>{t.authority}.</strong></p></div>
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
          </li>)}</ul>
        </div>
        {report.fuzzy_matching_limited && <p className="coverage-report partial" role="status">{t.fuzzyLimited}</p>}
        {report.findings.length === 0 && <p className="no-findings" role="status">{report.documents.some(d => !d.has_extractable_text) ? t.insufficient : t.noFindings}</p>}
        {report.checklist.length > 0 && <ReviewRestore report={report} language={language}
          onRestore={ids => setChecked(previous => new Set([...previous, ...ids]))} />}
        {report.findings.length > 0 && <ReviewFindings
          report={report} checked={checked} language={language} onCheck={setReviewed} onOpen={openSource}
        />}
        {report.warnings.length > 0 && <aside className="warnings"><h3>{t.warnings}</h3>{report.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</aside>}
      </section>}
    </main>
    {preview && <div className="preview-backdrop" role="presentation">
      <section ref={previewDialogRef} className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-heading">
        <div className="preview-top"><strong id="preview-heading">{preview.source.filename} · {t.page} {preview.source.page}</strong><button type="button" ref={closePreviewRef} onClick={() => setPreview(null)}>{t.closePreview} ×</button></div>
        <Suspense fallback={<p role="status">{t.previewLoading}</p>}>
          <PdfEvidencePreview file={preview.file} pageNumber={preview.source.page} evidence={preview.evidence} language={language} />
        </Suspense>
        {preview.evidence && <p className="preview-quote">{preview.evidence.text}</p>}
        <a href={`${preview.url}#page=${preview.source.page}`} target="_blank" rel="noopener noreferrer">{t.newTab} ↗</a>
      </section>
    </div>}
    <footer inert={Boolean(preview)}><span>NoticeBridge AI · Open-source / Apache-2.0</span><span>Understand change. Verify evidence.</span></footer>
  </div>;
}
