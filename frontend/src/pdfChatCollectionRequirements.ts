/** Collection requirement cues. Counts refer to literal text fragments,
 * not legal rules, inferred applicability or official requirements. */
import type { SearchIndex, Passage } from './pdfChatCore';
import { collectionCitation, type CollectionDocument } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';
import { buildRequirementIndex, findRequirements, requirementKinds, REQUIREMENT_KEYWORD_LIMIT,
  type RequirementIndex, type RequirementKind, type RequirementHit, type RequirementResults } from './pdfChatRequirements';

const cache = new WeakMap<SearchIndex, RequirementIndex>();
export const COLLECTION_REQUIREMENT_PAGE_SIZE = 12;
export type CollectionRequirementFilter = { kind: RequirementKind | 'all'; keyword: string; page?: number;
  wording: 'all' | 'shared' | 'unshared' };
export type CollectionRequirementHit = RequirementHit & { documentId: string; matchingDocumentIds: string[] };
export type CollectionRequirementSide = {
  documentId: string; results: RequirementResults; displayedHits: number; sharedHits: number;
};
export type CollectionRequirements = {
  sides: CollectionRequirementSide[]; hits: CollectionRequirementHit[];
  counts: Record<RequirementKind, number>;
};
function invalid(): never { throw new Error('Invalid collection requirement inspection.'); }
function indexFor(index: SearchIndex) {
  let result = cache.get(index);
  if (!result) { result = buildRequirementIndex(index); cache.set(index, result); }
  return result;
}
export function collectionRequirements(documents: readonly CollectionDocument[], selected: readonly string[],
  filter: CollectionRequirementFilter): CollectionRequirements {
  if (!filter || !['all','shared','unshared'].includes(filter.wording) ||
      typeof filter.keyword !== 'string' || filter.keyword.length > REQUIREMENT_KEYWORD_LIMIT ||
      (filter.kind !== 'all' && !requirementKinds.includes(filter.kind))) invalid();
  const docs = selectedCollectionDocuments(documents, selected);
  const counts: Record<RequirementKind, number> = { mandatory:0,prohibited:0,exception:0,permission:0,recommendation:0 };
  const sides: CollectionRequirementSide[] = [];
  const exact = new Map<string, Set<string>>();
  for (const doc of docs) {
    const results = findRequirements(doc.index, indexFor(doc.index), {
      scope: 'original', kind: filter.kind, keyword: filter.keyword, page: filter.page,
    }, ['original']);
    for (const hit of results.hits) {
      const ids = exact.get(hit.source.text) ?? new Set<string>();
      ids.add(doc.id); exact.set(hit.source.text, ids);
    }
    sides.push({ documentId: doc.id, results, displayedHits:0, sharedHits:0 });
  }
  const hits: CollectionRequirementHit[] = [];
  for (const side of sides) {
    for (const hit of side.results.hits) {
      const matchingDocumentIds = selected.filter(id => id !== side.documentId && exact.get(hit.source.text)!.has(id));
      if (matchingDocumentIds.length) side.sharedHits++;
      if (filter.wording === 'shared' && !matchingDocumentIds.length ||
          filter.wording === 'unshared' && matchingDocumentIds.length) continue;
      for (const kind of hit.kinds) counts[kind]++;
      side.displayedHits++;
      hits.push({ ...hit, documentId:side.documentId, matchingDocumentIds });
    }
  }
  return { sides, hits, counts };
}
export function collectionRequirementPage(hits: readonly CollectionRequirementHit[], page: number) {
  const pages = Math.max(1, Math.ceil(hits.length / COLLECTION_REQUIREMENT_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  const start = (page - 1) * COLLECTION_REQUIREMENT_PAGE_SIZE;
  const rows = hits.slice(start,start+COLLECTION_REQUIREMENT_PAGE_SIZE);
  return { rows, pages, first:rows.length?start+1:0,last:start+rows.length };
}
export function collectionRequirementSource(documents: readonly CollectionDocument[],
  result: CollectionRequirements, hit: CollectionRequirementHit): Passage {
  if (!result.hits.includes(hit)) invalid();
  return collectionCitation(documents,hit.documentId,hit.source).source;
}
/** Exact wording is a lookup only; duplicates within one document do not
 * establish support in a different document. */
export function collectionRequirementCounterparts(documents: readonly CollectionDocument[],
  result: CollectionRequirements, hit: CollectionRequirementHit): {documentId:string;source:Passage}[] {
  collectionRequirementSource(documents,result,hit);
  return result.sides.filter(side=>hit.matchingDocumentIds.includes(side.documentId))
    .flatMap(side=>side.results.hits.filter(row=>row.source.text===hit.source.text)
      .map(row=>({documentId:side.documentId,source:collectionCitation(documents,side.documentId,row.source).source})));
}
