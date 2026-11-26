import hashlib
import json

import pymupdf as fitz
import pytest

from noticebridge import chat_ocr_cli, chat_ocr_worker
from noticebridge.chat_ocr_protocol import (
    OcrReviewError,
    encode_report,
    validate_report,
    validate_selection,
)


def pdf():
    with fitz.open() as doc:
        doc.new_page()
        doc.new_page()
        return doc.tobytes()


def test_selected_page_ocr_review_preserves_source_and_transcription(monkeypatch):
    source = pdf()
    monkeypatch.setattr(chat_ocr_worker, "_ocr_lines", lambda page: ["Application fee: Rs. 500"])
    result = chat_ocr_worker.extract_review(source, "original", [2])
    assert result["source_sha256"] == hashlib.sha256(source).hexdigest()
    assert result["page_count"] == 2
    assert result["pages"] == [{
        "page": 2, "status": "ok", "lines": [{"ordinal": 1, "text": "Application fee: Rs. 500"}],
    }]
    assert json.loads(encode_report(result)) == result


def test_missing_ocr_is_not_guessed(monkeypatch):
    def unavailable(_):
        raise RuntimeError("private diagnostic")

    monkeypatch.setattr(chat_ocr_worker, "_ocr_lines", unavailable)
    report = chat_ocr_worker.extract_review(pdf(), "revised", [1])
    assert report["pages"] == [{"page": 1, "status": "unavailable", "lines": []}]


def test_oversized_line_is_omitted_and_gap_preserved(monkeypatch):
    monkeypatch.setattr(chat_ocr_worker, "_ocr_lines", lambda page: ["x" * 901, "Evidence"])
    result = chat_ocr_worker.extract_review(pdf(), "original", [1])
    assert result["pages"][0] == {
        "page": 1, "status": "limited", "lines": [{"ordinal": 2, "text": "Evidence"}],
    }


@pytest.mark.parametrize("pages", [[], [0], [81], [True], [2, 1], [1, 1], list(range(1, 14))])
def test_invalid_selection(pages):
    with pytest.raises(OcrReviewError):
        validate_selection(pages)


@pytest.mark.parametrize("field,value", [
    ("source_sha256", "a" * 64), ("role", "revised"), ("version", True),
    ("page_count", 81), ("extra", True),
])
def test_rejects_invalid_worker_metadata(monkeypatch, field, value):
    source = pdf()
    monkeypatch.setattr(chat_ocr_worker, "_ocr_lines", lambda page: ["Evidence"])
    raw = chat_ocr_worker.extract_review(source, "original", [1])
    raw[field] = value
    with pytest.raises(OcrReviewError):
        validate_report(raw, source, "original", [1])


def test_cli_requires_consent_and_refuses_overwrite(tmp_path, monkeypatch):
    source = tmp_path / "source.pdf"
    source.write_bytes(pdf())
    output = tmp_path / "report.json"
    args = [str(source), "--role", "original", "--pages", "1", "--output", str(output)]
    monkeypatch.setattr(chat_ocr_worker, "_ocr_lines", lambda page: ["Evidence"])
    monkeypatch.setattr(chat_ocr_cli, "run_ocr_review", chat_ocr_worker.extract_review)
    assert chat_ocr_cli.main(args) == 2
    assert not output.exists()
    assert chat_ocr_cli.main(args + ["--allow-local-processing"]) == 0
    before = output.read_bytes()
    assert chat_ocr_cli.main(args + ["--allow-local-processing"]) == 2
    assert output.read_bytes() == before
