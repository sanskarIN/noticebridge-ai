/** Page-level native fragment browsing, independent of relevance ranking. */
import { pageCoverage, sameTextFlow, type Corpus, type Passage } from './pdfChatCore';
import { collectionCitation, type CollectionDocument } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';

export const COLLECTION_FRAGMENT_PAGE_SIZE = 16;
export const MAX_FRAGMENT_FILTER = 120;
export type FragmentRelationship = 'selected' | 'nearby_same_flow' | 'other_fragment';
export type CollectionFragment = { source: Passage; relationship: FragmentRelationship };
export type CollectionPageFragments = {
  documentId: string; physicalPage: number; coverage: ReturnType<typeof pageCoverage>;
  fragments: CollectionFragment[];
};
const cached = new WeakMap<Corpus, Map<number, Passage[]>>();
function invalid(): never { throw new Error('Invalid collection fragment selection.'); }

function pageIndex(corpus: Corpus): Map<number, Passage[]> {
  const existing = cached.get(corpus);
  if (existing) return existing;
  const index = new Map<number, Passage[]>();
  for (const row of corpus.passages) {
    const rows = index.get(row.page) ?? [];
    rows.push(row);
    index.set(row.page, rows);
  }
  for (const rows of index.values()) rows.sort((a, b) => a.ordinal - b.ordinal);
  cached.set(corpus, index);
  return index;
}
export function collectionPageFragments(documents: readonly CollectionDocument[], documentId: string,
  physicalPage: number, selected?: Passage): CollectionPageFragments {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  if (!Number.isSafeInteger(physicalPage) || physicalPage < 1 || physicalPage > doc.corpus.pageCount) invalid();
  if (selected) {
    collectionCitation(documents, documentId, selected);
    if (selected.page !== physicalPage) invalid();
  }
  const rows = pageIndex(doc.corpus).get(physicalPage) ?? [];
  return { documentId, physicalPage, coverage: pageCoverage(doc.corpus, physicalPage),
    fragments: rows.map(source => ({
      source, relationship: source === selected ? 'selected' :
        selected && Math.abs(source.ordinal - selected.ordinal) === 1 &&
        (source.ordinal < selected.ordinal ? sameTextFlow(source, selected) : sameTextFlow(selected, source))
          ? 'nearby_same_flow' : 'other_fragment',
    })) };
}
export type FragmentFilter = { text: string; nearbyOnly: boolean };
export function filterCollectionFragments(rows: readonly CollectionFragment[], filter: FragmentFilter): CollectionFragment[] {
  if (!filter || typeof filter.text !== 'string' || filter.text.length > MAX_FRAGMENT_FILTER ||
      typeof filter.nearbyOnly !== 'boolean') invalid();
  const needle = filter.text.trim().toLowerCase();
  return rows.filter(row =>
    (!filter.nearbyOnly || row.relationship !== 'other_fragment') &&
    (!needle || row.source.text.toLowerCase().includes(needle)));
}
export function collectionFragmentPage(rows: readonly CollectionFragment[], page: number) {
  const pages = Math.max(1, Math.ceil(rows.length / COLLECTION_FRAGMENT_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  const start = (page - 1) * COLLECTION_FRAGMENT_PAGE_SIZE;
  const visible = rows.slice(start, start + COLLECTION_FRAGMENT_PAGE_SIZE);
  return { rows: visible, pages, first: visible.length ? start + 1 : 0, last: start + visible.length };
}
export function selectedFragmentListPage(rows: readonly CollectionFragment[]): number {
  const index = rows.findIndex(row => row.relationship === 'selected');
  return index < 0 ? 1 : Math.floor(index / COLLECTION_FRAGMENT_PAGE_SIZE) + 1;
}
