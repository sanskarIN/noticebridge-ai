import { useMemo, useState } from 'react';
import type { Passage, Scope } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { buildOutline, compareOutlineSections, filterOutline, findOutlineSection, outlinePage,
  searchSectionFragments, MAX_SECTION_FILTER_CHARS, SECTION_FRAGMENT_PAGE_SIZE,
  type Outline, type OutlineFilter, type OutlineSection, type SectionComparison } from './pdfChatStructure';

const roleName = (role: Passage['role']) => role === 'original' ? 'Original' : 'Revised';
function Source({ source, onInspect }: { source: Passage; onInspect: (source: Passage) => void }) {
  return <div className="chat-citation">
    <p className="chat-muted">{roleName(source.role)} · page {source.page} · fragment {source.ordinal}</p>
    <p>{source.text}</p>
    <button type="button" className="chat-button" onClick={() => onInspect(source)}>
      Inspect {roleName(source.role).toLowerCase()} page {source.page}, fragment {source.ordinal}
    </button>
  </div>;
}
function Pager({ page, pages, first, last, total, onChange, label }: {
  page: number; pages: number; first: number; last: number; total: number;
  onChange: (page: number) => void; label: string;
}) {
  return <div className="chat-toolbar" aria-label={label}>
    <button type="button" className="chat-button" disabled={page === 1} onClick={() => onChange(page - 1)}>Previous</button>
    <p>{first}–{last} of {total}</p>
    <button type="button" className="chat-button" disabled={page === pages} onClick={() => onChange(page + 1)}>Next</button>
  </div>;
}
function SectionReader({ section, onInspect }: { section: OutlineSection; onInspect: (source: Passage) => void }) {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const rows = searchSectionFragments(section, keyword);
  const results = outlinePage(rows, page, SECTION_FRAGMENT_PAGE_SIZE);
  return <section className="chat-context-results" aria-label="Selected section candidate">
    <h3>{section.source.text}</h3>
    <p className="chat-muted">{roleName(section.source.role)} · candidate span on physical pages
      {' '}{section.firstPage}–{section.lastPage} · {section.fragments.length} following indexed fragments.</p>
    <p className="chat-note">These are fragments in extraction order until the next detected heading.
      The heading and span boundaries are only candidates, not verified section structure.</p>
    {section.ordinalGaps > 0 && <p className="chat-note">{section.ordinalGaps} same-page ordinal gaps;
      omitted fragments may occur inside the span.</p>}
    {section.uncertainPages.length > 0 && <p className="chat-note">Missing or limited text on physical pages
      {' '}{section.uncertainPages.join(', ')}.</p>}
    <label className="chat-overview-filter">Filter selected section fragments
      <input maxLength={MAX_SECTION_FILTER_CHARS} value={keyword}
        onChange={event => { setKeyword(event.target.value); setPage(1); }} />
    </label>
    {results.items.map(source => <Source key={source.page + ':' + source.ordinal} source={source} onInspect={onInspect} />)}
    {!rows.length && <p>No exact indexed text matches this filter. Other content may be present in the PDF.</p>}
    <Pager {...results} page={page} total={rows.length} onChange={setPage} label="Section fragment pages" />
  </section>;
}
function Alignment({ result, onInspect }: { result: SectionComparison; onInspect: (source: Passage) => void }) {
  const [page, setPage] = useState(1);
  const [changesOnly, setChangesOnly] = useState(false);
  const rows = changesOnly ? result.rows.filter(row => row.kind !== 'same_wording') : result.rows;
  const shown = outlinePage(rows, page);
  return <section className="chat-context-results" aria-label="Exact section alignment">
    <h3>Literal sequence comparison</h3>
    <p>{result.same} paired exact-wording fragments · {result.originalUnpaired} unpaired original
      {' '}· {result.revisedUnpaired} unpaired revised.</p>
    <p className="chat-note">Same printed identifier does not prove the same legal section.
      Unpaired wording may reflect rearrangement, extraction differences or an actual revision.
      This alignment does not assert additions, removals, or equivalent requirements.</p>
    {result.repeatedText && <p className="chat-note">Repeated wording can produce multiple valid alignments.</p>}
    {result.coverageLimited && <p className="chat-note">Extraction coverage or ordinal gaps limit this comparison.</p>}
    <label className="chat-embedding-consent"><input type="checkbox" checked={changesOnly}
      onChange={event => { setChangesOnly(event.target.checked); setPage(1); }} /> Show unpaired fragments only</label>
    {shown.items.map((row, i) => <div key={shown.first + i} className="chat-section-alignment">
      <strong>{row.kind === 'same_wording' ? 'Paired exact wording' : 'Unpaired indexed wording'}</strong>
      <div className="chat-field-grid">
        {'original' in row ? <Source source={row.original} onInspect={onInspect} /> : <p className="chat-muted">No aligned original fragment</p>}
        {'revised' in row ? <Source source={row.revised} onInspect={onInspect} /> : <p className="chat-muted">No aligned revised fragment</p>}
      </div>
    </div>)}
    <Pager {...shown} page={page} total={rows.length} onChange={setPage} label="Alignment pages" />
  </section>;
}

