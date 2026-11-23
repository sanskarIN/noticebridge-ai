import { useEffect, useMemo, useRef, useState } from 'react';
import type { Evidence, Finding, FindingCategory, Report, ValueChange } from './comparison';
import { reviewPriorities } from './reviewPriority';

const PAGE_SIZE = 20;

const copy = {
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
  compareSources: 'Compare source pages',
  ocr: 'Machine OCR — verify transcription',
  semantic: 'Local AI suggestion — verify PDF source',
  similarity: 'text similarity (not confidence)',
  values: 'Extracted values (syntactic check only)',
};

const statuses: Record<Finding['status'], string> = {
  confirmed_change: 'Matched text change',
  possible_change: 'Possible change',
  contradiction: 'Conflicting dates',
  missing_information: 'Unmatched statement',
};

const categories: Record<FindingCategory, string> = {
  deadline: 'Deadline', eligibility: 'Eligibility', fee: 'Fee',
  time: 'Time', instruction: 'Instruction', general: 'General',
};

const valueKinds: Record<ValueChange['kind'], string> = {
  date: 'Date',
  amount: 'Amount',
};

const valueOutcomes: Record<ValueChange['outcome'], string> = {
  changed: 'Changed',
  same_value: 'Same value',
  uncertain: 'Uncertain',
};

function findingEvidence(finding: Finding): Evidence[] {
  return [finding.original, finding.revised, ...finding.supporting_evidence]
    .filter((evidence): evidence is Evidence => evidence !== null);
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function emphasizedQuote(text: string, tokens: string[]) {
  const spans = [...new Set(tokens)].flatMap(token => {
    const start = text.indexOf(token);
    return token && start >= 0 && start === text.lastIndexOf(token)
      ? [{ start, end: start + token.length }] : [];
  }).sort((a, b) => a.start - b.start);
  let end = 0;
  const parts = [];
  for (const span of spans) {
    if (span.start < end) continue;
    parts.push(text.slice(end, span.start), <mark key={span.start}>{text.slice(span.start, span.end)}</mark>);
    end = span.end;
  }
  parts.push(text.slice(end));
  return parts;
}

function EvidenceCard({ evidence, changedTokens, onOpen }: {
  evidence: Evidence;
  changedTokens: string[];
  onOpen: (evidence: Evidence) => void;
}) {
  const t = copy;
  return <div className="evidence-card">
    <div className="evidence-label">{t[evidence.document_id]}</div>
    <div className="page-ref">{evidence.filename} · {t.page} {evidence.page}</div>
    {evidence.extraction_method === 'ocr' && <p className="ocr-source">{t.ocr}</p>}
    <blockquote>{emphasizedQuote(evidence.text, changedTokens)}</blockquote>
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

export default function ReviewFindings({ report, checked, onCheck, onOpen, onCompareSources }: {
  report: Report;
  checked: ReadonlySet<string>;
  onCheck: (id: string, selected: boolean) => void;
  onOpen: (evidence: Evidence) => void;
  onCompareSources: (original: Evidence, revised: Evidence) => void;
}) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [focusFinding, setFocusFinding] = useState<string | null>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const t = copy;

  const checklist = useMemo(() =>
    new Map(report.checklist.map(item => [item.finding_id, item])), [report.checklist]
  );
  const reviewable = useMemo(() => new Set(checklist.keys()), [checklist]);
  const priorities = useMemo(
    () => reviewPriorities(report.findings, reviewable, checked),
    [report.findings, reviewable, checked],
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

  useEffect(() => {
    if (focusFinding === null) return;
    document.getElementById(`finding-${focusFinding}`)?.focus();
    setFocusFinding(null);
  }, [focusFinding]);

  function jumpToFinding(id: string) {
    const index = indexed.findIndex(entry => entry.finding.id === id);
    if (index < 0) return;
    setFilters(DEFAULT_FILTERS);
    setPage(Math.floor(index / PAGE_SIZE) + 1);
    setFocusFinding(id);
  }

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
    {!!priorities.length && <section className="review-priorities" aria-labelledby="review-first-heading">
      <div className="priority-intro">
        <h3 id="review-first-heading">Review first</h3>
        <p>Check urgent or uncertain changes against the source before acting.</p>
      </div>
      <ul>{priorities.map(item =>
        <li key={item.id}>
          <div><strong>{item.title}</strong><p>{item.detail}</p></div>
          <button type="button" className="review-button"
            aria-label={`Inspect finding: ${item.title}`}
            onClick={() => jumpToFinding(item.id)}>Inspect finding</button>
        </li>
      )}</ul>
    </section>}
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
        {Object.entries(statuses).map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label><span>{t.category}</span><select value={filters.category}
        onChange={event => changeFilters({ category: event.target.value as Filters['category'] })}>
        <option value="all">{t.all}</option>
        {Object.entries(categories).map(([key, label]) =>
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
      const changed = finding.field_changes.filter(delta => delta.outcome === 'changed');
      const { original, revised } = finding;
      return <article className="finding" key={finding.id} id={`finding-${finding.id}`} tabIndex={-1}>
        <div className="finding-header">
          <div>
            <span className={`status ${finding.status}`}>{statuses[finding.status]}</span>
            <span className="category">{categories[finding.category]}</span>
          </div>
          {finding.original && finding.revised && <span className="match-score">
            {finding.match_method === 'semantic_proposal' ? t.semantic :
              finding.match_method === 'explicit_amendment' ? 'Explicit amendment wording' :
                `${Math.round(finding.similarity * 100)}% ${t.similarity}`}
          </span>}
        </div>
        <p className="finding-summary">{finding.summary_en}</p>
        {finding.field_changes.length > 0 && <div className="value-changes">
          <b>{t.values}</b>
          {finding.field_changes.map((delta, i) => <p key={i}>
            <span className="value-outcome">{valueKinds[delta.kind]}: {finding.match_method === 'explicit_amendment'
              ? 'Stated in amendment' : valueOutcomes[delta.outcome]}</span>
            {' '}{delta.original.raw} → {delta.revised.raw}
            {delta.outcome !== 'uncertain' && ` (${delta.original.canonical} → ${delta.revised.canonical})`}
          </p>)}
        </div>}
        <div className={`evidence-grid${evidence.length === 1 ? ' single-evidence' : ''}`}>
          {evidence.map((item, i) => <EvidenceCard
            key={`${item.document_id}-${item.page}-${i}`}
            evidence={item} onOpen={onOpen}
            changedTokens={item === finding.original
              ? changed.map(delta => delta.original.raw)
              : item === finding.revised ? changed.map(delta => delta.revised.raw) : []}
          />)}
        </div>
        {original && revised && <button type="button" className="source-button compare-source-button"
          onClick={() => onCompareSources(original, revised)}>{t.compareSources}</button>}
        {task && <label className="checklist-item">
          <input type="checkbox" checked={checked.has(finding.id)}
            onChange={event => changeReview(finding.id, event.target.checked)} />
          <span>{task.description_en}</span>
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
