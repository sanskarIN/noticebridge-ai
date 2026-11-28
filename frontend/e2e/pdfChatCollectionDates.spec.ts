import { expect, test } from '@playwright/test';
import { admitCollectionDocument, type CollectionDocument } from '../src/pdfChatCollection';
import { collectionTimelines, collectionDates, collectionDateFields, collectionDateWindows,
  collectionDatePage, collectionDatePageFilter } from '../src/pdfChatCollectionDates';

async function add(docs: CollectionDocument[], name: string, lines: string[]) {
  return admitCollectionDocument(docs, new File([name], name + '.pdf'), new AbortController().signal,
    async () => ({ passages: lines.map((text, i) => ({ role: 'original' as const, page: 1, ordinal: i + 1, text })),
      pageCount: 1, processedPages: 1, missingPages: lines.length ? [] : [1], limited: false, limitedPages: [] }));
}
const filter = { kind: 'all', parse: 'all', order: 'chronological' } as const;
test('collection dates sort by calendar day without losing exact PDF source identity', async () => {
  const a = await add([], 'a', ['Application deadline: 20 December 2026']);
  const b = await add([a], 'b', ['Application deadline: 19 December 2026']);
  const c = await add([a, b], 'c', ['Application deadline: To be announced']);
  const sides = collectionTimelines([a, b, c], [a.id, b.id, c.id]);
  const rows = collectionDates(sides, filter);
  expect(rows.map(row => row.documentId)).toEqual([b.id, a.id, c.id]);
  expect(rows[0].occurrence.field.source).toBe(b.corpus.passages[0]);
  expect(collectionDates(sides, { ...filter, order: 'source' }).map(row => row.documentId)).toEqual([a.id,b.id,c.id]);
  expect(collectionDates(sides, { ...filter, parse: 'unparsed' }).map(row => row.documentId)).toEqual([c.id]);
  expect(collectionDates(sides, { ...filter, page: 2 })).toEqual([]);
});
test('calendar span is unsigned and withheld for missing, multiple or conditional values', async () => {
  const a = await add([], 'a', ['Application deadline: 20 December 2026']);
  const b = await add([a], 'b', ['Application deadline: 19 December 2026']);
  const c = await add([a, b], 'c', ['Application deadline: 18 December 2026', 'Application deadline: 19 December 2026']);
  const d = await add([a,b,c], 'd', ['Eligibility: Class 12']);
  const e = await add([a,b,c,d], 'e', ['Application deadline: 20 December 2026', 'Application deadline subject to approval']);
  const docs = [a,b,c,d,e];
  const field = (ids: string[]) => collectionDateFields(collectionTimelines(docs, ids)).find(row => row.id === 'application_deadline');
  expect(field([a.id,b.id])).toMatchObject({ state:'different_days',spanDays:1 });
  expect(field([b.id,a.id])).toMatchObject({ state:'different_days',spanDays:1 });
  expect(field([a.id])).toMatchObject({ state:'one_document',spanDays:null });
  expect(field([a.id,c.id])).toMatchObject({ state:'review_required',spanDays:null });
  expect(field([a.id,d.id])).toMatchObject({ state:'missing_label',spanDays:null });
  expect(field([a.id,e.id])).toMatchObject({ state:'review_required',spanDays:null });
});
test('window checks cannot combine an opening label from one PDF and closing label from another', async () => {
  const a = await add([], 'a', ['Application start date: 1 December 2026']);
  const b = await add([a], 'b', ['Application deadline: 20 December 2026']);
  const c = await add([a,b], 'c', ['Application start date: 20 December 2026','Application deadline: 1 December 2026']);
  const windows = collectionDateWindows(collectionTimelines([a,b,c],[a.id,b.id,c.id]));
  expect(windows.map(row => [row.documentId,row.outcome,row.differenceDays])).toEqual([
    [a.id,'missing_label',null],[b.id,'missing_label',null],[c.id,'reversed_printed_order',-19],
  ]);
});
test('date pagination and physical page grammar remain bounded', () => {
  expect(collectionDatePage([],1)).toMatchObject({rows:[],pages:1,first:0,last:0});
  expect(collectionDatePage(Array.from({length:25},(_,i)=>i),3)).toMatchObject({rows:[24],pages:3,first:25,last:25});
  for (const value of ['0','81','01','1-2','1e1','1.5']) expect(()=>collectionDatePageFilter(value)).toThrow();
  expect(collectionDatePageFilter(' 80 ')).toBe(80);
  expect(collectionDatePageFilter('')).toBeUndefined();
  expect(()=>collectionDatePage([],2)).toThrow();
});
