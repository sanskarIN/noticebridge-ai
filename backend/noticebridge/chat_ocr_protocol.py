"""Strict, bounded wire contract for local-only OCR review candidates."""

import hashlib
import json

MAX_REPORT_BYTES = 2 * 1024 * 1024
MAX_LINES = 6000
MAX_LINE_CHARS = 900
MAX_TEXT_CHARS = 800_000
MAX_PAGES = 80
MAX_SELECTED = 12
FORMAT = "noticebridge-chat-ocr-review"


class OcrReviewError(ValueError):
    """Fixed, quote-free error for invalid OCR review data."""


def units(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def validate_selection(pages: object) -> list[int]:
    if (
        type(pages) is not list or not 1 <= len(pages) <= MAX_SELECTED
        or any(type(p) is not int or not 1 <= p <= MAX_PAGES for p in pages)
        or pages != sorted(set(pages))
    ):
        raise OcrReviewError("Invalid OCR page selection")
    return pages


def validate_report(raw: object, source: bytes, role: str, pages: list[int]) -> dict:
    if role not in ("original", "revised"):
        raise OcrReviewError("Invalid source role")
    pages = validate_selection(pages)
    keys = {"format", "version", "source_sha256", "role", "page_count", "pages"}
    if (
        type(raw) is not dict or set(raw) != keys
        or raw["format"] != FORMAT or type(raw["version"]) is not int
        or raw["version"] != 1 or raw["role"] != role
        or raw["source_sha256"] != hashlib.sha256(source).hexdigest()
        or type(raw["page_count"]) is not int
        or not pages[-1] <= raw["page_count"] <= MAX_PAGES
        or type(raw["pages"]) is not list or len(raw["pages"]) != len(pages)
    ):
        raise OcrReviewError("Invalid OCR review report")
    count = chars = 0
    canonical_pages = []
    for expected, row in zip(pages, raw["pages"], strict=True):
        if (
            type(row) is not dict or set(row) != {"page", "status", "lines"}
            or type(row["page"]) is not int or row["page"] != expected
            or row["status"] not in ("ok", "empty", "unavailable", "limited")
            or type(row["lines"]) is not list
            or (row["status"] == "ok" and not row["lines"])
            or (row["status"] in ("empty", "unavailable") and row["lines"])
        ):
            raise OcrReviewError("Invalid OCR review page")
        canonical_lines = []
        last = 0
        for line in row["lines"]:
            if (
                type(line) is not dict or set(line) != {"ordinal", "text"}
                or type(line["ordinal"]) is not int
                or not last < line["ordinal"] <= 100_000
                or type(line["text"]) is not str or not line["text"].strip()
            ):
                raise OcrReviewError("Invalid OCR review line")
            try:
                length = units(line["text"])
            except UnicodeError as exc:
                raise OcrReviewError("Invalid OCR review text") from exc
            if length > MAX_LINE_CHARS:
                raise OcrReviewError("Invalid OCR review line")
            count += 1
            chars += length
            if count > MAX_LINES or chars > MAX_TEXT_CHARS:
                raise OcrReviewError("OCR review exceeds text limits")
            last = line["ordinal"]
            canonical_lines.append({"ordinal": last, "text": line["text"]})
        canonical_pages.append({"page": expected, "status": row["status"],
                                "lines": canonical_lines})
    return {
        "format": FORMAT, "version": 1, "source_sha256": raw["source_sha256"],
        "role": role, "page_count": raw["page_count"], "pages": canonical_pages,
    }


def encode_report(raw: dict) -> bytes:
    data = (json.dumps(raw, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    if len(data) > MAX_REPORT_BYTES:
        raise OcrReviewError("OCR review exceeds file limit")
    return data
