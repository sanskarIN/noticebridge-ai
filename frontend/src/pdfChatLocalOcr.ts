import type { Role } from './pdfChatCore';
import type { SourcePins } from './pdfChatSession';
import { localChatRequest } from './pdfChatLocalTransport';
import { parseOcrReview, type OcrReview } from './pdfChatOcrReview';

export const MAX_LOCAL_OCR_SELECTION = 120;
export const MAX_LOCAL_OCR_PAGES = 12;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
function invalid(): never { throw new Error('Invalid local OCR source or page selection.'); }

export function localOcrPages(text: string, pageCount: number): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 80 ||
      !text.trim() || text.length > MAX_LOCAL_OCR_SELECTION) invalid();
  const selected = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^([1-9][0-9]?)(?:\s*-\s*([1-9][0-9]?))?$/.exec(part.trim());
    if (!match) invalid();
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (first > last || last > pageCount) invalid();
    for (let page = first; page <= last; page++) {
      selected.add(page);
      if (selected.size > MAX_LOCAL_OCR_PAGES) invalid();
    }
  }
  return [...selected].sort((a, b) => a - b);
}

export async function requestLocalOcr(file: File, role: Role, pages: number[], pageCount: number,
  pins: SourcePins, signal: AbortSignal, consent: boolean,
  request = localChatRequest): Promise<OcrReview> {
  if (consent !== true || !['original', 'revised'].includes(role) || !file.size ||
      file.size > MAX_PDF_BYTES || !pins[role] || !pages.length ||
      pages.join(',') !== localOcrPages(pages.join(','), pageCount).join(',')) invalid();
  signal.throwIfAborted();
  const body = new FormData();
  body.append('source', file, 'source.pdf');
  body.append('role', role);
  body.append('pages', pages.join(','));
  body.append('consent', 'true');
  const text = await request('ocr', body, signal);
  signal.throwIfAborted();
  const result = parseOcrReview(text, pins, { [role]: pageCount });
  if (result.role !== role || result.pages.map(page => page.page).join(',') !== pages.join(',')) invalid();
  return result;
}
