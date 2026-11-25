import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { MAX_PASSAGE_CHARS, MAX_PASSAGES, type Corpus, type Passage, type Role } from './pdfChatCore';

GlobalWorkerOptions.workerSrc = workerUrl;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 80;
const MAX_CHARS = 800_000;
const MAX_TIME = 30_000;
const MAX_ITEMS = 80_000;

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
      const reader = page.streamTextContent().getReader();
      let line = '';
      const before = passages.length;
      let ordinal = 0;
      let items = 0;
      let oversized = false;
      let previous: { x: number; y: number; width: number; height: number } | null = null;
      function flush() {
        const text = line.trim();
        line = '';
        previous = null;
        if (oversized) {
          ordinal++; // Preserve the gap; contextual retrieval must not bridge omitted text.
          oversized = false;
          limited = true;
          return;
        }
        if (!text) return;
        ordinal++;
        if (chars + text.length > MAX_CHARS || passages.length >= MAX_PASSAGES / 2) {
          limited = true;
          return;
        }
        chars += text.length;
        passages.push({ role, page: pageNumber, text, ordinal });
      }
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (++items > MAX_ITEMS) {
              limited = true;
              break;
            }
            if (!('str' in item)) continue;
            const [,,,, x, y] = item.transform;
            const height = Math.max(1, Math.abs(item.height));
            // Split widely separated fragments, rows and reverse-direction
            // jumps. This reduces accidental column stitching; it does not
            // establish reliable table semantics or reading order.
            if (previous && (Math.abs(y - previous.y) > Math.max(height, previous.height) * 0.55 ||
                x < previous.x - height || x - (previous.x + previous.width) > height * 4)) flush();
            if (!oversized) {
              const gap = previous ? x - (previous.x + previous.width) : 0;
              const separator = line && gap > height * 0.15 && !/\s$/.test(line) && !/^\s/.test(item.str)
                ? ' ' : '';
              if (line.length + separator.length + item.str.length > MAX_PASSAGE_CHARS) {
                oversized = true;
                line = '';
              } else line += separator + item.str;
            }
            previous = { x, y, width: item.width, height };
            if (item.hasEOL) flush();
          }
          if (items > MAX_ITEMS || chars >= MAX_CHARS || passages.length >= MAX_PASSAGES / 2) {
            limited = true;
            // A partially streamed line cannot be a complete source quote.
            line = '';
            oversized = false;
            break;
          }
        }
        flush();
        if (passages.length === before) missingPages.push(pageNumber);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
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
