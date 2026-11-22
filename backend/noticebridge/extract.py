"""Extract line-level, page-linked PDF evidence without OCR or persistent storage."""

from dataclasses import dataclass

import fitz

from .models import DocumentSummary, Evidence, ExtractedLine

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_PAGES = 80
MAX_EXTRACTED_LINES = 12000


class InvalidDocument(ValueError):
    """The input cannot be safely processed by this first milestone."""


@dataclass(frozen=True)
class ExtractedDocument:
    summary: DocumentSummary
    lines: list[ExtractedLine]
    warnings: list[str]


def extract_pdf(contents: bytes, *, document_id: str, filename: str) -> ExtractedDocument:
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
    try:
        if pdf.is_encrypted or pdf.needs_pass:
            raise InvalidDocument("Encrypted PDFs are not supported")
        if not 1 <= len(pdf) <= MAX_PAGES:
            raise InvalidDocument(f"PDF must contain 1 to {MAX_PAGES} pages")
        for index, page in enumerate(pdf):
            page_lines = 0
            # Only text blocks; image blocks are intentionally ignored.
            data = page.get_text("dict", sort=True)
            for block in data.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for rawline in block.get("lines", []):
                    spans = rawline.get("spans", [])
                    text = " ".join(s.get("text", "").strip() for s in spans).strip()
                    if not text:
                        continue
                    box = rawline.get("bbox")
                    if not box or len(box) != 4:
                        continue
                    evidence = Evidence(
                        document_id=document_id,
                        filename=filename,
                        page=index + 1,
                        text=text,
                        bbox=tuple(round(float(c), 2) for c in box),
                    )
                    lines.append(ExtractedLine(text=text, evidence=evidence))
                    page_lines += 1
                    if len(lines) > MAX_EXTRACTED_LINES:
                        raise InvalidDocument("PDF contains too many text lines")
            if page_lines == 0:
                warnings.append(
                    f"{document_id}: page {index + 1} has no extractable text; "
                    "OCR not enabled"
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
        ),
        lines=lines,
        warnings=warnings,
    )
