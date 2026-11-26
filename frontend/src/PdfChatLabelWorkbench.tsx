import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { Passage, Role, Scope, SearchIndex } from './pdfChatCore';
import { passageId } from './pdfChatResearch';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { annotationCandidates, appendEvidenceSet, deleteDraftCase, exportLabelBundle, labelIsComplete,
  labelKinds, labelPage, makeDraftCase, readLabelDraft, removeEvidenceSet, saveDraftCase,
  serializeLabelDraft, setCaseKind, toggleEvidence, MAX_LABEL_CASES, MAX_LABEL_SETS,
  type DraftCase, type LabelBundle, type LabelDraft, type LabelKind, type LabelMetadata } from './pdfChatLabelWorkbench';

const descriptions: Record<LabelKind, string> = {
  answerable: 'Answerable with complete native evidence',
  unanswerable: 'No answer after independent PDF inspection',
  unindexed: 'Relevant material not represented in native index',
  ambiguous: 'Ambiguous or competing interpretations',
};
const defaultMetadata: LabelMetadata = {
  dataset: 'local-study', document: 'notice-1', family: 'notice-family-1',
  split: 'development', snapshot: 'notice-1.json',
};
function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function CaseEditor({ row, index, attached, onChange, onInspect }: {
  row: DraftCase; index: SearchIndex; attached: Role[];
  onChange: (row: DraftCase) => void; onInspect: (source: Passage) => void;
}) {
  const [set, setSet] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [nextKind, setNextKind] = useState<LabelKind | null>(null);
  const candidates = useMemo(() => annotationCandidates(index, {
    scope: row.scope, page: row.page, keyword,
  }), [index, row.scope, row.page, keyword]);
  const displayed = labelPage(candidates, page);
  const chosen = row.evidenceSets[set] ?? [];
  const selectedSources = useMemo(() => new Map(index.rows.map(item => [passageId(item.passage), item.passage])), [index]);
  function toggle(source: Passage) {
    try { onChange(toggleEvidence(row, set, source, index, attached)); setError(''); }
    catch { setError('This evidence set is full or the fragment is outside the labeled scope.'); }
  }
  return <section className="chat-context-results" aria-label="Manual annotation evidence">
    <h4>{row.id}: {row.question}</h4>
    <p className="chat-muted">{row.scope} {row.page ? '· physical page ' + row.page : ''} · {descriptions[row.kind]}</p>
    <p className="chat-note">Inspect the actual PDF, including qualifiers and omitted image text. Do not
      copy retrieval results as reference labels. Each alternative set must independently contain
      every fragment needed to support the answer.</p>
    <label className="chat-overview-filter">Revise selected annotation category
      <select aria-label="Revise selected annotation category" value={nextKind ?? row.kind}
        onChange={event => setNextKind(event.target.value as LabelKind)}>
        {labelKinds.map(value => <option value={value} key={value}>{descriptions[value]}</option>)}
      </select>
    </label>
    {nextKind !== null && nextKind !== row.kind && <div className="chat-note">
      <p>Changing the label category discards its current evidence alternatives. Review the PDF again before confirming.</p>
      <button type="button" className="chat-button" onClick={() => {
        try {
          onChange(setCaseKind(row, nextKind)); setSet(0); setNextKind(null); setError('');
        } catch { setError('Unable to change the category. Check the dataset metadata.'); }
      }}>Confirm annotation category change</button>
      <button type="button" className="chat-button" onClick={() => setNextKind(null)}>Keep annotation category</button>
    </div>}
    {row.kind !== 'answerable' ? <p>No native evidence set is attached to this label category.</p> : <>
      <div className="chat-toolbar">
        <button className="chat-button" type="button" disabled={row.evidenceSets.length >= MAX_LABEL_SETS}
          onClick={() => {
            try { onChange(appendEvidenceSet(row)); setSet(row.evidenceSets.length); setError(''); }
            catch { setError('Unable to add an alternative. Check the dataset metadata and set budget.'); }
          }}>
          Add alternative evidence set
        </button>
        {row.evidenceSets.map((ids, i) => <button className="chat-button" type="button" key={i}
          aria-pressed={set === i} onClick={() => { setSet(i); setError(''); }}>
          Set {i + 1} ({ids.length})
        </button>)}
      </div>
      {row.evidenceSets.length > 0 && <>
        <button type="button" className="chat-button" onClick={() => {
          try { onChange(removeEvidenceSet(row, set)); setSet(Math.max(0, set - 1)); setError(''); }
          catch { setError('Unable to remove the alternative. Check the dataset metadata.'); }
        }}>Remove selected evidence set</button>
        <p>Selected alternative: {chosen.length} source fragments.</p>
        {chosen.map(id => {
          const source = selectedSources.get(id);
          return source && <div className="chat-citation" key={id}>
            <p className="chat-muted">{id}</p><p>{source.text}</p>
            <button type="button" className="chat-button" onClick={() => onInspect(source)}>Inspect labeled {id}</button>
            <button type="button" className="chat-button" onClick={() => toggle(source)}>Remove {id} from set</button>
          </div>;
        })}
        <label className="chat-overview-filter">Manual annotation text filter
          <input value={keyword} maxLength={120} onChange={event => { setKeyword(event.target.value); setPage(1); }} />
        </label>
        <p className="chat-muted">{candidates.length} scoped native fragments, in physical extraction order.</p>
        {displayed.items.map(source => {
          const id = passageId(source);
          return <div className="chat-citation" key={id}>
            <p className="chat-muted">{id}</p><p>{source.text}</p>
            <label className="chat-embedding-consent"><input type="checkbox" checked={chosen.includes(id)}
              onChange={() => toggle(source)} /> Include {id} in alternative {set + 1}</label>
            <button className="chat-button" type="button" onClick={() => onInspect(source)}>Inspect annotation source {id}</button>
          </div>;
        })}
        <div className="chat-toolbar">
          <button className="chat-button" type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous annotation fragments</button>
          <span>Page {page} of {displayed.pages}</span>
          <button className="chat-button" type="button" disabled={page === displayed.pages} onClick={() => setPage(page + 1)}>Next annotation fragments</button>
        </div>
      </>}
    </>}
    {error && <p role="alert" className="chat-error">{error}</p>}
  </section>;
}
export default function PdfChatLabelWorkbench({ index, files, corpora, attached, onInspect }: {
  index: SearchIndex; files: AttachedFiles; corpora: ChatCorpora; attached: Role[];
  onInspect: (source: Passage) => void;
}) {
  const [draft, setDraft] = useState<LabelDraft>({ metadata: defaultMetadata, cases: [] });
  const [id, setId] = useState('');
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<Scope>(attached[0]);
  const [slices, setSlices] = useState('printed-field');
  const [kind, setKind] = useState<LabelKind>('answerable');
  const [selected, setSelected] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [declaration, setDeclaration] = useState<'synthetic' | 'independently_reviewed'>('synthetic');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bundle, setBundle] = useState<LabelBundle | null>(null);
  const [pending, setPending] = useState<LabelDraft | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const active = draft.cases.find(row => row.id === selected);
  const complete = draft.cases.filter(row => labelIsComplete(row, index, attached)).length;
  function change(next: LabelDraft) {
    setDraft(next); setBundle(null); setPending(null); setConfirmed(false); setError('');
  }
  function metadata(key: keyof LabelMetadata, value: string) {
    change({ ...draft, metadata: { ...draft.metadata, [key]: value } });
  }
  function add() {
    try {
      const row = makeDraftCase(id.trim(), question.trim(), scope,
        slices.split(',').map(value => value.trim()).filter(Boolean), kind, index, attached);
      change(saveDraftCase(draft, row, index, attached));
      setSelected(row.id); setId(''); setQuestion('');
    } catch { setError('Use a unique lowercase ID, one question, a valid scope and comma-separated lowercase slice IDs.'); }
  }
  async function perform(action: 'draft' | 'bundle' | File) {
    if (busy || (typeof action === 'string' && !consent)) return;
    const token = ++generation.current;
    setBusy(true); setError(''); setPending(null); setBundle(null);
    try {
      const pins = await fingerprintSources(files);
      if (action === 'draft') {
        const text = await serializeLabelDraft(draft, index, pins, corpora);
        if (token === generation.current) download(text, 'noticebridge-label-draft.json');
      } else if (action === 'bundle') {
        if (!confirmed) throw new Error('confirmation');
        const result = await exportLabelBundle(draft, index, pins, corpora, declaration, consent);
        if (token === generation.current) setBundle(result);
      } else {
        const result = await readLabelDraft(action, index, pins, corpora);
        if (token === generation.current) setPending(result);
      }
    } catch {
      if (token === generation.current) setError('Annotation exchange rejected. Check metadata, complete labels and exact attached PDF extraction.');
    } finally { if (token === generation.current) setBusy(false); }
  }
  function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (file) void perform(file);
  }
  return <details className="chat-session chat-embedding-panel">
    <summary>Research: independent evidence labeling</summary>
    <p className="chat-note">Create manually reviewed retrieval labels, not automatic ground truth.
      This workbench does not use model suggestions or the ranked chat answer. All files remain local.</p>
    <fieldset disabled={busy}>
      <legend>Dataset identity</legend>
      {(['dataset', 'document', 'family', 'snapshot'] as const).map(key => <label className="chat-overview-filter" key={key}>
        Annotation {key}<input value={draft.metadata[key]} maxLength={69}
          onChange={event => metadata(key, event.target.value)} />
      </label>)}
      <label className="chat-overview-filter">Annotation split
        <select value={draft.metadata.split} onChange={event => metadata('split', event.target.value)}>
          <option value="development">Development</option><option value="holdout">Holdout</option>
        </select>
      </label>
      <p className="chat-muted">Keep all revisions of one notice in the same family and split. Do not tune on holdout labels.</p>
      <h3>New annotation</h3>
      <label className="chat-overview-filter">Annotation case ID<input value={id} maxLength={64} onChange={event => setId(event.target.value)} /></label>
      <label className="chat-overview-filter">Annotation question<textarea rows={3} value={question}
        maxLength={400} onChange={event => setQuestion(event.target.value)} /></label>
      <label className="chat-overview-filter">Annotation scope
        <select value={scope} onChange={event => setScope(event.target.value as Scope)}>
          {attached.map(role => <option value={role} key={role}>{role}</option>)}
          {attached.length === 2 && <option value="both">Both</option>}
        </select>
      </label>
      <label className="chat-overview-filter">Annotation slices (comma-separated)
        <input value={slices} maxLength={300} onChange={event => setSlices(event.target.value)} />
      </label>
      <label className="chat-overview-filter">Annotation label kind
        <select value={kind} onChange={event => setKind(event.target.value as LabelKind)}>
          {labelKinds.map(value => <option value={value} key={value}>{descriptions[value]}</option>)}
        </select>
      </label>
      <button type="button" className="chat-button" disabled={draft.cases.length >= MAX_LABEL_CASES || !id.trim() || !question.trim()}
        onClick={add}>Add annotation case</button>
      <p>{complete}/{draft.cases.length} structurally complete labels; human correctness is not verified.</p>
      {draft.cases.map(row => <div key={row.id} className="chat-citation">
        <strong>{row.id}: {row.question}</strong>
        <p className="chat-muted">{descriptions[row.kind]} · {labelIsComplete(row, index, attached) ? 'structurally complete' : 'incomplete'}</p>
        <button className="chat-button" type="button" aria-pressed={selected === row.id}
          onClick={() => { setSelected(row.id); setDeletion(null); }}>Edit evidence for {row.id}</button>
        <button className="chat-button" type="button" onClick={() => setDeletion(row.id)}>Delete annotation {row.id}</button>
        {deletion === row.id && <div className="chat-toolbar">
          <button className="chat-button" type="button" onClick={() => {
            change(deleteDraftCase(draft, row.id)); setDeletion(null); if (selected === row.id) setSelected(null);
          }}>Confirm delete {row.id}</button>
          <button className="chat-button" type="button" onClick={() => setDeletion(null)}>Cancel deletion</button>
        </div>}
      </div>)}
      {active && <CaseEditor key={active.id} row={active} index={index} attached={attached} onInspect={onInspect}
        onChange={row => change(saveDraftCase(draft, row, index, attached, active.id))} />}
      <h3>Private label exchange</h3>
      <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
        onChange={event => { setConsent(event.target.checked); setBundle(null); }} />
        I approve exporting private questions, labels and native document text for evaluation.</label>
      <button type="button" className="chat-button" disabled={!consent} onClick={() => void perform('draft')}>Export annotation draft</button>
      <label className="chat-session-file">Restore annotation draft
        <input type="file" accept=".json,application/json" onChange={importFile} />
      </label>
      {pending && <section aria-label="Annotation restore confirmation">
        <p>Replace all current labels with {pending.cases.length} imported cases?</p>
        <button className="chat-button" type="button" onClick={() => { change(pending); setSelected(null); }}>Apply annotation draft</button>
        <button className="chat-button" type="button" onClick={() => setPending(null)}>Cancel annotation restore</button>
      </section>}
      <label className="chat-overview-filter">Label provenance declaration
        <select value={declaration} onChange={event => {
          setDeclaration(event.target.value as typeof declaration); setConfirmed(false); setBundle(null);
        }}>
          <option value="synthetic">Synthetic or development fixtures</option>
          <option value="independently_reviewed">Independently reviewed by a human</option>
        </select>
      </label>
      <label className="chat-embedding-consent"><input type="checkbox" checked={confirmed}
        onChange={event => { setConfirmed(event.target.checked); setBundle(null); }} />
        I confirm the selected provenance and have checked the labeled evidence sets.</label>
      <button type="button" className="chat-button" disabled={!consent || !confirmed || !draft.cases.length || complete !== draft.cases.length}
        onClick={() => void perform('bundle')}>Prepare evaluation files</button>
      {bundle && <div className="chat-note">
        <p>Save both files in the same private directory. The manifest binds to the exact snapshot hash.</p>
        <button className="chat-button" type="button" onClick={() => download(bundle.snapshot, draft.metadata.snapshot)}>Download evaluation snapshot</button>
        <button className="chat-button" type="button" onClick={() => download(bundle.manifest, 'labels.json')}>Download evaluation labels</button>
      </div>}
    </fieldset>
    {busy && <p role="status">Checking annotation source bindings…</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
  </details>;
}
