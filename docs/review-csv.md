# Exporting reviewed NoticeBridge findings as CSV

NoticeBridge AI has two local browser exports: the full structured JSON report
and a compact CSV with one row per finding. Both are exported only after a
comparison; neither is transmitted to an additional export service.

## Review CSV usage

1. Compare two PDFs. Check the source excerpts against each PDF.
2. Use source-text search and the category, finding status and checklist
   status filters to locate a finding. Mark the review checkbox beside its
   citations after you have reviewed the evidence. Use the coverage panel to
   inspect pages without extracted text.
3. Choose **Export review CSV** (Hindi: **समीक्षा CSV डाउनलोड करें**). The file
   is called `noticebridge-review.csv` and opens in standard spreadsheet apps.
4. Preserve the original/revised PDFs if you need to reproduce the evidence:
   the CSV contains SHA-256 fingerprints and quotations, not the full files.

Each row contains finding ID, category/status, whether the user's review box
was selected, whether human verification is still required, a separate issuer
authority flag, English/Hindi summaries, original/revised file names,
SHA-256 digests, page numbers, extraction methods and source excerpts.
Intra-document contradictions retain their additional citations in the
`supporting_evidence_json` column. Review instructions are exported in both
languages. The final columns record text extraction coverage and whether the
fuzzy matching budget skipped candidates. Exports include every finding and its
review state across all filters and pages.

**Never interpret `review_checkbox_selected=yes` as approval by an issuer.**
The prototype does not establish authenticity, effective amendment order,
legal deadlines or an applicant's eligibility. If a source was processed with
OCR, verify its transcription before taking action.

## Spreadsheet and privacy protections

The CSV uses quoted, quote-escaped cells and UTF-8 BOM for Hindi display.
Because PDF content is untrusted, cells beginning with spreadsheet formula
syntax (including after whitespace) receive a leading text apostrophe. This
reduces common CSV formula-injection risks when opening the file in spreadsheet
applications. It is not a guarantee against every spreadsheet parser or
copy/paste workflow. Avoid enabling macros or external content on imported data.

The CSV may include sensitive personal data contained in the PDFs. Store it
with the same protections as the source documents and delete unneeded copies.

## Resume a checklist

Use **Export evidence report (JSON)** to save a review session. After a reload,
compare the same two PDFs in the same order with the same options. Choose
**Restore checklist from JSON** and select the saved report. The browser reads
the file locally, checks both document fingerprints, and verifies each selected
finding against the current comparison. Saved selections are added to the
current checklist. The current comparison supplies all source evidence.

The review controls live in `frontend/src/ReviewFindings.tsx` and CSV
serialization in `frontend/src/exportCsv.ts`. Browser coverage includes
filtering, pagination, source preview, checklist restoration, formula
neutralization, Hindi export and mobile layout.
