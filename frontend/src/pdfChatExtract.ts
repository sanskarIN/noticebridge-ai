import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { MAX_PASSAGE_CHARS, MAX_PASSAGES, type Corpus, type Passage, type Role } from './pdfChatCore';

GlobalWorkerOptions.workerSrc = workerUrl;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 80;
const MAX_CHARS = 800_000;
const MAX_TIME = 30_000;

export async function readPdf(file: File, role: Role, signal: AbortSignal): Promise<Corpus> {
  if (!file.name.toLowerCase().endsWith('.pdf') || !file.size || file.size > MAX_PDF_BYTES) {
    throw new Error('Select a nonempty PDF up to 10 MiB.');
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  if (bytes.length !== file.size || bytes.length > MAX_PDF_BYTES) throw new Error('Invalid file.');
  const task = getDocument({ data: bytes, isEvalSupported: false, disableAutoFetch: true, disableStream: true });
  const cancel = () => { void task.destroy().catch(() => {}); };
  const timer = window.setTimeout(cancel, MAX_TIME);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const pdf = await task.promise;
    const passages: Passage[] = [];
    const missingPages: number[] = [];
    let chars = 0;
    let limited = pdf.numPages > MAX_PAGES;
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, MAX_PAGES); pageNumber++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let line = '';
      let before = passages.length;
      let ordinal = 0;
      function flush() {
        const text = line.trim();
        line = '';
        if (!text) return;
        // Do not truncate a passage in a way that could reverse its meaning.
        if (text.length > MAX_PASSAGE_CHARS || chars + text.length > MAX_CHARS ||
            passages.length >= MAX_PASSAGES / 2) {
          limited = true;
          return;
        }
        chars += text.length;
        passages.push({ role, page: pageNumber, text, ordinal: ++ordinal });
      }
      try {
        for (const item of content.items) {
          if (!('str' in item)) continue;
          if (line.length <= MAX_PASSAGE_CHARS) line += (line ? ' ' : '') + item.str;
          if (item.hasEOL) flush();
        }
        flush();
        if (passages.length === before) missingPages.push(pageNumber);
      } finally {
        page.cleanup();
      }
      if (chars >= MAX_CHARS || passages.length >= MAX_PASSAGES / 2) {
        limited = true;
        break;
      }
    }
    return { passages, missingPages, limited };
  } catch {
    signal.throwIfAborted();
    throw new Error('Unable to index the PDF within local processing limits.');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    await task.destroy().catch(() => {});
  }
}
