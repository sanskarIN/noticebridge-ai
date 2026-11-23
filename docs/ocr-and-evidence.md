# OCR and evidence provenance

NoticeBridge can transcribe scanned pages and pages with garbled or incomplete
embedded text. OCR runs on the backend with locally installed Tesseract
English and Hindi data.

## Choose pages to recover

- **Enable local OCR for scanned pages** runs OCR automatically on pages
  where native extraction found no text.
- **Recover text on selected pages with OCR** accepts one-based PDF page
  numbers and inclusive ranges, such as `1, 3–5`. Hindi digits such as
  `१, ३–५` work too. Use the page number shown in the PDF viewer. Selected
  pages use the rendered page as their text source, even when the PDF
  also contains an embedded text layer.
- Selected pages reserve places within the shared limit of 12 OCR attempts
  per PDF. A page must also fit within the 16-million-pixel render budget.
  When recovery yields no text, or the page exceeds the budget, coverage
  marks that page as uncovered and the reviewer can open it directly.

An operator can choose page-specific recovery independently of automatic
OCR for scanned pages. On `POST /api/compare`, use `enable_ocr=true` for
automatic scanning and `original_ocr_pages` or `revised_ocr_pages` for
page selections. Both selection fields are optional multipart strings.
Each document summary includes `ocr_override_pages` (selected pages) and
`ocr_pages` (pages that yielded usable OCR text).

## How the evidence is handled

PyMuPDF renders the displayed page at 150 DPI with RGB color. Tesseract
transcribes that image through `Pixmap.pdfocr_tobytes`. NoticeBridge maps
the extracted boxes back to unrotated source coordinates using the actual
page dimensions, including crop, rotation and PDF user-unit scaling.
[PyMuPDF OCR reference](https://pymupdf.readthedocs.io/en/latest/pixmap.html#Pixmap.pdfocr_tobytes)

Evidence links carry the extraction method, page, bounding box, dimensions
and rotation. The API checks evidence against the requested and transcribed
pages. OCR-derived matches remain possible changes and OCR dates and fees
remain uncertain even when their syntax is parseable. Inspect important
quotations against the PDF and the issuing authority.

Install Tesseract and check `tesseract --list-langs` for `eng` and `hin`.
Set `TESSDATA_PREFIX` if PyMuPDF cannot discover the language data. The
disposable worker enforces a wall-clock time limit, and OCR requests get the
OCR worker budget. The automated suite covers corrupted character mappings,
rotation and source geometry, unavailable OCR, and skipped pages.
