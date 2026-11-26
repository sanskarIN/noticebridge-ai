import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { answerScopedQuestions } from '../src/pdfChatInsights';
import { buildIndex } from '../src/pdfChatCore';
import { parseOcrReview, searchOcrReviews, MAX_OCR_REVIEW_BYTES } from '../src/pdfChatOcrReview';

const pins = { original: 'a'.repeat(64), revised: 'b'.repeat(64) };
const counts = { original: 3, revised: 3 };
const raw = {
  format: 'noticebridge-chat-ocr-review', version: 1, source_sha256: pins.original,
  role: 'original', page_count: 3,
  pages: [{ page: 2, status: 'ok', lines: [{ ordinal: 1, text: 'Application fee: Rs. 500' }] }],
};
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const review = parseOcrReview(encode(raw), pins, counts);
const empty = buildIndex([]);

test('OCR review matches exact original source without changing native abstention', () => {
  const answer = answerScopedQuestions(empty, 'Application fee?', 'original', ['original'])[0];
  expect(answer.kind).toBe('insufficient');
  expect(searchOcrReviews([review], answer)).toEqual([
    { role: 'original', page: 2, ordinal: 1, text: 'Application fee: Rs. 500' },
  ]);
  expect(answer.citations).toEqual([]);
});
test('OCR respects source and physical page filters', () => {
  for (const question of ['Application fee in revised notice?', 'Application fee on page 1?']) {
    const answer = answerScopedQuestions(empty, question, 'auto', ['original', 'revised'])[0];
    expect(searchOcrReviews([review], answer)).toEqual([]);
  }
  const answer = answerScopedQuestions(empty, 'Application fee on page 2?', 'original', ['original'])[0];
  expect(searchOcrReviews([review], answer)).toHaveLength(1);
});
test('OCR import requires matching source bytes and physical page count', () => {
  expect(() => parseOcrReview(encode(raw), { original: pins.revised }, counts)).toThrow();
  expect(() => parseOcrReview(encode(raw), pins, { original: 2 })).toThrow();
});
test('invalid OCR wire metadata and noncanonical representations are rejected', () => {
  for (const changed of [
    { ...raw, role: 'revised' }, { ...raw, version: true }, { ...raw, extra: true },
    { ...raw, pages: [{ ...raw.pages[0], page: 4 }] },
    { ...raw, pages: [{ ...raw.pages[0], status: 'unavailable' }] },
    { ...raw, pages: [{ ...raw.pages[0], lines: [{ ordinal: 1, text: 'x'.repeat(901) }] }] },
    { ...raw, pages: [...raw.pages, ...raw.pages] },
  ]) expect(() => parseOcrReview(encode(changed), pins, counts)).toThrow();
  expect(() => parseOcrReview(encode(raw).trim(), pins, counts)).toThrow();
  expect(() => parseOcrReview(encode(raw).replace('"version": 1,', '"version": 1, "version": 1,'), pins, counts)).toThrow();
  expect(() => parseOcrReview('x'.repeat(MAX_OCR_REVIEW_BYTES + 1), pins, counts)).toThrow();
});
test('limited selected page preserves available lines without claiming full coverage', () => {
  const result = parseOcrReview(encode({ ...raw, pages: [{ ...raw.pages[0], status: 'limited' }] }), pins, counts);
  expect(result.pages[0].status).toBe('limited');
  expect(result.pages[0].lines).toHaveLength(1);
});

test('Python report encoding round-trips through the strict browser parser', () => {
  // This is a wire interoperability test, not a live OCR accuracy claim.
  // Python is installed in the browser CI job for the live API tests.
  const data = execFileSync(process.env.PYTHON || 'python', ['-c', [
    'from noticebridge.chat_ocr_protocol import encode_report',
    'import json, sys',
    'sys.stdout.buffer.write(encode_report(json.load(sys.stdin)))',
  ].join('\n')], {
    input: JSON.stringify({ ...raw, pages: [{ ...raw.pages[0], lines: [
      { ordinal: 1, text: 'Fee: ₹500 — “fictional”' },
      { ordinal: 3, text: 'Proof: café and 😀' },
    ] }] }),
    maxBuffer: MAX_OCR_REVIEW_BYTES,
  }).toString('utf8');
  const parsed = parseOcrReview(data, pins, counts);
  expect(parsed.pages[0].lines.map(line => line.text)).toEqual([
    'Fee: ₹500 — “fictional”', 'Proof: café and 😀',
  ]);
});
