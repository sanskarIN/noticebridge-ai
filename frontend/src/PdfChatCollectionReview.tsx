import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Passage } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';
import { COLLECTION_REVIEW_PAGE_SIZE, COLLECTION_REVIEW_STATUSES, MAX_COLLECTION_REVIEW_ITEMS,
  MAX_COLLECTION_REVIEW_NOTE, collectionReviewCounts, collectionReviewKey, collectionReviewPage,
  filterCollectionReviews, loadCollectionReview, removeCollectionEvidence, serializeCollectionReview,
  updateCollectionEvidence, validCollectionReviewNote, type CollectionReviewEntry, type CollectionReviewFilter,
  type CollectionReviewStatus } from './pdfChatCollectionReview';

const statusNames: Record<CollectionReviewStatus, string> = {
  unreviewed: 'Unreviewed', reviewed_manually: 'Reviewed manually', needs_followup: 'Needs follow-up',
};
type Feedback = { error: boolean; message: string };
type Pending = { entries: CollectionReviewEntry[]; previous: readonly CollectionReviewEntry[] };
function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'noticebridge-collection-review.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PdfChatCollectionReview({ documents, entries, names, onChange, onInspect }: {
  documents: readonly CollectionDocument[];
  entries: readonly CollectionReviewEntry[];
  names: Map<string, string>;
  onChange: (entries: CollectionReviewEntry[]) => void;
  onInspect: (documentId: string, source: Passage, target: HTMLElement) => void;
}) {
  const [filter, setFilter] = useState<CollectionReviewFilter>({ documentId: 'all', status: 'all', query: '' });
  const [page, setPage] = useState(1);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const [clear, setClear] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latest = useRef(entries);
  latest.current = entries;
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  // Approvals apply to the current notebook only, not subsequent edits.
  useEffect(() => { setConsent(false); }, [entries]);
  const counts = collectionReviewCounts(entries);
  const filtered = filterCollectionReviews(entries, filter);
  const current = collectionReviewPage(filtered,
    Math.min(page, Math.max(1, Math.ceil(filtered.length / COLLECTION_REVIEW_PAGE_SIZE))));
  const unchanged = pending?.previous === entries;

  function changeFilter(change: Partial<CollectionReviewFilter>) {
    setFilter(old => ({ ...old, ...change }));
    setPage(1);
    setRemove(null);
  }
  function changeEntry(key: string, change: { status?: CollectionReviewStatus; note?: string }) {
    if (busy) return;
    try {
      onChange(updateCollectionEvidence(entries, key, change));
      setFeedback(null);
    } catch { setFeedback({ error: true, message: 'Review note or status is invalid.' }); }
  }
  async function exportReview() {
    if (!consent || busy || !entries.length || controller.current) return;
    const token = ++generation.current;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true); setConsent(false); setPending(null); setFeedback(null);
    try {
      const text = await serializeCollectionReview(documents, entries, operation.signal);
      if (token !== generation.current || operation.signal.aborted) return;
      if (latest.current !== entries) {
        setFeedback({ error: true, message: 'Review changed during export. Approve and export again.' });
        return;
      }
      download(text);
      setFeedback({ error: false, message: 'Private collection review exported locally.' });
    } catch {
      if (token === generation.current && !operation.signal.aborted)
        setFeedback({ error: true, message: 'Unable to export the collection review.' });
    } finally {
      if (token === generation.current) { controller.current = null; setBusy(false); }
    }
  }
  async function importReview(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy || controller.current) return;
    const token = ++generation.current;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true); setConsent(false); setPending(null); setFeedback(null);
    try {
      const restored = await loadCollectionReview(file, documents, operation.signal);
      if (token === generation.current && !operation.signal.aborted)
        setPending({ entries: restored, previous: entries });
    } catch {
      if (token === generation.current && !operation.signal.aborted)
        setFeedback({ error: true, message: 'Collection review rejected. Source fingerprints or text must match exactly.' });
    } finally {
      if (token === generation.current) { controller.current = null; setBusy(false); }
    }
  }
  return <details className="chat-collection-inspection" aria-label="Collection evidence review notebook">
    <summary>Review saved collection evidence</summary>
    <p>Save source fragments from the collection source inspection panel. Notes and review flags are personal
      annotations, not verified statements about applicability, accuracy or authority.</p>
    <div className="chat-collection-budget" aria-label="Collection review counts">
      <div><strong>{entries.length} / {MAX_COLLECTION_REVIEW_ITEMS}</strong><span>Saved fragments</span></div>
      {COLLECTION_REVIEW_STATUSES.map(status => <div key={status}><strong>{counts[status]}</strong><span>{statusNames[status]}</span></div>)}
    </div>
    {entries.length > 0 && <>
      <div className="chat-collection-filter-grid">
        <label>Review collection document
          <select value={filter.documentId} onChange={event => changeFilter({ documentId: event.target.value })}>
            <option value="all">All attached collection PDFs</option>
            {documents.map(doc => <option value={doc.id} key={doc.id}>{names.get(doc.id)}</option>)}
          </select>
        </label>
        <label>Review collection status
          <select value={filter.status} onChange={event => changeFilter({ status: event.target.value as CollectionReviewFilter['status'] })}>
            <option value="all">All statuses</option>
            {COLLECTION_REVIEW_STATUSES.map(status => <option value={status} key={status}>{statusNames[status]}</option>)}
          </select>
        </label>
        <label>Find collection review text
          <input value={filter.query} maxLength={100} onChange={event => changeFilter({ query: event.target.value })}
            placeholder="Search saved excerpts or notes" />
        </label>
      </div>
      <p role="status">{filtered.length} of {entries.length} saved collection fragments match the filters.</p>
      {!filtered.length && <p>No saved evidence matches the selected filters.</p>}
      {current.rows.map(entry => {
        const key = collectionReviewKey(entry.documentId, entry.source);
        return <section className="chat-answer chat-collection-review-entry" key={key}
          aria-label={'Saved collection evidence: ' + names.get(entry.documentId) + ', page ' + entry.source.page +
            ', fragment ' + entry.source.ordinal}>
          <h4>{names.get(entry.documentId)}</h4>
          <p className="chat-muted">Physical page {entry.source.page} · fragment {entry.source.ordinal}</p>
          <blockquote>{entry.source.text}</blockquote>
          <div className="chat-toolbar">
            <button type="button" className="chat-button" onClick={event => onInspect(entry.documentId, entry.source, event.currentTarget)}>Inspect saved collection source</button>
            <button type="button" className="chat-button" disabled={busy} onClick={() => { setRemove(key); setClear(false); }}>Remove saved fragment</button>
          </div>
          <label>Collection review status
            <select value={entry.status} disabled={busy} onChange={event => changeEntry(key, { status: event.target.value as CollectionReviewStatus })}>
              {COLLECTION_REVIEW_STATUSES.map(status => <option value={status} key={status}>{statusNames[status]}</option>)}
            </select>
          </label>
          <label>Collection review note
            <textarea rows={3} value={entry.note} maxLength={MAX_COLLECTION_REVIEW_NOTE} disabled={busy}
              onChange={event => {
                if (validCollectionReviewNote(event.target.value)) changeEntry(key, { note: event.target.value });
                else setFeedback({ error: true, message: 'Review notes cannot contain invalid control characters.' });
              }} />
          </label>
          <p className="chat-muted">{entry.note.length}/{MAX_COLLECTION_REVIEW_NOTE} text units</p>
          {remove === key && <div className="chat-note">
            <p>Remove this saved fragment and its private annotation?</p>
            <div className="chat-toolbar">
              <button type="button" className="chat-button" disabled={busy} onClick={() => {
                onChange(removeCollectionEvidence(entries, key)); setRemove(null);
              }}>Confirm saved fragment removal</button>
              <button type="button" className="chat-button" onClick={() => setRemove(null)}>Keep saved fragment</button>
            </div>
          </div>}
        </section>;
      })}
      {current.pages > 1 && <div className="chat-toolbar" aria-label="Collection review pagination">
        <button type="button" className="chat-button" disabled={current.page === 1} onClick={() => setPage(current.page - 1)}>Previous saved fragments</button>
        <span>{current.first}–{current.last} of {filtered.length} · page {current.page} of {current.pages}</span>
        <button type="button" className="chat-button" disabled={current.page === current.pages} onClick={() => setPage(current.page + 1)}>Next saved fragments</button>
      </div>}
      <button type="button" className="chat-button" disabled={busy} onClick={() => { setClear(true); setRemove(null); }}>Clear collection review notes</button>
      {clear && <div className="chat-note">
        <p>Remove every saved collection fragment and annotation? Questions and attached PDFs remain.</p>
        <button type="button" className="chat-button" disabled={busy} onClick={() => { onChange([]); setClear(false); }}>Confirm clear collection review</button>
        <button type="button" className="chat-button" onClick={() => setClear(false)}>Keep collection review</button>
      </div>}
    </>}
    <h4>Private review file</h4>
    <p className="chat-muted">The file includes your notes, review flags, PDF fingerprints, fragment locations
      and text hashes. It does not automatically include extracted quotes, filenames or PDF bytes. Keep it private.</p>
    <label className="chat-checkbox"><input type="checkbox" checked={consent} disabled={busy}
      onChange={event => setConsent(event.target.checked)} /> I approve exporting private collection review annotations.</label>
    <button type="button" className="chat-button" disabled={!consent || busy || !entries.length}
      onClick={() => void exportReview()}>Export collection review</button>
    <label className="chat-session-file">Import collection review
      <input type="file" accept=".json,application/json" disabled={busy} onChange={event => void importReview(event)} />
    </label>
    {busy && <div className="chat-toolbar">
      <p role="status">Checking private collection review…</p>
      <button type="button" className="chat-button" onClick={() => {
        controller.current?.abort(); setFeedback({ error: false, message: 'Collection review operation cancelled.' });
      }}>Cancel collection review operation</button>
    </div>}
    {pending && <section className="chat-note" aria-label="Collection review restore confirmation">
      <p>{pending.entries.length} saved fragment(s) match the attached PDF fingerprints and native source text.
        Applying replaces the current collection review.</p>
      {!unchanged && <p>The current review changed during validation. Import again before applying.</p>}
      <button type="button" className="chat-button" disabled={!unchanged || busy} onClick={() => {
        if (!unchanged || busy) return;
        onChange(pending.entries); setPending(null); setFilter({ documentId: 'all', status: 'all', query: '' }); setPage(1);
        setFeedback({ error: false, message: 'Collection review restored from attached sources.' });
      }}>Apply saved collection review</button>
      <button type="button" className="chat-button" onClick={() => setPending(null)}>Discard prepared collection review</button>
    </section>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'chat-error' : 'chat-note'}>{feedback.message}</p>}
  </details>;
}
