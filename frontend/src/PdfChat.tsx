import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { buildIndex, MAX_QUESTION, pageCoverage, type Answer, type Corpus, type Passage, type Role } from './pdfChatCore';
import { comparePrintedValues, groupPrintedValues, nearbyPassages, parseSearchQuestion, type ChatScope } from './pdfChatInsights';
import { MAX_CHAT_TURNS, runChatStep, type ChatTurn, type AttachedFiles } from './pdfChatSession';
import PdfChatSessionPanel from './PdfChatSessionPanel';
import PdfChatEvidenceReport from './PdfChatEvidenceReport';
import PdfChatOcrReview from './PdfChatOcrReview';
import PdfChatPageNavigator from './PdfChatPageNavigator';
import PdfChatReferenceReview from './PdfChatReferenceReview';
import PdfChatReviewWorkspace from './PdfChatReviewWorkspace';
import PdfChatRequirements, { PdfChatRequirementAnswer } from './PdfChatRequirements';
import { buildRequirementIndex } from './pdfChatRequirements';
import { MAX_REVIEW_ITEMS, pinEvidence, type ReviewEntry } from './pdfChatReviewWorkspace';
import { passageId } from './pdfChatResearch';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { readPdf } from './pdfChatExtract';
import PdfChatOverview from './PdfChatOverview';
import PdfChatEmbeddingPanel from './PdfChatEmbeddingPanel';
import PdfChatDirectAnswer from './PdfChatDirectAnswer';
import PdfChatCrossPage from './PdfChatCrossPage';
import PdfChatEvidenceExplorer, { PdfChatQuestionEvidence } from './PdfChatEvidenceExplorer';
import PdfChatTableAnswer from './PdfChatTableAnswer';
import PdfChatTableExplorer from './PdfChatTableExplorer';
import { buildCategoryTables, type TableIndex } from './pdfChatTables';
import './pdfChat.css';

const PdfEvidencePreview = lazy(() => import('./PdfEvidencePreview'));
const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
type Slot = { kind: 'empty' } | { kind: 'loading' } | { kind: 'error'; message: string } |
  { kind: 'ready'; file: File; corpus: Corpus };
