"""Extract bounded, page-linked PDF evidence with optional local OCR."""

import hashlib
import math
from dataclasses import dataclass

import fitz

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


class InvalidDocument(ValueError):
    """The input cannot be safely processed by this first milestone."""


@dataclass(frozen=True)
class ExtractedDocument:
    summary: DocumentSummary
    lines: list[ExtractedLine]
    warnings: list[str]


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
    total_characters = 0
    ocr_page_count = 0
    ocr_attempts = 0
    try:
        if pdf.is_encrypted or pdf.needs_pass:
            raise InvalidDocument("Encrypted PDFs are not supported")
        if not 1 <= len(pdf) <= MAX_PAGES:
            raise InvalidDocument(f"PDF must contain 1 to {MAX_PAGES} pages")
        for index, page in enumerate(pdf):
            page_lines = 0
            # Original text is always preferred. OCR only runs for pages with
            # no native text, avoiding duplicate lines and false certainty.
            data = page.get_text("dict", sort=True)
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
                        f"{document_id}: page {index + 1} was not OCR-scanned: "
                        f"per-document OCR limit of {MAX_OCR_PAGES} pages reached"
                    )
                elif (
                    page.rect.width * page.rect.height * (OCR_DPI / 72) ** 2
                    > MAX_OCR_RENDER_PIXELS
                ):
                    warnings.append(
                        f"{document_id}: page {index + 1} was not OCR-scanned: "
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
                            f"{document_id}: page {index + 1} OCR unavailable "
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
                    total_characters += len(text)
                    if total_characters > MAX_TOTAL_CHARACTERS:
                        raise InvalidDocument("PDF contains too much extractable text")
                    box = rawline.get("bbox")
                    if not box or len(box) != 4 or not all(
                        math.isfinite(float(c)) for c in box
                    ):
                        continue
                    evidence = Evidence(
                        document_id=document_id,
                        filename=filename,
                        page=index + 1,
                        text=text,
                        bbox=tuple(round(float(c), 2) for c in box),
                        extraction_method=method,
                        page_width=round(float(page.rect.width), 2),
                        page_height=round(float(page.rect.height), 2),
                        page_rotation=page.rotation,
                    )
                    lines.append(ExtractedLine(text=text, evidence=evidence))
                    page_lines += 1
                    if len(lines) > MAX_EXTRACTED_LINES:
                        raise InvalidDocument("PDF contains too many text lines")
            if method == "ocr" and page_lines:
                ocr_page_count += 1
            if page_lines == 0:
                warnings.append(
                    f"{document_id}: page {index + 1} has no extractable text; "
                    "OCR not enabled" if not enable_ocr else "comparison may be incomplete"
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
        ),
        lines=lines,
        warnings=warnings,
    )
