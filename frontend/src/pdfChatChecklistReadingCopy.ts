/** Human-readable derivatives of a replayed checklist. Never use these
 * derivatives as input evidence. The JSON report and snapshot remain primary.
 */
import { verifyChecklistReport, type VerifiedChecklist } from './pdfChatChecklistExchange';
import { parseCorpusSnapshot, type CorpusSnapshot } from './pdfChatCorpusSnapshot';
import type { ChecklistResult, ChecklistReview, ChecklistSourceResult } from './pdfChatChecklist';
import type { Role } from './pdfChatCore';

export const MAX_CHECKLIST_COPY_BYTES = 12 * 1024 * 1024;
export type ChecklistCopyFormat = 'html' | 'csv';
export type ChecklistCopy = { text: string; format: ChecklistCopyFormat; reportSha256: string };
const warning = 'Native text retrieval only. No match does not prove absence. Nearby fragments are not standalone answers. Review notes are personal annotations, not evidence. Official authority has not been verified.';
const labels: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };

async function sha(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 unavailable.');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function bounded(text: string): string {
  if (!text || text.length > MAX_CHECKLIST_COPY_BYTES ||
    new TextEncoder().encode(text).length > MAX_CHECKLIST_COPY_BYTES) throw new Error('Reading copy too large.');
  return text;
}
function escape(text: string | number): string {
  return String(text).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
/** CSV quotation is not sufficient to prevent spreadsheet formula execution.
 * Prefix cells whose compatibility-normalized text begins with a formula
 * marker, including after whitespace or formatting control characters.
 * This deliberately changes those cells in the derivative, never in evidence.
 */
export function safeChecklistCsvCell(value: string | number | boolean): string {
  let text = String(value);
  const probe = text.normalize('NFKC').replace(/^[\s\p{Cf}\p{Cc}]+/u, '');
  if (/^[=+\-@]/.test(probe) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function sourcePin(snapshot: CorpusSnapshot, role: Role): string {
  return snapshot.pins[role] ?? '';
}
function pageList(pages: number[]): string {
  return pages.length ? pages.join(', ') : 'None recorded';
}
function humanState(state: string): string { return state.replace(/_/g, ' '); }
function reviewFor(verified: VerifiedChecklist, id: string): ChecklistReview {
  const review = verified.reviews.find(row => row.id === id);
  if (!review) throw new Error('Missing replayed review.');
  return review;
}
const HEADERS = [
  'report_sha256', 'authority_verified', 'question_id', 'question', 'scope',
  'requested_physical_page', 'nearby_fallback', 'question_state', 'personal_review_status',
  'personal_note', 'source_role', 'source_sha256', 'source_state', 'source_coverage',
  'strict_matches', 'displayed_fragments', 'omitted_strict_matches',
  'citation_kind', 'context_group', 'physical_page', 'fragment_ordinal', 'native_text',
  'interpretation_warning',
] as const;
function sourceRow(result: ChecklistResult, review: ChecklistReview, source: ChecklistSourceResult,
  snapshot: CorpusSnapshot, reportSha256: string): (string | number | boolean)[] {
  return [
    reportSha256, false, result.item.id, result.item.question, result.item.scope,
    result.physicalPage ?? '', result.item.includeContext, result.state, review.status,
    review.note, source.role, sourcePin(snapshot, source.role), source.state, source.coverage,
    source.matchedCount, source.displayedCount, source.omittedStrictMatches,
  ];
}
function csv(verified: VerifiedChecklist, snapshot: CorpusSnapshot, reportSha256: string): string {
  const lines: string[] = [HEADERS.map(safeChecklistCsvCell).join(',')];
  for (const result of verified.results) {
    const review = reviewFor(verified, result.item.id);
    for (const source of result.sources) {
      const prefix = sourceRow(result, review, source, snapshot, reportSha256);
      if (!source.citations.length) {
        // A missing source or abstention must remain visible in tabular output.
        lines.push([...prefix, '', '', '', '', '', warning].map(safeChecklistCsvCell).join(','));
        continue;
      }
      for (const citation of source.citations) {
        lines.push([...prefix, citation.kind, citation.contextGroup ?? '', citation.source.page,
          citation.source.ordinal, citation.source.text, warning].map(safeChecklistCsvCell).join(','));
      }
    }
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
function sourceOverview(snapshot: CorpusSnapshot): string {
  return snapshot.attached.map(role => {
    const corpus = snapshot.corpora[role]!;
    return '<section><h3>' + escape(labels[role]) + '</h3><dl>' +
      '<dt>PDF SHA-256</dt><dd class="hash">' + escape(sourcePin(snapshot, role)) + '</dd>' +
      '<dt>Physical pages processed</dt><dd>' + corpus.processedPages + ' / ' + corpus.pageCount + '</dd>' +
      '<dt>Indexed fragments</dt><dd>' + corpus.passages.length + '</dd>' +
      '<dt>Missing text pages</dt><dd>' + escape(pageList(corpus.missingPages)) + '</dd>' +
      '<dt>Limited pages</dt><dd>' + escape(pageList(corpus.limitedPages)) + '</dd>' +
      '<dt>Extraction limited</dt><dd>' + (corpus.limited ? 'Yes' : 'Not flagged; completeness not established') +
      '</dd></dl></section>';
  }).join('');
}
function sourceHtml(source: ChecklistSourceResult): string {
  const citations = source.citations.map(citation =>
    '<figure><figcaption>Physical page ' + citation.source.page + ' · fragment ' + citation.source.ordinal +
    ' · ' + (citation.kind === 'strict' ? 'Strict match' : 'Nearby group ' + citation.contextGroup) +
    '</figcaption><blockquote>' + escape(citation.source.text) + '</blockquote></figure>').join('');
  return '<section class="source"><h4>' + escape(labels[source.role]) + '</h4>' +
    '<p><strong>' + escape(humanState(source.state)) + '</strong> · ' +
    escape(humanState(source.coverage)) + '</p><p>Strict matches: ' + source.matchedCount +
    ' · Displayed fragments: ' + source.displayedCount + ' · Omitted strict matches: ' +
    source.omittedStrictMatches + '</p>' +
    (source.state === 'context_leads' ? '<p>Nearby fragments collectively match terms; inspect the actual page.</p>' : '') +
    (citations || '<p>No native excerpt displayed for this source.</p>') + '</section>';
}
function questionHtml(result: ChecklistResult, review: ChecklistReview): string {
  return '<article><h3>' + escape(result.item.id) + ' · ' + escape(result.item.question) + '</h3>' +
    '<p>Scope: ' + escape(result.item.scope) + ' · ' +
    (result.physicalPage === null ? 'All indexed physical pages' : 'Physical page ' + result.physicalPage) +
    ' · ' + (result.item.includeContext ? 'Nearby fallback enabled' : 'Strict only') + '</p>' +
    '<p><strong>Retrieval state:</strong> ' + escape(humanState(result.state)) + '</p>' +
    result.sources.map(sourceHtml).join('') +
    '<section class="review"><h4>Personal review (not evidence)</h4><p>' +
    escape(humanState(review.status)) + '</p><p class="note">' +
    escape(review.note || 'No saved note') + '</p></section></article>';
}
function html(verified: VerifiedChecklist, snapshot: CorpusSnapshot, reportSha256: string): string {
  const summary = verified.summary;
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>NoticeBridge — private checklist reading copy</title><style>' +
    'body{font:16px/1.55 system-ui,sans-serif;color:#172032;background:#fff;max-width:900px;margin:2rem auto;padding:0 1.25rem}' +
    'h1,h2,h3,h4{line-height:1.3}h1{font-size:2rem}h2{border-bottom:1px solid #a9b4c4;padding-bottom:.4rem}' +
    '.warning{border:2px solid #53637b;padding:1rem;background:#f2f5f8}.hash{overflow-wrap:anywhere;font-family:monospace}' +
    'dl{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:.35rem 1rem}dt{font-weight:bold}dd{margin:0;min-width:0}' +
    'article{border-top:2px solid #a9b4c4;padding:1rem 0}.source,.review{border-left:3px solid #a9b4c4;padding-left:1rem;margin:1rem 0}' +
    'blockquote,.note{white-space:pre-wrap;overflow-wrap:anywhere;margin:.5rem 0;padding:.5rem;background:#f2f5f8}' +
    'figure{margin:1rem 0}figcaption{font-size:.9rem;color:#42516b}@media(max-width:520px){dl{display:block}dd{margin-bottom:.5rem}}' +
    '@media print{body{max-width:none;margin:0;padding:0;font-size:10pt}.source,figure{break-inside:avoid}h2,h3,h4{break-after:avoid}}' +
    '</style></head><body><header><h1>Private question checklist</h1><p class="warning">' + escape(warning) +
    '</p><p>Derived reading copy — not a signed or authoritative notice.</p><p>Canonical report SHA-256:</p><p class="hash">' +
    escape(reportSha256) + '</p></header><main><section><h2>Retrieval overview</h2><dl>' +
    '<dt>Questions</dt><dd>' + summary.questions + '</dd><dt>Native fragments displayed</dt><dd>' + summary.citations +
    '</dd><dt>Nearby fragments</dt><dd>' + summary.contextFragments + '</dd><dt>Matched all requested roles</dt><dd>' +
    summary.matchedAllRoles + '</dd><dt>Partial matches or context</dt><dd>' + summary.partialOrContext +
    '</dd><dt>No matches</dt><dd>' + summary.noMatch + '</dd><dt>Unavailable</dt><dd>' + summary.unavailable +
    '</dd><dt>Manually reviewed</dt><dd>' + summary.reviewed + '</dd><dt>Needs follow-up</dt><dd>' + summary.needsFollowup +
    '</dd></dl></section><section><h2>Source extraction coverage</h2>' + sourceOverview(snapshot) +
    '</section><section><h2>Question results</h2>' + verified.results.map(row => questionHtml(row,
      reviewFor(verified, row.item.id))).join('') + '</section></main></body></html>\n';
}
/** The only public rendering entry point verifies the report from the
 * independently supplied canonical snapshot before rendering any text.
 */
export async function prepareChecklistReadingCopy(reportText: string, snapshotText: string,
  format: ChecklistCopyFormat): Promise<ChecklistCopy> {
  if (format !== 'html' && format !== 'csv') throw new Error('Unsupported reading copy format.');
  const verified = await verifyChecklistReport(reportText, snapshotText);
  const snapshot = parseCorpusSnapshot(snapshotText);
  const reportSha256 = await sha(reportText);
  return { text: bounded(format === 'html' ? html(verified, snapshot, reportSha256)
    : csv(verified, snapshot, reportSha256)), format, reportSha256 };
}
