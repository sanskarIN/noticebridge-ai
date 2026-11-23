# OCR and evidence provenance (engineering milestone 3)

## Goal

Allow the reviewer to compare scanned official notices without pretending OCR text is automatically correct or that a PDF's upload position proves its authority. All processing is local to the deployed backend; no hosted vision or AI model is called.

## How it works

1. `enable_ocr` defaults to `false` on `POST /api/compare` and in the web UI.
2. PyMuPDF first extracts native text from each page. If a page has text, OCR is skipped to avoid duplicates.
3. For a native-text-empty page, opt-in OCR uses `get_textpage_ocr(language="eng+hin", dpi=150, full=True)` with the locally installed Tesseract data, then retrieves the resulting TextPage with `page.get_text(..., textpage=...)`.
4. OCR is capped at 12 attempted pages **per PDF** and 16 million estimated pixels per page. Pages not scanned or not successfully extracted are identified in `warnings` rather than silently treated as empty notices.
5. Every `Evidence` records `extraction_method`, `page`, `bbox`, `page_width`, `page_height`, and `page_rotation`, and each `DocumentSummary` contains `sha256` and `ocr_page_count`. OCR-derived matches are `possible_change` at most, regardless of text similarity. Structured OCR date/fee deltas are `uncertain` even when they parse syntactically; OCR-derived dates do not establish contradictions.
6. The UI labels OCR text, displays the original PDF via local PDF.js rendering, and overlays a source bbox on unrotated pages. Rotated pages are shown without a potentially misleading overlay.

This is a **transcription aid**, not issuer authentication or complete document understanding. OCR may misread punctuation, numbers, text direction, Hindi characters, or image layers. The hash identifies the exact input bytes, not its authenticity. A user should verify important facts against the issuing organization.

## Local setup

Install the Tesseract command and language data `eng` and `hin` on the host running the API. Check `tesseract --list-langs`. PyMuPDF discovers Tessdata; if the data directory is not automatically discovered, configure the Tesseract environment for your host (e.g., `TESSDATA_PREFIX`) before starting the API. OCR is fully optional; the no-OCR API path requires no Tesseract installation.

Use the `Enable local OCR` checkbox in the frontend, or supply multipart `enable_ocr=true` to the API. This does **not** make the API safe for untrusted public deployment: PyMuPDF and Tesseract still run inside the API process, without an enforceable per-page CPU timeout. Production needs parser sandboxing and per-request worker process limits.

## Verification matrix

| Test | Expected result |
| --- | --- |
| No OCR opt-in, scanned PDF | Warn about no extractable text; never invent data |
| OCR opt-in, valid English image-only PDF | Transcribed passage with page coordinates and OCR method |
| OCR opt-in, Tesseract unavailable | Warning; no fabricated text |
| OCR opt-in, page exceeds size/page budget | Warning and partial comparison |
| Native text with OCR opt-in | Keep native text and provenance; don't OCR it |
| OCR-derived date differs | Possible change with both raw passages, not confirmed change |
| OCR-derived conflicting deadlines | Do not assert verified contradiction |
| Rotated page in browser viewer | Display page, omit inaccurate bbox highlight |
| Any uploaded PDF | SHA-256 fingerprint of exact submitted bytes |

## Privacy caveat

Uploads are request-scoped, but Starlette multipart handling may spool large uploads to temporary OS files. Do not describe the service as strictly in-memory or completely disk-free. Public hosting requires secured temporary storage, data retention policy, and explicit disclosures.
