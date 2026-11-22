import { useState, type FormEvent } from 'react';

type Language = 'en' | 'hi';
type Evidence = { document_id: string; filename: string; page: number; text: string; bbox: [number, number, number, number] };
type Finding = {
  id: string; status: 'confirmed_change' | 'possible_change' | 'contradiction' | 'missing_information';
  category: string; summary_en: string; summary_hi: string;
  original: Evidence | null; revised: Evidence | null; supporting_evidence: Evidence[]; similarity: number; authority_verified: boolean;
};
type Checklist = { description_en: string; description_hi: string; finding_id: string; requires_human_verification: boolean };
type Report = {
  documents: { id: string; filename: string; page_count: number; line_count: number; has_extractable_text: boolean }[];
  findings: Finding[]; checklist: Checklist[]; warnings: string[]; verification_policy: string;
};

const translations = {
  en: {
    eyebrow: 'EVIDENCE-FIRST DOCUMENT INTELLIGENCE',
    title: 'Understand what changed.', subtitle: 'Know what to do. Verify the evidence.',
    detail: 'Compare two official PDFs and inspect the original passages behind every finding. No invented citations. No automatic authority claims.',
    original: 'Original notice', revised: 'Updated notice', drop: 'Select a PDF (up to 10 MiB)',
    button: 'Compare documents', comparing: 'Comparing source passages…',
    note: 'Your PDFs are processed in memory on the server; they are not intentionally stored by this application.',
    findings: 'Findings', confirmed: 'Matched text changes', possible: 'Possible changes',
    checklist: 'Review checklist', source: 'Source evidence', noFindings: 'No differences identified by the current matcher.',
    page: 'Page', verify: 'Verify against the issuing organization before acting on a deadline or eligibility change.',
    authority: 'Authority not verified', warnings: 'Processing warnings',
  },
  hi: {
    eyebrow: 'स्रोत-आधारित दस्तावेज़ विश्लेषण',
    title: 'जानें, क्या बदला।', subtitle: 'अगला कदम समझें। प्रमाण जाँचें।',
    detail: 'दो आधिकारिक PDF की तुलना करें और हर निष्कर्ष के मूल प्रमाण देखें। कोई काल्पनिक संदर्भ या स्वतः आधिकारिक दावा नहीं।',
    original: 'मूल सूचना', revised: 'संशोधित सूचना', drop: 'PDF चुनें (अधिकतम 10 MiB)',
    button: 'दस्तावेज़ों की तुलना करें', comparing: 'स्रोत अंशों की तुलना जारी…',
    note: 'PDF सर्वर की मेमोरी में प्रोसेस होती हैं; यह ऐप उन्हें जानबूझकर स्टोर नहीं करता।',
    findings: 'निष्कर्ष', confirmed: 'मिलते अंशों में बदलाव', possible: 'संभावित बदलाव',
    checklist: 'सत्यापन सूची', source: 'मूल प्रमाण', noFindings: 'वर्तमान मिलान विधि ने कोई अंतर नहीं पहचाना।',
    page: 'पृष्ठ', verify: 'तिथि या पात्रता में बदलाव के आधार पर कदम उठाने से पहले जारीकर्ता से पुष्टि करें।',
    authority: 'आधिकारिक प्राथमिकता अप्रमाणित', warnings: 'प्रोसेसिंग चेतावनियाँ',
  },
};

function EvidenceCard({ evidence, label, page }: { evidence: Evidence | null; label: string; page: string }) {
  return <div className="evidence-card">
    <div className="evidence-label">{label}</div>
    {evidence ? <>
      <div className="page-ref">{evidence.filename} · {page} {evidence.page}</div>
      <blockquote>{evidence.text}</blockquote>
    </> : <p className="muted">—</p>}
  </div>;
}

