import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { answerQuestion, buildIndex, MAX_QUESTION, resolveQuestion, type Answer, type Corpus, type Passage, type Role, type Scope } from './pdfChatCore';
import { readPdf } from './pdfChatExtract';
import './pdfChat.css';

const PdfEvidencePreview = lazy(() => import('./PdfEvidencePreview'));
const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
type Slot = { kind: 'empty' } | { kind: 'loading' } | { kind: 'error'; message: string } |
  { kind: 'ready'; file: File; corpus: Corpus };
type Turn = { input: string; answer: Answer };
const MAX_TURNS = 24;
const examples = ['What is the application deadline?', 'What is the application fee?', 'Who can apply?'];
const empty = (): Record<Role, Slot> => ({ original: { kind: 'empty' }, revised: { kind: 'empty' } });

export default function PdfChat() {
  const [slots, setSlots] = useState(empty);
  const [scope, setScope] = useState<Scope>('original');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [reuse, setReuse] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Passage | null>(null);
  const controllers = useRef<Partial<Record<Role, AbortController>>>({});
  const generation = useRef({ original: 0, revised: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => {
    for (const controller of Object.values(controllers.current)) controller?.abort();
    generation.current.original++;
    generation.current.revised++;
  }, []);
  const index = useMemo(() => buildIndex(Object.values(slots).flatMap(slot =>
    slot.kind === 'ready' ? slot.corpus.passages : [],
  )), [slots]);
  const ready = (role: Role) => slots[role].kind === 'ready';
  const canAsk = scope === 'both' ? ready('original') && ready('revised') : ready(scope);

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
    if (!file) return;
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
  function ask(event: FormEvent) {
    event.preventDefault();
    if (!canAsk || turns.length >= MAX_TURNS) return;
    try {
      const resolved = resolveQuestion(question, turns.at(-1)?.answer.question ?? null, reuse);
      const answer = answerQuestion(index, resolved, scope);
      setTurns(old => [...old, { input: question.trim(), answer }]);
      setQuestion('');
      setReuse(false);
      setPreview(null);
      setError('');
      inputRef.current?.focus();
    } catch {
      setError('Enter a nonempty question within the 400-character limit.');
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
        <h2 id="chat-files-title">1. Attach notices</h2>
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
                {slot.corpus.missingPages.length > 0 && <p className="chat-note">
                  No indexed text on pages {slot.corpus.missingPages.join(', ')}. Inspect scanned or image-only pages directly.
                </p>}
                {slot.corpus.limited && <p className="chat-note">Indexing limits were reached. Some content is not searchable.</p>}
              </>}
              <button type="button" className="chat-button" disabled={slot.kind === 'empty'}
                onClick={() => remove(role)}>Clear {role} PDF</button>
            </div>;
          })}
        </div>
        <p className="chat-muted">Maximum 10 MiB and 80 pages per PDF; native embedded text only. No OCR or external AI service is used here.</p>
      </section>
      <section className="chat-panel" aria-labelledby="chat-title">
        <div className="chat-toolbar"><h2 id="chat-title">2. Ask a question</h2>
          <button type="button" className="chat-button" disabled={!turns.length} onClick={clearConversation}>Clear conversation</button>
        </div>
        <div className="chat-history" role="log" aria-label="Document chat history" aria-live="polite">
          {!turns.length && <p className="chat-muted">Your questions and matching document passages will appear here.</p>}
          {turns.map(({ input, answer }, i) => <article className="chat-turn" key={i}>
            <p className="chat-user"><strong>You</strong> {input}</p>
            <div className="chat-answer">
              <h3>{answer.kind === 'passages' ? 'Relevant source passages' : 'Insufficient matching evidence'}</h3>
              <p className="chat-muted">Scope: {answer.scope === 'both' ? 'Both PDFs' : names[answer.scope]}</p>
              {answer.question !== input && <p className="chat-muted">Search context: {answer.question}</p>}
              {answer.kind === 'insufficient' && <p>No sufficiently matching passage was found. This does not establish that the answer is absent. Try more specific wording or inspect the PDF.</p>}
              {answer.missingRoles.length > 0 && answer.kind === 'passages' && <p className="chat-note">
                No sufficiently matching passage in {answer.missingRoles.map(role => names[role]).join(', ')}.
                Do not infer that a requirement was removed.
              </p>}
              {answer.citations.map((citation, j) => <div className="chat-citation" key={j}>
                <p className="chat-muted">[{j + 1}] {names[citation.role]} · PDF page {citation.page}</p>
                <blockquote>{citation.text}</blockquote>
                <button type="button" className="chat-button" onClick={() => setPreview(citation)}>
                  Inspect source [{j + 1}]
                </button>
              </div>)}
              {answer.citations.length > 0 && <p className="chat-muted">Quoted extracted text only. Review nearby context, images and the official publication before acting.</p>}
            </div>
          </article>)}
          <div ref={latestRef} />
        </div>
        <form className="chat-form" onSubmit={ask}>
          <label>Search scope
            <select value={scope} onChange={event => setScope(event.target.value as Scope)}>
              <option value="original">Original / first PDF</option>
              <option value="revised">Updated / second PDF</option>
              <option value="both">Both PDFs</option>
            </select>
          </label>
          <div className="chat-examples">{examples.map(example =>
            <button type="button" key={example} className="chat-button" onClick={() => {
              setQuestion(example); setReuse(false); inputRef.current?.focus();
            }}>{example}</button>)}</div>
          <label>Your question<textarea ref={inputRef} value={question} maxLength={MAX_QUESTION}
            onChange={event => setQuestion(event.target.value)} rows={3} placeholder="Ask about the notice…" /></label>
          <label className="chat-checkbox"><input type="checkbox" checked={reuse} disabled={!turns.length}
            onChange={event => setReuse(event.target.checked)} /> Include previous question as search context</label>
          <div className="chat-toolbar">
            <span className="chat-muted">{question.length}/{MAX_QUESTION} · {turns.length}/{MAX_TURNS} turns</span>
            <button type="submit" className="primary-button" disabled={!canAsk || !question.trim() || turns.length >= MAX_TURNS}>Ask PDF</button>
          </div>
          {!canAsk && <p className="chat-muted">Attach the PDF or PDFs selected in the scope before asking.</p>}
          {turns.length >= MAX_TURNS && <p className="chat-note">Conversation limit reached. Clear the conversation to continue.</p>}
          {error && <p role="alert" className="chat-error">{error}</p>}
        </form>
      </section>
      {preview && previewSlot?.kind === 'ready' && <section className="chat-panel" aria-label="Source page inspection">
        <div className="chat-toolbar"><h2>{names[preview.role]} · page {preview.page}</h2>
          <button type="button" className="chat-button" onClick={() => setPreview(null)}>Close source page</button></div>
        <blockquote>{preview.text}</blockquote>
        <p className="chat-note">This page is shown for manual inspection. The chat index does not establish verified highlight geometry.</p>
        <Suspense fallback={<p role="status">Preparing local PDF viewer…</p>}>
          <PdfEvidencePreview file={previewSlot.file} pageNumber={preview.page} inspectionOnly />
        </Suspense>
      </section>}
    </main>
  </div>;
}
