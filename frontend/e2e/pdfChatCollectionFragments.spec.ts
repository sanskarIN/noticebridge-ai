import { expect, test } from '@playwright/test';
import { admitCollectionDocument, type CollectionDocument } from '../src/pdfChatCollection';
import type { Passage } from '../src/pdfChatCore';
import { collectionPageFragments, filterCollectionFragments, collectionFragmentPage,
  selectedFragmentListPage } from '../src/pdfChatCollectionFragments';

function source(page: number, ordinal: number, text: string, x = 40, y = 700): Passage {
  return { role: 'original', page, ordinal, text, position: { x0: x, x1: x + 100, y, height: 12 } };
}
async function add(docs: CollectionDocument[], name: string, rows: Passage[]) {
  return admitCollectionDocument(docs, new File([name], name + '.pdf'), new AbortController().signal,
    async () => ({ passages: rows, pageCount: 3, processedPages: 2, missingPages: [2], limited: true, limitedPages: [] }));
}
test('page browser uses exact source object and never joins other documents or pages', async () => {
  const a = await add([], 'a', [source(1,1,'first',40,700),source(1,2,'second',40,685),
    source(1,3,'right column',300,670),source(1,5,'gap',40,655)]);
  const b = await add([a], 'b', [source(1,1,'first')]);
  const selected = a.corpus.passages[1];
  const result = collectionPageFragments([a,b],a.id,1,selected);
  expect(result.fragments.map(row=>row.relationship)).toEqual(['nearby_same_flow','selected','other_fragment','other_fragment']);
  expect(result.fragments[1].source).toBe(selected);
  expect(()=>collectionPageFragments([a,b],b.id,1,selected)).toThrow();
  expect(()=>collectionPageFragments([a,b],a.id,2,selected)).toThrow();
  expect(()=>collectionPageFragments([a,b],a.id,1,{...selected})).toThrow();
  expect(collectionPageFragments([a,b],b.id,1).fragments.map(row=>row.source)).toEqual(b.corpus.passages);
});
test('blank and unindexed pages are visible as distinct coverage states', async () => {
  const a = await add([], 'a', [source(1,1,'text')]);
  expect(collectionPageFragments([a],a.id,2)).toMatchObject({coverage:'no_indexed_text',fragments:[]});
  expect(collectionPageFragments([a],a.id,3)).toMatchObject({coverage:'not_indexed',fragments:[]});
  for(const page of [0,4,NaN,1.5]) expect(()=>collectionPageFragments([a],a.id,page)).toThrow();
});
test('filter and pagination retain exact source objects and the selected page', async () => {
  const a = await add([], 'a', Array.from({length:35},(_,i)=>source(1,i+1,'Text '+(i+1),40,700-i*15)));
  const rows = collectionPageFragments([a],a.id,1,a.corpus.passages[20]).fragments;
  expect(selectedFragmentListPage(rows)).toBe(2);
  expect(collectionFragmentPage(rows,3)).toMatchObject({first:33,last:35,pages:3});
  const filtered = filterCollectionFragments(rows,{text:' TEXT 21 ',nearbyOnly:true});
  expect(filtered.map(row=>row.source)).toEqual([a.corpus.passages[20]]);
  expect(selectedFragmentListPage(filtered)).toBe(1);
  expect(()=>filterCollectionFragments(rows,{text:'x'.repeat(121),nearbyOnly:false})).toThrow();
  expect(()=>collectionFragmentPage(rows,4)).toThrow();
});

test('missing geometry never earns a geometry-supported neighbor label', async () => {
  const a = await add([], 'a', [
    { role: 'original', page: 1, ordinal: 1, text: 'no coordinates' },
    source(1,2,'selected',40,685),
    { role: 'original', page: 1, ordinal: 3, text: 'no coordinates either' },
  ]);
  expect(collectionPageFragments([a], a.id, 1, a.corpus.passages[1]).fragments.map(row => row.relationship))
    .toEqual(['other_fragment', 'selected', 'other_fragment']);
});
