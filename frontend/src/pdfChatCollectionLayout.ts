/** Bounded collection layout inspection. Each table/page is tied to an
 * individual document. This module never joins cells across PDFs. */
import { type Answer, type Passage, type Corpus } from './pdfChatCore';
import { collectionCitation, type CollectionDocument } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';
import { describePages, manualPageNumber, type PageDescription, type PageFilter } from './pdfChatPageCoverage';
import { answerCategoryTable, buildCategoryTables, tableCellQuestion, tableQuestion,
  type CategoryTable, type TableIndex, type TableAnswer } from './pdfChatTables';

export type CollectionPage = Omit<PageDescription, 'role'> & { documentId: string };
export const COLLECTION_PAGE_LIST_SIZE = 16;

export function collectionPageDescriptions(documents: readonly CollectionDocument[], documentId: string): CollectionPage[] {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  return describePages({ original: doc.corpus }).map(({ role: _role, ...page }) => ({ ...page, documentId }));
}
export function filterCollectionPages(rows: readonly CollectionPage[], filter: PageFilter): CollectionPage[] {
  if (filter === 'all') return [...rows];
  if (filter === 'attention') return rows.filter(row => row.status !== 'some_text');
  if (!['some_text', 'no_indexed_text', 'limited', 'not_indexed'].includes(filter)) throw new Error('Invalid page filter.');
  return rows.filter(row => row.status === filter);
}
export function collectionPageList(rows: readonly CollectionPage[], page: number) {
  const pages = Math.max(1, Math.ceil(rows.length / COLLECTION_PAGE_LIST_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error('Invalid page list position.');
  const offset = (page - 1) * COLLECTION_PAGE_LIST_SIZE;
  const selected = rows.slice(offset, offset + COLLECTION_PAGE_LIST_SIZE);
  return { rows: selected, pages, first: selected.length ? offset + 1 : 0, last: offset + selected.length };
}

/** Manual navigation has no native indexing-page restriction. */
export function resolveCollectionPage(documents: readonly CollectionDocument[], documentId: string, input: string) {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  const page = manualPageNumber(input, doc.corpus.pageCount);
  if (page === null) throw new Error('Invalid physical page for the selected collection PDF.');
  return { documentId, page, file: doc.file };
}

const indexes = new WeakMap<Corpus, TableIndex>();
function localTables(doc: CollectionDocument): TableIndex {
  const old = indexes.get(doc.corpus);
  if (old) return old;
  const index = buildCategoryTables(doc.corpus);
  indexes.set(doc.corpus, index);
  return index;
}
export type CollectionTable = { documentId: string; key: string; table: CategoryTable };
export type CollectionTableSide = {
  documentId: string;
  tables: CollectionTable[];
  skippedPages: number[];
  limited: boolean;
};
export function collectionTableKey(documentId: string, table: CategoryTable): string {
  return documentId + ':' + table.page + ':' + table.headers[0].ordinal;
}

export function collectionTableInventory(documents: readonly CollectionDocument[], selected: readonly string[]): CollectionTableSide[] {
  return selectedCollectionDocuments(documents, selected).map(doc => {
    const index = localTables(doc);
    return { documentId: doc.id, tables: index.tables.map(table => ({
      documentId: doc.id, key: collectionTableKey(doc.id, table), table,
    })), limited: index.limited, skippedPages: [...index.skippedPages] };
  });
}

/** Validate all four evidence fragments against the live collection, and
 * keep the layout proposal separate from the native baseline answer. */
export function collectionTableAnswer(documents: readonly CollectionDocument[], documentId: string, answer: Answer):
  { result: TableAnswer | null; skippedPages: number[]; limited: boolean } {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  if (answer.scope !== 'original') throw new Error('Invalid collection answer scope.');
  for (const source of answer.citations) collectionCitation(documents, documentId, source);
  const index = localTables(doc);
  const result = answerCategoryTable(index.tables, answer);
  for (const match of result?.matches ?? []) {
    for (const source of [match.categoryHeader, match.fieldHeader, match.category, match.value]) {
      collectionCitation(documents, documentId, source);
    }
  }
  return { result, skippedPages: [...index.skippedPages], limited: index.limited };
}

export function collectionTableQuestion(documents: readonly CollectionDocument[], documentId: string,
  key: string, row: number, column: number): string | null {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  const table = localTables(doc).tables.find(table => collectionTableKey(doc.id, table) === key);
  if (!table) throw new Error('Unknown collection table.');
  return tableCellQuestion(table, row, column);
}

export function isCollectionTableQuestion(answer: Answer): boolean {
  return answer.scope === 'original' && tableQuestion(answer) !== null;
}

/** Reject references that are not exact local table fragments. */
export function inspectCollectionTableSource(documents: readonly CollectionDocument[], documentId: string,
  key: string, source: Passage) {
  const [doc] = selectedCollectionDocuments(documents, [documentId]);
  const table = localTables(doc).tables.find(table => collectionTableKey(doc.id, table) === key);
  if (!table || ![...table.headers, ...table.rows.flat()].includes(source as CategoryTable['headers'][number])) {
    throw new Error('The source is not part of the selected table.');
  }
  return collectionCitation(documents, documentId, source);
}
