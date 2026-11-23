import { useMemo, useRef, useState } from 'react';
import type { Evidence, Finding, FindingCategory, Language, Report, ValueChange } from './comparison';

const PAGE_SIZE = 20;

const copy = {
  en: {
    heading: 'Review findings',
    search: 'Search source text',
    status: 'Finding status',
    category: 'Category',
    review: 'Checklist status',
    all: 'All',
    toReview: 'Needs review',
    reviewed: 'Marked reviewed',
    clear: 'Clear filters',
    empty: 'No findings match these filters.',
    count: (start: number, end: number, filtered: number, total: number) =>
      `Showing ${start}–${end} of ${filtered} matching findings (${total} total)`,
    progress: (reviewed: number, total: number) => `Review checklist · ${reviewed}/${total} marked reviewed`,
    previous: 'Previous findings',
    next: 'Next findings',
    original: 'Original notice',
    revised: 'Updated notice',
    page: 'Page',
    open: 'Open PDF page',
    ocr: 'Machine OCR — verify transcription',
    semantic: 'Local AI suggestion — verify PDF source',
    similarity: 'text similarity (not confidence)',
    values: 'Extracted values (syntactic check only)',
  },
  hi: {
    heading: 'निष्कर्षों की समीक्षा',
    search: 'मूल पाठ खोजें',
    status: 'निष्कर्ष की स्थिति',
    category: 'श्रेणी',
    review: 'समीक्षा की स्थिति',
    all: 'सभी',
    toReview: 'समीक्षा बाकी',
    reviewed: 'समीक्षा पूरी चिह्नित',
    clear: 'फ़िल्टर हटाएँ',
    empty: 'इन फ़िल्टरों से कोई निष्कर्ष नहीं मिला।',
    count: (start: number, end: number, filtered: number, total: number) =>
      `${filtered} मिलते निष्कर्षों में से ${start}–${end} दिख रहे हैं (कुल ${total})`,
    progress: (reviewed: number, total: number) => `सत्यापन सूची · ${reviewed}/${total} की समीक्षा पूरी चिह्नित`,
    previous: 'पिछले निष्कर्ष',
    next: 'अगले निष्कर्ष',
    original: 'मूल सूचना',
    revised: 'संशोधित सूचना',
    page: 'पृष्ठ',
    open: 'PDF पृष्ठ खोलें',
    ocr: 'मशीन OCR — पाठ की जाँच करें',
    semantic: 'स्थानीय AI का सुझाव — PDF स्रोत जाँचें',
    similarity: 'पाठ समानता (सटीकता की पुष्टि नहीं)',
    values: 'निकाले गए मान (केवल प्रारूप की जाँच)',
  },
};

const statuses: Record<Language, Record<Finding['status'], string>> = {
  en: {
    confirmed_change: 'Matched text change',
    possible_change: 'Possible change',
    contradiction: 'Conflicting dates',
    missing_information: 'Unmatched statement',
  },
  hi: {
    confirmed_change: 'पाठ में बदलाव',
    possible_change: 'संभावित बदलाव',
    contradiction: 'विरोधी तिथियाँ',
    missing_information: 'बेमेल कथन',
  },
};

const categories: Record<Language, Record<FindingCategory, string>> = {
  en: {
    deadline: 'Deadline', eligibility: 'Eligibility', fee: 'Fee',
    time: 'Time', instruction: 'Instruction', general: 'General',
  },
  hi: {
    deadline: 'अंतिम तिथि', eligibility: 'पात्रता', fee: 'शुल्क',
    time: 'समय', instruction: 'निर्देश', general: 'सामान्य',
  },
};

const valueKinds: Record<Language, Record<ValueChange['kind'], string>> = {
  en: { date: 'Date', amount: 'Amount' },
  hi: { date: 'तिथि', amount: 'राशि' },
};

const valueOutcomes: Record<Language, Record<ValueChange['outcome'], string>> = {
  en: { changed: 'Changed', same_value: 'Same value', uncertain: 'Uncertain' },
  hi: { changed: 'बदला', same_value: 'समान मान', uncertain: 'अनिश्चित' },
};

