import { expect, test } from '@playwright/test';
import { admitCollectionDocument, runCollectionStep, type CollectionDocument } from '../src/pdfChatCollection';
import { collectionFieldMatrix, collectionFieldPage, collectionQuestionEvidence, filterCollectionFields,
  parseCollectionEvidencePage, searchCollectionEvidence, selectedCollectionDocuments } from '../src/pdfChatCollectionTools';
import { explorerPage, highlightedSegments } from '../src/pdfChatEvidenceExplorer';
import type { Corpus, Passage } from '../src/pdfChatCore';

async function add(docs: CollectionDocument[], name: string, lines: string[], options: Partial<Corpus> = {}) {
  const passages = lines.map((text, i): Passage => ({ role: 'original', page: 1, ordinal: i + 1, text }));
  return admitCollectionDocument(docs, new File([name], name + '.pdf'), new AbortController().signal,
    async () => ({ passages, pageCount: 1, processedPages: 1, missingPages: lines.length ? [] : [1],
      limited: false, limitedPages: [], ...options }));
}
async function fixture() {
  const a = await add([], 'a', ['Application fee: INR 500', 'Application deadline: 19 December 2026',
    'Clause 4.2(a): Fee exceptions', 'Eligibility: Class 12']);
  const b = await add([a], 'b', ['Application charges: INR 350', 'Application deadline: 19 December 2026',
    'See Clause 4.2(a).', 'Clause 4.20: Different provision', 'Eligibility: Class 12']);
  const c = await add([a, b], 'c', ['Application fee: INR 350', 'Application fee: INR 200', 'Other information']);
  return [a, b, c];
}
const ids = (docs: CollectionDocument[]) => docs.map(doc => doc.id);

