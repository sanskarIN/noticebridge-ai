# Exporting reviewed NoticeBridge findings as CSV

NoticeBridge AI has two local browser exports: the full structured JSON report
and a compact CSV with one row per finding. Both are exported only after a
comparison; neither is transmitted to an additional export service.

## Review CSV usage

1. Compare two PDFs. Check the source excerpts against each PDF.
2. Select checklist boxes for the items you have **reviewed**. Checked is not
   an assertion that the issuing organization has verified a statement.
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
languages.

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
The app does not keep a durable review history: browser checkboxes reset on
reload, and saving the CSV/JSON is a user action.

Relevant code: `frontend/src/exportCsv.ts`, `frontend/src/App.tsx`.
Browser tests cover reviewed CSV content, formula neutralization, Hindi export
and mobile viewport behavior. There is no server-side spreadsheet processing.
