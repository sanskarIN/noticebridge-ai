import PdfEvidencePreview from './PdfEvidencePreview';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Language = 'en' | 'hi';
type DocumentRole = 'original' | 'revised';
type Evidence = { document_id: DocumentRole; filename: string; page: number; text: string; bbox: [number, number, number, number]; extraction_method: 'native' | 'ocr'; page_width: number; page_height: number; page_rotation: 0 | 90 | 180 | 270 };
type ParsedValue = { kind: 'date' | 'amount'; raw: string; canonical: string | null; confidence: 'parsed' | 'ambiguous' | 'invalid' };
type ValueChange = { kind: 'date' | 'amount'; original: ParsedValue; revised: ParsedValue; outcome: 'changed' | 'same_value' | 'uncertain' };
type Finding = {
  id: string; status: 'confirmed_change' | 'possible_change' | 'contradiction' | 'missing_information';
  category: string; summary_en: string; summary_hi: string;
  original: Evidence | null; revised: Evidence | null; supporting_evidence: Evidence[];
  similarity: number; match_method: 'deterministic' | 'semantic_proposal';
  authority_verified: boolean; field_changes: ValueChange[];
};
type Checklist = { description_en: string; description_hi: string; finding_id: string; requires_human_verification: boolean };
type Report = {
  documents: { id: string; filename: string; page_count: number; line_count: number; has_extractable_text: boolean; sha256: string; ocr_page_count: number; pages_with_text: number; pages_without_text: number[] }[];
  findings: Finding[]; checklist: Checklist[]; warnings: string[]; verification_policy: string;
  text_coverage: 'all_pages_have_text' | 'partial' | 'inconclusive';
  semantic_assistance: 'not_requested' | 'no_candidates' | 'unavailable' | 'no_verified_pairs' | 'proposals_added';
};
type Preview = { url: string; file: File; evidence: Evidence };

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const translations = {
  en: {
    eyebrow: 'EVIDENCE-FIRST DOCUMENT INTELLIGENCE',
    title: 'Understand what changed.', subtitle: 'Know what to do. Verify the evidence.',
    detail: 'Compare two official PDFs and inspect the original passages behind every finding. No invented citations. No automatic authority claims.',
    original: 'Original notice', revised: 'Updated notice', drop: 'Select a PDF (up to 10 MiB)',
    button: 'Compare documents', comparing: 'Comparing source passages…',
    note: 'Your PDFs are sent to this backend. Uploads may use temporary OS storage while processing; the app does not intentionally retain them permanently.',
    findings: 'Findings', confirmed: 'Matched text changes', possible: 'Possible changes',
    checklist: 'Review checklist', source: 'Source evidence', noFindings: 'No wording differences were identified in extractable text. This does not prove that the PDFs are equivalent.',
    insufficient: 'Comparison is inconclusive because one or both PDFs have no extractable text. Enable OCR for scanned pages or supply text-based PDFs.',
    page: 'Page', verify: 'Verify against the issuing organization before acting on a deadline or eligibility change.',
    authority: 'Authority not verified', warnings: 'Processing warnings',
    openPage: 'Open PDF page', closePreview: 'Close preview', newTab: 'Open PDF in new tab',
    previewNote: 'The PDF preview highlights source coordinates on unrotated pages. Review the original document before relying on this evidence.',
    export: 'Export evidence report (JSON)', progress: 'Reviewed',
    values: 'Extracted values (syntactic check only)', uncertain: 'Uncertain',
    invalidFile: 'Select a PDF no larger than 10 MiB.',
    ocr: 'Enable local OCR for scanned pages (English + Hindi)',
    ocrNote: 'Optional. Tesseract and the eng/hin language packs must be installed on the server. OCR text can be wrong; it never establishes an authoritative change. Up to 12 scanned pages per PDF.',
    ocrSource: 'Machine OCR — verify transcription',
    coverageTitle: 'Text extraction coverage',
    coverageFull: 'Every PDF page yielded some text, but this does not prove every statement was captured.',
    coveragePartial: 'Some PDF pages yielded no text. Changes on those pages may be missed.',
    coverageInconclusive: 'One or both PDFs yielded no text. The comparison is inconclusive.',
    coveragePages: 'pages yielded text',
    semantic: 'Suggest matches with local AI (experimental)',
    semanticNote: 'Optional: sends selected unmatched text excerpts to Ollama running on the backend computer (127.0.0.1:11434). This feature does not call cloud APIs. Suggestions are unverified.',
    semanticSuggested: 'Local AI suggestion — verify PDF source',
    semanticAdded: 'Local AI suggested possible passage pairings. None are verified.',
    semanticNoCandidates: 'No unmatched category-labeled passages were eligible for local AI review.',
    semanticUnavailable: 'Local AI was unavailable; deterministic findings remain available.',
    semanticRejected: 'No local AI suggestions passed source verification.',
    similarityLabel: 'text similarity (not confidence)',
  },
  hi: {
    eyebrow: 'स्रोत-आधारित दस्तावेज़ विश्लेषण',
    title: 'जानें, क्या बदला।', subtitle: 'अगला कदम समझें। प्रमाण जाँचें।',
    detail: 'दो आधिकारिक PDF की तुलना करें और हर निष्कर्ष के मूल प्रमाण देखें। कोई काल्पनिक संदर्भ या स्वतः आधिकारिक दावा नहीं।',
    original: 'मूल सूचना', revised: 'संशोधित सूचना', drop: 'PDF चुनें (अधिकतम 10 MiB)',
    button: 'दस्तावेज़ों की तुलना करें', comparing: 'स्रोत अंशों की तुलना जारी…',
    note: 'PDF इस बैकएंड पर भेजी जाती हैं। प्रोसेसिंग के दौरान अस्थायी सिस्टम स्टोरेज उपयोग हो सकता है; ऐप इन्हें स्थायी रूप से रखने का उद्देश्य नहीं रखता।',
    findings: 'निष्कर्ष', confirmed: 'मिलते अंशों में बदलाव', possible: 'संभावित बदलाव',
    checklist: 'सत्यापन सूची', source: 'मूल प्रमाण', noFindings: 'निकाले जा सकने वाले पाठ में अंतर नहीं मिला। इससे दोनों PDF एक जैसी सिद्ध नहीं होतीं।',
    insufficient: 'तुलना अधूरी है क्योंकि किसी एक या दोनों PDF से पाठ नहीं मिला। स्कैन किए पन्नों के लिए OCR चालू करें या पाठ वाली PDF चुनें।',
    page: 'पृष्ठ', verify: 'तिथि या पात्रता में बदलाव के आधार पर कदम उठाने से पहले जारीकर्ता से पुष्टि करें।',
    authority: 'आधिकारिक प्राथमिकता अप्रमाणित', warnings: 'प्रोसेसिंग चेतावनियाँ',
    openPage: 'PDF पृष्ठ खोलें', closePreview: 'पूर्वावलोकन बंद करें', newTab: 'नए टैब में PDF खोलें',
    previewNote: 'मूल PDF के बिना घुमाए गए पृष्ठों पर स्रोत अंश हाइलाइट होता है। प्रमाण को स्वयं जाँचें।',
    export: 'प्रमाण रिपोर्ट डाउनलोड करें (JSON)', progress: 'समीक्षा पूरी',
    values: 'निकाले गए मान (केवल प्रारूप की जाँच)', uncertain: 'अनिश्चित',
    invalidFile: 'केवल 10 MiB तक की PDF चुनें।',
    ocr: 'स्कैन किए गए पन्नों के लिए स्थानीय OCR चालू करें (हिंदी + अंग्रेज़ी)',
    ocrNote: 'वैकल्पिक। सर्वर पर Tesseract और eng/hin भाषा डेटा आवश्यक है। OCR में गलतियाँ हो सकती हैं। प्रत्येक PDF के अधिकतम 12 पन्ने।',
    ocrSource: 'मशीन OCR — पाठ की जाँच करें',
    coverageTitle: 'पाठ निष्कर्षण की स्थिति',
    coverageFull: 'हर PDF पृष्ठ से कुछ पाठ मिला, लेकिन इससे सभी कथन निकलने की पुष्टि नहीं होती।',
    coveragePartial: 'कुछ PDF पृष्ठों से पाठ नहीं मिला। उन पृष्ठों के बदलाव छूट सकते हैं।',
    coverageInconclusive: 'एक या दोनों PDF से कोई पाठ नहीं मिला। तुलना अनिर्णायक है।',
    coveragePages: 'पृष्ठों से पाठ मिला',
    semantic: 'स्थानीय AI से संभावित मिलान सुझाएँ (प्रयोगात्मक)',
    semanticNote: 'वैकल्पिक: कुछ बेमेल पाठ अंश बैकएंड पर चल रहे Ollama (127.0.0.1:11434) को भेजे जाएँगे। यह सुविधा क्लाउड API का उपयोग नहीं करती। सुझाव अप्रमाणित हैं।',
    semanticSuggested: 'स्थानीय AI का सुझाव — PDF स्रोत जाँचें',
    semanticAdded: 'स्थानीय AI ने संभावित अंश मिलान सुझाए हैं। कोई भी सत्यापित नहीं है।',
    semanticNoCandidates: 'स्थानीय AI समीक्षा के लिए उपयुक्त बेमेल अंश नहीं मिले।',
    semanticUnavailable: 'स्थानीय AI उपलब्ध नहीं था; नियम-आधारित निष्कर्ष उपलब्ध हैं।',
    semanticRejected: 'स्थानीय AI का कोई सुझाव स्रोत जाँच में सफल नहीं हुआ।',
    similarityLabel: 'पाठ समानता (सटीकता की पुष्टि नहीं)',
  },
};

