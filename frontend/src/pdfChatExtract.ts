import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Corpus, Passage, Role } from './pdfChatCore';
import { NativePageAssembler, MAX_NATIVE_DOCUMENT_CHARS, MAX_NATIVE_DOCUMENT_ITEMS,
  MAX_NATIVE_DOCUMENT_PASSAGES, MAX_NATIVE_PAGE_ITEMS } from './pdfChatNativeText';

GlobalWorkerOptions.workerSrc = workerUrl;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 80;
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
  let timedOut = false;
  const cancel = () => { void task.destroy().catch(() => {}); };
  const timer = window.setTimeout(() => { timedOut = true; cancel(); }, MAX_TIME);
  const active = () => {
    signal.throwIfAborted();
    if (timedOut) throw new Error('Local PDF extraction timed out.');
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    active();
    const pdf = await task.promise;
    active();
    const passages: Passage[] = [];
    const missingPages: number[] = [];
    const limitedPages: number[] = [];
    let processedPages = 0;
    let chars = 0;
    let items = 0;
    let limited = pdf.numPages > MAX_PAGES;
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, MAX_PAGES); pageNumber++) {
      active();
      const page = await pdf.getPage(pageNumber);
      const assembler = new NativePageAssembler(role, pageNumber, {
        chars: MAX_NATIVE_DOCUMENT_CHARS - chars,
        passages: MAX_NATIVE_DOCUMENT_PASSAGES - passages.length,
        items: Math.min(MAX_NATIVE_PAGE_ITEMS, MAX_NATIVE_DOCUMENT_ITEMS - items),
      });
      const reader = page.streamTextContent().getReader();
      let complete = false;
      try {
        reading: for (;;) {
          active();
          const { done, value } = await reader.read();
          active();
          if (done) { complete = true; break; }
          for (const item of value.items) {
            if (!assembler.push(item)) break reading;
          }
        }
        const result = assembler.finish(complete);
        passages.push(...result.passages);
        chars += result.chars;
        items += result.items;
        if (!result.passages.length) missingPages.push(pageNumber);
        if (result.limited) {
          limitedPages.push(pageNumber);
          limited = true;
        }
        processedPages = pageNumber;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      active();
      if (chars >= MAX_NATIVE_DOCUMENT_CHARS || passages.length >= MAX_NATIVE_DOCUMENT_PASSAGES ||
          items >= MAX_NATIVE_DOCUMENT_ITEMS) {
        if (pageNumber < pdf.numPages) limited = true;
        break;
      }
    }
    active();
    return { passages, missingPages, limited, pageCount: pdf.numPages, processedPages, limitedPages };
  } catch {
    signal.throwIfAborted();
    throw new Error('Unable to index the PDF within local processing limits.');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    await task.destroy().catch(() => {});
  }
}
