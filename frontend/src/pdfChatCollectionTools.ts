/** Multi-document evidence inspection tools. These are separate from
 * question answering and never infer authority or document relationships. */
import { pageCoverage, type Answer, type Passage } from './pdfChatCore';
import { collectionStats, CollectionError, type CollectionDocument, type CollectionId } from './pdfChatCollection';
import { buildNoticeOverview, fieldDefinitions, type FieldId, type FieldDefinition, type OverviewValue } from './pdfChatOverview';
import { literalRanges, parseReference, searchLiteral, searchReference, searchAllQuestionMatches,
  type ExplorerHit, type ExplorerResult } from './pdfChatEvidenceExplorer';

export type CollectionSelection = readonly CollectionId[];
export function selectedCollectionDocuments(documents: readonly CollectionDocument[],
  selection: CollectionSelection): CollectionDocument[] {
  collectionStats(documents);
  if (!Array.isArray(selection) || !selection.length || new Set(selection).size !== selection.length) {
    throw new CollectionError('source');
  }
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  return selection.map(id => {
    const doc = byId.get(id);
    if (!doc) throw new CollectionError('source');
    return doc;
  });
}

export type CollectionCoverage = {
  pageCount: number;
  processedPages: number;
  missingPages: number[];
  limitedPages: number[];
  limited: boolean;
  pageState?: ReturnType<typeof pageCoverage>;
};
function coverage(doc: CollectionDocument, page?: number): CollectionCoverage {
  const { pageCount, processedPages, missingPages, limitedPages, limited } = doc.corpus;
  return { pageCount, processedPages, missingPages: [...missingPages], limitedPages: [...limitedPages], limited,
    ...(page === undefined ? {} : { pageState: pageCoverage(doc.corpus, page) }) };
}

export type CollectionFieldSide = {
  documentId: CollectionId;
  distinctValues: number;
  values: OverviewValue[];
  coverage: CollectionCoverage;
};
export type CollectionFieldStatus = 'one_document' | 'missing_in_selected_documents' |
  'same_literal_value' | 'different_literal_values' | 'multiple_values_within_document';
export type CollectionField = {
  definition: FieldDefinition;
  status: CollectionFieldStatus;
  missingDocuments: number;
  multipleValueDocuments: number;
  sides: CollectionFieldSide[];
};

function fieldStatus(sides: CollectionFieldSide[]): CollectionFieldStatus {
  if (sides.some(side => side.distinctValues > 1)) return 'multiple_values_within_document';
  if (sides.length === 1) return 'one_document';
  if (sides.some(side => side.distinctValues === 0)) return 'missing_in_selected_documents';
  return new Set(sides.map(side => side.values[0].value)).size === 1
    ? 'same_literal_value' : 'different_literal_values';
}

/** Match only known printed labels, preserve exact values, and include
 * empty/limited sources rather than treating them as negative evidence. */
export function collectionFieldMatrix(documents: readonly CollectionDocument[],
  selection: CollectionSelection): CollectionField[] {
  const selected = selectedCollectionDocuments(documents, selection);
  const overviews = selected.map(doc => ({
    doc, coverage: coverage(doc),
    byField: new Map<FieldId, ReturnType<typeof buildNoticeOverview>[number]>(
      buildNoticeOverview(doc.index).map(field => [field.definition.id, field])),
  }));
  return fieldDefinitions.flatMap(definition => {
    const sides = overviews.map(({ doc, coverage: info, byField }) => {
      const side = byField.get(definition.id)?.original;
      return { documentId: doc.id, distinctValues: side?.distinctValues ?? 0, values: side?.values ?? [],
        coverage: info };
    });
    if (!sides.some(side => side.distinctValues > 0)) return [];
    return [{ definition, status: fieldStatus(sides),
      missingDocuments: sides.filter(side => side.distinctValues === 0).length,
      multipleValueDocuments: sides.filter(side => side.distinctValues > 1).length, sides }];
  });
}