function EvidenceCard({ evidence, label, page, openPage, ocrSource, onOpen }: {
  evidence: Evidence | null; label: string; page: string; openPage: string; ocrSource: string; onOpen: (e: Evidence) => void;
}) {
  return <div className="evidence-card">
    <div className="evidence-label">{label}</div>
    {evidence ? <>
      <div className="page-ref">{evidence.filename} · {page} {evidence.page}</div>
      {evidence.extraction_method === 'ocr' && <p className="ocr-source">{ocrSource}</p>}
      <blockquote>{evidence.text}</blockquote>
      <button type="button" className="source-button" onClick={() => onOpen(evidence)}>{openPage} ↗</button>
    </> : <p className="muted">—</p>}
  </div>;
}

export default function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [original, setOriginal] = useState<File | null>(null);
  const [revised, setRevised] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);
  const [enableOcr, setEnableOcr] = useState(false);
  const [enableSemantic, setEnableSemantic] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const closePreviewRef = useRef<HTMLButtonElement | null>(null);
  const previewDialogRef = useRef<HTMLElement | null>(null);
  const t = translations[language];

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview.url); };
  }, [preview]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (!preview) return;
    const previousFocus = document.activeElement instanceof HTMLElement ?
      document.activeElement : null;
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

  function setSource(role: DocumentRole, file: File | null) {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPending(false); setReport(null); setChecked([]); setPreview(null); setError('');
    if (file && (!file.name.toLowerCase().endsWith('.pdf') || file.size > MAX_FILE_BYTES)) {
      setError(t.invalidFile);
      if (role === 'original') setOriginal(null); else setRevised(null);
      return;
    }
    if (role === 'original') setOriginal(file); else setRevised(file);
  }

  function openEvidence(evidence: Evidence) {
    const file = evidence.document_id === 'original' ? original : revised;
    if (!file) return;
    setPreview({
      url: URL.createObjectURL(file), file, evidence,
    });
  }

  function exportReport() {
    if (!report) return;
    const payload = { ...report, review: checked, exported_at: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'noticebridge-evidence-report.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!original || !revised) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true); setError(''); setReport(null); setChecked([]); setPreview(null);
    try {
      const body = new FormData();
      body.append('original', original); body.append('revised', revised);
      body.append('enable_ocr', String(enableOcr));
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
        <div className="language-switch" role="group" aria-label="Explanation language">
          <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')} type="button">EN</button>
          <button className={language === 'hi' ? 'active' : ''} onClick={() => setLanguage('hi')} type="button">हिंदी</button>
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
        <div className="section-heading"><div><span className="section-number">01 / ANALYZE</span><h2>Document comparison</h2></div><div className="section-hint">PDF → EVIDENCE → FINDINGS</div></div>
        <form onSubmit={submit}>
          <div className="upload-grid">
            {([['original', original, t.original], ['revised', revised, t.revised]] as const).map(([id, file, label], i) =>
              <label className="upload-card" key={id} htmlFor={id}>
                <span className="upload-icon">{i === 0 ? '01' : '02'}</span><strong>{label}</strong>
                <span className="upload-detail">{file ? file.name : t.drop}</span>
                <span className="upload-action">{file ? '↻ Replace' : '+ Browse file'}</span>
                <input id={id} type="file" accept=".pdf,application/pdf" onChange={(e) => setSource(id, e.target.files?.[0] ?? null)} />
              </label>)}
          </div>
          <label className="ocr-option"><input type="checkbox" checked={enableOcr} onChange={(e) => setEnableOcr(e.target.checked)} /><span><strong>{t.ocr}</strong><small>{t.ocrNote}</small></span></label>
          <label className="ocr-option"><input type="checkbox" checked={enableSemantic} onChange={(e) => setEnableSemantic(e.target.checked)} /><span><strong>{t.semantic}</strong><small>{t.semanticNote}</small></span></label>
          <div className="upload-footer"><p>{t.note}</p><button type="submit" disabled={!original || !revised || pending} className="primary-button">{pending ? t.comparing : t.button}<span>→</span></button></div>
          {error && <p role="alert" className="error-banner">{error}</p>}
        </form>
      </section>
      {report && <section className="results" aria-live="polite">
        <div className="section-heading"><div><span className="section-number">02 / REVIEW</span><h2>{t.findings}</h2></div><button type="button" className="export-button" onClick={exportReport}>{t.export} ↓</button></div>
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
          <p>{report.documents.map(d =>
            `${d.filename}: ${d.pages_with_text}/${d.page_count} ${t.coveragePages}`
          ).join(' · ')}</p>
        </div>
        {report.findings.length === 0 && <p className="no-findings" role="status">{report.documents.some(d => !d.has_extractable_text) ? t.insufficient : t.noFindings}</p>}
        <div className="findings-list">{report.findings.map(f => <article className="finding" key={f.id}>
          <div className="finding-header"><div><span className={`status ${f.status}`}>{f.status.replaceAll('_', ' ')}</span><span className="category">{f.category.toUpperCase()}</span></div><span className="match-score">{f.match_method === 'semantic_proposal' ?
            t.semanticSuggested : `${Math.round(f.similarity * 100)}% ${t.similarityLabel}`}</span></div>
          <p className="finding-summary">{language === 'hi' ? f.summary_hi : f.summary_en}</p>
          {f.field_changes.length > 0 && <div className="value-changes"><b>{t.values}</b>{f.field_changes.map((delta, i) => <p key={i}><span className="value-outcome">{delta.kind}: {delta.outcome.replaceAll('_', ' ')}</span> {delta.original.raw} → {delta.revised.raw} {delta.outcome === 'uncertain' ? `(${t.uncertain})` : `(${delta.original.canonical} → ${delta.revised.canonical})`}</p>)}</div>}
          <div className="evidence-grid"><EvidenceCard evidence={f.original} label={t.original} page={t.page} openPage={t.openPage} ocrSource={t.ocrSource} onOpen={openEvidence} /><EvidenceCard evidence={f.revised} label={t.revised} page={t.page} openPage={t.openPage} ocrSource={t.ocrSource} onOpen={openEvidence} /></div>
          {f.supporting_evidence.length > 0 && <div className="evidence-grid">{f.supporting_evidence.map((e, i) => <EvidenceCard key={`${e.document_id}-${e.page}-${i}`} evidence={e} label={`${t.source} ${i + 1}`} page={t.page} openPage={t.openPage} ocrSource={t.ocrSource} onOpen={openEvidence} />)}</div>}
        </article>)}</div>
        {report.checklist.length > 0 && <div className="checklist"><h3>{t.checklist} · {checked.length}/{report.checklist.length} {t.progress}</h3>{report.checklist.map(item => <label key={item.finding_id} className="checklist-item"><input type="checkbox" checked={checked.includes(item.finding_id)} onChange={(e) => setChecked(old => e.target.checked ? [...old, item.finding_id] : old.filter(x => x !== item.finding_id))} /><span>{language === 'hi' ? item.description_hi : item.description_en}</span></label>)}</div>}
        {report.warnings.length > 0 && <aside className="warnings"><h3>{t.warnings}</h3>{report.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</aside>}
      </section>}
    </main>
    {preview && <div className="preview-backdrop" role="presentation">
      <section ref={previewDialogRef} className="preview-dialog" role="dialog" aria-modal="true" aria-label={`${preview.evidence.filename} · ${t.page} ${preview.evidence.page}`}>
        <div className="preview-top"><strong>{preview.evidence.filename} · {t.page} {preview.evidence.page}</strong><button type="button" ref={closePreviewRef} onClick={() => setPreview(null)}>{t.closePreview} ×</button></div>
        <PdfEvidencePreview file={preview.file} evidence={preview.evidence} language={language} />
        <p className="preview-quote">{preview.evidence.text}</p>
        <a href={`${preview.url}#page=${preview.evidence.page}`} target="_blank" rel="noopener noreferrer">{t.newTab} ↗</a>
      </section>
    </div>}
    <footer inert={Boolean(preview)}><span>NoticeBridge AI · Open-source / Apache-2.0</span><span>Understand change. Verify evidence.</span></footer>
  </div>;
}
