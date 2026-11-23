"""Extract bounded, page-linked PDF evidence with optional local OCR."""

import hashlib
import math
from dataclasses import dataclass

import pymupdf as fitz

from .models import DocumentSummary, Evidence, ExtractedLine

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_PAGES = 80
MAX_EXTRACTED_LINES = 12000
MAX_LINE_CHARACTERS = 5000
MAX_TOTAL_CHARACTERS = 1_000_000
MAX_OCR_PAGES = 12
MAX_OCR_RENDER_PIXELS = 16_000_000
OCR_DPI = 150
OCR_LANGUAGES = "eng+hin"
NATIVE_TEXT_FLAGS = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES


class InvalidDocument(ValueError):
    """The input cannot be processed within the configured prototype limits."""


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


def extract_pdf(
    contents: bytes, *, document_id: str, filename: str, enable_ocr: bool = False
) -> ExtractedDocument:
    if not contents or len(contents) > MAX_UPLOAD_BYTES:
        raise InvalidDocument("PDF must be nonempty and at most 10 MiB")
    if not contents.lstrip().startswith(b"%PDF-"):
        raise InvalidDocument("File is not recognized as a PDF")
    if document_id not in ("original", "revised"):
        raise InvalidDocument("Invalid document role")
    try:
        pdf = fitz.open(stream=contents, filetype="pdf")
    except (fitz.FileDataError, RuntimeError, ValueError) as exc:
        raise InvalidDocument("Malformed or unreadable PDF") from exc
    lines: list[ExtractedLine] = []
    warnings: list[str] = []
    pages_without_text: list[int] = []
    total_lines = 0
    total_characters = 0
    ocr_page_count = 0
    ocr_attempts = 0
    try:
        if pdf.is_encrypted or pdf.needs_pass:
            raise InvalidDocument("Encrypted PDFs are not supported")
        if not 1 <= len(pdf) <= MAX_PAGES:
            raise InvalidDocument(f"PDF must contain 1 to {MAX_PAGES} pages")
        for index, page in enumerate(pdf):
            page_number = index + 1
            page_lines = 0
            skipped_boxes = 0
            rect = page.rect
            width, height = round(float(rect.width), 2), round(float(rect.height), 2)
            rotation = page.rotation
            # Original text is always preferred. OCR only runs for pages with
            # no native text, avoiding duplicate lines and false certainty.
            # The dict API normally copies image streams into each block, but
            # native text extraction does not consume them.
            data = page.get_text("dict", flags=NATIVE_TEXT_FLAGS, sort=True)
            native_has_text = any(
                span.get("text", "").strip()
                for block in data.get("blocks", []) if block.get("type") == 0
                for line in block.get("lines", [])
                for span in line.get("spans", [])
            )
            method = "native"
            if not native_has_text and enable_ocr:
                if ocr_attempts >= MAX_OCR_PAGES:
                    warnings.append(
                        f"{document_id}: page {page_number} was not OCR-scanned: "
                        f"per-document OCR limit of {MAX_OCR_PAGES} pages reached"
                    )
                elif (
                    rect.width * rect.height * (OCR_DPI / 72) ** 2 > MAX_OCR_RENDER_PIXELS
                ):
                    warnings.append(
                        f"{document_id}: page {page_number} was not OCR-scanned: "
                        "page would exceed OCR pixel limit"
                    )
                else:
                    ocr_attempts += 1
                    try:
                        textpage = page.get_textpage_ocr(
                            language=OCR_LANGUAGES, dpi=OCR_DPI, full=True
                        )
                        data = page.get_text("dict", textpage=textpage, sort=True)
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
            if method == "ocr" and page_lines:
                ocr_page_count += 1
            if skipped_boxes:
                warnings.append(
                    f"{document_id}: page {page_number} omitted {skipped_boxes} text line(s) "
                    "with invalid source coordinates"
                )
            if page_lines == 0:
                pages_without_text.append(page_number)
                explanation = (
                    "OCR not enabled" if not enable_ocr else "comparison may be incomplete"
                )
                warnings.append(
                    f"{document_id}: page {page_number} has no extractable text; {explanation}"
                )
        if ocr_page_count:
            warnings.append(
                f"{document_id}: {ocr_page_count} page(s) used machine OCR; "
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
            ocr_page_count=ocr_page_count,
            pages_with_text=index + 1 - len(pages_without_text),
            pages_without_text=pages_without_text,
        ),
        lines=lines,
        warnings=warnings,
    )
