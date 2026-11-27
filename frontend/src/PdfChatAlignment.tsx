import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { Passage, Role, SearchIndex } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';
import { passageId } from './pdfChatResearch';
import { alignmentCandidates, alignmentPage, alignmentSources, alignmentStates, alignmentStatuses,
  analyzeAlignment, appendAlignment, filterAlignments, moveAlignment, nextAlignmentId,
  removeAlignment, replaceAlignment, summarizeAlignment, toggleAlignmentSource,
  updateAlignmentReview, MAX_ALIGNMENT_GROUPS, MAX_ALIGNMENT_SIDE, MAX_ALIGNMENT_TITLE,
  MAX_ALIGNMENT_NOTE, MAX_ALIGNMENT_FILTER, ALIGNMENT_CANDIDATE_PAGE, ALIGNMENT_RESULT_PAGE,
  type AlignmentFragment, type AlignmentGroup, type AlignmentLedger, type AlignmentResult,
  type AlignmentState, type AlignmentStatus } from './pdfChatAlignment';
import { readAlignmentFile, serializeAlignmentReport, verifyAttachedAlignmentReport } from './pdfChatAlignmentExchange';

const roleNames: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
const statusNames: Record<AlignmentStatus, string> = {
  unreviewed: 'Not yet reviewed', reviewed_manually: 'Reviewed manually', needs_followup: 'Needs follow-up',
};
const stateNames: Record<AlignmentState, string> = {
  both_selected_same_multiset: 'Selected wording counts match',
  both_selected_different_multiset: 'Selected wording counts differ',
  original_selection_only: 'Only original fragments selected',
  revised_selection_only: 'Only revised fragments selected',
};
type Draft = { id: string | null; title: string; original: string[]; revised: string[] };
type Feedback = { message: string; error: boolean };
const emptyDraft = (): Draft => ({ id: null, title: '', original: [], revised: [] });

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'noticebridge-private-evidence-alignment.json';
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function CandidatePicker({ role, index, selected, onToggle, onInspect }: {
  role: Role; index: SearchIndex; selected: string[];
  onToggle: (id: string) => void; onInspect: (source: Passage) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [physical, setPhysical] = useState('');
  const [page, setPage] = useState(1);
  const [hide, setHide] = useState(false);
  const parsed = physical === '' ? undefined : /^[1-9][0-9]?$/.test(physical) &&
    Number(physical) <= 80 ? Number(physical) : null;
  const candidates = useMemo(() => parsed === null ? [] : alignmentCandidates(index,
    { role, page: parsed, keyword, hideSelected: hide }, selected), [index, role, parsed, keyword, hide, selected]);
  const shown = alignmentPage(candidates, page, ALIGNMENT_CANDIDATE_PAGE);
  const sources = useMemo(() => alignmentSources(index), [index]);
  return <section className="chat-context-results chat-alignment-picker" aria-label={'Alignment candidates ' + role}>
    <h4>{roleNames[role]}</h4>
    <p className="chat-muted">{selected.length}/{MAX_ALIGNMENT_SIDE} fragments selected for this role</p>
    {selected.length > 0 && <ul className="chat-alignment-selected" aria-label={'Selected alignment fragments ' + role}>
      {selected.map(id => <li key={id}>
        <span>{id}</span><button type="button" className="chat-button" onClick={() => onToggle(id)}>Remove selected {id}</button>
        <button type="button" className="chat-button" onClick={() => onInspect(sources.get(id)!)}>Inspect selected {id}</button>
      </li>)}
    </ul>}
    <label className="chat-overview-filter">{role} alignment text filter
      <input value={keyword} maxLength={MAX_ALIGNMENT_FILTER} onChange={event => {
        setKeyword(event.target.value); setPage(1);
      }} />
    </label>
    <label className="chat-overview-filter">{role} alignment physical page
      <input value={physical} maxLength={2} inputMode="numeric" onChange={event => {
        setPhysical(event.target.value); setPage(1);
      }} />
    </label>
    {parsed === null && <p role="alert" className="chat-error">Enter one physical page from 1 to 80.</p>}
    <label className="chat-embedding-consent"><input type="checkbox" checked={hide} onChange={event => {
      setHide(event.target.checked); setPage(1);
    }} /> Hide selected {role} fragments</label>
    <p className="chat-muted">{shown.total} matching fragments in physical source order</p>
    {shown.rows.map(source => {
      const id = passageId(source), active = selected.includes(id);
      return <article className="chat-citation" key={id}>
        <p className="chat-muted">{id}</p>
        <blockquote>{source.text}</blockquote>
        <label className="chat-embedding-consent">
          <input type="checkbox" checked={active} disabled={!active && selected.length >= MAX_ALIGNMENT_SIDE}
            onChange={() => onToggle(id)} /> Select alignment fragment {id}
        </label>
        <button type="button" className="chat-button" onClick={() => onInspect(source)}>Inspect alignment candidate {id}</button>
      </article>;
    })}
    {!shown.rows.length && <p className="chat-muted">No fragments match these filters. This is not proof of absence.</p>}
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={shown.page === 1}
        onClick={() => setPage(shown.page - 1)}>Previous {role} alignment candidates</button>
      <span>Page {shown.page} of {shown.pages}</span>
      <button type="button" className="chat-button" disabled={shown.page === shown.pages}
        onClick={() => setPage(shown.page + 1)}>Next {role} alignment candidates</button>
    </div>
  </section>;
}
function SelectedSide({ role, rows, onInspect }: {
  role: Role; rows: AlignmentFragment[]; onInspect: (source: Passage) => void;
}) {
  return <section className="chat-checklist-source" aria-label={'Alignment selected ' + role}>
    <h5>{roleNames[role]}</h5>
    {!rows.length && <p className="chat-note">No fragment manually selected for this role. This does not establish absence.</p>}
    {rows.map(row => <div key={row.id} className="chat-citation">
      <p className="chat-muted">{row.id} · selected in {row.sharedGroupCount} group(s)</p>
      <blockquote>{row.source.text}</blockquote>
      <button type="button" className="chat-button" onClick={() => onInspect(row.source)}>Inspect grouped {row.id}</button>
    </div>)}
  </section>;
}
function GroupDetail({ result, onInspect, onEdit, onReview, onRemove, onMove, first, last, pending }: {
  result: AlignmentResult; onInspect: (source: Passage) => void; onEdit: () => void;
  onReview: (patch: Partial<Pick<AlignmentGroup, 'status' | 'note'>>) => void;
  onRemove: (confirm: boolean | null) => void; onMove: (direction: -1 | 1) => void;
  first: boolean; last: boolean; pending: boolean;
}) {
  const group = result.group;
  const [note, setNote] = useState(group.note);
  const [showDiff, setShowDiff] = useState(false);
  useEffect(() => setNote(group.note), [group.note]);
  return <article className="chat-checklist-result" aria-label={'Evidence group ' + group.id}>
    <div className="chat-checklist-result-header">
      <h4>{group.title}</h4><span className="chat-checklist-state">{stateNames[result.state]}</span>
    </div>
    <p className="chat-muted">{group.id} · {result.original.length} original and {result.revised.length} revised selections</p>
    <div className="chat-checklist-source-grid">
      <SelectedSide role="original" rows={result.original} onInspect={onInspect} />
      <SelectedSide role="revised" rows={result.revised} onInspect={onInspect} />
    </div>
    <p>Exact selected wording occurrences: {result.identicalOccurrences} shared · {result.originalOnlyOccurrences}
      {' '}first-selection only · {result.revisedOnlyOccurrences} second-selection only.</p>
    <details className="chat-context-results">
      <summary>Inspect exact selected wording counts</summary>
      <p className="chat-muted">Each row is one exact text string. Counts preserve repeated physical fragment identities.</p>
      {result.observations.map((row, i) => <article className="chat-citation" key={i}>
        <blockquote>{row.text}</blockquote>
        <p>Original: {row.originalIds.join(', ') || 'No selected occurrence'}</p>
        <p>Revised: {row.revisedIds.join(', ') || 'No selected occurrence'}</p>
        <p className="chat-muted">{row.identicalOccurrenceCount} shared · {row.originalOnlyCount} first-selection only
          · {row.revisedOnlyCount} second-selection only</p>
      </article>)}
    </details>
    {result.literalDiff && <div className="chat-context-results">
      <label className="chat-embedding-consent"><input type="checkbox" checked={showDiff}
        onChange={event => setShowDiff(event.target.checked)} /> Show literal single-pair alignment</label>
      {showDiff && <div aria-label={'Literal alignment ' + group.id}>
        <p className="chat-note">Highlighted tokens are unpaired by one literal alignment, not verified changes.</p>
        {result.literalDiff.repeatedTokens && <p className="chat-muted">Repeated tokens may admit alternative alignments.</p>}
        <div className="chat-checklist-source-grid">
          {(['original', 'revised'] as const).map(role => <section key={role}>
            <h5>{roleNames[role]}</h5>
            <p className="chat-literal-diff-text">{(role === 'original' ? result.literalDiff!.originalSegments :
              result.literalDiff!.revisedSegments).map(segment => segment.kind === 'unpaired'
              ? <mark key={segment.start}>{segment.text}</mark> : <span key={segment.start}>{segment.text}</span>)}</p>
          </section>)}
        </div>
        <p className="chat-muted">Unpaired printed numeric markers: first {result.changedNumeric?.original.map(row => row.text).join(' · ') || 'none'};
          {' '}second {result.changedNumeric?.revised.map(row => row.text).join(' · ') || 'none'}.
          No numeric interpretation is applied.</p>
      </div>}
    </div>}
    {result.literalDiffStatus === 'token_budget' && <p className="chat-muted">Single-pair alignment unavailable within token budget.</p>}
    {result.literalDiffStatus === 'not_single_pair' && <p className="chat-muted">No token alignment across multiple fragments; they remain separate source excerpts.</p>}
    <div className="chat-checklist-review">
      <label className="chat-overview-filter">Alignment review status {group.id}
        <select value={group.status} onChange={event => onReview({ status: event.target.value as AlignmentStatus })}>
          {alignmentStatuses.map(status => <option value={status} key={status}>{statusNames[status]}</option>)}
        </select>
      </label>
      <label className="chat-overview-filter">Alignment personal note {group.id}
        <textarea rows={3} maxLength={MAX_ALIGNMENT_NOTE} value={note} onChange={event => setNote(event.target.value)} />
      </label>
      <p className="chat-muted">Personal annotation only. Save before changing filters. {note.length}/{MAX_ALIGNMENT_NOTE}</p>
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={note.trim() === group.note}
          onClick={() => onReview({ note: note.trim() })}>Save alignment note {group.id}</button>
        <button type="button" className="chat-button" onClick={onEdit}>Edit evidence group {group.id}</button>
        <button type="button" className="chat-button" disabled={first} onClick={() => onMove(-1)}>Move evidence group {group.id} up</button>
        <button type="button" className="chat-button" disabled={last} onClick={() => onMove(1)}>Move evidence group {group.id} down</button>
        <button type="button" className="chat-button" onClick={() => onRemove(null)}>Remove evidence group {group.id}</button>
      </div>
      {pending && <div className="chat-note">
        <p>Remove this group's selections and saved personal annotations?</p>
        <button type="button" className="chat-button" onClick={() => onRemove(true)}>Confirm remove evidence group {group.id}</button>
        <button type="button" className="chat-button" onClick={() => onRemove(false)}>Keep evidence group {group.id}</button>
      </div>}
    </div>
  </article>;
}

export default function PdfChatAlignment({ index, files, corpora, onInspect }: {
  index: SearchIndex; files: AttachedFiles; corpora: ChatCorpora; onInspect: (source: Passage) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [groups, setGroups] = useState<AlignmentLedger>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [state, setState] = useState<AlignmentState | 'all'>('all');
  const [status, setStatus] = useState<AlignmentStatus | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingImport, setPendingImport] = useState<AlignmentLedger | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const generation = useRef(0);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { generation.current++; }, []);
  const results = useMemo(() => analyzeAlignment(index, groups), [index, groups]);
  const summary = useMemo(() => summarizeAlignment(results), [results]);
  const filtered = useMemo(() => filterAlignments(results, { state, status, keyword }), [results, state, status, keyword]);
  const shown = alignmentPage(filtered, page, ALIGNMENT_RESULT_PAGE);
  function changed(next: AlignmentLedger) {
    setGroups(next); setPendingRemove(null); setPendingImport(null); setConfirmClear(false); setFeedback(null);
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    try {
      const prior = groups.find(row => row.id === draft.id);
      const row: AlignmentGroup = { id: draft.id ?? nextAlignmentId(groups), title: draft.title.trim(),
        original: draft.original, revised: draft.revised, status: prior?.status ?? 'unreviewed', note: prior?.note ?? '' };
      changed(draft.id ? replaceAlignment(index, groups, row) : appendAlignment(index, groups, row));
      setDraft(emptyDraft()); setPage(1); setState('all'); setStatus('all'); setKeyword('');
      setFeedback({ error: false, message: 'Manual evidence group saved. Review the selected full pages before interpreting it.' });
      titleRef.current?.focus();
    } catch { setFeedback({ error: true, message: 'Group rejected. Check the topic, selected source identities and limits.' }); }
  }
  function toggle(role: Role, id: string) {
    try { setDraft({ ...draft, [role]: toggleAlignmentSource(draft[role], id, role) }); setFeedback(null); }
    catch { setFeedback({ error: true, message: 'Selection rejected or per-role fragment limit reached.' }); }
  }
  function edit(group: AlignmentGroup) {
    setDraft({ id: group.id, title: group.title, original: [...group.original], revised: [...group.revised] });
    setPendingImport(null); titleRef.current?.focus();
  }
  async function exportReport() {
    if (!consent || busy || !groups.length) return;
    const token = ++generation.current;
    setBusy(true); setPendingImport(null); setFeedback(null);
    try {
      const report = await serializeAlignmentReport(index, await fingerprintSources(files), corpora, groups, results, true);
      if (token === generation.current) {
        download(report);
        setFeedback({ error: false, message: 'Private alignment report saved locally. It includes selected excerpts and personal notes.' });
      }
    } catch { if (token === generation.current) setFeedback({ error: true, message: 'Report export failed. Check source bindings and export limits.' }); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function importReport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file || busy) return;
    const token = ++generation.current;
    setBusy(true); setPendingImport(null); setFeedback(null);
    try {
      const result = await verifyAttachedAlignmentReport(await readAlignmentFile(file),
        await fingerprintSources(files), corpora, index);
      if (token === generation.current) setPendingImport(result.groups);
    } catch { if (token === generation.current) setFeedback({ error: true, message: 'Alignment report rejected. Attach the exact PDF bytes and roles with matching native extraction. Current groups unchanged.' }); }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <details className="chat-panel chat-alignment" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Build manual evidence alignment groups</summary>
    <p>Group native passages from the two attached PDFs for a topic you choose. The application does not automatically
      match clauses or determine whether a requirement was added, removed, changed or applies to a person.</p>
    <p className="chat-note">Every excerpt keeps its own physical location. Multiple fragments are not concatenated
      into a synthetic quotation. A one-sided selection describes your selection only, not the other PDF's contents.</p>
    {opened && <fieldset className="chat-checklist-fieldset" disabled={busy}>
      <legend>Manual source selection</legend>
      <form onSubmit={save} className="chat-alignment-editor">
        <h3>{draft.id ? 'Edit ' + draft.id : 'Create evidence group'}</h3>
        <label className="chat-overview-filter">Evidence group topic
          <input ref={titleRef} aria-label="Evidence group topic" value={draft.title} maxLength={MAX_ALIGNMENT_TITLE}
            onChange={event => setDraft(old => ({ ...old, title: event.target.value }))} />
        </label>
        <div className="chat-checklist-editor-grid">
          {(['original', 'revised'] as const).map(role => <CandidatePicker key={role} role={role} index={index}
            selected={draft[role]} onToggle={id => toggle(role, id)} onInspect={onInspect} />)}
        </div>
        <p className="chat-muted">Select at least one fragment. A changed topic or selection resets that group's saved review status and note.</p>
        <div className="chat-toolbar">
          <button type="submit" className="primary-button" disabled={!draft.title.trim() ||
            (!draft.original.length && !draft.revised.length) || (!draft.id && groups.length >= MAX_ALIGNMENT_GROUPS)}>
            {draft.id ? 'Save evidence group edit' : 'Add evidence group'}
          </button>
          <button type="button" className="chat-button" onClick={() => setDraft(emptyDraft())}>Reset evidence group editor</button>
        </div>
      </form>
      <section aria-label="Saved manual evidence alignment groups">
        <h3>Saved evidence groups ({groups.length}/{MAX_ALIGNMENT_GROUPS})</h3>
        <div className="chat-checklist-counts">
          {[
            [summary.groups, 'Groups'], [summary.originalSelections, 'Original selections'],
            [summary.revisedSelections, 'Revised selections'], [summary.reusedFragments, 'Fragments reused across groups'],
          ].map(([count, label]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}
        </div>
        <p className="chat-muted">{summary.distinctOriginal} distinct original · {summary.distinctRevised} distinct revised fragments;
          {' '}{summary.statuses.reviewed_manually} manually reviewed · {summary.statuses.needs_followup} need follow-up.</p>
        <div className="chat-checklist-filters">
          <label className="chat-overview-filter">Alignment observation filter
            <select value={state} onChange={event => { setState(event.target.value as typeof state); setPage(1); }}>
              <option value="all">All observations</option>
              {alignmentStates.map(value => <option value={value} key={value}>{stateNames[value]}</option>)}
            </select>
          </label>
          <label className="chat-overview-filter">Alignment status filter
            <select value={status} onChange={event => { setStatus(event.target.value as typeof status); setPage(1); }}>
              <option value="all">All review statuses</option>
              {alignmentStatuses.map(value => <option key={value} value={value}>{statusNames[value]}</option>)}
            </select>
          </label>
          <label className="chat-overview-filter">Filter saved groups by topic
            <input value={keyword} maxLength={MAX_ALIGNMENT_FILTER} onChange={event => { setKeyword(event.target.value); setPage(1); }} />
          </label>
        </div>
        <p className="chat-muted">{shown.total} matching evidence groups · page {shown.page} of {shown.pages}</p>
        {shown.rows.map(result => {
          const id = result.group.id, at = groups.findIndex(row => row.id === id);
          return <GroupDetail key={JSON.stringify([id, result.group.title, result.group.original, result.group.revised])}
            result={result} onInspect={onInspect} first={at === 0} last={at === groups.length - 1} pending={pendingRemove === id}
            onEdit={() => edit(result.group)} onMove={direction => changed(moveAlignment(groups, id, direction))}
            onReview={patch => {
              try { changed(updateAlignmentReview(index, groups, id, patch)); }
              catch { setFeedback({ error: true, message: 'Personal annotation rejected.' }); }
            }} onRemove={confirm => {
              if (confirm === null) setPendingRemove(id);
              else if (!confirm) setPendingRemove(null);
              else { changed(removeAlignment(groups, id)); if (draft.id === id) setDraft(emptyDraft()); }
            }} />;
        })}
        {!shown.rows.length && <p>No saved groups match these filters.</p>}
        <div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={shown.page === 1}
            onClick={() => setPage(shown.page - 1)}>Previous evidence groups</button>
          <button type="button" className="chat-button" disabled={shown.page === shown.pages}
            onClick={() => setPage(shown.page + 1)}>Next evidence groups</button>
          <button type="button" className="chat-button" disabled={!groups.length}
            onClick={() => setConfirmClear(true)}>Clear evidence alignment groups</button>
        </div>
        {confirmClear && <div className="chat-note"><p>Clear every saved group and personal note?</p>
          <button type="button" className="chat-button" onClick={() => { changed([]); setDraft(emptyDraft()); }}>Confirm clear evidence groups</button>
          <button type="button" className="chat-button" onClick={() => setConfirmClear(false)}>Keep evidence groups</button>
        </div>}
      </section>
      <section className="chat-context-results" aria-label="Private alignment file exchange">
        <h3>Export or restore private evidence groups</h3>
        <p className="chat-note">The report includes selected native text, exact source fingerprints, manual topics and saved notes.
          It is not a signed decision record. Keep it private with the matching native snapshot.</p>
        <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
          onChange={event => setConsent(event.target.checked)} /> I approve exporting selected alignment excerpts and personal annotations.</label>
        <button type="button" className="chat-button" disabled={!groups.length || !consent}
          onClick={() => void exportReport()}>Export private evidence alignment</button>
        <label className="chat-session-file">Verify and restore evidence alignment
          <input type="file" accept=".json,application/json" onChange={event => void importReport(event)} />
        </label>
        {pendingImport && <section className="chat-note" aria-label="Alignment import confirmation">
          <p>{pendingImport.length} groups replayed. Replace the current groups and personal notes?</p>
          <button type="button" className="chat-button" onClick={() => {
            changed(pendingImport); setDraft(emptyDraft()); setPage(1); setState('all'); setStatus('all'); setKeyword('');
            setFeedback({ error: false, message: 'Source-bound evidence groups restored. Personal annotations remain unverified.' });
          }}>Apply imported evidence groups</button>
          <button type="button" className="chat-button" onClick={() => setPendingImport(null)}>Cancel alignment import</button>
        </section>}
      </section>
    </fieldset>}
    {busy && <p role="status">Replaying private alignment evidence…</p>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'chat-error' : 'chat-note'}>{feedback.message}</p>}
  </details>;
}
