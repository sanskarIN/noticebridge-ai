"""Extract bounded, page-linked PDF evidence with optional local OCR."""

import hashlib
import math
import re
from dataclasses import dataclass

import pymupdf as fitz

from .image_coverage import has_unchecked_image
from .models import DocumentSummary, Evidence, ExtractedLine
from .table_rows import join_ruled_value_rows

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_PAGES = 80
MAX_EXTRACTED_LINES = 12000
MAX_LINE_CHARACTERS = 5000
MAX_TOTAL_CHARACTERS = 1_000_000
MAX_OCR_PAGES = 12
MAX_OCR_RENDER_PIXELS = 16_000_000
OCR_DPI = 150
OCR_LANGUAGES = "eng+hin"
MAX_OCR_SELECTION_LENGTH = 160
PAGE_RANGE = re.compile(r"(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?")
NATIVE_TEXT_FLAGS = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES


class InvalidDocument(ValueError):
    """The input cannot be processed within the configured prototype limits."""


def validate_ocr_pages(selection: object) -> tuple[int, ...]:
    """Validate the normalized selection crossing the worker boundary."""
    if not isinstance(selection, (list, tuple)) or len(selection) > MAX_OCR_PAGES:
        raise InvalidDocument(f"Select at most {MAX_OCR_PAGES} OCR pages per PDF")
    if any(type(page) is not int or not 1 <= page <= MAX_PAGES for page in selection):
        raise InvalidDocument(f"OCR page numbers must be between 1 and {MAX_PAGES}")
    if len(set(selection)) != len(selection):
        raise InvalidDocument("OCR page numbers must be unique")
    return tuple(sorted(selection))


def parse_ocr_selection(value: str) -> tuple[int, ...]:
    """Parse PDF page numbers and inclusive ranges, including Hindi digits."""
    if len(value) > MAX_OCR_SELECTION_LENGTH:
        raise InvalidDocument("OCR page selection is too long")
    if not value.strip():
        return ()
    pages: set[int] = set()
    for part in value.split(","):
        span = PAGE_RANGE.fullmatch(part.strip())
        if not span:
            raise InvalidDocument("Enter OCR page numbers and ranges, such as 1, 3-5")
        start = int(span[1])
        end = int(span[2]) if span[2] else start
        if not 1 <= start <= end <= MAX_PAGES:
            raise InvalidDocument(f"OCR ranges must be ascending and within pages 1 to {MAX_PAGES}")
        pages.update(range(start, end + 1))
        if len(pages) > MAX_OCR_PAGES:
            raise InvalidDocument(f"Select at most {MAX_OCR_PAGES} OCR pages per PDF")
    return validate_ocr_pages(tuple(pages))


@dataclass(frozen=True)
class ExtractedDocument:
    summary: DocumentSummary
    lines: list[ExtractedLine]
    warnings: list[str]


def bbox_intersects_page(
    bbox: tuple[float, float, float, float], width: float, height: float, rotation: int,
) -> bool:
    """Text boxes use unrotated coordinates, even when the page is rotated."""
    if rotation in (90, 270):
        width, height = height, width
    x0, y0, x1, y1 = bbox
    return x1 > 0 and y1 > 0 and x0 < width and y0 < height


def _within_ocr_pixel_budget(rect: fitz.Rect) -> bool:
    width, height = rect.width * OCR_DPI / 72, rect.height * OCR_DPI / 72
    return (
        0 < width <= MAX_OCR_RENDER_PIXELS and 0 < height <= MAX_OCR_RENDER_PIXELS
        and math.ceil(width) * math.ceil(height) <= MAX_OCR_RENDER_PIXELS
    )


def _extract_ocr_dict(page: fitz.Page) -> dict:
    """Transcribe the rendered page and map its boxes to native source coordinates."""
    image = page.get_pixmap(dpi=OCR_DPI, colorspace=fitz.csRGB, alpha=False)
    payload = image.pdfocr_tobytes(compress=False, language=OCR_LANGUAGES)
    with fitz.open(stream=payload, filetype="pdf") as document:
        scanned = document[0]
        data = scanned.get_text("dict", flags=0, sort=True)
        rendered = fitz.Rect(0, 0, page.rect.width, page.rect.height)
        unrotate = fitz.Matrix(-page.rotation)
        # Calculate translation in scaled page points. A PDF's stored
        # derotation matrix can translate in unscaled /UserUnit coordinates.
        bounds = rendered * unrotate
        unrotate.e = -bounds.x0
        unrotate.f = -bounds.y0
        to_source = scanned.rect.torect(rendered) * unrotate
        for block in data.get("blocks", []):
            if block.get("type") == 0:
                for line in block.get("lines", []):
                    line["bbox"] = tuple(fitz.Rect(line["bbox"]) * to_source)
    return data


