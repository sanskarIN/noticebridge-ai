"""Reject arbitrary worker-authored warning messages before they reach the UI.

Warnings describe limitations, not authority. The parent cannot fully reparse
untrusted source PDFs, but it can require the warning language to be from a
small deterministic grammar. All page numbers remain bounded by the reported
source document summaries.
"""

import re

from .extract import MAX_EXTRACTED_LINES, MAX_OCR_PAGES, MAX_PAGES
from .models import DocumentSummary

COVERAGE_WARNINGS = {
    "At least one document has no extractable text; comparison is incomplete",
    "Some pages have no extractable text; comparisons may omit changes on those pages",
}
AI_WARNINGS = {
    "Local AI matching skipped: candidate budget exceeded",
    "Local AI assistant unavailable; deterministic comparison was preserved",
    "Local AI output was rejected as invalid or oversized",
    "Local AI suggested no pairings that passed source-ID/category checks",
    "AI-suggested pairings require direct review of both PDF passages",
}
OCR_NOT_SCANNED = {
    f"was not OCR-scanned: per-document OCR limit of {MAX_OCR_PAGES} pages reached",
    "was not OCR-scanned: page would exceed OCR pixel limit",
}
MAX_CROSS_PAGE_DETAILS = 20
PAGE_RE = re.compile(r"^(original|revised): page ([1-9][0-9]{0,2}) (.+)$")
OMITTED_BOXES_RE = re.compile(
    r"^omitted ([1-9][0-9]{0,4}) text line\(s\) with invalid source coordinates$"
)
OCR_FAILURE_RE = re.compile(
    r"^OCR unavailable \(([A-Za-z][A-Za-z0-9_]{0,79})\); "
    r"install Tesseract eng\+hin language data$"
)
OCR_TOTAL_RE = re.compile(
    r"^(original|revised): ([1-9][0-9]{0,2}) page\(s\) used machine OCR; "
    r"transcription can be inaccurate and needs manual checking$"
)
CROSS_PAGE_RE = re.compile(
    r"^(original|revised): differing dates under a repeated deadline label "
    r"on pages ((?:[1-9][0-9]{0,2})(?:, [1-9][0-9]{0,2})*); "
    r"verify whether they concern the same requirement$"
)
CROSS_PAGE_OVERFLOW_RE = re.compile(
    r"^(original|revised): ([1-9][0-9]{0,4}) additional repeated deadline labels need review$"
)


def warning_supported(
    message: str,
    documents: dict[str, DocumentSummary],
    *,
    ocr_requested: bool,
    semantic_requested: bool,
    text_coverage: str,
) -> bool:
    """Allow only bounded messages from known extraction/comparison branches."""
    if not isinstance(message, str) or len(message) > 700:
        return False
    if message in COVERAGE_WARNINGS:
        return (
            text_coverage == "inconclusive"
            if message.startswith("At least")
            else text_coverage == "partial"
        )
    if message in AI_WARNINGS:
        return semantic_requested
    match = PAGE_RE.fullmatch(message)
    if match:
        role, raw_page, description = match.groups()
        summary = documents[role]
        page = int(raw_page)
        omitted = OMITTED_BOXES_RE.fullmatch(description)
        if omitted:
            return 1 <= page <= summary.page_count and int(omitted[1]) <= MAX_EXTRACTED_LINES
        if page not in summary.pages_without_text:
            return False
        if description == "has no extractable text; OCR not enabled":
            return not ocr_requested
        if description == "has no extractable text; comparison may be incomplete":
            return ocr_requested
        return ocr_requested and (
            description in OCR_NOT_SCANNED
            or OCR_FAILURE_RE.fullmatch(description) is not None
        )
    match = OCR_TOTAL_RE.fullmatch(message)
    if match:
        role, count = match.groups()
        return ocr_requested and int(count) == documents[role].ocr_page_count
    match = CROSS_PAGE_RE.fullmatch(message)
    if match:
        role, pages = match.groups()
        numbers = [int(value) for value in pages.split(", ")]
        return (
            len(numbers) >= 2
            and numbers == sorted(set(numbers))
            and all(1 <= n <= documents[role].page_count <= MAX_PAGES for n in numbers)
        )
    match = CROSS_PAGE_OVERFLOW_RE.fullmatch(message)
    if match:
        role, count = match.groups()
        return documents[role].pages_with_text >= 2 and int(count) <= MAX_EXTRACTED_LINES // 2
    return False
