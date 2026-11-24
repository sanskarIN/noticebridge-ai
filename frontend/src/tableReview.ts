import type { DocumentRole, Report } from './comparison';

// A table warning is a review prompt, never proof of official authority.
const TABLE_WARNING = new RegExp(
  '^(original|revised): page ([1-9][0-9]{0,2}) contains an earlier/revised ' +
  '(date|fee|time|date-and-time) table; both printed values are retained, ' +
  'verify the column headings$',
);
export type RevisionTableKind = 'date' | 'fee' | 'time' | 'date-and-time';
export type RevisionTableReview = {
  role: DocumentRole;
  filename: string;
  page: number;
  kind: RevisionTableKind;
};

export function revisionTableReviews(report: Report): RevisionTableReview[] {
  const documents = new Map(report.documents.map(document => [document.id, document]));
  const found: RevisionTableReview[] = [];
  const seen = new Set<string>();

  for (const warning of report.warnings) {
    const match = TABLE_WARNING.exec(warning);
    if (!match) continue;
    const role = match[1] as DocumentRole;
    const page = Number(match[2]);
    const kind = match[3] as RevisionTableKind;
    const document = documents.get(role);
    if (!document || page > document.page_count ||
        document.pages_without_text.includes(page) ||
        document.ocr_pages?.includes(page)) continue;
    const key = `${role}:${page}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ role, page, kind, filename: document.filename });
  }
  return found;
}