export type MatrixFilter = 'all' | 'review';
export function filterCollectionFields(fields: readonly CollectionField[], filter: MatrixFilter, text: string): CollectionField[] {
  if (filter !== 'all' && filter !== 'review') throw new Error('Invalid collection field filter.');
  if (typeof text !== 'string' || text.length > 100) throw new Error('Invalid collection field filter.');
  const needle = text.trim().toLowerCase();
  return fields.filter(field => {
    const matches = !needle || field.definition.label.toLowerCase().includes(needle) ||
      field.definition.aliases.some(alias => alias.toLowerCase().includes(needle));
    return matches && (filter === 'all' || !['same_literal_value', 'one_document'].includes(field.status));
  });
}

export const COLLECTION_FIELD_PAGE_SIZE = 6;
export function collectionFieldPage(fields: readonly CollectionField[], page: number) {
  const pages = Math.max(1, Math.ceil(fields.length / COLLECTION_FIELD_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error('Invalid collection field page.');
  const offset = (page - 1) * COLLECTION_FIELD_PAGE_SIZE;
  const rows = fields.slice(offset, offset + COLLECTION_FIELD_PAGE_SIZE);
  return { rows, pages, page, first: rows.length ? offset + 1 : 0, last: offset + rows.length };
}

export type CollectionEvidenceQuery = {
  mode: 'literal' | 'reference';
  text: string;
  documentIds: CollectionId[];
  page?: number;
  ignoreAsciiCase: boolean;
};
export type CollectionEvidenceSide = {
  documentId: CollectionId;
  hits: ExplorerHit[];
  coverage: CollectionCoverage;
};
export type CollectionEvidenceResult = {
  query: CollectionEvidenceQuery;
  sides: CollectionEvidenceSide[];
  total: number;
};

function validPage(page: unknown): page is number | undefined {
  return page === undefined || (typeof page === 'number' && Number.isSafeInteger(page) && page >= 1 && page <= 80);
}
export function parseCollectionEvidencePage(text: string): number | undefined {
  if (typeof text !== 'string') throw new Error('Invalid physical page.');
  const clean = text.trim();
  if (!clean) return undefined;
  if (!/^[1-9][0-9]?$/.test(clean) || !validPage(Number(clean))) {
    throw new Error('Use one physical PDF page from 1 to 80.');
  }
  return Number(clean);
}

/** Search within one native source fragment. Results retain document
 * identity, exact text offsets and explicit per-source coverage. */
export function searchCollectionEvidence(documents: readonly CollectionDocument[],
  query: CollectionEvidenceQuery): CollectionEvidenceResult {
  if (!query || (query.mode !== 'literal' && query.mode !== 'reference') ||
      typeof query.text !== 'string' || typeof query.ignoreAsciiCase !== 'boolean' ||
      !validPage(query.page)) throw new Error('Invalid collection evidence query.');
  const selected = selectedCollectionDocuments(documents, query.documentIds);
  const reference = query.mode === 'reference' ? parseReference(query.text) : null;
  if (!reference) literalRanges('', query.text, query.ignoreAsciiCase);
  const sides = selected.map(doc => {
    const options = { scope: 'original' as const, page: query.page };
    const result = reference ? searchReference(doc.index, options, reference)
      : searchLiteral(doc.index, options, query.text, query.ignoreAsciiCase);
    return { documentId: doc.id, hits: result.hits, coverage: coverage(doc, query.page) };
  });
  return { query: { ...query, documentIds: [...query.documentIds] }, sides,
    total: sides.reduce((sum, side) => sum + side.hits.length, 0) };
}

/** Expand one existing answer in the exact document and physical scope.
 * Do not turn contextual fallback windows into full strict matches. */
export function collectionQuestionEvidence(documents: readonly CollectionDocument[],
  documentId: CollectionId, answer: Answer): ExplorerResult {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  if (!answer || answer.scope !== 'original' ||
      !validPage(answer.pageFilter)) throw new Error('Invalid collection answer scope.');
  const sources = new Set<Passage>(doc.corpus.passages);
  if (answer.citations.some(citation => !sources.has(citation))) throw new CollectionError('source');
  const result = searchAllQuestionMatches(doc.index, answer);
  if (result.hits.length !== answer.matchedCounts.original) throw new Error('Collection answer does not match the current index.');
  return result;
}
