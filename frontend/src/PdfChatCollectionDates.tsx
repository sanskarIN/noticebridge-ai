import { useMemo, useState } from 'react';
import type { Passage } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';
import { collectionTimelines, collectionDates, collectionDateFields, collectionDateWindows,
  collectionDatePage, collectionDatePageFilter, COLLECTION_DATE_PAGE_SIZE, type CollectionDateFilter,
  type CollectionDateField } from './pdfChatCollectionDates';
import { dateCoverage, describeTimelineValue, type DateOccurrence, type DateEvent } from './pdfChatTimeline';

type Inspect = (id: string, source: Passage, target: HTMLElement) => void;
const reason: Record<DateEvent['reason'], string> = {
  unique: 'One distinct supported date; undiscovered qualifications may remain.',
  multiple_values: 'Multiple distinct printed values; no preferred date is selected.',
  not_single_date: 'Not a complete single date; arithmetic withheld.',
  possible_conditions: 'Additional matching or nearby text requires manual review.',
};
const fieldState: Record<CollectionDateField['state'], string> = {
  one_document: 'One selected document has a supported date.',
  missing_label: 'One or more selected documents lack a recognized date label.',
  review_required: 'At least one document needs manual review; arithmetic withheld.',
  same_day: 'The supported printed dates refer to the same calendar day.',
  different_days: 'The supported printed dates refer to different calendar days.',
};
function Occurrence({ id, row, inspect }: { id: string; row: DateOccurrence; inspect: Inspect }) {
  const source = row.field.source;
  return <div className="chat-citation">
    <p className="chat-muted">Physical page {source.page} · fragment {source.ordinal}</p>
    <p><strong>{row.field.label}:</strong> {row.field.value}</p>
    <p className="chat-muted">{describeTimelineValue(row.parsed)}</p>
    <button type="button" className="chat-button" onClick={event => inspect(id, source, event.currentTarget)}>Inspect collection date source</button>
    {row.reviewLeadCount > 0 && <details>
      <summary>{row.reviewLeadCount} possible contextual lead(s)</summary>
      <p className="chat-note">These leads are not verified conditions or qualifications.</p>
      {row.reviewLeads.map(lead => <div key={lead.page + ':' + lead.ordinal}>
        <blockquote>{lead.text}</blockquote>
        <button type="button" className="chat-button" onClick={event => inspect(id, lead, event.currentTarget)}>
          Inspect collection date context page {lead.page}, fragment {lead.ordinal}</button>
      </div>)}
      {row.reviewLeadCount > row.reviewLeads.length && <p>Additional leads not displayed.</p>}
    </details>}
  </div>;
}
function EventSummary({ id, value, inspect }: { id: string; value: DateEvent | null; inspect: Inspect }) {
  if (!value) return <p>No recognized indexed date label. This is not proof of absence.</p>;
  return <div>
    <p><strong>{value.definition.label}</strong> · {value.occurrences.length} occurrence(s)</p>
    <p className="chat-muted">{reason[value.reason]}</p>
    {value.occurrences.slice(0, 2).map(row => <Occurrence key={row.id} id={id} row={row} inspect={inspect} />)}
    {value.occurrences.length > 2 && <p className="chat-muted">Additional occurrences are available in the date inventory.</p>}
  </div>;
}
export default function PdfChatCollectionDates({ documents, selected, names, onInspect }: {
  documents: readonly CollectionDocument[];
  selected: string[];
  names: Map<string, string>;
  onInspect: Inspect;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'dates' | 'fields' | 'windows'>('dates');
  const [filter, setFilter] = useState<CollectionDateFilter>({ kind: 'all', parse: 'all', order: 'chronological' });
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [error, setError] = useState(false);
  const sides = useMemo(() => open && selected.length ? collectionTimelines(documents, selected) : [],
    [open, documents, selected]);
  const dates = useMemo(() => mode === 'dates' ? collectionDates(sides, filter) : [], [mode, sides, filter]);
  const fields = useMemo(() => mode === 'fields' ? collectionDateFields(sides) : [], [mode, sides]);
  const windows = useMemo(() => mode === 'windows' ? collectionDateWindows(sides) : [], [mode, sides]);
  const size = mode === 'dates' ? COLLECTION_DATE_PAGE_SIZE : 4;
  const count = mode === 'dates' ? dates.length : mode === 'fields' ? fields.length : windows.length;
  const current = Math.min(page, Math.max(1, Math.ceil(count / size)));
  function change(change: Partial<CollectionDateFilter>) {
    setFilter(old => ({ ...old, ...change })); setPage(1);
  }
  return <details className="chat-collection-inspection" aria-label="Collection printed dates"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Inspect printed dates across collection PDFs</summary>
    <p className="chat-note">This inventory lists recognized printed date labels, not official schedules.
      Different documents are independent; no version, applicability, deadline reminder or authority is inferred.</p>
    {open && <>
      {!selected.length && <p>Select collection PDFs first.</p>}
      <div className="chat-toolbar">
        {([['dates', 'Collection date occurrences'], ['fields', 'Compare collection date labels'],
          ['windows', 'Inspect within-document date windows']] as const).map(([key, label]) =>
          <button type="button" key={key} className="chat-button" aria-pressed={mode === key}
            onClick={() => { setMode(key); setPage(1); }}>{label}</button>)}
      </div>
      {mode === 'dates' && <>
        <div className="chat-collection-filter-grid">
          <label>Collection date type
            <select value={filter.kind} onChange={event => change({ kind: event.target.value as CollectionDateFilter['kind'] })}>
              <option value="all">All labels</option><option value="opening">Opening</option><option value="closing">Closing</option><option value="event">Other events</option>
            </select>
          </label>
          <label>Collection date parsing
            <select value={filter.parse} onChange={event => change({ parse: event.target.value as CollectionDateFilter['parse'] })}>
              <option value="all">All values</option><option value="parsed">Supported date expressions</option><option value="unparsed">Unparsed values</option>
            </select>
          </label>
          <label>Collection date order
            <select value={filter.order} onChange={event => change({ order: event.target.value as CollectionDateFilter['order'] })}>
              <option value="chronological">Calendar order</option><option value="source">Document and page order</option>
            </select>
          </label>
          <label>Collection date physical page (optional)
            <input value={pageInput} maxLength={2} inputMode="numeric" onChange={event => {
              setPageInput(event.target.value);
              try { change({ page: collectionDatePageFilter(event.target.value) }); setError(false); }
              catch { setError(true); }
            }} />
          </label>
        </div>
        {error && <p role="alert" className="chat-error">Enter a physical page from 1 to 80. The prior valid filter remains active.</p>}
        {sides.map(side => <p key={side.documentId} className="chat-muted">{names.get(side.documentId)}:
          {' '}{dateCoverage(documents.find(doc => doc.id === side.documentId)?.corpus, filter.page)}</p>)}
        <p role="status">{dates.length} printed date occurrence(s).</p>
        {collectionDatePage(dates, current).rows.map(row => <section className="chat-answer"
          key={row.documentId + ':' + row.occurrence.id} aria-label={'Collection date: ' + names.get(row.documentId)}>
          <h4>{names.get(row.documentId)} · {row.event.definition.label}</h4>
          <p className="chat-muted">{reason[row.event.reason]}</p>
          <Occurrence id={row.documentId} row={row.occurrence} inspect={onInspect} />
        </section>)}
      </>}
      {mode === 'fields' && <>
        <p className="chat-muted">A calendar-day span is an unsigned difference between printed values, not a deadline extension.
          Arithmetic requires one supported, unqualified single date in every selected PDF.</p>
        {collectionDatePage(fields, current, size).rows.map(field => <article className="chat-field-pair" key={field.id}>
          <h4>{field.label}</h4><p>{fieldState[field.state]}</p>
          {field.spanDays !== null && <p>Printed calendar-day span: {field.spanDays} day(s).</p>}
          <div className="chat-collection-matrix">
            {field.sides.map(side => <section className="chat-overview-side" key={side.documentId}>
              <h5>{names.get(side.documentId)}</h5>
              <EventSummary id={side.documentId} value={side.event} inspect={onInspect} />
            </section>)}
          </div>
        </article>)}
      </>}
      {mode === 'windows' && <>
        <p className="chat-muted">Opening and closing labels are paired only within the same PDF. Day differences are not inclusive durations.</p>
        {collectionDatePage(windows, current, size).rows.map(window => <article className="chat-field-pair" key={window.documentId + ':' + window.name}>
          <h4>{names.get(window.documentId)} · {window.name}</h4>
          <p>{window.outcome === 'missing_label' ? 'A recognized opening or closing label is missing.'
            : window.outcome === 'review_required' ? 'Manual review required; arithmetic withheld.'
            : window.outcome === 'reversed_printed_order' ? 'Printed closing day precedes printed opening day.'
            : 'Printed closing day is on or after printed opening day.'}</p>
          {window.differenceDays !== null && <p>Closing minus opening: {window.differenceDays} calendar day(s).</p>}
          <div className="chat-collection-matrix">
            <EventSummary id={window.documentId} value={window.opening} inspect={onInspect} />
            <EventSummary id={window.documentId} value={window.closing} inspect={onInspect} />
          </div>
        </article>)}
      </>}
      {!count && <p>No matching recognized date evidence indexed.</p>}
      {count > size && <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous collection dates</button>
        <span>Page {current} of {Math.ceil(count / size)}</span>
        <button type="button" className="chat-button" disabled={current >= Math.ceil(count / size)} onClick={() => setPage(current + 1)}>Next collection dates</button>
      </div>}
    </>}
  </details>;
}
