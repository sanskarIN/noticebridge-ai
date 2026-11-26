import { expect, test } from '@playwright/test';
import { isLocalChatOrigin, localChatRequest, readBoundedJson } from '../src/pdfChatLocalTransport';
import { localOcrPages, requestLocalOcr } from '../src/pdfChatLocalOcr';

const ORIGIN = 'http://127.0.0.1:5173';
const signal = () => new AbortController().signal;
const pin = 'a'.repeat(64);
const source = new File(['fixture'], 'private-file.pdf', { type: 'application/pdf' });
const report = {
  format: 'noticebridge-chat-ocr-review', version: 1, source_sha256: pin,
  role: 'original', page_count: 4,
  pages: [
    { page: 1, status: 'ok', lines: [{ ordinal: 1, text: 'Application fee: INR 500 😀' }] },
    { page: 3, status: 'empty', lines: [] },
  ],
};
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

test('local origin allowlist is exact and rejects hosted, opaque and misleading hosts', () => {
  for (const origin of [ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:8000', 'http://localhost:8000']) {
    expect(isLocalChatOrigin(origin)).toBe(true);
  }
  for (const origin of ['https://example.com', 'http://localhost.example.com:5173',
    'http://127.0.0.1:4173', 'http://localhost:9000', 'null', '', 'https://localhost:5173']) {
    expect(isLocalChatOrigin(origin)).toBe(false);
  }
});
test('fixed loopback request uses no credentials or redirects and exact header', async () => {
  const body = new FormData();
  const fetcher: typeof fetch = async (url, options) => {
    expect(url).toBe('/api/chat/ocr');
    expect(options?.method).toBe('POST');
    expect(options?.credentials).toBe('omit');
    expect(options?.redirect).toBe('error');
    expect(options?.cache).toBe('no-store');
    expect(new Headers(options?.headers).get('X-NoticeBridge-Local-OCR')).toBe('1');
    expect(options?.body).toBe(body);
    return new Response('{"fixture":true}', { headers: { 'Content-Type': 'application/json' } });
  };
  expect(await localChatRequest('ocr', body, signal(), ORIGIN, fetcher)).toBe('{"fixture":true}');
});
test('hosted origin is rejected before any fetch', async () => {
  const never: typeof fetch = async () => { throw new Error('unexpected fetch'); };
  await expect(localChatRequest('ocr', new FormData(), signal(), 'https://example.com', never))
    .rejects.toThrow('restricted');
});
test('bounded response reader rejects status, content-type, invalid encoding and oversized streams', async () => {
  await expect(readBoundedJson(new Response('bad', { status: 503 }), 100)).rejects.toThrow();
  await expect(readBoundedJson(new Response('bad', { headers: { 'Content-Type': 'text/html' } }), 100)).rejects.toThrow();
  await expect(readBoundedJson(new Response('bad', { headers: {
    'Content-Type': 'application/json', 'Content-Length': '1000',
  } }), 100)).rejects.toThrow();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(60));
      controller.enqueue(new Uint8Array(60));
      controller.close();
    },
  });
  await expect(readBoundedJson(new Response(stream, { headers: { 'Content-Type': 'application/json' } }), 100)).rejects.toThrow();
  await expect(readBoundedJson(new Response(new Uint8Array([0xff]), {
    headers: { 'Content-Type': 'application/json' },
  }), 100)).rejects.toThrow();
});
test('explicit local page selection is bounded, sorted and deduplicated', () => {
  expect(localOcrPages('3,1,2-4,3', 4)).toEqual([1, 2, 3, 4]);
  for (const text of ['', '0', '4-1', '1,', '1e1', '1.5', '5', '1–2']) {
    expect(() => localOcrPages(text, 4)).toThrow();
  }
  expect(() => localOcrPages('1-13', 80)).toThrow();
  expect(() => localOcrPages('1', 81)).toThrow();
});
test('OCR result must bind to the requested source, exact pages and page count', async () => {
  const result = await requestLocalOcr(source, 'original', [1, 3], 4, { original: pin }, signal(), true,
    async (service, body) => {
      expect(service).toBe('ocr');
      expect(body.get('role')).toBe('original');
      expect(body.get('pages')).toBe('1,3');
      expect(body.get('consent')).toBe('true');
      expect((body.get('source') as File).name).toBe('source.pdf');
      return encode(report);
    });
  expect(result.pages[0].lines[0].text).toBe('Application fee: INR 500 😀');
  for (const value of [{ ...report, source_sha256: 'b'.repeat(64) },
    { ...report, page_count: 5 }, { ...report, pages: [report.pages[0]] }, { ...report, role: 'revised' }]) {
    await expect(requestLocalOcr(source, 'original', [1, 3], 4, { original: pin }, signal(), true,
      async () => encode(value))).rejects.toThrow();
  }
});
test('no consent or malformed selection cannot invoke the transport', async () => {
  const never = async () => { throw new Error('unexpected transport'); };
  await expect(requestLocalOcr(source, 'original', [1, 3], 4, { original: pin }, signal(), false, never))
    .rejects.toThrow('Invalid local OCR');
  await expect(requestLocalOcr(source, 'original', [3, 1], 4, { original: pin }, signal(), true, never))
    .rejects.toThrow('Invalid local OCR');
});
