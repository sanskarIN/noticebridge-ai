import { useMemo, useState } from 'react';
import type { Passage } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';
import { COLLECTION_FRAGMENT_PAGE_SIZE, MAX_FRAGMENT_FILTER, collectionPageFragments,
  filterCollectionFragments, collectionFragmentPage, selectedFragmentListPage } from './pdfChatCollectionFragments';

export default function PdfChatCollectionFragments({ documents, documentId, physicalPage, selected, onInspect }: {
  documents: readonly CollectionDocument[];
  documentId: string;
  physicalPage: number;
  selected?: Passage;
  onInspect: (documentId: string, source: Passage, target: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [nearbyOnly, setNearbyOnly] = useState(false);
  const [page, setPage] = useState<number | null>(null);
  const result = useMemo(() => open ? collectionPageFragments(documents, documentId, physicalPage, selected) : null,
    [open, documents, documentId, physicalPage, selected]);
  const visible = useMemo(() => filterCollectionFragments(result?.fragments ?? [], { text, nearbyOnly }), [result, text, nearbyOnly]);
  const current = Math.min(page ?? selectedFragmentListPage(visible), Math.max(1, Math.ceil(visible.length / COLLECTION_FRAGMENT_PAGE_SIZE)));
  const shown = collectionFragmentPage(visible, current);
  return <details className="chat-collection-inspection" aria-label="Collection page native fragments"
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Browse native fragments on this collection page</summary>
    <p className="chat-note">Extracted fragments are in native extraction order, which can differ from visual reading order.
      Nearby geometry is only an inspection aid; no additional answer claim or verified highlight is implied.</p>
    {result && <>
      <div className="chat-collection-filter-grid">
        <label>Find text on this collection page
          <input value={text} maxLength={MAX_FRAGMENT_FILTER} onChange={event => {
            setText(event.target.value); setPage(1);
          }} />
        </label>
        {selected && <label className="chat-checkbox"><input type="checkbox" checked={nearbyOnly}
          onChange={event => { setNearbyOnly(event.target.checked); setPage(1); }} />
          Only selected fragment and geometry-supported immediate neighbors</label>}
      </div>
      <p role="status">{visible.length} of {result.fragments.length} indexed native fragments shown by the filter.</p>
      {result.coverage !== 'some_text' && <p className="chat-muted">Native coverage: {result.coverage.replaceAll('_', ' ')}.
        Inspect the rendered page even if the list is empty.</p>}
      {!visible.length && <p>No indexed native fragment matches. This does not establish absence from the PDF.</p>}
      {shown.rows.map(row => <article className="chat-citation" key={row.source.ordinal}>
        <p className="chat-muted">Fragment {row.source.ordinal}
          {row.relationship === 'selected' ? ' · currently selected' : row.relationship === 'nearby_same_flow' ? ' · geometry-supported adjacent lead' : ''}</p>
        <p>{row.source.text}</p>
        <button type="button" className="chat-button" disabled={row.relationship === 'selected'}
          onClick={event => onInspect(documentId, row.source, event.currentTarget)}>Inspect collection fragment {row.source.ordinal}</button>
      </article>)}
      {shown.pages > 1 && <div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={current === 1}
          onClick={() => setPage(current - 1)}>Previous collection fragments</button>
        <span>{shown.first}–{shown.last} of {visible.length} · page {current} of {shown.pages}</span>
        <button type="button" className="chat-button" disabled={current === shown.pages}
          onClick={() => setPage(current + 1)}>Next collection fragments</button>
      </div>}
    </>}
  </details>;
}
