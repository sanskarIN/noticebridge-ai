import { useMemo, useState, type FormEvent } from 'react';
import type { Answer, Passage } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';
import { MAX_COVERAGE_LIST_PAGES, pageStatusLabels, type PageFilter } from './pdfChatPageCoverage';
import { COLLECTION_PAGE_LIST_SIZE, collectionPageDescriptions, collectionPageList, filterCollectionPages,
  resolveCollectionPage, collectionTableInventory, collectionTableAnswer, collectionTableQuestion,
  inspectCollectionTableSource, isCollectionTableQuestion } from './pdfChatCollectionLayout';

type Inspect = (documentId: string, source: Passage, target: HTMLElement) => void;
type Props = { documents: readonly CollectionDocument[]; names: Map<string, string> };

export function CollectionPageNavigator({ documents, names, onInspect }: Props & {
  onInspect: (documentId: string, page: number, target: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const [documentId, setDocumentId] = useState(documents[0].id);
  const [filter, setFilter] = useState<PageFilter>('attention');
  const [listPage, setListPage] = useState(1);
  const [input, setInput] = useState('');
  const [error, setError] = useState(false);
  const document = documents.find(doc => doc.id === documentId) ?? documents[0];
  const rows = useMemo(() => open ? collectionPageDescriptions(documents, document.id) : [],
    [open, documents, document.id]);
  const visible = filterCollectionPages(rows, filter);
  const page = Math.min(listPage, Math.max(1, Math.ceil(visible.length / COLLECTION_PAGE_LIST_SIZE)));
  const current = collectionPageList(visible, page);
  function jump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    try {
      const source = resolveCollectionPage(documents, document.id, input);
      setError(false);
      const button = event.currentTarget.querySelector<HTMLButtonElement>('button[type=submit]');
      if (button) onInspect(source.documentId, source.page, button);
    } catch { setError(true); }
  }
  return <details className="chat-collection-inspection" aria-label="Collection page coverage"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Inspect collection PDF page coverage</summary>
    <p>Open any physical page, including blank, image-only, partially indexed and unindexed pages.
      A native text count does not establish complete transcription.</p>
    {open && <>
      <div className="chat-collection-filter-grid">
        <label>Collection page document
          <select value={document.id} onChange={event => {
            setDocumentId(event.target.value); setListPage(1); setInput(''); setError(false);
          }}>
            {documents.map(doc => <option key={doc.id} value={doc.id}>{names.get(doc.id)}</option>)}
          </select>
        </label>
        <label>Collection page coverage filter
          <select value={filter} onChange={event => { setFilter(event.target.value as PageFilter); setListPage(1); }}>
            <option value="attention">Pages needing inspection</option>
            <option value="all">All listed pages</option>
            <option value="no_indexed_text">No indexed text</option>
            <option value="limited">Partial indexing</option>
            <option value="not_indexed">Not indexed</option>
            <option value="some_text">Some indexed text</option>
          </select>
        </label>
      </div>
      <p role="status">{visible.length} of {rows.length} listed physical pages match the filter.</p>
      <p className="chat-muted">{document.corpus.processedPages}/{document.corpus.pageCount} physical pages processed.</p>
      {document.corpus.pageCount > MAX_COVERAGE_LIST_PAGES && <p className="chat-note">
        The list includes only the first {MAX_COVERAGE_LIST_PAGES} physical pages. Manual inspection can open later pages.</p>}
      <form className="chat-form" onSubmit={jump}>
        <label>Collection physical page to inspect
          <input value={input} inputMode="numeric" maxLength={16} onChange={event => { setInput(event.target.value); setError(false); }} />
        </label>
        <p className="chat-muted">Enter a physical page from 1 to {document.corpus.pageCount}.</p>
        <button type="submit" className="chat-button">Inspect selected collection page</button>
        {error && <p role="alert" className="chat-error">Enter a valid physical page for this collection PDF.</p>}
      </form>
      <div className="chat-page-grid">
        {current.rows.map(row => <button type="button" key={row.page} className="chat-button chat-page-button"
          aria-label={'Inspect collection physical page ' + row.page + ': ' + pageStatusLabels[row.status]}
          onClick={event => onInspect(row.documentId, row.page, event.currentTarget)}>
          <strong>Page {row.page}</strong><span>{pageStatusLabels[row.status]}</span>
          <small>{row.fragments} indexed fragments</small>
        </button>)}
      </div>
      {!visible.length && <p>No listed pages match this filter.</p>}
      {current.pages > 1 && <div className="chat-toolbar" aria-label="Collection coverage list pagination">
        <button type="button" className="chat-button" disabled={page === 1} onClick={() => setListPage(page - 1)}>Previous coverage pages</button>
        <span>{current.first}–{current.last} of {visible.length} · list page {page} of {current.pages}</span>
        <button type="button" className="chat-button" disabled={page === current.pages} onClick={() => setListPage(page + 1)}>Next coverage pages</button>
      </div>}
    </>}
  </details>;
}

export function CollectionTableExplorer({ documents, names, selected, onInspect, onAsk }: Props & {
  selected: string[]; onInspect: Inspect; onAsk: (documentId: string, question: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState(false);
  const sides = useMemo(() => open && selected.length ? collectionTableInventory(documents, selected) : [],
    [open, documents, selected]);
  const rows = sides.flatMap(side => side.tables);
  const row = rows.find(table => table.key === choice) ?? rows[0];
  const table = row?.table;
  function inspect(source: Passage, target: HTMLElement) {
    if (!row) return;
    try {
      inspectCollectionTableSource(documents, row.documentId, row.key, source);
      setError(false);
      onInspect(row.documentId, source, target);
    } catch { setError(true); }
  }
  return <details className="chat-collection-inspection" aria-label="Collection aligned tables"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Explore aligned category tables in selected collection PDFs</summary>
    <p className="chat-note">These are possible tables reconstructed from native text alignment, not verified
      table structures. Inspect the rendered source before relying on a cell.</p>
    {open && <>
      {!selected.length && <p>Select collection PDFs above.</p>}
      {sides.map(side => <div key={side.documentId} className="chat-note">
        <strong>{names.get(side.documentId)}</strong>
        <p>{side.tables.length} aligned table candidate(s).
          {side.skippedPages.length ? ' Layout inspection skipped physical pages: ' + side.skippedPages.join(', ') + '.' : ''}
          {side.limited ? ' Table candidate limit reached.' : ''}</p>
        <p className="chat-muted">No detected table is not proof that the PDF contains no tables.</p>
      </div>)}
      {row && table && <>
        <label className="chat-table-selector">Select collection table
          <select value={row.key} onChange={event => { setChoice(event.target.value); setError(false); }}>
            {rows.map((item, index) => <option key={item.key} value={item.key}>
              {names.get(item.documentId)} · page {item.table.page} · candidate {index + 1}</option>)}
          </select>
        </label>
        <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="Collection aligned table preview">
          <table>
            <caption>{names.get(row.documentId)} · physical page {table.page}</caption>
            <thead><tr>{table.headers.map((header, index) => <th key={header.ordinal} scope="col">
              {header.text}
              <button className="chat-button" type="button" aria-label={'Inspect collection table header ' + (index + 1)}
                onClick={event => inspect(header, event.currentTarget)}>Source</button>
            </th>)}</tr></thead>
            <tbody>{table.rows.map((cells, index) => <tr key={cells[0].ordinal}>
              <th scope="row">{cells[0].text}
                <button className="chat-button" type="button" aria-label={'Inspect collection table row ' + (index + 1)}
                  onClick={event => inspect(cells[0], event.currentTarget)}>Source</button>
              </th>
              {cells.slice(1).map((cell, column) => {
                const question = collectionTableQuestion(documents, row.documentId, row.key, index, column + 1);
                return <td key={cell.ordinal}><strong>{cell.text}</strong>
                  <div className="chat-table-actions">
                    <button type="button" className="chat-button"
                      aria-label={'Inspect collection ' + table.headers[column + 1].text + ' for ' + cells[0].text}
                      onClick={event => inspect(cell, event.currentTarget)}>Source</button>
                    {question && <button type="button" className="chat-button"
                      aria-label={'Ask collection ' + table.headers[column + 1].text + ' for ' + cells[0].text}
                      onClick={() => onAsk(row.documentId, question)}>Ask</button>}
                  </div>
                </td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
        <p className="chat-muted">Ask selects the exact PDF and prefills a physical-page question without submitting it.</p>
      </>}
      {error && <p role="alert" className="chat-error">Unable to inspect the selected collection table source.</p>}
    </>}
  </details>;
}

export function CollectionTableCandidates({ documents, documentId, answer, onInspect }: {
  documents: readonly CollectionDocument[]; documentId: string; answer: Answer; onInspect: Inspect;
}) {
  const [open, setOpen] = useState(false);
  const candidate = useMemo(() => open ? collectionTableAnswer(documents, documentId, answer) : null,
    [open, documents, documentId, answer]);
  if (!isCollectionTableQuestion(answer)) return null;
  return <details className="chat-collection-inspection" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Inspect possible collection table answers</summary>
    <p className="chat-note">Aligned table candidates are independent of the native-text baseline,
      are not included in saved answer replay, and do not establish applicability or authority.</p>
    {candidate && <>
      {!candidate.result && <p>No matching aligned table candidate in this document.</p>}
      {candidate.result?.matches.map((match, index) => <div className="chat-direct-side" key={match.page + ':' + match.value.ordinal}>
        <p className="chat-muted">Physical page {match.page} · table candidate {index + 1}</p>
        <dl className="chat-table-evidence">
          {([['Category header', match.categoryHeader], ['Field header', match.fieldHeader],
            ['Row category', match.category], ['Aligned cell text', match.value]] as const).map(([label, source]) =>
            <div key={label}><dt>{label}</dt><dd>{source.text}
              <button type="button" className="chat-button" aria-label={'Inspect collection table ' + label.toLowerCase()}
                onClick={event => onInspect(documentId, source, event.currentTarget)}>Source</button></dd></div>)}
        </dl>
      </div>)}
      {candidate.result && candidate.result.total > candidate.result.matches.length &&
        <p className="chat-note">{candidate.result.total - candidate.result.matches.length} additional table candidates not displayed.</p>}
      {candidate.skippedPages.length > 0 && <p className="chat-muted">Layout inspection skipped physical pages:
        {' '}{candidate.skippedPages.join(', ')}.</p>}
      {candidate.limited && <p className="chat-note">Table candidate limit reached.</p>}
    </>}
  </details>;
}
