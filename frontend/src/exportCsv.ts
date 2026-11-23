/**
 * Portable, local-only human review export.
 *
 * Untrusted PDF quotations can start with spreadsheet formula syntax.
 * Quote RFC-4180 fields AND prefix risky cells with a text apostrophe:
 * CSV escaping alone is not sufficient against spreadsheet formula injection.
 */
type SourceEvidence = {
  document_id: 'original' | 'revised';
  page: number;
  text: string;
  filename: string;
  extraction_method: 'native' | 'ocr';
};

type ReviewFinding = {
  id: string;
  category: string;
  status: string;
  summary_en: string;
  summary_hi: string;
  original: SourceEvidence | null;
  revised: SourceEvidence | null;
  supporting_evidence: SourceEvidence[];
  authority_verified: boolean;
};

export type ReviewCsvReport = {
  documents: { id: string; sha256: string }[];
  findings: ReviewFinding[];
  checklist: {
    finding_id: string;
    description_en: string;
    description_hi: string;
    requires_human_verification: boolean;
  }[];
};

const HEADERS = [
  'finding_id', 'category', 'finding_status', 'review_checkbox_selected',
  'human_verification_required', 'issuer_authority_verified',
  'summary_en', 'summary_hi',
  'original_sha256', 'original_filename', 'original_page',
  'original_extraction_method', 'original_source_quote',
  'revised_sha256', 'revised_filename', 'revised_page',
  'revised_extraction_method', 'revised_source_quote',
  'supporting_evidence_json', 'review_instruction_en', 'review_instruction_hi',
] as const;

function safeCsvField(value: string | number | boolean | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Includes whitespace before formula starters: spreadsheet apps may trim.
  // Prefix with apostrophe before quoting to force display as inert text.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function serializeReviewCsv(report: ReviewCsvReport, checked: string[]): string {
  const hashes = new Map(report.documents.map(document => [document.id, document.sha256]));
  const checklist = new Map(report.checklist.map(item => [item.finding_id, item]));
  const reviewedIds = new Set(checked);
  const rows = report.findings.map(finding => {
    const task = checklist.get(finding.id);
    const original = finding.original;
    const revised = finding.revised;
    const supplementary = finding.supporting_evidence.map(evidence => ({
      document_id: evidence.document_id,
      filename: evidence.filename,
      page: evidence.page,
      extraction_method: evidence.extraction_method,
      text: evidence.text,
      sha256: hashes.get(evidence.document_id) ?? '',
    }));
    return [
      finding.id,
      finding.category,
      finding.status,
      reviewedIds.has(finding.id) ? 'yes' : 'no',
      task?.requires_human_verification ? 'yes' : 'no',
      // This is never an assertion that the "revised" upload is authoritative.
      finding.authority_verified ? 'yes' : 'no',
      finding.summary_en,
      finding.summary_hi,
      original ? hashes.get('original') ?? '' : '',
      original?.filename ?? '',
      original?.page ?? '',
      original?.extraction_method ?? '',
      original?.text ?? '',
      revised ? hashes.get('revised') ?? '' : '',
      revised?.filename ?? '',
      revised?.page ?? '',
      revised?.extraction_method ?? '',
      revised?.text ?? '',
      JSON.stringify(supplementary),
      task?.description_en ?? '',
      task?.description_hi ?? '',
    ];
  });
  // UTF-8 BOM helps desktop spreadsheet applications display Hindi text.
  return '\uFEFF' + [HEADERS, ...rows]
    .map(row => row.map(safeCsvField).join(','))
    .join('\r\n') + '\r\n';
}
