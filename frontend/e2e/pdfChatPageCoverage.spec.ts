import { expect, test } from '@playwright/test';
import type { Corpus } from '../src/pdfChatCore';
import { describePages, manualPageNumber, MAX_COVERAGE_LIST_PAGES } from '../src/pdfChatPageCoverage';

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
  expect(() => describePages({ revised: { ...corpus, pageCount: 0 } })).toThrow();
});

test('large physical page counts do not allocate an unbounded page list', () => {
  const corpus: Corpus = {
    passages: [], pageCount: 100_000, processedPages: 80,
    missingPages: [1], limitedPages: [], limited: true,
  };
  const pages = describePages({ original: corpus });
  expect(pages).toHaveLength(MAX_COVERAGE_LIST_PAGES);
  expect(pages.at(-1)?.page).toBe(80);
  expect(manualPageNumber('100000', corpus.pageCount)).toBe(100000);
  expect(manualPageNumber('81', corpus.pageCount)).toBe(81);
  expect(manualPageNumber('100001', corpus.pageCount)).toBeNull();
});
test('manual physical-page jump rejects malformed or unsafe numeric input', () => {
  for (const value of ['', '0', '-1', '1e2', '1.5', '1-2', 'Infinity', '9007199254740992']) {
    expect(manualPageNumber(value, 100)).toBeNull();
  }
  expect(manualPageNumber(' 4 ', 100)).toBe(4);
});