function OutlineBrowser({ outline, onInspect }: { outline: Outline; onInspect: (source: Passage) => void }) {
  const [filter, setFilter] = useState<OutlineFilter>({ scope: 'both', keyword: '', kind: 'all', pairedOnly: false });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [comparison, setComparison] = useState<SectionComparison | null>(null);
  const [error, setError] = useState('');
  const rows = filterOutline(outline, filter);
  const shown = outlinePage(rows, page);
  function update(change: Partial<OutlineFilter>) {
    setFilter(old => ({ ...old, ...change }));
    setPage(1); setSelected(null); setComparison(null); setError('');
  }
  function compare(section: OutlineSection, other: OutlineSection) {
    setError(''); setSelected(null); setComparison(null);
    try {
      setComparison(section.source.role === 'original'
        ? compareOutlineSections(outline, section.id, other.id)
        : compareOutlineSections(outline, other.id, section.id));
    } catch { setError('The candidate spans cannot be aligned within the inspection limits. Open each independently.'); }
  }
  return <>
    <div className="chat-field-grid">
      {(['original', 'revised'] as const).map(role => {
        const side = outline[role];
        return side && <div key={role} className="chat-muted">
          <strong>{roleName(role)}</strong>
          <p>{side.sections.length} candidate headings; {side.beforeFirst.length} fragments before the first heading;
            {' '}{side.processedPages}/{side.physicalPages} physical pages processed.</p>
        </div>;
      })}
    </div>
    <label className="chat-overview-filter">Outline source
      <select aria-label="Outline source" value={filter.scope} onChange={event => update({ scope: event.target.value as Scope })}>
        <option value="both">Both PDFs</option>
        <option value="original">Original PDF</option>
        <option value="revised">Revised PDF</option>
      </select>
    </label>
    <label className="chat-overview-filter">Heading marker type
      <select value={filter.kind} onChange={event => update({ kind: event.target.value as OutlineFilter['kind'] })}>
        <option value="all">All heading candidates</option>
        <option value="reference">Explicit section / clause markers</option>
        <option value="numbered">Numbered heading candidates</option>
        <option value="named">Recognized standalone labels</option>
      </select>
    </label>
    <label className="chat-overview-filter">Heading text filter
      <input value={filter.keyword} maxLength={MAX_SECTION_FILTER_CHARS}
        onChange={event => update({ keyword: event.target.value })} />
    </label>
    <label className="chat-embedding-consent"><input type="checkbox" checked={filter.pairedOnly}
      onChange={event => update({ pairedOnly: event.target.checked })} /> Only candidates with a matching heading marker in the other PDF</label>
    {!rows.length && <p>No candidate headings match the selected filters. Use the indexed evidence explorer or inspect the PDF.</p>}
    {shown.items.map(({ section, sameKeyOther, repeatedHere }) => <div className="chat-citation" key={section.id}>
      <p className="chat-muted">{roleName(section.source.role)} · page {section.source.page} · fragment {section.source.ordinal}</p>
      <strong>{section.source.text}</strong>
      <p>{section.fragments.length} following fragments · {sameKeyOther.length} same-marker candidate(s) in the other PDF.</p>
      {repeatedHere > 1 && <p className="chat-note">This marker occurs {repeatedHere} times in this source; no occurrence is preferred.</p>}
      <button type="button" className="chat-button" onClick={() => {
        setSelected(section.id); setComparison(null); setError('');
      }}>Open candidate span</button>
      {sameKeyOther.length > 0 && <details>
        <summary>Choose a physical counterpart</summary>
        <p className="chat-muted">Matching marker only; not a confirmed corresponding clause.</p>
        {sameKeyOther.slice(0, 12).map(other => <div key={other.id}>
          <p>{roleName(other.source.role)} page {other.source.page}, fragment {other.source.ordinal}: {other.source.text}</p>
          <button type="button" className="chat-button" onClick={() => compare(section, other)}>
            Compare with {roleName(other.source.role).toLowerCase()} page {other.source.page}, fragment {other.source.ordinal}
          </button>
        </div>)}
        {sameKeyOther.length > 12 && <p className="chat-note">More counterpart candidates exist. Narrow the outline or inspect the other PDF.</p>}
      </details>}
    </div>)}
    <Pager {...shown} page={page} total={rows.length} onChange={setPage} label="Outline pages" />
    {selected && <SectionReader key={selected} section={findOutlineSection(outline, selected)} onInspect={onInspect} />}
    {comparison && <Alignment key={comparison.original.id + comparison.revised.id} result={comparison} onInspect={onInspect} />}
    {error && <p role="alert" className="chat-error">{error}</p>}
  </>;
}
export default function PdfChatStructure({ corpora, onInspect }: {
  corpora: ChatCorpora; onInspect: (source: Passage) => void;
}) {
  const [open, setOpen] = useState(false);
  const outline = useMemo(() => open ? buildOutline(corpora) : null, [open, corpora]);
  return <details className="chat-session chat-embedding-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Inspect candidate section outline and literal alignment</summary>
    <p className="chat-note">This is a conservative outline of native extracted heading candidates,
      not a verified table of contents. No OCR or model output is added. Selecting a candidate
      does not change the question scope or answer.</p>
    {outline && <OutlineBrowser outline={outline} onInspect={onInspect} />}
  </details>;
}
