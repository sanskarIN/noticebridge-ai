/** Imported machine transcription remains a separate, unverified review channel. */
import { buildIndex, type Answer, type Passage, type Role } from './pdfChatCore';
import { answerScopedQuestions } from './pdfChatInsights';
import type { SourcePins } from './pdfChatSession';

export const MAX_OCR_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 6000;
const MAX_TEXT = 800_000;
const FORMAT = 'noticebridge-chat-ocr-review';
type Status = 'ok' | 'empty' | 'unavailable' | 'limited';
export type OcrReview = {
  role: Role;
  source_sha256: string;
  page_count: number;
  pages: { page: number; status: Status; lines: { ordinal: number; text: string }[] }[];
};

function fail(): never { throw new Error('Invalid or mismatched OCR review report.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== keys.length ||
      !keys.every(key => Object.prototype.hasOwnProperty.call(raw, key))) fail();
  return raw;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function validStatus(value: unknown): value is Status {
  return value === 'ok' || value === 'empty' || value === 'unavailable' || value === 'limited';
}

export function parseOcrReview(text: string, pins: SourcePins, pageCounts: Partial<Record<Role, number>>): OcrReview {
  if (!text || text.length > MAX_OCR_REVIEW_BYTES ||
      new TextEncoder().encode(text).length > MAX_OCR_REVIEW_BYTES) fail();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(); }
  const raw = object(value, ['format', 'version', 'source_sha256', 'role', 'page_count', 'pages']);
  if (raw.format !== FORMAT || raw.version !== 1 ||
      (raw.role !== 'original' && raw.role !== 'revised') ||
      typeof raw.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.source_sha256) ||
      raw.source_sha256 !== pins[raw.role] || !integer(raw.page_count, 1, 80) ||
      raw.page_count !== pageCounts[raw.role] ||
      !Array.isArray(raw.pages) || !raw.pages.length || raw.pages.length > 12) fail();
  let priorPage = 0, total = 0, chars = 0;
  const pages: OcrReview['pages'] = [];
  for (const item of raw.pages) {
    const page = object(item, ['page', 'status', 'lines']);
    if (!integer(page.page, priorPage + 1, raw.page_count) || !validStatus(page.status) ||
        !Array.isArray(page.lines) || (page.status === 'ok' && !page.lines.length) ||
        ((page.status === 'empty' || page.status === 'unavailable') && page.lines.length)) fail();
    let ordinal = 0;
    const lines: OcrReview['pages'][number]['lines'] = [];
    for (const value of page.lines) {
      const row = object(value, ['ordinal', 'text']);
      if (!integer(row.ordinal, ordinal + 1, 100_000) || typeof row.text !== 'string' ||
          !row.text.trim() || row.text.length > 900 ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(row.text)) fail();
      ordinal = row.ordinal;
      if (++total > MAX_LINES || (chars += row.text.length) > MAX_TEXT) fail();
      lines.push({ ordinal, text: row.text });
    }
    priorPage = page.page;
    pages.push({ page: page.page, status: page.status, lines });
  }
  const result: OcrReview = { role: raw.role, source_sha256: raw.source_sha256, page_count: raw.page_count, pages };
  const canonical = JSON.stringify({
    format: FORMAT, version: 1, source_sha256: result.source_sha256,
    role: result.role, page_count: result.page_count, pages,
  }, null, 2) + '\n';
  if (text !== canonical) fail();
  return result;
}

export async function readOcrReview(file: File): Promise<string> {
  if (!file.size || file.size > MAX_OCR_REVIEW_BYTES) fail();
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_OCR_REVIEW_BYTES) fail();
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail(); }
}

/** Only original OCR lines are returned, never a synthesized printed field.
 * The native Answer is used only for the question, role and physical-page scope.
 */
export function searchOcrReviews(reviews: OcrReview[], answer: Answer): Passage[] {
  const roles: Role[] = answer.scope === 'both' ? ['original', 'revised'] : [answer.scope];
  const passages = reviews.filter(review => roles.includes(review.role)).flatMap(review =>
    review.pages.filter(page => answer.pageFilter === undefined || page.page === answer.pageFilter)
      .flatMap(page => page.lines.map(line => ({ role: review.role, page: page.page, ...line }))));
  const index = buildIndex(passages);
  // Use the strict existing lexical ranker without adjacent OCR grouping.
  const results = answerScopedQuestions(index, answer.question, answer.scope, roles, false);
  if (results.length !== 1) return [];
  return results[0].citations;
}