const MAX_TURNS = MAX_CHAT_TURNS;
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
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [reviewEntries, setReviewEntries] = useState<ReviewEntry[]>([]);
  const [conversationEpoch, setConversationEpoch] = useState(0);
  const [reuse, setReuse] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{
    role: Role; page: number; source?: Passage; kind: 'native' | 'ocr' | 'page';
  } | null>(null);
  const controllers = useRef<Partial<Record<Role, AbortController>>>({});
  const generation = useRef({ original: 0, revised: 0 });
  const demoGeneration = useRef(0);
  const [demoLoading, setDemoLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => {
    for (const controller of Object.values(controllers.current)) controller?.abort();
    generation.current.original++;
    generation.current.revised++;
    demoGeneration.current++;
  }, []);
  const index = useMemo(() => buildIndex(Object.values(slots).flatMap(slot =>
    slot.kind === 'ready' ? slot.corpus.passages : [],
  )), [slots]);
  const requirements = useMemo(() => buildRequirementIndex(index), [index]);
  const tableIndexes = useMemo<Record<Role, TableIndex | null>>(() => ({
    original: slots.original.kind === 'ready' ? buildCategoryTables(slots.original.corpus) : null,
    revised: slots.revised.kind === 'ready' ? buildCategoryTables(slots.revised.corpus) : null,
  }), [slots]);
  const ready = (role: Role) => slots[role].kind === 'ready';
  const attached = (['original', 'revised'] as const).filter(ready);
  const files: AttachedFiles = {};
  const corpora: ChatCorpora = {};
  for (const role of attached) {
    const slot = slots[role];
    if (slot.kind === 'ready') { files[role] = slot.file; corpora[role] = slot.corpus; }
  }
  const indexing = demoLoading || Object.values(slots).some(slot => slot.kind === 'loading');
  const canAsk = !indexing && (scope === 'auto' ? attached.length > 0 : scope === 'both' ? ready('original') && ready('revised') : ready(scope));

  function clearConversation() {
    setConversationEpoch(epoch => epoch + 1);
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
    setReviewEntries([]);
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
      const turn = runChatStep(index, { input: question.trim(), scope, includeContext, reuse }, turns.at(-1), attached);
      setTurns(old => [...old, turn]);
      setQuestion('');
      setReuse(false);
      setPreview(null);
      setError('');
      inputRef.current?.focus({ preventScroll: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to search the selected PDFs.');
    }
  }

  // Keep the composer and the outer page stable while updating history.
  // scrollIntoView on a nested element also scrolls outer ancestors.
  useEffect(() => {
    if (turns.length && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [turns.length, conversationEpoch]);
  function inspectNative(source: Passage) {
    setPreview({ role: source.role, page: source.page, source, kind: 'native' });
  }
  function inspectOcr(source: Passage) {
    setPreview({ role: source.role, page: source.page, source, kind: 'ocr' });
  }
  function inspectPage(role: Role, page: number) {
    const slot = slots[role];
    if (slot.kind !== 'ready' || !Number.isSafeInteger(page) ||
        page < 1 || page > slot.corpus.pageCount) return;
    setPreview({ role, page, kind: 'page' });
  }
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
        <p className="chat-note">Default answers are generated from locally indexed source text, not by a language model. Files and questions stay in this browser unless you explicitly export them for optional local AI processing. A matching passage is not a verified answer or proof of official authority.</p>
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
                {tableIndexes[role] && tableIndexes[role]!.tables.length > 0 && <p className="chat-muted">{tableIndexes[role]!.tables.length} aligned category table candidates.</p>}
                {tableIndexes[role] && (tableIndexes[role]!.skippedPages.length > 0 || tableIndexes[role]!.limited) && <p className="chat-muted">Layout analysis is limited for this PDF. Inspect tables directly.</p>}
              </>}
              <button type="button" className="chat-button" disabled={slot.kind === 'empty'}
                onClick={() => { demoGeneration.current++; setDemoLoading(false); remove(role); }}>Clear {role} PDF</button>
            </div>;
          })}
        </div>
        <p className="chat-muted">Maximum 10 MiB per PDF; the first 80 physical pages can be indexed. The primary index uses native embedded text.
          Optional OCR review uses a separate local file workflow.</p>
        {!indexing && attached.length > 0 && <PdfChatPageNavigator
          key={'page-navigator:' + generation.current.original + ':' + generation.current.revised}
          corpora={corpora} onInspect={inspectPage} />}
      </section>
      {!indexing && <PdfChatOverview index={index} attached={attached} onInspect={inspectNative}
        onAsk={value => { setQuestion(value); setReuse(false); setScope('auto'); inputRef.current?.focus(); }} />}
      {!indexing && <PdfChatTableExplorer key={'tables:' + generation.current.original + ':' + generation.current.revised}
        indexes={tableIndexes} onInspect={inspectNative} onAsk={(value, role) => {
          setQuestion(value); setReuse(false); setScope(role); inputRef.current?.focus();
        }} />}
      {!indexing && attached.length > 0 && <PdfChatEvidenceExplorer
        key={'explorer:' + generation.current.original + ':' + generation.current.revised}
        index={index} corpora={corpora} onInspect={inspectNative} />}
      {!indexing && attached.length > 0 && <PdfChatRequirements
        key={'requirements:' + generation.current.original + ':' + generation.current.revised}
        index={index} requirements={requirements} corpora={corpora} attached={attached} onInspect={inspectNative} />}
      <section className="chat-panel" aria-labelledby="chat-title">
        <div className="chat-toolbar"><h2 id="chat-title">2. Ask a question</h2>
          <button type="button" className="chat-button" disabled={!turns.length} onClick={clearConversation}>Clear conversation</button>
        </div>
        <div ref={historyRef} className="chat-history" role="log" aria-label="Document chat history" aria-live="polite">
          {!turns.length && <p className="chat-muted">Your questions and matching document passages will appear here.</p>}
          {turns.map(({ input, resolved, answers }, i) => <article className="chat-turn" key={conversationEpoch + ':' + i}>
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
              {parseSearchQuestion(answer.question).comparison && <p className="chat-note">
                Recognized printed-value comparison: {parseSearchQuestion(answer.question).comparison!.field.label}.
                {answer.scope !== 'both' ? ' Select both PDFs or Auto to compare the two sources.' :
                  ' Calculations use only supported literal values; no conclusion about authority or applicability is inferred.'}
              </p>}
              <SearchCoverage answer={answer} slots={slots} />
              <PdfChatDirectAnswer index={index} answer={answer} onInspect={inspectNative} />
              <PdfChatTableAnswer indexes={tableIndexes} answer={answer} onInspect={inspectNative} />
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
                <button type="button" className="chat-button" onClick={() => inspectNative(citation)}>
                  Inspect source [{j + 1}]
                </button>
              </div>)}
              {answer.citations.length > 0 && <p className="chat-muted">Quoted extracted text only. Review nearby context, images and the official publication before acting.</p>}
              <PdfChatCrossPage index={index} answer={answer} onInspect={inspectNative} />
              <PdfChatQuestionEvidence index={index} answer={answer} corpora={corpora} onInspect={inspectNative} />
              <PdfChatRequirementAnswer index={index} requirements={requirements} corpora={corpora}
                attached={attached} answer={answer} onInspect={inspectNative} />
            </div>)}
          </article>)}
        </div>
        <form className="chat-form" onSubmit={ask}>
          <label htmlFor="chat-search-scope">Search scope</label>
          <select id="chat-search-scope" aria-label="Search scope" value={scope}
            onChange={event => setScope(event.target.value as ChatScope)}>
              <option value="auto">Auto (explicit source wording)</option>
              <option value="original">Original / first PDF</option>
              <option value="revised">Updated / second PDF</option>
              <option value="both">Both PDFs</option>
          </select>
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
          {reuse && <p className="chat-muted">For source or page changes, try “What about the revised notice?”
            or “On page 2?”. The previous question’s subject and qualifiers are retained.
            The selected search scope still takes precedence over automatic source wording.</p>}
          <div className="chat-toolbar">
            <span className="chat-muted">{question.length}/{MAX_QUESTION} · {turns.length}/{MAX_TURNS} turns</span>
            <button type="submit" className="primary-button" disabled={!canAsk || !question.trim() || turns.length >= MAX_TURNS}>Ask PDF</button>
          </div>
          {!canAsk && <p className="chat-muted">{indexing ? 'Finish indexing the selected PDFs before asking.' : 'Attach the PDF or PDFs selected in the scope before asking.'}</p>}
          {turns.length >= MAX_TURNS && <p className="chat-note">Conversation limit reached. Clear the conversation to continue.</p>}
          {error && <p role="alert" className="chat-error">{error}</p>}
        </form>
        {!indexing && turns.at(-1)?.answers.length === 1 && <PdfChatEmbeddingPanel
          key={'models:' + generation.current.original + ':' + generation.current.revised + ':' + conversationEpoch + ':' + turns.length}
          index={index} answer={turns.at(-1)!.answers[0]} onInspect={inspectNative} />}
        {!indexing && attached.length > 0 && <PdfChatSessionPanel
          key={'session:' + generation.current.original + ':' + generation.current.revised}
          files={files} index={index} turns={turns} onRestore={restored => {
            clearConversation(); setTurns(restored); setQuestion('');
          }} />}
        {!indexing && attached.length > 0 && <PdfChatEvidenceReport
          key={'report:' + generation.current.original + ':' + generation.current.revised + ':' + conversationEpoch + ':' + turns.length}
          files={files} corpora={corpora} index={index} turns={turns} />}
        {!indexing && attached.length > 0 && <PdfChatOcrReview
          key={'ocr:' + generation.current.original + ':' + generation.current.revised + ':' + conversationEpoch}
          files={files} corpora={corpora}
          answer={turns.at(-1)?.answers.length === 1 ? turns.at(-1)!.answers[0] : null}
          onInspect={inspectOcr} />}
      </section>
      {!indexing && attached.length > 0 && <PdfChatReviewWorkspace
        key={'review-workspace:' + generation.current.original + ':' + generation.current.revised}
        entries={reviewEntries} files={files} index={index} onChange={setReviewEntries} onInspect={inspectNative} />}
      {preview && previewSlot?.kind === 'ready' && <section className="chat-panel" aria-label="Source page inspection">
        <div className="chat-toolbar"><h2>{names[preview.role]} · page {preview.page}</h2>
          <button type="button" className="chat-button" onClick={() => setPreview(null)}>Close source page</button></div>
        {preview.kind === 'ocr' && <p className="chat-note">Unverified OCR transcription. Compare this text
          with the rendered PDF page; it is not an indexed native-text fragment.</p>}
        {preview.source && <blockquote>{preview.source.text}</blockquote>}
        {preview.kind === 'native' && preview.source && <div className="chat-toolbar">
          <button type="button" className="chat-button"
            disabled={reviewEntries.length >= MAX_REVIEW_ITEMS ||
              reviewEntries.some(entry => passageId(entry.source) === passageId(preview.source!))}
            onClick={() => setReviewEntries(old => pinEvidence(index, old, preview.source!))}>
            {reviewEntries.some(entry => passageId(entry.source) === passageId(preview.source!))
              ? 'Saved in evidence review' : 'Save source to evidence review'}
          </button>
          <span className="chat-muted">{reviewEntries.length}/{MAX_REVIEW_ITEMS} saved native fragments</span>
        </div>}
        {preview.kind === 'native' && preview.source && <details className="chat-nearby"><summary>Nearby extracted passages (same PDF page)</summary>
          <p className="chat-muted">Extraction order may differ from visual reading order. These fragments are not additional answer claims.</p>
          {nearbyPassages(index, preview.source).map(passage => <p key={passage.ordinal}
            className={passage.ordinal === preview.source?.ordinal ? 'chat-selected-fragment' : undefined}>{passage.text}</p>)}
        </details>}
        {preview.kind === 'native' && preview.source && <PdfChatReferenceReview
          key={preview.role + ':' + preview.page + ':' + preview.source.ordinal}
          source={preview.source} index={index} onInspect={inspectNative} />}
        <div className="chat-toolbar" aria-label="Source page navigation">
          <button type="button" className="chat-button" disabled={preview.page <= 1}
            onClick={() => inspectPage(preview.role, preview.page - 1)}>Previous PDF page</button>
          <span className="chat-muted">Physical page {preview.page} of {previewSlot.corpus.pageCount}</span>
          <button type="button" className="chat-button" disabled={preview.page >= previewSlot.corpus.pageCount}
            onClick={() => inspectPage(preview.role, preview.page + 1)}>Next PDF page</button>
        </div>
        {preview.kind === 'page' && <p className="chat-muted">Manual page selection.
          No particular source fragment is selected.</p>}
        <p className="chat-note">This page is shown for manual inspection. The chat index does not establish verified highlight geometry.</p>
        <Suspense fallback={<p role="status">Preparing local PDF viewer…</p>}>
          <PdfEvidencePreview file={previewSlot.file} pageNumber={preview.page} inspectionOnly />
        </Suspense>
      </section>}
    </main>
  </div>;
}
