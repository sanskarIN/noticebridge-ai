"""One-shot selected-page OCR worker. Apply limits before importing PDF libraries."""

import base64
import hashlib
import json
import sys

from .chat_ocr_protocol import (
    FORMAT,
    MAX_LINES,
    MAX_LINE_CHARS,
    MAX_TEXT_CHARS,
    OcrReviewError,
    encode_report,
    units,
    validate_report,
    validate_selection,
)

MAX_SOURCE = 10 * 1024 * 1024
MAX_INPUT = 4 * ((MAX_SOURCE + 2) // 3) + 4096


def _ocr_lines(page) -> list[str]:
    # Deliberately use only the English pack for this local chat experiment.
    import pymupdf as fitz

    image = page.get_pixmap(dpi=150, colorspace=fitz.csRGB, alpha=False)
    data = image.pdfocr_tobytes(compress=False, language="eng")
    with fitz.open(stream=data, filetype="pdf") as transcription:
        blocks = transcription[0].get_text("dict", flags=0, sort=True)["blocks"]
        return [
            " ".join(span.get("text", "").strip() for span in line["spans"]).strip()
            for block in blocks if block.get("type") == 0 for line in block["lines"]
        ]


def extract_review(source: bytes, role: str, pages: list[int]) -> dict:
    import pymupdf as fitz

    from .extract import _within_ocr_pixel_budget

    pages = validate_selection(pages)
    if (
        not source or len(source) > MAX_SOURCE or not source.lstrip().startswith(b"%PDF-")
        or role not in ("original", "revised")
    ):
        raise OcrReviewError("Invalid OCR source")
    count = chars = 0
    results = []
    with fitz.open(stream=source, filetype="pdf") as pdf:
        if pdf.is_encrypted or pdf.needs_pass or not pages[-1] <= len(pdf) <= 80:
            raise OcrReviewError("Unsupported PDF or selected pages")
        page_count = len(pdf)
        for number in pages:
            page = pdf[number - 1]
            lines = []
            status = "empty"
            if not _within_ocr_pixel_budget(page.rect):
                status = "limited"
            else:
                try:
                    text_lines = _ocr_lines(page)
                except (RuntimeError, ValueError, OSError):
                    status = "unavailable"
                else:
                    status = "ok" if any(text_lines) else "empty"
                    for ordinal, text in enumerate(text_lines, 1):
                        if not text:
                            continue
                        length = units(text)
                        if (
                            ordinal > 100_000 or length > MAX_LINE_CHARS or count >= MAX_LINES
                            or chars + length > MAX_TEXT_CHARS
                        ):
                            status = "limited"
                            continue
                        count += 1
                        chars += length
                        lines.append({"ordinal": ordinal, "text": text})
            results.append({"page": number, "status": status, "lines": lines})
    raw = {
        "format": FORMAT, "version": 1, "source_sha256": hashlib.sha256(source).hexdigest(),
        "role": role, "page_count": page_count, "pages": results,
    }
    return validate_report(raw, source, role, pages)


def main() -> int:
    from .worker_limits import apply_worker_limits

    apply_worker_limits(enable_ocr=True)
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            return 2
        raw = json.loads(data)
        if type(raw) is not dict or set(raw) != {"source", "role", "pages"}:
            return 2
        source = base64.b64decode(raw["source"], validate=True)
        output = encode_report(extract_review(source, raw["role"], raw["pages"]))
    except Exception:
        # This subprocess never returns parser diagnostics or source text on failure.
        return 2
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
