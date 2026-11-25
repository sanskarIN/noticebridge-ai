import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { buildIndex, MAX_QUESTION, pageCoverage, type Answer, type Corpus, type Passage, type Role } from './pdfChatCore';
import { answerScopedQuestions, comparePrintedValues, groupPrintedValues, nearbyPassages, resolveChatQuestion, type ChatScope } from './pdfChatInsights';
import { readPdf } from './pdfChatExtract';
import PdfChatOverview from './PdfChatOverview';
import './pdfChat.css';

const PdfEvidencePreview = lazy(() => import('./PdfEvidencePreview'));
const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
type Slot = { kind: 'empty' } | { kind: 'loading' } | { kind: 'error'; message: string } |
  { kind: 'ready'; file: File; corpus: Corpus };
type Turn = { input: string; resolved: string; answers: Answer[] };
const MAX_TURNS = 24;
const examples = ['What is the application deadline?', 'What is the application fee?', 'Who can apply?', 'What are the application deadline and fee?'];
const empty = (): Record<Role, Slot> => ({ original: { kind: 'empty' }, revised: { kind: 'empty' } });

function SearchCoverage({ answer, slots }: { answer: Answer; slots: Record<Role, Slot> }) {
  const roles: Role[] = answer.scope === 'both' ? ['original', 'revised'] : [answer.scope];
  const warnings = roles.flatMap(role => {
    const slot = slots[role];
    if (slot.kind !== 'ready') return [];
    const corpus = slot.corpus;
    if (answer.pageFilter !== undefined) {
      const page = answer.pageFilter;
      const state = pageCoverage(corpus, page);
      const description = state === 'not_present' ? 'does not exist in this PDF.'
        : state === 'not_indexed' ? 'was not indexed within the processing limits.'
        : state === 'no_indexed_text' ? 'has no indexed text. It may contain scanned or image-only material.'
        : state === 'limited' ? 'was indexed only partially because processing limits were reached.'
        : null;
      return description ? [names[role] + ': physical page ' + page + ' ' + description] : [];
    }
    if (corpus.limited || corpus.missingPages.length) {
      return [names[role] + ': searchable text coverage is incomplete. Some pages or fragments were not indexed.'];
    }
    return [];
  });
  return warnings.length ? <div className="chat-note" aria-label="Search coverage limitations">
    {warnings.map(warning => <p key={warning}>{warning}</p>)}
  </div> : null;
}


function PrintedInsights({ answer }: { answer: Answer }) {
  const groups = groupPrintedValues(answer);
  const comparisons = comparePrintedValues(groups);
  const multiple = groups.filter(group => group.values.length > 1);
  if (!comparisons.length && !multiple.length) return null;
  return <section className="chat-insights" aria-label="Printed field comparisons">
    {multiple.map(group => <p className="chat-note" key={group.role + group.label}>
      Multiple printed values for {group.label} in {names[group.role]}. Check their context; no single value has been selected.
    </p>)}
    {comparisons.map(comparison => <div key={comparison.label} className="chat-field-pair">
      <h4>{comparison.label}</h4>
      <p className="chat-muted">{comparison.outcome === 'same_printed_text' ? 'Same displayed wording'
        : comparison.outcome === 'different_printed_text' ? 'Different displayed wording'
        : 'Multiple displayed values; comparison requires review'}</p>
      <div className="chat-field-grid">
        {[comparison.original, comparison.revised].map(group => <div key={group.role}>
          <strong>{names[group.role]}</strong>
          {group.values.map(value => <p key={value.value}>{value.value} {value.citations.map(n => '[' + n + ']').join(' ')}</p>)}
        </div>)}
      </div>
    </div>)}
    {comparisons.length > 0 && <p className="chat-muted">Printed wording only. These comparisons do not establish equivalent values, an official amendment, or authority. Undisplayed matches may change the interpretation.</p>}
  </section>;
}

