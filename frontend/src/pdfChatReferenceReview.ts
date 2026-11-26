/** Explicit one-hop cross-reference inspection, never automatic evidence expansion. */
import { MAX_PASSAGE_CHARS, type Passage, type SearchIndex } from './pdfChatCore';
import { referencesIn, searchReference, type ExplorerHit, type Reference } from './pdfChatEvidenceExplorer';
import { passageId } from './pdfChatResearch';

export const MAX_SOURCE_REFERENCES = 6;
export const REFERENCE_PAGE_SIZE = 8;
export type SourceReference = {
  reference: Reference;
  printed: string;
  atStart: boolean;
};
export type ReferenceInventory = {
  references: SourceReference[];
  total: number;
};
export type ReferenceReview = {
  reference: SourceReference;
  hits: ExplorerHit[];
  samePage: number;
  otherPages: number;
  startsWithReference: number;
};

function key(ref: Reference) { return ref.kind + ':' + ref.identifier; }

/** Preserve printed spelling and deduplicate explicit identifiers.
 * Leading references can be headings, but are not certified definitions.
 */
export function sourceReferences(source: Passage): ReferenceInventory {
  if (source.text.length > MAX_PASSAGE_CHARS) throw new Error('Source text exceeds the inspection limit.');
  const map = new Map<string, SourceReference>();
  for (const found of referencesIn(source.text)) {
    const id = key(found.reference);
    if (!map.has(id)) {
      map.set(id, { reference: found.reference,
        printed: source.text.slice(found.range.start, found.range.end),
        atStart: !source.text.slice(0, found.range.start).trim() });
    }
  }
  return { references: [...map.values()].slice(0, MAX_SOURCE_REFERENCES), total: map.size };
}

/** The starting fragment must be exactly present in the native index.
 * A reference may point to another document in reality: same-PDF hits
 * here are only search leads. Never cross into the other source role.
 */
export function followSourceReference(index: SearchIndex, source: Passage, ref: Reference): ReferenceReview {
  const id = passageId(source);
  const local = index.rows.find(row => passageId(row.passage) === id)?.passage;
  if (!local || local.text !== source.text) throw new Error('Source fragment is unavailable.');
  const inventory = sourceReferences(local);
  const selected = inventory.references.find(item => key(item.reference) === key(ref));
  if (!selected) throw new Error('Reference was not printed in this fragment.');
  const hits = searchReference(index, { scope: source.role }, selected.reference).hits
    .filter(hit => passageId(hit.source) !== id)
    .sort((a, b) => Number(Boolean(b.startsWithReference)) - Number(Boolean(a.startsWithReference)) ||
      a.source.page - b.source.page || a.source.ordinal - b.source.ordinal);
  return { reference: selected, hits,
    samePage: hits.filter(hit => hit.source.page === source.page).length,
    otherPages: hits.filter(hit => hit.source.page !== source.page).length,
    startsWithReference: hits.filter(hit => hit.startsWithReference).length };
}
export function referencePage(review: ReferenceReview, page: number) {
  const pages = Math.max(1, Math.ceil(review.hits.length / REFERENCE_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error('Invalid reference result page.');
  const offset = (page - 1) * REFERENCE_PAGE_SIZE;
  return { pages, hits: review.hits.slice(offset, offset + REFERENCE_PAGE_SIZE),
    first: review.hits.length ? offset + 1 : 0,
    last: Math.min(offset + REFERENCE_PAGE_SIZE, review.hits.length) };
}
