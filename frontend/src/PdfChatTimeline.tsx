import { useMemo, useState } from 'react';
import type { Passage, Role, Scope, SearchIndex } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { buildTimeline, compareTimeline, dateCoverage, describeTimelineValue, filterTimeline,
  inspectWindows, timelinePage, type DateEvent, type DateOccurrence, type TimelineFilter } from './pdfChatTimeline';

const names: Record<Role, string> = { original: 'Original PDF', revised: 'Revised PDF' };
const reasons = {
  unique: 'One distinct supported printed date; possible undiscovered conditions remain.',
  multiple_values: 'Several distinct printed values; no preferred date is selected.',
  not_single_date: 'Not a single complete date; arithmetic is withheld.',
  possible_conditions: 'Additional matching or nearby text requires manual review.',
};

function Occurrence({ occurrence, onInspect }: { occurrence: DateOccurrence; onInspect: (source: Passage) => void }) {
  const source = occurrence.field.source;
  return <div className="chat-citation">
    <p className="chat-muted">{names[source.role]} · physical page {source.page} · fragment {source.ordinal}</p>
    <p><strong>{occurrence.field.label}:</strong> {occurrence.field.value}</p>
    <p className="chat-muted">{describeTimelineValue(occurrence.parsed)}</p>
    <button className="chat-button" type="button" onClick={() => onInspect(source)}>
      Inspect date source {occurrence.id}
    </button>
    {occurrence.reviewLeadCount > 0 && <details>
      <summary>{occurrence.reviewLeadCount} possible contextual lead(s)</summary>
      <p className="chat-note">These excerpts are not asserted qualifications. Inspect their meaning in the actual PDF.</p>
      {occurrence.reviewLeads.map(lead => <div className="chat-citation" key={lead.page + ':' + lead.ordinal}>
        <p>{lead.text}</p>
        <button className="chat-button" type="button" onClick={() => onInspect(lead)}>
          Inspect date context page {lead.page}, fragment {lead.ordinal}
        </button>
      </div>)}
      {occurrence.reviewLeadCount > occurrence.reviewLeads.length && <p className="chat-muted">
        Additional leads are not displayed; use the full native evidence explorer.
      </p>}
    </details>}
  </div>;
}
function EventSummary({ event, onInspect }: { event: DateEvent | null; onInspect: (source: Passage) => void }) {
  if (!event) return <p className="chat-muted">No matching printed label indexed.</p>;
  return <div>
    <p><strong>{names[event.role]}</strong> · {event.definition.label}</p>
    <p className="chat-muted">{event.occurrences.length} occurrences · {event.distinctPrintedValues} distinct values.</p>
    <p className="chat-note">{reasons[event.reason]}</p>
    {event.occurrences.slice(0, 3).map(row => <Occurrence key={row.id} occurrence={row} onInspect={onInspect} />)}
    {event.occurrences.length > 3 && <p className="chat-muted">More occurrences are in the timeline browser.</p>}
  </div>;
}
function TimelineBrowser({ index, corpora, onInspect }: {
  index: SearchIndex; corpora: ChatCorpora; onInspect: (source: Passage) => void;
}) {
  const timeline = useMemo(() => buildTimeline(index, corpora), [index, corpora]);
  const [mode, setMode] = useState<'dates' | 'comparison' | 'windows'>('dates');
  const [filter, setFilter] = useState<TimelineFilter>({ scope: 'both', kind: 'all', parse: 'all', order: 'chronological' });
  const [page, setPage] = useState(1);
  const [pageText, setPageText] = useState('');
  const [error, setError] = useState('');
  const rows = filterTimeline(timeline, filter);
  const shown = timelinePage(rows, page);
  function update(change: Partial<TimelineFilter>) {
    setFilter(old => ({ ...old, ...change })); setPage(1);
  }
  function physicalPage(text: string) {
    setPageText(text);
    if (!text.trim()) { update({ page: undefined }); setError(''); return; }
    if (!/^[1-9][0-9]?$/.test(text) || Number(text) > 80) {
      setError('Enter one physical page from 1 to 80.'); return;
    }
    update({ page: Number(text) }); setError('');
  }
  return <>
    <p className="chat-note">Only recognized printed date labels are listed. No date is treated
      as the official current deadline, and no applicant eligibility or reminder is inferred.</p>
    <div className="chat-toolbar">
      <button className="chat-button" type="button" aria-pressed={mode === 'dates'} onClick={() => setMode('dates')}>Printed date occurrences</button>
      <button className="chat-button" type="button" aria-pressed={mode === 'comparison'} onClick={() => setMode('comparison')}>Compare printed dates</button>
      <button className="chat-button" type="button" aria-pressed={mode === 'windows'} onClick={() => setMode('windows')}>Inspect printed date windows</button>
    </div>
    {mode === 'dates' && <section aria-label="Printed date timeline">
      <div className="chat-field-grid">
        <label className="chat-overview-filter">Timeline source
          <select value={filter.scope} onChange={event => update({ scope: event.target.value as Scope })}>
            <option value="both">Both PDFs</option><option value="original">Original PDF</option><option value="revised">Revised PDF</option>
          </select>
        </label>
        <label className="chat-overview-filter">Timeline date type
          <select value={filter.kind} onChange={event => update({ kind: event.target.value as TimelineFilter['kind'] })}>
            <option value="all">All labels</option><option value="opening">Opening dates</option>
            <option value="closing">Closing dates</option><option value="event">Other events</option>
          </select>
        </label>
        <label className="chat-overview-filter">Timeline parse status
          <select value={filter.parse} onChange={event => update({ parse: event.target.value as TimelineFilter['parse'] })}>
            <option value="all">All printed values</option><option value="parsed">Supported literal dates</option><option value="unparsed">Needs date review</option>
          </select>
        </label>
        <label className="chat-overview-filter">Timeline order
          <select value={filter.order} onChange={event => update({ order: event.target.value as TimelineFilter['order'] })}>
            <option value="chronological">Calendar order, unparsed last</option><option value="source">Physical extraction order</option>
          </select>
        </label>
        <label className="chat-overview-filter">Timeline physical page (optional)
          <input value={pageText} inputMode="numeric" maxLength={2} onChange={event => physicalPage(event.target.value)} />
        </label>
      </div>
      {error && <p role="alert" className="chat-error">{error} The prior valid filter remains active.</p>}
      {(['original', 'revised'] as const).filter(role => filter.scope === 'both' || role === filter.scope).map(role =>
        <p className="chat-muted" key={role}>{names[role]}: {dateCoverage(corpora[role], filter.page)}</p>)}
      <p role="status">{rows.length} printed date occurrences match these filters.</p>
      {!rows.length && <p>No matching printed date label was indexed. Inspect the actual PDF for other dates.</p>}
      {shown.rows.map(({ occurrence, event }) => <article className="chat-context-results" key={occurrence.id}>
        <h4>{event.definition.label}</h4>
        <p className="chat-muted">{reasons[event.reason]}</p>
        <Occurrence occurrence={occurrence} onInspect={onInspect} />
      </article>)}
      <div className="chat-toolbar">
        <button className="chat-button" type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous dates</button>
        <span>Page {page} of {shown.pages}</span>
        <button className="chat-button" type="button" disabled={page === shown.pages} onClick={() => setPage(page + 1)}>Next dates</button>
      </div>
    </section>}
    {mode === 'comparison' && <section aria-label="Timeline date comparison">
      <p className="chat-note">Comparisons use both complete indexed sources, not the date-list filters.
        Only a unique, supported calendar date with no detected review leads on each side is compared.</p>
      {compareTimeline(timeline).map(pair => <article className="chat-context-results" key={pair.field.id}>
        <h4>{pair.field.label}</h4>
        <p>{pair.outcome === 'same_day' ? 'Both printed dates denote the same day.' :
          pair.outcome === 'different_day' ? 'Revised printed date is ' + Math.abs(pair.deltaDays!) +
            ' calendar day(s) ' + (pair.deltaDays! > 0 ? 'later' : 'earlier') + '.' :
          pair.outcome === 'missing_source' ? 'Another source is not attached.' :
          pair.outcome === 'missing_label' ? 'One source has no indexed matching label.' : 'Review competing values, date expressions or possible conditions.'}</p>
        <div className="chat-field-grid"><EventSummary event={pair.original} onInspect={onInspect} />
          <EventSummary event={pair.revised} onInspect={onInspect} /></div>
      </article>)}
    </section>}
    {mode === 'windows' && <section aria-label="Printed date window checks">
      <p className="chat-note">These checks compare literal opening and closing dates from the same source.
        Calendar-day subtraction is not an inclusive application period or a determination that the window is valid.</p>
      {inspectWindows(timeline).map(window => <article className="chat-context-results" key={window.role + window.name}>
        <h4>{names[window.role]} · {window.name}</h4>
        <p>{window.outcome === 'missing_label' ? 'An opening or closing label is not indexed.' :
          window.outcome === 'review_required' ? 'Arithmetic withheld pending manual review.' :
          window.outcome === 'reversed_printed_order' ? 'Printed closing date precedes printed opening date by ' +
            Math.abs(window.differenceDays!) + ' calendar day(s). Inspect both sources.' :
          'Printed closing date minus opening date: ' + window.differenceDays + ' calendar day(s).'}</p>
        <div className="chat-field-grid"><EventSummary event={window.opening} onInspect={onInspect} />
          <EventSummary event={window.closing} onInspect={onInspect} /></div>
      </article>)}
    </section>}
  </>;
}
export default function PdfChatTimeline(props: { index: SearchIndex; corpora: ChatCorpora; onInspect: (source: Passage) => void }) {
  const [open, setOpen] = useState(false);
  return <details className="chat-session chat-embedding-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Explore printed notice timeline and date windows</summary>
    {open && <TimelineBrowser {...props} />}
  </details>;
}
