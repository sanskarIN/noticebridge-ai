import { pageCoverage, type PageCoverage, type Role } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';

type PhysicalPageStatus = Exclude<PageCoverage, 'not_present'>;
export const MAX_COVERAGE_LIST_PAGES = 80;
export type PageFilter = 'all' | 'attention' | PhysicalPageStatus;
export type PageDescription = {
  role: Role;
  page: number;
  status: PhysicalPageStatus;
  fragments: number;
};
export const pageStatusLabels: Record<PhysicalPageStatus, string> = {
  some_text: 'Some indexed text',
  no_indexed_text: 'No indexed text',
  limited: 'Partial indexing',
  not_indexed: 'Not indexed',
};

/** Count exact indexed fragments, never infer page completeness from a count. */
export function describePages(corpora: ChatCorpora): PageDescription[] {
  const output: PageDescription[] = [];
  for (const role of ['original', 'revised'] as const) {
    const corpus = corpora[role];
    if (!corpus) continue;
    if (!Number.isSafeInteger(corpus.pageCount) || corpus.pageCount < 1) {
      throw new Error('Invalid physical PDF page count.');
    }
    const counts = new Map<number, number>();
    for (const passage of corpus.passages) {
      if (passage.role !== role || !Number.isSafeInteger(passage.page) ||
          passage.page < 1 || passage.page > corpus.pageCount) continue;
      counts.set(passage.page, (counts.get(passage.page) ?? 0) + 1);
    }
    for (let page = 1; page <= Math.min(corpus.pageCount, MAX_COVERAGE_LIST_PAGES); page++) {
      const status = pageCoverage(corpus, page);
      if (status === 'not_present') continue;
      output.push({ role, page, status, fragments: counts.get(page) ?? 0 });
    }
  }
  return output;
}

/** Validate a direct manual jump independently of the native index limit. */
export function manualPageNumber(text: string, pageCount: number): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(text.trim())) return null;
  const page = Number(text);
  return Number.isSafeInteger(page) && Number.isSafeInteger(pageCount) && page <= pageCount ? page : null;
}
