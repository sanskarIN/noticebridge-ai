import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Passage, SearchIndex, Role } from './pdfChatCore';
import { passageId } from './pdfChatResearch';
import { fingerprintSources, type AttachedFiles } from './pdfChatSession';
import { filterEvidence, loadReview, MAX_REVIEW_ITEMS, MAX_REVIEW_NOTE, removeEvidence,
  reviewCounts, serializeReview, updateEvidence, type ReviewEntry, type ReviewStatus } from './pdfChatReviewWorkspace';

const STATUS: Record<ReviewStatus, string> = {
  unreviewed: 'Not yet reviewed', reviewed_manually: 'Reviewed manually', needs_followup: 'Needs follow-up',
};
const PAGE_SIZE = 10;

export default function PdfChatReviewWorkspace({ entries, files, index, onChange, onInspect }: {
  entries: ReviewEntry[]; files: AttachedFiles; index: SearchIndex;
  onChange: (entries: ReviewEntry[]) => void; onInspect: (source: Passage) => void;
}) {
  const [role, setRole] = useState<Role | 'both'>('both');
  const [status, setStatus] = useState<ReviewStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clear, setClear] = useState(false);
  const [pending, setPending] = useState<{ base: ReviewEntry[]; entries: ReviewEntry[] } | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const counts = reviewCounts(entries);
  const visible = filterEvidence(entries, { role, status });
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const selected = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  function change(next: ReviewEntry[]) {
    setPending(null); setClear(false); setFeedback(null); onChange(next);
  }
  async function save() {
    if (!consent || busy || !entries.length) return;
    const token = ++generation.current;
    setBusy(true); setFeedback(null); setPending(null);
    try {
      const text = await serializeReview(index, await fingerprintSources(files), entries);
      if (token !== generation.current) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'noticebridge-evidence-review.json';
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback({ error: false, text: 'Local review copy exported. It contains your notes and source fingerprints.' });
    } catch {
      if (token === generation.current) setFeedback({ error: true, text: 'Unable to export the evidence review.' });
    } finally { if (token === generation.current) setBusy(false); }
  }
  async function restore(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;
    const token = ++generation.current;
    setBusy(true); setFeedback(null); setPending(null);
    try {
      const result = await loadReview(file, index, await fingerprintSources(files));
      if (token === generation.current) setPending({ entries: result, base: entries });
    } catch {
      if (token === generation.current) setFeedback({ error: true,
        text: 'Review file rejected. It must match the exact attached PDFs and extracted source fragments.' });
    } finally { if (token === generation.current) setBusy(false); }
  }
  return <details className="chat-panel chat-embedding-panel">
    <summary>Evidence review workspace ({entries.length})</summary>
    <p className="chat-note">Save native source fragments from the source inspector and record your own
      review notes. A reviewed flag is a personal annotation, not independent verification.
      Entries stay in this browser session until cleared or a PDF changes.</p>
    <div className="chat-toolbar">
      <p>{entries.length}/{MAX_REVIEW_ITEMS} saved · {counts.unreviewed} not reviewed
        {' '}· {counts.reviewed_manually} reviewed · {counts.needs_followup} need follow-up</p>
      <button type="button" className="chat-button" disabled={!entries.length || busy}
        onClick={() => setClear(true)}>Clear review workspace</button>
    </div>
    {clear && <div className="chat-note">
      <p>Remove all saved fragments and your notes? Export a private copy first if needed.</p>
      <button type="button" className="chat-button" disabled={busy} onClick={() => change([])}>Confirm clear review</button>
      <button type="button" className="chat-button" onClick={() => setClear(false)}>Keep review entries</button>
    </div>}
    <div className="chat-field-grid">
      <label className="chat-overview-filter">Review workspace source
        <select value={role} onChange={event => { setRole(event.target.value as typeof role); setPage(1); }}>
          <option value="both">Both PDFs</option>
          <option value="original">Original / first PDF</option>
          <option value="revised">Updated / second PDF</option>
        </select>
      </label>
      <label className="chat-overview-filter">Review workspace status
        <select value={status} onChange={event => { setStatus(event.target.value as typeof status); setPage(1); }}>
          <option value="all">All statuses</option>
          {Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>
    {!selected.length && <p className="chat-muted">{entries.length
      ? 'No review entries match these filters.' : 'No saved fragments yet. Inspect a native citation and save it here.'}</p>}
    {selected.map(entry => {
      const id = passageId(entry.source);
      return <article className="chat-citation chat-review-entry" key={id} aria-label={'Review entry ' + id}>
        <p className="chat-muted">{entry.source.role} · physical page {entry.source.page} · fragment {entry.source.ordinal}</p>
        <blockquote>{entry.source.text}</blockquote>
        <div className="chat-toolbar">
          <button type="button" className="chat-button" onClick={() => onInspect(entry.source)}>
            Inspect saved source {id}
          </button>
          <button type="button" className="chat-button" disabled={busy}
            onClick={() => change(removeEvidence(entries, id))}>Remove review entry {id}</button>
        </div>
        <label className="chat-overview-filter">Review status for {id}
          <select disabled={busy} value={entry.status} onChange={event =>
            change(updateEvidence(entries, id, { status: event.target.value as ReviewStatus }))}>
            {Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="chat-overview-filter">Your note for {id}
          <textarea disabled={busy} rows={3} maxLength={MAX_REVIEW_NOTE} value={entry.note}
            onChange={event => {
              try { change(updateEvidence(entries, id, { note: event.target.value })); }
              catch { setFeedback({ error: true, text: 'Invalid note characters or length.' }); }
            }} />
        </label>
        <p className="chat-muted">{entry.note.length}/{MAX_REVIEW_NOTE} characters · user-authored note</p>
      </article>;
    })}
    {pages > 1 && <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={current === 1}
        onClick={() => setPage(current - 1)}>Previous review entries</button>
      <span>Review page {current} of {pages}</span>
      <button type="button" className="chat-button" disabled={current === pages}
        onClick={() => setPage(current + 1)}>Next review entries</button>
    </div>}
    <section className="chat-session" aria-label="Private evidence review exchange">
      <h3>Save or restore your review</h3>
      <p className="chat-muted">The local JSON includes notes, statuses, source IDs and fingerprints.
        It does not contain the full PDF or source quotations unless you type them into your notes.
        Notes may contain private information. Restore requires matching PDF bytes and extracted fragments.</p>
      <label className="chat-embedding-consent"><input type="checkbox" checked={consent}
        disabled={busy} onChange={event => setConsent(event.target.checked)} />
        I approve exporting my private evidence review notes.</label>
      <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={!consent || busy || !entries.length}
          onClick={() => void save()}>Export private evidence review</button>
        <label className="chat-session-file">Restore private evidence review
          <input type="file" accept=".json,application/json" disabled={busy}
            onChange={event => void restore(event)} /></label>
      </div>
      {busy && <p role="status">Checking local review fingerprints…</p>}
      {pending && <div className="chat-note" role="region" aria-label="Review restore confirmation">
        {pending.base === entries
          ? <p>Restore {pending.entries.length} user review entries? This replaces the current {entries.length} entries.</p>
          : <p>The review workspace changed while this file was being checked. Import it again to avoid losing edits.</p>}
        <button type="button" className="chat-button" disabled={pending.base !== entries}
          onClick={() => { change(pending.entries); setPage(1); }}>Apply restored review</button>
        <button type="button" className="chat-button" onClick={() => setPending(null)}>Cancel review restore</button>
      </div>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'}
        className={feedback.error ? 'chat-error' : 'chat-note'}>{feedback.text}</p>}
    </section>
  </details>;
}
