import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { MAX_QUESTION, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { addChecklistPreset, appendChecklist, carryChecklistReviews,
  checklistCounts, checklistPage, checklistPresets, checklistResultStates, checklistReviewCounts,
  checklistReviewStatuses, filterChecklist, moveChecklistItem, nextChecklistId,
  removeChecklistItem, replaceChecklistItem, runChecklist, updateChecklistReview,
  MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_NOTE, type ChecklistCoverage, type ChecklistItem,
  type ChecklistPlan, type ChecklistResult, type ChecklistResultState, type ChecklistReview,
  type ChecklistReviewStatus, type ChecklistSourceResult, type SourceMatchState } from './pdfChatChecklist';
import { emptyChecklistFromTemplate, readChecklistFile, serializeChecklistReport,
  serializeChecklistTemplate, verifyAttachedChecklistReport } from './pdfChatChecklistExchange';

const roleNames: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
const scopes: Record<Scope, string> = { ...roleNames, both: 'Both PDFs' };
const stateNames: Record<ChecklistResultState, string> = {
  matches_all_requested_roles: 'Matching passages in every requested PDF',
  some_matches_or_context: 'Partial matches or nearby leads',
  no_matching_passages: 'No matching passages',
  unavailable: 'Requested text unavailable',
};
const sourceStateNames: Record<SourceMatchState, string> = {
  source_unattached: 'Requested PDF not attached',
  page_not_present: 'Physical page does not exist',
  page_not_indexed: 'Physical page not indexed',
  no_indexed_text: 'No indexed native text',
  no_matching_passage: 'No sufficiently matching passage',
  context_leads: 'Nearby fragments only',
  matching_passages: 'Matching source passages',
};
const coverageNames: Record<ChecklistCoverage, string> = {
  unattached: 'No attached PDF',
  not_present: 'Page not present',
  not_indexed: 'Page outside the native indexing limit',
  no_indexed_text: 'No indexed native text',
  limited: 'Partial or limited native extraction',
  some_text: 'Some native text indexed; completeness not established',
};
const reviewNames: Record<ChecklistReviewStatus, string> = {
  unreviewed: 'Not yet reviewed', reviewed_manually: 'Reviewed manually', needs_followup: 'Needs follow-up',
};
const ALL_SCOPES: Scope[] = ['original', 'revised', 'both'];

type Editor = { id: string | null; question: string; scope: Scope; includeContext: boolean };
type PendingImport = {
  kind: 'template' | 'report'; items: ChecklistPlan; reviews: ChecklistReview[];
  results: ChecklistResult[] | null;
};
type Feedback = { error: boolean; message: string };

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function initialScope(attached: Role[]): Scope {
  return attached.length === 2 ? 'both' : attached[0] ?? 'original';
}
function ScopePicker({ value, onChange, attached, label }: {
  value: Scope; onChange: (scope: Scope) => void; attached: Role[]; label: string;
}) {
  return <label className="chat-overview-filter">{label}
    <select value={value} onChange={event => onChange(event.target.value as Scope)}>
      {ALL_SCOPES.map(scope => {
        const present = scope === 'both' ? attached.length === 2 : attached.includes(scope);
        return <option key={scope} value={scope}>{scopes[scope]}{present ? '' : ' (not fully attached)'}</option>;
      })}
    </select>
  </label>;
}
function SourceResult({ source, onInspect }: {
  source: ChecklistSourceResult; onInspect: (source: Passage) => void;
}) {
  return <section className="chat-checklist-source" aria-label={'Checklist source ' + roleNames[source.role]}>
    <h5>{roleNames[source.role]}</h5>
    <p><strong>{sourceStateNames[source.state]}</strong></p>
    <p className="chat-muted">{coverageNames[source.coverage]}</p>
    {source.matchedCount > 0 && <p className="chat-muted">{source.matchedCount} distinct strict matches;
      {' '}{source.displayedCount} displayed. {source.omittedStrictMatches > 0 &&
      source.omittedStrictMatches + ' additional matches not displayed.'}</p>}
    {source.state === 'context_leads' && <p className="chat-note">These fragments collectively match the search terms.
      They may describe unrelated conditions and are not standalone answers.</p>}
    {source.citations.map((citation, i) => <div className="chat-citation" key={citation.source.page + ':' + citation.source.ordinal}>
      <p className="chat-muted">Physical page {citation.source.page} · fragment {citation.source.ordinal}
        {citation.kind === 'context' ? ' · nearby group ' + citation.contextGroup : ' · strict match'}</p>
      <blockquote>{citation.source.text}</blockquote>
      <button className="chat-button" type="button" onClick={() => onInspect(citation.source)}>
        Inspect checklist citation {i + 1}
      </button>
    </div>)}
    {source.state === 'no_matching_passage' && <p className="chat-muted">No match does not prove the information is absent.</p>}
  </section>;
}
function ReviewEditor({ row, review, onChange, onInspect, onAsk }: {
  row: ChecklistResult; review: ChecklistReview;
  onChange: (patch: Partial<Pick<ChecklistReview, 'status' | 'note'>>) => void;
  onInspect: (source: Passage) => void;
  onAsk: (question: string, scope: Scope) => void;
}) {
  const [draft, setDraft] = useState(review.note);
  useEffect(() => setDraft(review.note), [review.note]);
  return <article className="chat-checklist-result" aria-label={'Checklist result ' + row.item.id}>
    <div className="chat-checklist-result-header">
      <h4>{row.item.question}</h4>
      <span className="chat-checklist-state" data-state={row.state}>{stateNames[row.state]}</span>
    </div>
    <p className="chat-muted">{scopes[row.item.scope]} · {row.physicalPage === null ? 'All indexed physical pages' : 'Physical page ' + row.physicalPage}
      {' · '}{row.item.includeContext ? 'Nearby fallback enabled' : 'Strict retrieval only'}</p>
    <div className="chat-checklist-source-grid">
      {row.sources.map(source => <SourceResult key={source.role} source={source} onInspect={onInspect} />)}
    </div>
    <div className="chat-checklist-review">
      <label className="chat-overview-filter">Review status for {row.item.id}
        <select value={review.status} onChange={event => onChange({ status: event.target.value as ChecklistReviewStatus })}>
          {checklistReviewStatuses.map(status => <option key={status} value={status}>{reviewNames[status]}</option>)}
        </select>
      </label>
      <label className="chat-overview-filter">Personal note for {row.item.id}
        <textarea rows={2} maxLength={MAX_CHECKLIST_NOTE} value={draft}
          onChange={event => setDraft(event.target.value)} />
      </label>
      <div className="chat-toolbar">
        <span className="chat-muted">{draft.length}/{MAX_CHECKLIST_NOTE} · Personal annotation, not evidence. Save before switching filters.</span>
        <button type="button" className="chat-button" disabled={draft.trim() === review.note}
          onClick={() => onChange({ note: draft.trim() })}>Save note for {row.item.id}</button>
        <button type="button" className="chat-button"
          onClick={() => onAsk(row.item.question, row.item.scope)}>Open question in chat composer</button>
      </div>
    </div>
  </article>;
}
export default function PdfChatChecklist({ files, index, corpora, attached, onInspect, onAsk }: {
  files: AttachedFiles; index: SearchIndex; corpora: ChatCorpora; attached: Role[];
  onInspect: (source: Passage) => void;
  onAsk: (question: string, scope: Scope) => void;
}) {
  const [items, setItems] = useState<ChecklistPlan>([]);
  const [reviews, setReviews] = useState<ChecklistReview[]>([]);
  const [results, setResults] = useState<ChecklistResult[] | null>(null);
  const [editor, setEditor] = useState<Editor>({ id: null, question: '', scope: initialScope(attached), includeContext: false });
  const [preset, setPreset] = useState('quick');
  const [presetScope, setPresetScope] = useState<Scope>(initialScope(attached));
  const [presetContext, setPresetContext] = useState(false);
  const [stateFilter, setStateFilter] = useState<ChecklistResultState | 'all'>('all');
  const [reviewFilter, setReviewFilter] = useState<ChecklistReviewStatus | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [templateConsent, setTemplateConsent] = useState(false);
  const [reportConsent, setReportConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const generation = useRef(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => { generation.current++; }, []);
  const selectedPreset = checklistPresets.find(row => row.id === preset)!;
  const resultCounts = useMemo(() => checklistCounts(results ?? []), [results]);
  const reviewedCounts = useMemo(() => checklistReviewCounts(reviews), [reviews]);
  const filtered = useMemo(() => filterChecklist(results ?? [], reviews,
    { state: stateFilter, review: reviewFilter, keyword }), [results, reviews, stateFilter, reviewFilter, keyword]);
  const displayed = checklistPage(filtered, page);
  const byId = new Map(reviews.map(row => [row.id, row]));

  function resetEditor() {
    setEditor(old => ({ ...old, id: null, question: '' }));
  }
  function invalidate(next: ChecklistPlan) {
    setReviews(carryChecklistReviews(items, reviews, next));
    setItems(next);
    setResults(null); setPending(null); setPendingRemoval(null); setConfirmClear(false);
    setPage(1); setFeedback(null);
  }
  function saveItem(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    try {
      const item: ChecklistItem = { id: editor.id ?? nextChecklistId(items),
        question: editor.question.trim(), scope: editor.scope, includeContext: editor.includeContext };
      const next = editor.id ? replaceChecklistItem(items, editor.id, item) : appendChecklist(items, item);
      invalidate(next); resetEditor(); editorRef.current?.focus();
    } catch {
      setFeedback({ error: true, message: 'Use one distinct question with a valid physical-page restriction and matching explicit PDF scope.' });
    }
  }
  function insertPreset() {
    try {
      const result = addChecklistPreset(items, preset, presetScope, presetContext);
      if (result.added) invalidate(result.items);
      setFeedback({ error: false, message: 'Added ' + result.added + ' questions; skipped ' + result.skipped + ' existing questions.' });
    } catch {
      setFeedback({ error: true, message: 'The preset would exceed the checklist budget or contains incompatible questions. Nothing was changed.' });
    }
  }
  function execute() {
    if (busy || !items.length) return;
    setPending(null); setFeedback(null);
    try {
      const computed = runChecklist(index, corpora, items);
      setResults(computed); setPage(1); setStateFilter('all'); setReviewFilter('all'); setKeyword('');
      setFeedback({ error: false, message: 'Ran ' + computed.length + ' independent local questions. Inspect the PDF before making any decision.' });
    } catch {
      setResults(null);
      setFeedback({ error: true, message: 'Checklist could not be evaluated against the current native PDF index.' });
    }
  }
  function editReview(id: string, patch: Partial<Pick<ChecklistReview, 'status' | 'note'>>) {
    try {
      setReviews(updateChecklistReview(items, reviews, id, patch));
      setPending(null); setFeedback(null);
    } catch { setFeedback({ error: true, message: 'Review note rejected. Check its length and characters.' }); }
  }
  function exportTemplate() {
    if (!templateConsent || busy || !items.length) return;
    try {
      download(serializeChecklistTemplate(items, true), 'noticebridge-question-checklist-template.json');
      setFeedback({ error: false, message: 'Question template exported without PDF fingerprints, evidence or review notes.' });
    } catch { setFeedback({ error: true, message: 'Template export failed.' }); }
  }
  async function exportReport() {
    if (!reportConsent || busy || !results) return;
    const token = ++generation.current;
    setBusy(true); setPending(null); setFeedback(null);
    try {
      const text = await serializeChecklistReport(index, await fingerprintSources(files), corpora,
        items, reviews, results, true);
      if (token !== generation.current) return;
      download(text, 'noticebridge-private-question-checklist.json');
      setFeedback({ error: false, message: 'Private checklist report exported locally. It contains source text and personal notes.' });
    } catch {
      if (token === generation.current) setFeedback({ error: true, message: 'Report export failed. Run the current checklist and check the exact attached sources.' });
    } finally { if (token === generation.current) setBusy(false); }
  }
  async function importFile(event: ChangeEvent<HTMLInputElement>, kind: 'template' | 'report') {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
    const token = ++generation.current;
    setBusy(true); setPending(null); setFeedback(null);
    try {
      const text = await readChecklistFile(file, kind);
      const prepared = kind === 'template'
        ? { ...emptyChecklistFromTemplate(text), results: null }
        : await verifyAttachedChecklistReport(text, await fingerprintSources(files), corpora, index);
      if (token === generation.current) setPending({ kind, items: prepared.items,
        reviews: prepared.reviews, results: prepared.results });
    } catch {
      if (token === generation.current) setFeedback({ error: true, message: kind === 'template'
        ? 'Template rejected. Current checklist has not changed.'
        : 'Report rejected. Attach the exact original PDF bytes and roles with the same native extraction. Current checklist has not changed.' });
    } finally { if (token === generation.current) setBusy(false); }
  }
  function applyImport() {
    if (!pending || busy) return;
    setItems(pending.items); setReviews(pending.reviews); setResults(pending.results);
    setPending(null); setPage(1); setStateFilter('all'); setReviewFilter('all'); setKeyword('');
    setConfirmClear(false); setPendingRemoval(null); resetEditor();
    setFeedback({ error: false, message: pending.kind === 'template'
      ? 'Template applied. Run the questions against the currently attached PDFs.'
      : 'Report replayed and restored. Review statuses remain personal annotations.' });
  }
  return <details className="chat-panel chat-checklist">
    <summary>Question checklist and systematic notice review</summary>
    <p>Build a reusable list of independent questions, run them against the selected PDFs, and inspect the source passages.
      This does not change your conversation, call a model, or verify official authority.</p>
    <p className="chat-note">A missing match is not evidence that a requirement was removed or never existed.
      Nearby fragments and incomplete indexing require manual inspection. Personal review statuses do not certify answers.</p>
    <fieldset className="chat-checklist-fieldset" disabled={busy}>
      <legend>Build the question list</legend>
      <div className="chat-checklist-editor-grid">
        <div className="chat-context-results">
          <h4>Use a starting template</h4>
          <label className="chat-overview-filter">Checklist preset
            <select value={preset} onChange={event => setPreset(event.target.value)}>
              {checklistPresets.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
            </select>
          </label>
          <p className="chat-muted">{selectedPreset.description} ({selectedPreset.fields.length} questions)</p>
          <ScopePicker value={presetScope} onChange={setPresetScope} attached={attached} label="Preset search scope" />
          <label className="chat-embedding-consent"><input type="checkbox" checked={presetContext}
            onChange={event => setPresetContext(event.target.checked)} /> Enable nearby fallback for preset questions</label>
          <button className="chat-button" type="button" disabled={items.length >= MAX_CHECKLIST_ITEMS}
            onClick={insertPreset}>Add preset questions</button>
        </div>
        <form className="chat-context-results chat-checklist-form" onSubmit={saveItem}>
          <h4>{editor.id ? 'Edit checklist question' : 'Add your own question'}</h4>
          <label className="chat-overview-filter">Checklist question
            <textarea ref={editorRef} maxLength={MAX_QUESTION} rows={3} value={editor.question}
              onChange={event => setEditor(old => ({ ...old, question: event.target.value }))} />
          </label>
          <ScopePicker value={editor.scope} onChange={scope => setEditor(old => ({ ...old, scope }))}
            attached={attached} label="Checklist search scope" />
          <label className="chat-embedding-consent"><input type="checkbox" checked={editor.includeContext}
            onChange={event => setEditor(old => ({ ...old, includeContext: event.target.checked }))} /> Search nearby lines if no strict match</label>
          <p className="chat-muted">One question at a time. Use “on page 2” for a single physical page.
            Editing its question or routing clears its personal review.</p>
          <div className="chat-toolbar">
            <button className="chat-button" type="submit" disabled={!editor.question.trim() ||
              (!editor.id && items.length >= MAX_CHECKLIST_ITEMS)}>
              {editor.id ? 'Save checklist question' : 'Add checklist question'}
            </button>
            {editor.id && <button type="button" className="chat-button" onClick={resetEditor}>Cancel question edit</button>}
          </div>
        </form>
      </div>
      <div className="chat-toolbar">
        <strong>{items.length}/{MAX_CHECKLIST_ITEMS} checklist questions</strong>
        <button className="chat-button" type="button" disabled={!items.length}
          onClick={() => setConfirmClear(true)}>Clear checklist</button>
      </div>
      {confirmClear && <div className="chat-note" role="group" aria-label="Clear checklist confirmation">
        <p>Remove all questions, results and personal notes?</p>
        <div className="chat-toolbar">
          <button type="button" className="chat-button" onClick={() => { invalidate([]); resetEditor(); }}>Confirm clear checklist</button>
          <button type="button" className="chat-button" onClick={() => setConfirmClear(false)}>Keep checklist</button>
        </div>
      </div>}
      <ol className="chat-checklist-plan">
        {items.map((item, i) => <li key={item.id}>
          <div><strong>{item.question}</strong>
            <p className="chat-muted">{scopes[item.scope]} · {item.includeContext ? 'Nearby fallback' : 'Strict only'}
              {' · '}{reviewNames[byId.get(item.id)?.status ?? 'unreviewed']}</p>
          </div>
          <div className="chat-checklist-item-actions">
            <button className="chat-button" type="button" aria-label={'Move ' + item.id + ' up'} disabled={i === 0}
              onClick={() => invalidate(moveChecklistItem(items, item.id, -1))}>↑</button>
            <button className="chat-button" type="button" aria-label={'Move ' + item.id + ' down'} disabled={i === items.length - 1}
              onClick={() => invalidate(moveChecklistItem(items, item.id, 1))}>↓</button>
            <button className="chat-button" type="button" onClick={() => {
              setEditor({ ...item }); editorRef.current?.focus();
            }}>Edit {item.id}</button>
            <button className="chat-button" type="button" onClick={() => setPendingRemoval(item.id)}>Remove {item.id}</button>
          </div>
          {pendingRemoval === item.id && <div className="chat-note">
            <p>Remove this question and its personal review?</p>
            <button className="chat-button" type="button" onClick={() => {
              invalidate(removeChecklistItem(items, item.id)); if (editor.id === item.id) resetEditor();
            }}>Confirm remove {item.id}</button>
            <button className="chat-button" type="button" onClick={() => setPendingRemoval(null)}>Cancel removal</button>
          </div>}
        </li>)}
      </ol>
      <div className="chat-toolbar">
        <button type="button" className="primary-button" disabled={!items.length} onClick={execute}>Run question checklist</button>
        {!results && items.length > 0 && <p className="chat-muted">Run the current list to refresh results before reviewing or exporting.</p>}
      </div>
      {results && <section aria-label="Question checklist results" className="chat-checklist-results">
        <h3>Checklist evidence results</h3>
        <div className="chat-checklist-counts">
          {checklistResultStates.map(state => <div key={state}>
            <strong>{resultCounts[state]}</strong><span>{stateNames[state]}</span>
          </div>)}
        </div>
        <p className="chat-muted">{reviewedCounts.reviewed_manually} manually reviewed · {reviewedCounts.needs_followup} need follow-up
          · {reviewedCounts.unreviewed} not reviewed. These are personal review decisions.</p>
        <div className="chat-checklist-filters">
          <label className="chat-overview-filter">Checklist result filter
            <select value={stateFilter} onChange={event => {
              setStateFilter(event.target.value as typeof stateFilter); setPage(1);
            }}>
              <option value="all">All result types</option>
              {checklistResultStates.map(state => <option key={state} value={state}>{stateNames[state]}</option>)}
            </select>
          </label>
          <label className="chat-overview-filter">Checklist review filter
            <select value={reviewFilter} onChange={event => {
              setReviewFilter(event.target.value as typeof reviewFilter); setPage(1);
            }}>
              <option value="all">All review statuses</option>
              {checklistReviewStatuses.map(status => <option key={status} value={status}>{reviewNames[status]}</option>)}
            </select>
          </label>
          <label className="chat-overview-filter">Filter checklist questions
            <input value={keyword} maxLength={MAX_QUESTION} onChange={event => { setKeyword(event.target.value); setPage(1); }} />
          </label>
        </div>
        <p className="chat-muted">{displayed.total} matching checklist results · page {displayed.page} of {displayed.pages}</p>
        {!displayed.rows.length && <p>No checklist questions match these filters.</p>}
        {displayed.rows.map(row => <ReviewEditor key={row.item.id} row={row} review={byId.get(row.item.id)!}
          onChange={patch => editReview(row.item.id, patch)} onInspect={onInspect} onAsk={onAsk} />)}
        <div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={displayed.page === 1}
            onClick={() => setPage(displayed.page - 1)}>Previous checklist results</button>
          <button type="button" className="chat-button" disabled={displayed.page === displayed.pages}
            onClick={() => setPage(displayed.page + 1)}>Next checklist results</button>
        </div>
      </section>}
      <section className="chat-context-results" aria-label="Checklist file exchange">
        <h3>Reuse or verify a checklist</h3>
        <p className="chat-muted">Template files contain questions and search settings only.
          Private report files additionally contain exact source fingerprints, native excerpts and saved personal notes.</p>
        <label className="chat-embedding-consent"><input type="checkbox" checked={templateConsent}
          onChange={event => setTemplateConsent(event.target.checked)} /> I approve exporting my checklist questions as a reusable template.</label>
        <button type="button" className="chat-button" disabled={!items.length || !templateConsent}
          onClick={exportTemplate}>Export question checklist template</button>
        <label className="chat-session-file">Import checklist template
          <input type="file" accept=".json,application/json" onChange={event => void importFile(event, 'template')} />
        </label>
        <label className="chat-embedding-consent"><input type="checkbox" checked={reportConsent}
          onChange={event => setReportConsent(event.target.checked)} /> I approve exporting private source excerpts, questions and saved notes.</label>
        <button type="button" className="chat-button" disabled={!results || !reportConsent}
          onClick={() => void exportReport()}>Export private checklist report</button>
        <label className="chat-session-file">Verify and restore checklist report
          <input type="file" accept=".json,application/json" onChange={event => void importFile(event, 'report')} />
        </label>
        {pending && <section className="chat-note" aria-label="Checklist import confirmation">
          <p>{pending.kind === 'report' ? 'The exact native evidence was replayed.' : 'Question template validated.'}
            {' '}Replace the current checklist with {pending.items.length} questions?
            {pending.kind === 'template' && ' Previous results and review notes will be cleared.'}</p>
          <div className="chat-toolbar">
            <button className="chat-button" type="button" onClick={applyImport}>Apply imported checklist</button>
            <button className="chat-button" type="button" onClick={() => setPending(null)}>Cancel checklist import</button>
          </div>
        </section>}
      </section>
    </fieldset>
    {busy && <p role="status">Checking private checklist file and source bindings…</p>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'chat-error' : 'chat-note'}>{feedback.message}</p>}
  </details>;
}