def extract_pdf(
    contents: bytes, *, document_id: str, filename: str, enable_ocr: bool = False,
    ocr_override_pages: tuple[int, ...] = (),
) -> ExtractedDocument:
    if not contents or len(contents) > MAX_UPLOAD_BYTES:
        raise InvalidDocument("PDF must be nonempty and at most 10 MiB")
    if not contents.lstrip().startswith(b"%PDF-"):
        raise InvalidDocument("File is not recognized as a PDF")
    if document_id not in ("original", "revised"):
        raise InvalidDocument("Invalid document role")
    requested_pages = validate_ocr_pages(ocr_override_pages)
    selected_pages = set(requested_pages)
    try:
        pdf = fitz.open(stream=contents, filetype="pdf")
    except (fitz.FileDataError, RuntimeError, ValueError) as exc:
        raise InvalidDocument("Malformed or unreadable PDF") from exc
    lines: list[ExtractedLine] = []
    warnings: list[str] = []
    pages_without_text: list[int] = []
    pages_with_unchecked_images: list[int] = []
    total_lines = 0
    total_characters = 0
    ocr_pages: list[int] = []
    automatic_ocr_slots = MAX_OCR_PAGES - len(selected_pages)
    automatic_ocr_attempts = 0
    try:
        if pdf.is_encrypted or pdf.needs_pass:
            raise InvalidDocument("Encrypted PDFs are not supported")
        if not 1 <= len(pdf) <= MAX_PAGES:
            raise InvalidDocument(f"PDF must contain 1 to {MAX_PAGES} pages")
        if requested_pages and requested_pages[-1] > len(pdf):
            raise InvalidDocument(
                f"OCR page {requested_pages[-1]} is outside the {document_id} PDF "
                f"({len(pdf)} pages)"
            )
        for index, page in enumerate(pdf):
            page_number = index + 1
            page_start = len(lines)
            page_lines = 0
            skipped_boxes = 0
            rect = page.rect
            width, height = round(float(rect.width), 2), round(float(rect.height), 2)
            rotation = page.rotation
            # The dict API normally copies image streams into each block, but
            # native text extraction does not consume them.
            # Explicit recovery pages bypass the native text layer completely.
            forced_ocr = page_number in selected_pages
            data = {} if forced_ocr else page.get_text("dict", flags=NATIVE_TEXT_FLAGS, sort=True)
            native_has_text = any(
                span.get("text", "").strip()
                for block in data.get("blocks", []) if block.get("type") == 0
                for line in block.get("lines", [])
                for span in line.get("spans", [])
            )
            method = "native"
            if forced_ocr or (enable_ocr and not native_has_text):
                if not forced_ocr and automatic_ocr_attempts >= automatic_ocr_slots:
                    warnings.append(
                        f"{document_id}: page {page_number} was not OCR-scanned: "
                        f"per-document OCR limit of {MAX_OCR_PAGES} pages reached"
                    )
                elif not _within_ocr_pixel_budget(rect):
                    warnings.append(
                        f"{document_id}: page {page_number} was not OCR-scanned: "
                        "page would exceed OCR pixel limit"
                    )
                else:
                    if not forced_ocr:
                        automatic_ocr_attempts += 1
                    try:
                        data = _extract_ocr_dict(page)
                        method = "ocr"
                    except (RuntimeError, ValueError, OSError) as exc:
                        # OCR packs and Tesseract are not present on all hosts.
                        # Don't return guessed or unverified text as evidence.
                        warnings.append(
                            f"{document_id}: page {page_number} OCR unavailable "
                            f"({type(exc).__name__}); install Tesseract eng+hin language data"
                        )
            for block in data.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for rawline in block.get("lines", []):
                    spans = rawline.get("spans", [])
                    text = " ".join(s.get("text", "").strip() for s in spans).strip()
                    if not text:
                        continue
                    if len(text) > MAX_LINE_CHARACTERS:
                        raise InvalidDocument("PDF contains an excessively long text line")
                    total_lines += 1
                    if total_lines > MAX_EXTRACTED_LINES:
                        raise InvalidDocument("PDF contains too many text lines")
                    total_characters += len(text)
                    if total_characters > MAX_TOTAL_CHARACTERS:
                        raise InvalidDocument("PDF contains too much extractable text")
                    box = tuple(round(float(c), 2) for c in (rawline.get("bbox") or ()))
                    if (
                        len(box) != 4 or not all(math.isfinite(c) for c in box)
                        or box[0] >= box[2] or box[1] >= box[3]
                        or not bbox_intersects_page(box, width, height, rotation)
                    ):
                        skipped_boxes += 1
                        continue
                    evidence = Evidence(
                        document_id=document_id,
                        filename=filename,
                        page=page_number,
                        text=text,
                        bbox=box,
                        extraction_method=method,
                        page_width=width,
                        page_height=height,
                        page_rotation=rotation,
                    )
                    lines.append(ExtractedLine(text=text, evidence=evidence))
                    page_lines += 1
            if method == "native" and not skipped_boxes and page_lines >= 2:
                lines[page_start:] = join_ruled_value_rows(
                    page, lines[page_start:], max_quote_length=MAX_LINE_CHARACTERS,
                )
            if method == "ocr" and page_lines:
                ocr_pages.append(page_number)
            elif page_lines and has_unchecked_image(page, lines[page_start:]):
                pages_with_unchecked_images.append(page_number)
            if skipped_boxes:
                warnings.append(
                    f"{document_id}: page {page_number} omitted {skipped_boxes} text line(s) "
                    "with invalid source coordinates"
                )
            if page_lines == 0:
                pages_without_text.append(page_number)
                explanation = (
                    "comparison may be incomplete"
                    if enable_ocr or forced_ocr else "OCR not enabled"
                )
                warnings.append(
                    f"{document_id}: page {page_number} has no extractable text; {explanation}"
                )
        if ocr_pages:
            warnings.append(
                f"{document_id}: {len(ocr_pages)} page(s) used machine OCR; "
                "transcription can be inaccurate and needs manual checking"
            )
    finally:
        pdf.close()
    return ExtractedDocument(
        summary=DocumentSummary(
            id=document_id,
            filename=filename,
            page_count=index + 1,
            line_count=len(lines),
            has_extractable_text=bool(lines),
            sha256=hashlib.sha256(contents).hexdigest(),
            ocr_page_count=len(ocr_pages),
            ocr_pages=ocr_pages,
            ocr_override_pages=list(requested_pages),
            pages_with_text=index + 1 - len(pages_without_text),
            pages_without_text=pages_without_text,
            pages_with_unchecked_images=pages_with_unchecked_images,
        ),
        lines=lines,
        warnings=warnings,
    )
