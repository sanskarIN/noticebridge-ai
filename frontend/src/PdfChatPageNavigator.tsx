import { useState, type FormEvent } from 'react';
import type { Role } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { describePages, manualPageNumber, MAX_COVERAGE_LIST_PAGES, pageStatusLabels, type PageFilter } from './pdfChatPageCoverage';

const roles: Role[] = ['original', 'revised'];
const names: Record<Role, string> = {
  original: 'Original / first PDF', revised: 'Updated / second PDF',
};

export default function PdfChatPageNavigator({ corpora, onInspect }: {
  corpora: ChatCorpora; onInspect: (role: Role, page: number) => void;
}) {
  const [filter, setFilter] = useState<PageFilter>('attention');
  const [role, setRole] = useState<Role>(corpora.original ? 'original' : 'revised');
  const [pageText, setPageText] = useState('');
  const [error, setError] = useState(false);
  const pages = describePages(corpora);
  function jump(event: FormEvent) {
    event.preventDefault();
    const corpus = corpora[role];
    const page = corpus ? manualPageNumber(pageText, corpus.pageCount) : null;
    setError(page === null);
    if (page !== null) onInspect(role, page);
  }
  const visible = filter === 'all' ? pages : filter === 'attention'
    ? pages.filter(page => page.status !== 'some_text')
    : pages.filter(page => page.status === filter);
  return <details className="chat-session chat-embedding-panel">
    <summary>Inspect PDF page coverage</summary>
    <p className="chat-note">Inspect any physical page, including pages without indexed text.
      Coverage reflects extraction only, not whether a page is completely understood or authentic.</p>
    <label className="chat-overview-filter">Page coverage filter
      <select value={filter} onChange={event => setFilter(event.target.value as PageFilter)}>
        <option value="attention">Pages needing inspection</option>
        <option value="all">All physical pages</option>
        <option value="no_indexed_text">No indexed text</option>
        <option value="limited">Partial indexing</option>
        <option value="not_indexed">Not indexed</option>
        <option value="some_text">Some indexed text</option>
      </select>
    </label>
    <p role="status">{visible.length} of {pages.length} listed physical pages shown.</p>
    <form className="chat-form" onSubmit={jump}>
      <label>Manual PDF source
        <select value={role} onChange={event => { setRole(event.target.value as Role); setError(false); }}>
          {roles.filter(item => corpora[item]).map(item =>
            <option key={item} value={item}>{names[item]}</option>)}
        </select>
      </label>
      <label>Physical page to inspect
        <input type="text" inputMode="numeric" maxLength={16} value={pageText}
          onChange={event => { setPageText(event.target.value); setError(false); }} />
      </label>
      <p className="chat-muted">Jump to any physical page from 1 to {corpora[role]?.pageCount ?? 0},
        including pages beyond the native indexing limit.</p>
      <button type="submit" className="chat-button">Inspect selected physical page</button>
      {error && <p role="alert" className="chat-error">Enter a valid physical page for this PDF.</p>}
    </form>
    {roles.map(role => corpora[role] && <section key={role} aria-label={names[role] + ' page coverage'}>
      <h3>{names[role]}</h3>
      <p className="chat-muted">{pages.filter(page => page.role === role && page.status === 'some_text').length}
        {' '}pages with some indexed native text; this does not establish complete coverage.</p>
      {corpora[role]!.pageCount > MAX_COVERAGE_LIST_PAGES && <p className="chat-note">
        The list is limited to the first {MAX_COVERAGE_LIST_PAGES} physical pages.
        Use the manual page control to inspect later pages.
      </p>}
      <div className="chat-page-grid">
        {visible.filter(page => page.role === role).map(page => <button key={page.page}
          type="button" className="chat-button chat-page-button"
          aria-label={'Inspect ' + role + ' physical page ' + page.page + ': ' + pageStatusLabels[page.status]}
          onClick={() => onInspect(role, page.page)}>
          <strong>Page {page.page}</strong>
          <span>{pageStatusLabels[page.status]}</span>
          <small>{page.fragments} indexed fragments</small>
        </button>)}
      </div>
      {!visible.some(page => page.role === role) && <p className="chat-muted">No pages match this filter.</p>}
    </section>)}
  </details>;
}
