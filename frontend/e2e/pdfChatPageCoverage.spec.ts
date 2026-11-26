import { expect, test } from '@playwright/test';
import type { Corpus } from '../src/pdfChatCore';
import { describePages } from '../src/pdfChatPageCoverage';

test('page inventory includes missing, partially indexed, and unprocessed pages', () => {
  const corpus: Corpus = {
    passages: [
      { role: 'original', page: 1, ordinal: 1, text: 'Fee' },
      { role: 'original', page: 3, ordinal: 1, text: 'Partial text' },
      { role: 'original', page: 3, ordinal: 2, text: 'More text' },
    ],
    pageCount: 5, processedPages: 3, missingPages: [2], limitedPages: [3], limited: true,
  };
  expect(describePages({ original: corpus })).toEqual([
    { role: 'original', page: 1, status: 'some_text', fragments: 1 },
    { role: 'original', page: 2, status: 'no_indexed_text', fragments: 0 },
    { role: 'original', page: 3, status: 'limited', fragments: 2 },
    { role: 'original', page: 4, status: 'not_indexed', fragments: 0 },
    { role: 'original', page: 5, status: 'not_indexed', fragments: 0 },
  ]);
});
test('page inventory keeps roles separate and does not invent absent sources', () => {
  const corpus: Corpus = {
    passages: [{ role: 'revised', page: 1, ordinal: 1, text: 'Text' }],
    pageCount: 1, processedPages: 1, missingPages: [], limitedPages: [], limited: false,
  };
  expect(describePages({ revised: corpus })).toEqual([
    { role: 'revised', page: 1, status: 'some_text', fragments: 1 },
  ]);
  expect(describePages({})).toEqual([]);
  expect(() => describePages({ revised: { ...corpus, pageCount: 81 } })).toThrow();
});