export default function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [original, setOriginal] = useState<File | null>(null);
  const [revised, setRevised] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const t = translations[language];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!original || !revised) return;
    setPending(true); setError(''); setReport(null); setChecked([]);
    try {
      const body = new FormData();
      body.append('original', original); body.append('revised', revised);
      const response = await fetch('/api/compare', { method: 'POST', body });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(typeof payload?.detail === 'string' ? payload.detail : `Request failed (${response.status})`);
      }
      setReport(await response.json() as Report);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not compare documents');
    } finally { setPending(false); }
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">N<span>↗</span></span><span>NoticeBridge <b>AI</b></span></div>
      <div className="top-actions">
        <span className="privacy-tag">● Local development MVP</span>
        <div className="language-switch" role="group" aria-label="Explanation language">
          <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')} type="button">EN</button>
          <button className={language === 'hi' ? 'active' : ''} onClick={() => setLanguage('hi')} type="button">हिंदी</button>
        </div>
      </div>
    </header>
    <main>
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
            {([['original', original, setOriginal, t.original], ['revised', revised, setRevised, t.revised]] as const).map(([id, file, setter, label], i) =>
              <label className="upload-card" key={id} htmlFor={id}>
                <span className="upload-icon">{i === 0 ? '01' : '02'}</span><strong>{label}</strong>
                <span className="upload-detail">{file ? file.name : t.drop}</span>
                <span className="upload-action">{file ? '↻ Replace' : '+ Browse file'}</span>
                <input id={id} type="file" accept=".pdf,application/pdf" onChange={(e) => setter(e.target.files?.[0] ?? null)} />
              </label>)}
          </div>
          <div className="upload-footer"><p>{t.note}</p><button type="submit" disabled={!original || !revised || pending} className="primary-button">{pending ? t.comparing : t.button}<span>→</span></button></div>
          {error && <p role="alert" className="error-banner">{error}</p>}
        </form>
      </section>
      {report && <section className="results" aria-live="polite">
        <div className="section-heading"><div><span className="section-number">02 / REVIEW</span><h2>{t.findings}</h2></div><div className="section-hint">{report.findings.length} RESULTS</div></div>
        <div className="metrics">
          <div><b>{report.findings.length}</b><span>{t.findings}</span></div>
          <div><b>{report.findings.filter(f => f.status === 'confirmed_change').length}</b><span>{t.confirmed}</span></div>
          <div><b>{report.findings.filter(f => f.status === 'possible_change').length}</b><span>{t.possible}</span></div>
        </div>
        <div className="caution"><span>!</span><p>{t.verify} <strong>{t.authority}.</strong></p></div>
        {report.findings.length === 0 && <p className="no-findings">{t.noFindings}</p>}
        <div className="findings-list">{report.findings.map(f => <article className="finding" key={f.id}>
          <div className="finding-header"><div><span className={`status ${f.status}`}>{f.status.replaceAll('_', ' ')}</span><span className="category">{f.category.toUpperCase()}</span></div><span className="match-score">{Math.round(f.similarity * 100)}% context match</span></div>
          <p className="finding-summary">{language === 'hi' ? f.summary_hi : f.summary_en}</p>
          <div className="evidence-grid"><EvidenceCard evidence={f.original} label={t.original} page={t.page} /><EvidenceCard evidence={f.revised} label={t.revised} page={t.page} /></div>
          {f.supporting_evidence.length > 0 && <div className="evidence-grid">{f.supporting_evidence.map((e, i) => <EvidenceCard key={`${e.filename}-${e.page}-${i}`} evidence={e} label={`${t.source} ${i + 1}`} page={t.page} />)}</div>}
        </article>)}</div>
        {report.checklist.length > 0 && <div className="checklist"><h3>{t.checklist}</h3>{report.checklist.map(item => <label key={item.finding_id} className="checklist-item"><input type="checkbox" checked={checked.includes(item.finding_id)} onChange={(e) => setChecked(old => e.target.checked ? [...old, item.finding_id] : old.filter(x => x !== item.finding_id))} /><span>{language === 'hi' ? item.description_hi : item.description_en}</span></label>)}</div>}
        {report.warnings.length > 0 && <aside className="warnings"><h3>{t.warnings}</h3>{report.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</aside>}
      </section>}
    </main>
    <footer><span>NoticeBridge AI · Open-source / Apache-2.0</span><span>Understand change. Verify evidence.</span></footer>
  </div>;
}