function findingEvidence(finding: Finding): Evidence[] {
  return [finding.original, finding.revised, ...finding.supporting_evidence]
    .filter((evidence): evidence is Evidence => evidence !== null);
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function EvidenceCard({ evidence, language, onOpen }: {
  evidence: Evidence;
  language: Language;
  onOpen: (evidence: Evidence) => void;
}) {
  const t = copy[language];
  return <div className="evidence-card">
    <div className="evidence-label">{t[evidence.document_id]}</div>
    <div className="page-ref">{evidence.filename} · {t.page} {evidence.page}</div>
    {evidence.extraction_method === 'ocr' && <p className="ocr-source">{t.ocr}</p>}
    <blockquote>{evidence.text}</blockquote>
    <button type="button" className="source-button" onClick={() => onOpen(evidence)}>{t.open} ↗</button>
  </div>;
}

type Filters = {
  search: string;
  status: Finding['status'] | 'all';
  category: FindingCategory | 'all';
  review: 'all' | 'pending' | 'reviewed';
};

const DEFAULT_FILTERS: Filters = { search: '', status: 'all', category: 'all', review: 'all' };

export default function ReviewFindings({ report, checked, language, onCheck, onOpen }: {
  report: Report;
  checked: ReadonlySet<string>;
  language: Language;
  onCheck: (id: string, selected: boolean) => void;
  onOpen: (evidence: Evidence) => void;
}) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const countRef = useRef<HTMLParagraphElement>(null);
  const t = copy[language];

  const checklist = useMemo(() =>
    new Map(report.checklist.map(item => [item.finding_id, item])), [report.checklist]
  );
  const indexed = useMemo(() => report.findings.map(finding => {
    const evidence = findingEvidence(finding);
    return { finding, evidence, quotes: evidence.map(item => normalizeSearch(item.text)) };
  }), [report.findings]);
  const query = normalizeSearch(filters.search);
  const matches = indexed.filter(({ finding, quotes }) => {
    if (filters.status !== 'all' && filters.status !== finding.status) return false;
    if (filters.category !== 'all' && filters.category !== finding.category) return false;
    if (filters.review !== 'all' &&
      (!checklist.has(finding.id) || checked.has(finding.id) !== (filters.review === 'reviewed'))) {
      return false;
    }
    return !query || quotes.some(quote => quote.includes(query));
  });
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const shown = matches.slice(start, start + PAGE_SIZE);
  const hasFilters = Object.keys(DEFAULT_FILTERS).some(key => {
    const filter = key as keyof Filters;
    return filters[filter] !== DEFAULT_FILTERS[filter];
  });

  function changeFilters(updates: Partial<Filters>) {
    setFilters(previous => ({ ...previous, ...updates }));
    setPage(1);
  }

  function changePage(next: number) {
    setPage(next);
    countRef.current?.focus();
  }

  function changeReview(id: string, selected: boolean) {
    onCheck(id, selected);
    if (filters.review !== 'all') {
      // The active row disappears from a filtered queue when its state changes.
      setPage(currentPage);
      countRef.current?.focus();
    }
  }

  return <section className="review-findings" aria-labelledby="review-heading">
    <h3 id="review-heading">{t.heading}</h3>
    {checklist.size > 0 && <p className="review-progress" role="status">
      {t.progress(checked.size, checklist.size)}
    </p>}
    <div className="review-filters">
      <label><span>{t.search}</span><input type="search" value={filters.search}
        onChange={event => changeFilters({ search: event.target.value })} /></label>
      <label><span>{t.status}</span><select value={filters.status}
        onChange={event => changeFilters({ status: event.target.value as Filters['status'] })}>
        <option value="all">{t.all}</option>
        {Object.entries(statuses[language]).map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label><span>{t.category}</span><select value={filters.category}
        onChange={event => changeFilters({ category: event.target.value as Filters['category'] })}>
        <option value="all">{t.all}</option>
        {Object.entries(categories[language]).map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}
      </select></label>
      {checklist.size > 0 && <label><span>{t.review}</span><select value={filters.review}
        onChange={event => changeFilters({ review: event.target.value as Filters['review'] })}>
        <option value="all">{t.all}</option>
        <option value="pending">{t.toReview}</option>
        <option value="reviewed">{t.reviewed}</option>
      </select></label>}
      {hasFilters && <button type="button" className="review-button" onClick={() => {
        changeFilters(DEFAULT_FILTERS);
        countRef.current?.focus();
      }}>{t.clear}</button>}
    </div>
    <p className="review-count" ref={countRef} role="status" tabIndex={-1}>
      {shown.length ? t.count(start + 1, start + shown.length, matches.length, indexed.length) : t.empty}
    </p>
    <div className="findings-list">{shown.map(({ finding, evidence }) => {
      const task = checklist.get(finding.id);
      return <article className="finding" key={finding.id}>
        <div className="finding-header">
          <div>
            <span className={`status ${finding.status}`}>{statuses[language][finding.status]}</span>
            <span className="category">{categories[language][finding.category]}</span>
          </div>
          {finding.original && finding.revised && <span className="match-score">
            {finding.match_method === 'semantic_proposal' ? t.semantic :
              `${Math.round(finding.similarity * 100)}% ${t.similarity}`}
          </span>}
        </div>
        <p className="finding-summary">{language === 'hi' ? finding.summary_hi : finding.summary_en}</p>
        {finding.field_changes.length > 0 && <div className="value-changes">
          <b>{t.values}</b>
          {finding.field_changes.map((delta, i) => <p key={i}>
            <span className="value-outcome">{valueKinds[language][delta.kind]}: {valueOutcomes[language][delta.outcome]}</span>
            {' '}{delta.original.raw} → {delta.revised.raw}
            {delta.outcome !== 'uncertain' && ` (${delta.original.canonical} → ${delta.revised.canonical})`}
          </p>)}
        </div>}
        <div className={`evidence-grid${evidence.length === 1 ? ' single-evidence' : ''}`}>
          {evidence.map((item, i) => <EvidenceCard
            key={`${item.document_id}-${item.page}-${i}`}
            evidence={item} language={language} onOpen={onOpen}
          />)}
        </div>
        {task && <label className="checklist-item">
          <input type="checkbox" checked={checked.has(finding.id)}
            onChange={event => changeReview(finding.id, event.target.checked)} />
          <span>{language === 'hi' ? task.description_hi : task.description_en}</span>
        </label>}
      </article>;
    })}</div>
    {pageCount > 1 && <nav className="review-pagination" aria-label={t.heading}>
      <button className="review-button" type="button" disabled={currentPage <= 1}
        onClick={() => changePage(currentPage - 1)}>{t.previous}</button>
      <button className="review-button" type="button" disabled={currentPage >= pageCount}
        onClick={() => changePage(currentPage + 1)}>{t.next}</button>
    </nav>}
  </section>;
}