export default function PdfChat() {
  const [slots, setSlots] = useState(empty);
  const [scope, setScope] = useState<ChatScope>('original');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [reuse, setReuse] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Passage | null>(null);
  const controllers = useRef<Partial<Record<Role, AbortController>>>({});
  const generation = useRef({ original: 0, revised: 0 });
  const demoGeneration = useRef(0);
  const [demoLoading, setDemoLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => {
    for (const controller of Object.values(controllers.current)) controller?.abort();
    generation.current.original++;
    generation.current.revised++;
    demoGeneration.current++;
  }, []);
  const index = useMemo(() => buildIndex(Object.values(slots).flatMap(slot =>
    slot.kind === 'ready' ? slot.corpus.passages : [],
  )), [slots]);
  const ready = (role: Role) => slots[role].kind === 'ready';
  const attached = (['original', 'revised'] as const).filter(ready);
  const indexing = demoLoading || Object.values(slots).some(slot => slot.kind === 'loading');
  const canAsk = !indexing && (scope === 'auto' ? attached.length > 0 : scope === 'both' ? ready('original') && ready('revised') : ready(scope));

  function clearConversation() {
    setTurns([]);
    setPreview(null);
    setReuse(false);
    setError('');
  }
  function update(role: Role, slot: Slot) {
    setSlots(old => ({ ...old, [role]: slot }));
  }
  function remove(role: Role) {
    controllers.current[role]?.abort();
    generation.current[role]++;
    update(role, { kind: 'empty' });
    clearConversation();
    setQuestion('');
  }
  async function choose(role: Role, event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) {
      demoGeneration.current++;
      setDemoLoading(false);
      await indexFile(role, file);
    }
  }
  async function indexFile(role: Role, file: File) {
    remove(role);
    const token = generation.current[role];
    const controller = new AbortController();
    controllers.current[role] = controller;
    update(role, { kind: 'loading' });
    try {
      if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Invalid PDF size.');
      // Use a snapshot for both indexing and later visual inspection.
      const bytes = await file.arrayBuffer();
      controller.signal.throwIfAborted();
      const snapshot = new File([bytes], file.name, { type: 'application/pdf' });
      const corpus = await readPdf(snapshot, role, controller.signal);
      if (token === generation.current[role]) update(role, { kind: 'ready', file: snapshot, corpus });
    } catch {
      if (!controller.signal.aborted && token === generation.current[role]) {
        update(role, { kind: 'error', message: 'Unable to index this PDF. Choose a text-based PDF up to 10 MiB.' });
      }
    }
  }
  async function tryDemo() {
    const token = ++demoGeneration.current;
    setDemoLoading(true);
    setError('');
    try {
      const { loadShowcase } = await import('./showcase/load');
      if (token !== demoGeneration.current) return;
      const sample = loadShowcase();
      setScope('both');
      await Promise.all([indexFile('original', sample.original), indexFile('revised', sample.revised)]);
    } catch {
      if (token === demoGeneration.current) setError('Unable to load fictional notices.');
    } finally {
      if (token === demoGeneration.current) setDemoLoading(false);
    }
  }
  function ask(event: FormEvent) {
    event.preventDefault();
    if (!canAsk || turns.length >= MAX_TURNS) return;
    try {
      const resolved = resolveChatQuestion(question, turns.at(-1)?.resolved ?? null, reuse);
      const answers = answerScopedQuestions(index, resolved, scope, attached, includeContext);
      setTurns(old => [...old, { input: question.trim(), resolved, answers }]);
      setQuestion('');
      setReuse(false);
      setPreview(null);
      setError('');
      inputRef.current?.focus();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to search the selected PDFs.');
    }
  }
  useEffect(() => { if (turns.length) latestRef.current?.scrollIntoView({ block: 'nearest' }); }, [turns.length]);
  const previewSlot = preview ? slots[preview.role] : null;
  return <div className="app-shell pdf-chat">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">N</span><span>NoticeBridge <b>AI</b></span></div>
      <a className="repo-link" href="?">Return to comparison</a>
    </header>
    <main className="chat-main">
      <section className="chat-intro">
        <p className="chat-eyebrow">LOCAL DOCUMENT QUESTION ANSWERING</p>
        <h1>Chat with your PDFs</h1>
        <p>Ask about deadlines, fees, eligibility and other written requirements. Search one notice or both versions and inspect the pages yourself.</p>
        <p className="chat-note">This is extractive question answering, not a generative language model. Files and questions stay in this browser session. A matching passage is not a verified answer or proof of official authority.</p>
      </section>
      <section className="chat-panel" aria-labelledby="chat-files-title">
        <div className="chat-toolbar"><h2 id="chat-files-title">1. Attach notices</h2>
          <button type="button" className="chat-button" onClick={() => void tryDemo()}
            disabled={demoLoading || Object.values(slots).some(slot => slot.kind === 'loading')}>Try fictional notices</button></div>
        <div className="chat-file-grid">
          {(['original', 'revised'] as const).map(role => {
            const slot = slots[role];
            return <div key={role} className="chat-file">
              <label>{names[role]}<input type="file" accept=".pdf,application/pdf"
                onChange={event => void choose(role, event)} /></label>
              {slot.kind === 'loading' && <p role="status">Indexing local PDF…</p>}
              {slot.kind === 'error' && <p role="alert" className="chat-error">{slot.message}</p>}
              {slot.kind === 'ready' && <>
                <p className="chat-filename">{slot.file.name}</p>
                <p role="status">{slot.corpus.passages.length} extracted passages available.</p>
                <p className="chat-muted">Processed {slot.corpus.processedPages} of {slot.corpus.pageCount} physical PDF pages. Embedded text is not proof of complete page coverage.</p>
                {slot.corpus.limitedPages.length > 0 && <p className="chat-note">Processing limits affected pages {slot.corpus.limitedPages.join(', ')}.</p>}
                {slot.corpus.missingPages.length > 0 && <p className="chat-note">
                  No indexed text on pages {slot.corpus.missingPages.join(', ')}. Inspect scanned or image-only pages directly.
                </p>}
                {slot.corpus.limited && <p className="chat-note">Indexing limits were reached. Some content is not searchable.</p>}
              </>}
              <button type="button" className="chat-button" disabled={slot.kind === 'empty'}
                onClick={() => { demoGeneration.current++; setDemoLoading(false); remove(role); }}>Clear {role} PDF</button>
            </div>;
          })}
        </div>
        <p className="chat-muted">Maximum 10 MiB and 80 pages per PDF; native embedded text only. No OCR or external AI service is used here.</p>
      </section>
      {!indexing && <PdfChatOverview index={index} attached={attached} onInspect={setPreview}
        onAsk={value => { setQuestion(value); setReuse(false); setScope('auto'); inputRef.current?.focus(); }} />}
      <section className="chat-panel" aria-labelledby="chat-title">
        <div className="chat-toolbar"><h2 id="chat-title">2. Ask a question</h2>
          <button type="button" className="chat-button" disabled={!turns.length} onClick={clearConversation}>Clear conversation</button>
        </div>
        <div className="chat-history" role="log" aria-label="Document chat history" aria-live="polite">
          {!turns.length && <p className="chat-muted">Your questions and matching document passages will appear here.</p>}
          {turns.map(({ input, resolved, answers }, i) => <article className="chat-turn" key={i}>
            <p className="chat-user"><strong>You</strong> {input}</p>
            {resolved !== input && <p className="chat-muted">Search context: {resolved}</p>}
            {answers.map((answer, part) => <div className="chat-answer" key={part}>
              {answers.length > 1 && <h4 className="chat-subquestion">Question {part + 1}: {answer.question}</h4>}
              <h3>{answer.kind === 'passages' ? 'Relevant source passages' : 'Insufficient matching evidence'}</h3>
              <p className="chat-muted">Scope: {answer.scope === 'both' ? 'Both PDFs' : names[answer.scope]}
                {answer.pageFilter !== undefined && <> · Physical PDF page {answer.pageFilter} only</>}
              </p>
              {answer.missingRoles.some(role => !attached.includes(role)) && <p className="chat-note">
                Requested source not attached: {answer.missingRoles.filter(role => !attached.includes(role)).map(role => names[role]).join(', ')}.
              </p>}
              <SearchCoverage answer={answer} slots={slots} />
              {answer.kind === 'insufficient' && <p>No sufficiently matching passage was found. This does not establish that the answer is absent. Try more specific wording or inspect the PDF.</p>}
              {answer.missingRoles.length > 0 && answer.kind === 'passages' && <p className="chat-note">
                No sufficiently matching passage in {answer.missingRoles.map(role => names[role]).join(', ')}.
                Do not infer that a requirement was removed.
              </p>}
              {answer.printedFields.length > 0 && <div className="chat-printed-fields">
                <h4>Printed values in matching passages</h4>
                {answer.printedFields.map(field => <p key={field.citation}>
                  <strong>{field.label}:</strong> {field.value} [{field.citation}]
                </p>)}
                <p className="chat-muted">Literal fields only; no inferred or calculated values.</p>
              </div>}
              <PrintedInsights answer={answer} />
              {answer.contextGroups.length > 0 && <section className="chat-context-results" aria-label="Nearby matching fragments">
                <h4>Nearby matching fragments</h4>
                <p className="chat-note">No individual line matched every term in these sources. Nearby lines collectively match the query, but may describe unrelated conditions. These are not verified answers.</p>
                {answer.contextGroups.map((group, k) => <p key={k} className="chat-muted">
                  {names[group.role]} · page {group.page} · citations {group.citations.map(n => '[' + n + ']').join(' ')}
                </p>)}
              </section>}
              {Object.values(answer.matchedCounts).some(count => count > 4) &&
                <p className="chat-note">More passages matched than are displayed (maximum four per PDF).
                  Narrow the question or inspect the full document.</p>}
              {answer.citations.map((citation, j) => <div className="chat-citation" key={j}>
                <p className="chat-muted">[{j + 1}] {names[citation.role]} · PDF page {citation.page}</p>
                {answer.contextGroups.some(group => group.citations.includes(j + 1)) && <p className="chat-muted">Context fragment, not a standalone answer</p>}
                <blockquote>{citation.text}</blockquote>
                <button type="button" className="chat-button" onClick={() => setPreview(citation)}>
                  Inspect source [{j + 1}]
                </button>
              </div>)}
              {answer.citations.length > 0 && <p className="chat-muted">Quoted extracted text only. Review nearby context, images and the official publication before acting.</p>}
            </div>)}
          </article>)}
          <div ref={latestRef} />
        </div>
        <form className="chat-form" onSubmit={ask}>
          <label>Search scope
            <select value={scope} onChange={event => setScope(event.target.value as ChatScope)}>
              <option value="auto">Auto (explicit source wording)</option>
              <option value="original">Original / first PDF</option>
              <option value="revised">Updated / second PDF</option>
              <option value="both">Both PDFs</option>
            </select>
          </label>
          <p className="chat-muted">Auto scope recognizes phrases such as “original notice”, “updated notice” and “both PDFs”. If a requested source is missing, it will not substitute another PDF.</p>
          <div className="chat-examples">{examples.map(example =>
            <button type="button" key={example} className="chat-button" onClick={() => {
              setQuestion(example); setReuse(false); inputRef.current?.focus();
            }}>{example}</button>)}</div>
          <label>Your question<textarea ref={inputRef} value={question} maxLength={MAX_QUESTION}
            onChange={event => setQuestion(event.target.value)} rows={3} placeholder="Ask about the notice…" /></label>
          <p className="chat-muted">Ask separate questions with question marks or semicolons (up to four). Use “on page 2” to restrict a question to physical PDF page 2.</p>
          <label className="chat-checkbox"><input type="checkbox" checked={includeContext}
            onChange={event => setIncludeContext(event.target.checked)} /> Search nearby lines when no single line matches</label>
          <label className="chat-checkbox"><input type="checkbox" checked={reuse} disabled={!turns.length || turns.at(-1)?.answers.length !== 1}
            onChange={event => setReuse(event.target.checked)} /> Include previous question as search context</label>
          <div className="chat-toolbar">
            <span className="chat-muted">{question.length}/{MAX_QUESTION} · {turns.length}/{MAX_TURNS} turns</span>
            <button type="submit" className="primary-button" disabled={!canAsk || !question.trim() || turns.length >= MAX_TURNS}>Ask PDF</button>
          </div>
          {!canAsk && <p className="chat-muted">{indexing ? 'Finish indexing the selected PDFs before asking.' : 'Attach the PDF or PDFs selected in the scope before asking.'}</p>}
          {turns.length >= MAX_TURNS && <p className="chat-note">Conversation limit reached. Clear the conversation to continue.</p>}
          {error && <p role="alert" className="chat-error">{error}</p>}
        </form>
      </section>
      {preview && previewSlot?.kind === 'ready' && <section className="chat-panel" aria-label="Source page inspection">
        <div className="chat-toolbar"><h2>{names[preview.role]} · page {preview.page}</h2>
          <button type="button" className="chat-button" onClick={() => setPreview(null)}>Close source page</button></div>
        <blockquote>{preview.text}</blockquote>
        <details className="chat-nearby"><summary>Nearby extracted passages (same PDF page)</summary>
          <p className="chat-muted">Extraction order may differ from visual reading order. These fragments are not additional answer claims.</p>
          {nearbyPassages(index, preview).map(passage => <p key={passage.ordinal}
            className={passage.ordinal === preview.ordinal ? 'chat-selected-fragment' : undefined}>{passage.text}</p>)}
        </details>
        <p className="chat-note">This page is shown for manual inspection. The chat index does not establish verified highlight geometry.</p>
        <Suspense fallback={<p role="status">Preparing local PDF viewer…</p>}>
          <PdfEvidencePreview file={previewSlot.file} pageNumber={preview.page} inspectionOnly />
        </Suspense>
      </section>}
    </main>
  </div>;
}
