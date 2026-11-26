import { useMemo, useState } from 'react';
import type { Passage, Role, SearchIndex } from './pdfChatCore';
import { passageId } from './pdfChatResearch';
import { changedNumericMarkers, compareLiteralSources, diffCandidatePage, diffCandidates,
  exactWordingOccurrences, MAX_DIFF_CANDIDATE_FILTER, type DiffSegment, type LiteralDiff } from './pdfChatLiteralDiff';

const names: Record<Role, string> = { original: 'Original PDF', revised: 'Revised PDF' };
function CandidatePicker({ role, index, selected, onSelect, onInspect }: {
  role: Role; index: SearchIndex; selected: string | null; onSelect: (id: string) => void;
  onInspect: (source: Passage) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [physicalPage, setPhysicalPage] = useState('');
  const [page, setPage] = useState(1);
  const parsed = physicalPage === '' ? undefined : /^[1-9][0-9]?$/.test(physicalPage) &&
    Number(physicalPage) <= 80 ? Number(physicalPage) : null;
  const candidates = useMemo(() => parsed === null ? [] : diffCandidates(index, { role, page: parsed, keyword }),
    [index, role, parsed, keyword]);
  const shown = diffCandidatePage(candidates, Math.min(page, Math.max(1, Math.ceil(candidates.length / 12))));
  return <section className="chat-context-results" aria-label={names[role] + ' literal comparison candidates'}>
    <h4>{names[role]}</h4>
    <label className="chat-overview-filter">{role} comparison text filter
      <input value={keyword} maxLength={MAX_DIFF_CANDIDATE_FILTER}
        onChange={event => { setKeyword(event.target.value); setPage(1); }} />
    </label>
    <label className="chat-overview-filter">{role} comparison physical page (optional)
      <input value={physicalPage} inputMode="numeric" maxLength={2}
        onChange={event => { setPhysicalPage(event.target.value); setPage(1); }} />
    </label>
    {parsed === null && <p role="alert" className="chat-error">Enter a physical page from 1 to 80.</p>}
    <p className="chat-muted">{candidates.length} native fragments match; source order only.</p>
    {shown.rows.map(source => {
      const id = passageId(source);
      return <article className="chat-citation" key={id}>
        <p className="chat-muted">{id}</p>
        <p>{source.text}</p>
        <button type="button" className="chat-button" aria-pressed={selected === id}
          onClick={() => onSelect(id)}>{selected === id ? 'Selected ' : 'Select '}{id}</button>
        <button type="button" className="chat-button" onClick={() => onInspect(source)}>Inspect candidate {id}</button>
      </article>;
    })}
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={page <= 1}
        onClick={() => setPage(old => old - 1)}>Previous {role} candidates</button>
      <span>Page {page} of {shown.pages}</span>
      <button type="button" className="chat-button" disabled={page >= shown.pages}
        onClick={() => setPage(old => old + 1)}>Next {role} candidates</button>
    </div>
  </section>;
}
function SourceDiff({ source, segments, onInspect }: {
  source: Passage; segments: DiffSegment[]; onInspect: (source: Passage) => void;
}) {
  return <article className="chat-citation">
    <h4>{names[source.role]}</h4>
    <p className="chat-muted">{passageId(source)}</p>
    <p className="chat-literal-diff-text">{segments.map(segment => segment.kind === 'unpaired'
      ? <mark key={segment.start}>{segment.text}</mark>
      : <span key={segment.start}>{segment.text}</span>)}</p>
    <button type="button" className="chat-button" onClick={() => onInspect(source)}>
      Inspect compared {passageId(source)}
    </button>
  </article>;
}
function DiffResult({ diff, index, onInspect }: { diff: LiteralDiff; index: SearchIndex; onInspect: (source: Passage) => void }) {
  const numeric = changedNumericMarkers(diff);
  const [only, setOnly] = useState(false);
  const [page, setPage] = useState(1);
  const shown = diffCandidatePage(diff.changes, page);
  const oldCounts = exactWordingOccurrences(index, diff.original);
  const newCounts = exactWordingOccurrences(index, diff.revised);
  return <section aria-label="Literal fragment comparison" className="chat-context-results">
    <h3>{diff.identical ? 'Identical indexed wording' : 'Literal wording differences'}</h3>
    <p className="chat-note">The selected fragments may describe unrelated conditions. Highlighted
      wording is unpaired by one exact token alignment, not a verified addition, deletion or legal amendment.</p>
    <p className="chat-muted">{diff.sameTokens} paired tokens · {diff.originalTokens} original tokens
      {' '}· {diff.revisedTokens} revised tokens. Whitespace and punctuation are included.</p>
    {diff.repeatedTokens && <p className="chat-note">Repeated words can admit multiple valid alignments.</p>}
    <div className="chat-field-grid">
      <SourceDiff source={diff.original} segments={diff.originalSegments} onInspect={onInspect} />
      <SourceDiff source={diff.revised} segments={diff.revisedSegments} onInspect={onInspect} />
    </div>
    <p className="chat-muted">Original selected wording occurs {oldCounts.original} time(s) in original
      {' '}and {oldCounts.revised} in revised indexed text. Revised selected wording occurs
      {' '}{newCounts.original} time(s) in original and {newCounts.revised} in revised indexed text.</p>
    {(numeric.original.length > 0 || numeric.revised.length > 0) && <div className="chat-note">
      <strong>Unpaired literal numeric markers</strong>
      <p>Original: {numeric.original.map(marker => marker.text).join(' · ') || 'None in unpaired tokens'}</p>
      <p>Revised: {numeric.revised.map(marker => marker.text).join(' · ') || 'None in unpaired tokens'}</p>
      <p>Markers are not interpreted as amounts, dates, units or quantities.</p>
    </div>}
    <label className="chat-embedding-consent"><input type="checkbox" checked={only}
      onChange={event => { setOnly(event.target.checked); setPage(1); }} /> Inspect unpaired wording groups</label>
    {only && <section aria-label="Unpaired wording groups">
      {shown.rows.map((chunk, i) => <div className="chat-field-grid chat-section-alignment" key={page + ':' + i}>
        {(['original', 'revised'] as const).map(role => <div key={role}>
          <strong>{names[role]}</strong>
          <p className="chat-literal-diff-text">{chunk[role].map(token => token.text).join('') || 'No unpaired tokens'}</p>
          {chunk[role].length > 0 && <p className="chat-muted">UTF-16 offsets {chunk[role][0].start}–{chunk[role].at(-1)!.end}</p>}
        </div>)}
      </div>)}
      {!diff.changes.length && <p>No unpaired tokens.</p>}
      <div className="chat-toolbar">
        <button className="chat-button" type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous wording groups</button>
        <span>Page {page} of {shown.pages}</span>
        <button className="chat-button" type="button" disabled={page === shown.pages} onClick={() => setPage(page + 1)}>Next wording groups</button>
      </div>
    </section>}
  </section>;
}
function LiteralBrowser({ index, onInspect }: { index: SearchIndex; onInspect: (source: Passage) => void }) {
  const [original, setOriginal] = useState<string | null>(null);
  const [revised, setRevised] = useState<string | null>(null);
  const [diff, setDiff] = useState<LiteralDiff | null>(null);
  const [error, setError] = useState('');
  function select(role: Role, id: string) {
    if (role === 'original') setOriginal(id); else setRevised(id);
    setDiff(null); setError('');
  }
  function compare() {
    if (!original || !revised) return;
    try { setDiff(compareLiteralSources(index, original, revised)); setError(''); }
    catch { setError('Selected fragments cannot be compared within the literal token budget.'); setDiff(null); }
  }
  return <>
    <p className="chat-note">Manually select one native fragment from each PDF. The tool never automatically
      pairs them or changes the search answer. Inspect both full pages before interpreting differences.</p>
    <div className="chat-field-grid">
      <CandidatePicker role="original" index={index} selected={original} onSelect={id => select('original', id)} onInspect={onInspect} />
      <CandidatePicker role="revised" index={index} selected={revised} onSelect={id => select('revised', id)} onInspect={onInspect} />
    </div>
    <p className="chat-muted">Selected original: {original ?? 'None'} · selected revised: {revised ?? 'None'}</p>
    <button type="button" className="chat-button" disabled={!original || !revised} onClick={compare}>Compare selected literal fragments</button>
    {error && <p role="alert" className="chat-error">{error}</p>}
    {diff && <DiffResult key={original + ':' + revised} diff={diff} index={index} onInspect={onInspect} />}
  </>;
}
export default function PdfChatLiteralDiff({ index, onInspect }: { index: SearchIndex; onInspect: (source: Passage) => void }) {
  const [open, setOpen] = useState(false);
  return <details className="chat-session chat-embedding-panel" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Compare manually selected native fragments</summary>
    {open && <LiteralBrowser index={index} onInspect={onInspect} />}
  </details>;
}
