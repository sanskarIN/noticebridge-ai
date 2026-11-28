import { expect, test } from '@playwright/test';
import { admitCollectionDocument, runCollectionStep, type CollectionDocument } from '../src/pdfChatCollection';
import { collectionPageDescriptions, filterCollectionPages, collectionPageList, resolveCollectionPage,
  collectionTableInventory, collectionTableAnswer, collectionTableQuestion, inspectCollectionTableSource,
  isCollectionTableQuestion } from '../src/pdfChatCollectionLayout';
import type { Corpus, Passage } from '../src/pdfChatCore';

type Cell = { text: string; x: number; y: number };
const table: Cell[] = [
  { text: 'Category', x: 40, y: 700 },
  { text: 'Application fee', x: 200, y: 700 },
  { text: 'General', x: 40, y: 670 },
  { text: 'INR 500', x: 200, y: 670 },
  { text: 'Reserved', x: 40, y: 640 },
  { text: 'INR 250', x: 200, y: 640 },
];
function positioned(cells: Cell[], page = 1): Passage[] {
  return cells.map((cell, i) => ({ role: 'original', page, ordinal: i + 1, text: cell.text,
    position: { x0: cell.x, x1: cell.x + cell.text.length * 5, y: cell.y, height: 12 } }));
}
async function add(docs: CollectionDocument[], name: string, passages: Passage[], extra: Partial<Corpus> = {}) {
  return admitCollectionDocument(docs, new File([name], name + '.pdf'), new AbortController().signal,
    async () => ({ passages, pageCount: 1, processedPages: 1, missingPages: passages.length ? [] : [1],
      limited: false, limitedPages: [], ...extra }));
}
test('page navigator retains blank, partial and unindexed pages per document', async () => {
  const a = await add([], 'a', positioned(table), { pageCount: 100, processedPages: 3,
    limited: true, limitedPages: [3], missingPages: [2, 3] });
  const b = await add([a], 'b', []);
  const rows = collectionPageDescriptions([a, b], a.id);
  expect(rows).toHaveLength(80);
  expect(rows.slice(0, 4).map(row => [row.page, row.status, row.fragments])).toEqual([
    [1, 'some_text', 6], [2, 'no_indexed_text', 0], [3, 'limited', 0], [4, 'not_indexed', 0],
  ]);
  expect(rows.every(row => row.documentId === a.id)).toBe(true);
  expect(collectionPageDescriptions([a, b], b.id)).toEqual([
    { documentId: b.id, page: 1, status: 'no_indexed_text', fragments: 0 },
  ]);
  expect(filterCollectionPages(rows, 'attention')).toHaveLength(79);
  expect(filterCollectionPages(rows, 'not_indexed')).toHaveLength(77);
  expect(collectionPageList(rows, 5).rows).toEqual(rows.slice(64));
  expect(collectionPageList([], 1)).toEqual({ rows: [], pages: 1, first: 0, last: 0 });
  expect(() => collectionPageList(rows, 6)).toThrow();
});
test('manual navigation validates the actual PDF, not the 80 page text-search cap', async () => {
  const a = await add([], 'a', [], { pageCount: 100, processedPages: 1, limited: true });
  const b = await add([a], 'b', []);
  expect(resolveCollectionPage([a, b], a.id, ' 100 ')).toEqual({ documentId: a.id, file: a.file, page: 100 });
  expect(() => resolveCollectionPage([a, b], b.id, '100')).toThrow();
  for (const value of ['0', '01', '1.5', '101', '1e1', '1-2', '-1', '9999999999999999'])
    expect(() => resolveCollectionPage([a, b], a.id, value)).toThrow();
});
test('table inventory retains separate document identity even with identical physical locations', async () => {
  const a = await add([], 'a', positioned(table));
  const b = await add([a], 'b', positioned(table.map(cell => cell.text === 'INR 500' ? { ...cell, text: 'INR 350' } : cell)));
  const rows = collectionTableInventory([a, b], [b.id, a.id]);
  expect(rows.map(row => row.documentId)).toEqual([b.id, a.id]);
  expect(rows.map(row => row.tables.length)).toEqual([1, 1]);
  expect(rows[0].tables[0].key).not.toBe(rows[1].tables[0].key);
  const first = rows[1].tables[0];
  expect(inspectCollectionTableSource([a, b], a.id, first.key, first.table.rows[0][1]).file).toBe(a.file);
  expect(() => inspectCollectionTableSource([a, b], b.id, first.key, first.table.rows[0][1])).toThrow();
  expect(() => inspectCollectionTableSource([a, b], a.id, first.key, { ...first.table.rows[0][1] })).toThrow();
});
test('table candidates remain independent of the strict baseline and of other documents', async () => {
  const a = await add([], 'a', positioned(table));
  const b = await add([a], 'b', positioned(table.map(cell => cell.text === 'INR 500' ? { ...cell, text: 'INR 350' } : cell)));
  const docs = [a, b];
  const turn = runCollectionStep(docs, { question: 'Application fee for General on page 1?', documentIds: [a.id, b.id], includeContext: false });
  const answers = turn.results.map(row => row.parts[0].answer);
  const old = JSON.stringify(answers);
  expect(answers.every(isCollectionTableQuestion)).toBe(true);
  expect(answers.map((answer, index) => collectionTableAnswer(docs, docs[index].id, answer).result?.matches[0].value.text))
    .toEqual(['INR 500', 'INR 350']);
  expect(JSON.stringify(answers)).toBe(old);
  const missing = runCollectionStep(docs, { question: 'Application fee for General on page 2?', documentIds: [a.id], includeContext: false });
  expect(collectionTableAnswer(docs, a.id, missing.results[0].parts[0].answer).result).toBeNull();
});
test('partial tables and separate PDFs cannot establish a combined row', async () => {
  const a = await add([], 'a', positioned(table.slice(0, 4)));
  const b = await add([a], 'b', positioned(table.slice(4)));
  const c = await add([a, b], 'c', positioned(table), { limited: true, limitedPages: [1] });
  const sides = collectionTableInventory([a, b, c], [a.id, b.id, c.id]);
  expect(sides.every(side => side.tables.length === 0)).toBe(true);
  expect(sides[2].skippedPages).toEqual([1]);
});
test('guided table questions retain the exact page, category, field and document', async () => {
  const a = await add([], 'a', positioned(table, 2), { pageCount: 2, processedPages: 2, missingPages: [1] });
  const candidate = collectionTableInventory([a], [a.id])[0].tables[0];
  expect(collectionTableQuestion([a], a.id, candidate.key, 1, 1)).toBe('Application fee for Reserved on page 2?');
  expect(collectionTableQuestion([a], a.id, candidate.key, 1, 0)).toBeNull();
  expect(collectionTableQuestion([a], a.id, candidate.key, 999, 1)).toBeNull();
  expect(() => collectionTableQuestion([a], a.id, 'unknown', 1, 1)).toThrow();
});
