import { useMemo, useState, type FormEvent } from 'react';
import { MAX_QUESTION } from './pdfChatCore';
import type { CollectionDocument, CollectionStep, CollectionTurn } from './pdfChatCollection';
import { collectionFollowupDraft, collectionHistoryParts, independentCollectionQuestion,
  removeCollectionTurn, reviseCollectionHistory } from './pdfChatCollectionHistory';

type Props = {
  documents: readonly CollectionDocument[];
  names: Map<string, string>;
  turns: CollectionTurn[];
  at: number;
  disabled: boolean;
  onDraft: (step: CollectionStep) => void;
  onChange: (turns: CollectionTurn[], active: number | null) => void;
};
export default function PdfChatCollectionHistory({ documents, names, turns, at, disabled, onDraft, onChange }: Props) {
  const turn = turns[at];
  const parts = useMemo(() => collectionHistoryParts(documents, turn), [documents, turn]);
  const [mode, setMode] = useState<'none' | 'followup' | 'edit' | 'remove'>('none');
  const [part, setPart] = useState(0);
  const [followup, setFollowup] = useState('');
  const [draft, setDraft] = useState<CollectionStep | null>(null);
  const [replacement, setReplacement] = useState(() => independentCollectionQuestion(documents, turn));
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState('');
  const later = turns.length - at - 1;
  function selectMode(next: typeof mode) {
    setMode(next); setError(''); setDraft(null); setDiscard(false);
    if (next === 'edit') setReplacement(independentCollectionQuestion(documents, turn));
  }
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDraft(null); setError('');
    if (disabled) return;
    try { setDraft(collectionFollowupDraft(documents, turn, part, followup)); }
    catch { setError('Choose one earlier question part and a valid single follow-up within the question and page limits.'); }
  }
  function revise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || (later > 0 && !discard)) return;
    try {
      const updated = reviseCollectionHistory(documents, turns, at,
        { ...replacement, question: replacement.question.trim() }, discard);
      onChange(updated, at); selectMode('none');
    } catch { setError('Unable to revise this collection question. The existing history has not changed.'); }
  }
  return <section className="chat-collection-inspection" aria-label="Collection history actions">
    <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={disabled} onClick={() => selectMode('followup')}>Prepare collection follow-up</button>
      <button type="button" className="chat-button" disabled={disabled} onClick={() => selectMode('edit')}>Edit collection question</button>
      <button type="button" className="chat-button" disabled={disabled} onClick={() => selectMode('remove')}>Remove collection question</button>
    </div>
    {mode === 'followup' && <form className="chat-form" onSubmit={prepare}>
      <h5>Follow up using a specific earlier question</h5>
      <p className="chat-muted">Only the selected question's wording is reused. No answer text or implied
        reference to another document is included. Review and edit the standalone question before asking it.</p>
      <label>Earlier collection question part
        <select value={part} onChange={event => {
          setPart(Number(event.target.value)); setDraft(null); setError('');
        }}>
          {parts.map((text, index) => <option key={index} value={index}>{index + 1}. {text}</option>)}
        </select>
      </label>
      <label>Collection follow-up wording
        <textarea rows={2} maxLength={MAX_QUESTION} value={followup} placeholder="On page 2?"
          onChange={event => { setFollowup(event.target.value); setDraft(null); setError(''); }} />
      </label>
      <button type="submit" className="chat-button" disabled={disabled || !followup.trim()}>Preview collection follow-up</button>
      {draft && <div className="chat-note" aria-label="Resolved collection follow-up">
        <strong>Standalone question draft</strong><p>{draft.question}</p>
        <p className="chat-muted">Selected sources: {draft.documentIds.map(id => names.get(id)).join('; ')}.</p>
        <button type="button" className="chat-button" disabled={disabled} onClick={() => {
          onDraft(draft); selectMode('none');
        }}>Use this collection follow-up</button>
      </div>}
      <button type="button" className="chat-button" onClick={() => selectMode('none')}>Cancel collection follow-up</button>
    </form>}
    {mode === 'edit' && <form className="chat-form" onSubmit={revise}>
      <h5>Edit question {at + 1}</h5>
      <label>Revised collection question
        <textarea rows={3} maxLength={MAX_QUESTION} value={replacement.question}
          onChange={event => setReplacement(old => ({ ...old, question: event.target.value }))} />
      </label>
      <fieldset className="chat-collection-edit-scope">
        <legend>Documents for revised question</legend>
        {documents.map(doc => <label className="chat-checkbox" key={doc.id}>
          <input type="checkbox" checked={replacement.documentIds.includes(doc.id)} onChange={event => {
            const checked = event.target.checked;
            setReplacement(old => ({ ...old, documentIds: checked
              ? [...old.documentIds, doc.id] : old.documentIds.filter(id => id !== doc.id) }));
          }} /> {names.get(doc.id)}
        </label>)}
      </fieldset>
      <label className="chat-checkbox"><input type="checkbox" checked={replacement.includeContext}
        onChange={event => setReplacement(old => ({ ...old, includeContext: event.target.checked }))} />
        Search nearby lines for revised collection question</label>
      {later > 0 && <label className="chat-checkbox chat-note"><input type="checkbox" checked={discard}
        onChange={event => setDiscard(event.target.checked)} /> I approve discarding {later} later collection question turn(s).</label>}
      <p className="chat-muted">Earlier questions and personal evidence-review notes remain unchanged.</p>
      <div className="chat-toolbar">
        <button type="submit" className="chat-button" disabled={disabled || !replacement.question.trim() ||
          !replacement.documentIds.length || (later > 0 && !discard)}>Apply revised collection question</button>
        <button type="button" className="chat-button" onClick={() => selectMode('none')}>Cancel collection question edit</button>
      </div>
    </form>}
    {mode === 'remove' && <div className="chat-note" aria-label="Remove collection question confirmation">
      <p>Remove this question and its displayed results? Other standalone questions and review annotations remain.</p>
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={disabled} onClick={() => {
          try {
            const remaining = removeCollectionTurn(turns, at, true);
            onChange(remaining, remaining.length ? Math.min(at, remaining.length - 1) : null);
            selectMode('none');
          } catch { setError('Unable to remove the selected question.'); }
        }}>Confirm collection question removal</button>
        <button type="button" className="chat-button" onClick={() => selectMode('none')}>Keep collection question</button>
      </div>
    </div>}
    {error && <p role="alert" className="chat-error">{error}</p>}
  </section>;
}