test('matrix groups known aliases while preserving conflicting literal values per document', async () => {
  const docs = await fixture();
  const fields = collectionFieldMatrix(docs, ids(docs));
  const fee = fields.find(field => field.definition.id === 'application_fee')!;
  expect(fee.status).toBe('multiple_values_within_document');
  expect(fee.multipleValueDocuments).toBe(1);
  expect(fee.sides.map(side => side.distinctValues)).toEqual([1, 1, 2]);
  expect(fee.sides.map(side => side.values.map(value => value.value))).toEqual([
    ['INR 500'], ['INR 350'], ['INR 350', 'INR 200'],
  ]);
  expect(fee.sides[1].values[0].citations[0].label).toBe('Application charges');
  expect(fee.sides[1].values[0].citations[0].source).toBe(docs[1].corpus.passages[0]);
});
test('same, different and missing literal statuses are distinct and never designate authority', async () => {
  const docs = await fixture();
  const two = collectionFieldMatrix(docs, ids(docs.slice(0, 2)));
  expect(two.find(field => field.definition.id === 'application_fee')?.status).toBe('different_literal_values');
  expect(two.find(field => field.definition.id === 'application_deadline')?.status).toBe('same_literal_value');
  expect(two.find(field => field.definition.id === 'eligibility')?.status).toBe('same_literal_value');
  const three = collectionFieldMatrix(docs, ids(docs));
  expect(three.find(field => field.definition.id === 'application_deadline')?.status).toBe('missing_in_selected_documents');
  expect(three.find(field => field.definition.id === 'application_deadline')?.missingDocuments).toBe(1);
  expect(collectionFieldMatrix(docs, [docs[0].id]).every(field => field.status === 'one_document')).toBe(true);
  expect(filterCollectionFields(two, 'review', '').map(field => field.definition.id)).toEqual(['application_fee']);
});
test('blank and limited sources remain visible in every recognized field row', async () => {
  const a = await add([], 'a', ['Eligibility: Class 12']);
  const b = await add([a], 'b', [], { pageCount: 3, processedPages: 1, limited: true });
  const field = collectionFieldMatrix([a, b], [a.id, b.id])[0];
  expect(field.missingDocuments).toBe(1);
  expect(field.sides[1]).toMatchObject({ documentId: b.id, distinctValues: 0, values: [],
    coverage: { pageCount: 3, processedPages: 1, missingPages: [1], limited: true } });
});
test('matrix displays bounded values and citations without hiding total distinct values', async () => {
  const lines = Array.from({ length: 7 }, (_, i) => 'Application fee: INR ' + (i + 1))
    .concat(Array(5).fill('Application fee: INR 1'));
  const a = await add([], 'a', lines);
  const field = collectionFieldMatrix([a], [a.id])[0];
  expect(field.sides[0].distinctValues).toBe(7);
  expect(field.sides[0].values).toHaveLength(4);
  expect(field.sides[0].values[0].occurrences).toBe(6);
  expect(field.sides[0].values[0].citations).toHaveLength(3);
});
test('field filtering uses only field labels and aliases, and paging never drops source rows', async () => {
  const docs = await fixture();
  const fields = collectionFieldMatrix(docs, ids(docs));
  expect(filterCollectionFields(fields, 'all', 'charges').map(field => field.definition.id)).toEqual(['application_fee']);
  expect(filterCollectionFields(fields, 'all', 'INR 500')).toEqual([]);
  expect(filterCollectionFields(fields, 'all', ' ELIGIBILITY ')).toHaveLength(1);
  expect(collectionFieldPage(fields, 1).rows).toEqual(fields);
  expect(collectionFieldPage([], 1)).toMatchObject({ rows: [], first: 0, last: 0, pages: 1 });
  expect(() => collectionFieldPage(fields, 2)).toThrow();
  expect(() => filterCollectionFields(fields, 'all', 'a'.repeat(101))).toThrow();
});
test('selection rejects duplicates and unknown fingerprints and preserves explicit order', async () => {
  const docs = await fixture();
  expect(selectedCollectionDocuments(docs, [docs[2].id, docs[0].id])).toEqual([docs[2], docs[0]]);
  for (const selection of [[], [docs[0].id, docs[0].id], ['f'.repeat(64)]]) {
    expect(() => selectedCollectionDocuments(docs, selection)).toThrow();
    expect(() => collectionFieldMatrix(docs, selection)).toThrow();
  }
});
test('literal evidence preserves exact original offsets and never fuses document results', async () => {
  const a = await add([], 'a', ['😀 Fee: INR 500; Fee: INR 350']);
  const b = await add([a], 'b', ['FEE: INR 200']);
  const result = searchCollectionEvidence([a, b], {
    mode: 'literal', text: 'fee', documentIds: [b.id, a.id], ignoreAsciiCase: true,
  });
  expect(result.sides.map(side => side.documentId)).toEqual([b.id, a.id]);
  expect(result.total).toBe(2);
  const hit = result.sides[1].hits[0];
  expect(hit.source).toBe(a.corpus.passages[0]);
  expect(highlightedSegments(hit.source.text, hit.ranges).filter(segment => segment.match).map(segment => segment.text))
    .toEqual(['Fee', 'Fee']);
  expect(hit.ranges[0].start).toBe(3);
  expect(searchCollectionEvidence([a, b], {
    mode: 'literal', text: 'fee', documentIds: [a.id, b.id], ignoreAsciiCase: false,
  }).total).toBe(0);
});
test('reference search distinguishes explicit mentions and near-identical identifiers', async () => {
  const docs = await fixture();
  const result = searchCollectionEvidence(docs, {
    mode: 'reference', text: 'Clause 4.2(a)', documentIds: ids(docs), ignoreAsciiCase: true,
  });
  expect(result.total).toBe(2);
  expect(result.sides.map(side => side.hits.length)).toEqual([1, 1, 0]);
  expect(result.sides[0].hits[0].startsWithReference).toBe(true);
  expect(result.sides[1].hits[0].startsWithReference).toBe(false);
  expect(result.sides[1].hits[0].source.text).toBe('See Clause 4.2(a).');
});
test('page-specific literal matches do not substitute from another page or document', async () => {
  const a = await add([], 'a', ['Fee']);
  const b = await add([a], 'b', ['Fee'], { pageCount: 3, processedPages: 1, limited: true });
  const docs = [a, b];
  const result = searchCollectionEvidence(docs, {
    mode: 'literal', text: 'Fee', documentIds: ids(docs), ignoreAsciiCase: false, page: 2,
  });
  expect(result.total).toBe(0);
  expect(result.sides.map(side => side.coverage.pageState)).toEqual(['not_present', 'not_indexed']);
});
test('invalid literal, reference and page syntax never becomes an unconstrained query', async () => {
  const docs = await fixture();
  for (const page of [0, 81, NaN, Infinity, 1.5]) {
    expect(() => searchCollectionEvidence(docs, { mode: 'literal', text: 'Fee',
      documentIds: ids(docs), ignoreAsciiCase: false, page })).toThrow();
  }
  for (const value of ['0', '01', '1-2', '81', '1e1', '1.5', '1/2']) {
    expect(() => parseCollectionEvidencePage(value)).toThrow();
  }
  expect(parseCollectionEvidencePage('')).toBeUndefined();
  expect(parseCollectionEvidencePage(' 80 ')).toBe(80);
  expect(() => searchCollectionEvidence(docs, {
    mode: 'literal', text: ' ', documentIds: ids(docs), ignoreAsciiCase: false,
  })).toThrow();
  expect(() => searchCollectionEvidence(docs, {
    mode: 'reference', text: 'Clause 4.2(a) or 5', documentIds: ids(docs), ignoreAsciiCase: false,
  })).toThrow();
});
test('all strict question matches can be reconstructed independently of display limit', async () => {
  const a = await add([], 'a', Array.from({ length: 17 }, (_, i) => 'Application fee: INR ' + i));
  const b = await add([a], 'b', ['Application fee: INR 999']);
  const turn = runCollectionStep([a, b], { question: 'Application fee?', documentIds: [a.id], includeContext: true });
  const answer = turn.results[0].parts[0].answer;
  expect(answer.citations).toHaveLength(4);
  expect(answer.matchedCounts.original).toBe(17);
  const expanded = collectionQuestionEvidence([a, b], a.id, answer);
  expect(expanded.hits).toHaveLength(17);
  expect(explorerPage(expanded.hits, 2).hits).toHaveLength(5);
  expect(() => collectionQuestionEvidence([a, b], b.id, answer)).toThrow();
  expect(() => collectionQuestionEvidence([a, b], a.id, { ...answer, matchedCounts: { original: 16, revised: 0 } })).toThrow();
});
test('contextual fallback is not promoted to strict evidence expansion', async () => {
  const a = await add([], 'a', ['Rural applicants', 'Residence certificate']);
  const turn = runCollectionStep([a], { question: 'rural residence certificate', documentIds: [a.id], includeContext: true });
  const answer = turn.results[0].parts[0].answer;
  expect(answer.citations).toHaveLength(2);
  expect(answer.matchedCounts.original).toBe(0);
  expect(collectionQuestionEvidence([a], a.id, answer).hits).toEqual([]);
});
