"""Local OCR endpoint authorization, request bounds, and canonical report contract."""

import asyncio
import hashlib
import json

import httpx
import pytest

from noticebridge import api, body_limit
from noticebridge.chat_ocr_protocol import OcrReviewError, encode_report

PATH = "/api/chat/ocr"
HEADERS = {"X-NoticeBridge-Local-OCR": "1", "Origin": "http://localhost:5173"}


def post(data=None, headers=None, peer="127.0.0.1", base_url="http://127.0.0.1:8000",
         pdf=b"fixture-pdf", filename="notice.pdf"):
    fields = {"role": "original", "pages": "1,3", "consent": "true"}
    fields.update(data or {})

    async def run():
        transport = httpx.ASGITransport(app=api.app, client=(peer, 1234))
        async with httpx.AsyncClient(transport=transport, base_url=base_url) as client:
            return await client.post(
                PATH, data=fields, headers=HEADERS if headers is None else headers,
                files={"source": (filename, pdf, "application/pdf")},
            )
    return asyncio.run(run())


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_OCR", "1")
    calls = []

    def worker(source, role, pages):
        calls.append((source, role, pages))
        return {
            "format": "noticebridge-chat-ocr-review", "version": 1,
            "source_sha256": hashlib.sha256(source).hexdigest(),
            "role": role, "page_count": 3,
            "pages": [{"page": page, "status": "ok",
                       "lines": [{"ordinal": 1, "text": "Printed text 😀"}]} for page in pages],
        }

    monkeypatch.setattr(api, "run_ocr_review", worker)
    return calls


def test_default_disabled_before_worker_or_spool(monkeypatch, enabled):
    monkeypatch.delenv("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_OCR", raising=False)
    monkeypatch.setattr(body_limit, "SpooledTemporaryFile",
                        lambda **_: pytest.fail("disabled upload was buffered"))
    response = post()
    assert response.status_code == 404
    assert enabled == []


@pytest.mark.parametrize("headers,peer,base_url", [
    ({}, "127.0.0.1", "http://127.0.0.1:8000"),
    ({"X-NoticeBridge-Local-OCR": "0"}, "127.0.0.1", "http://127.0.0.1:8000"),
    ({**HEADERS, "Origin": "https://example.com"}, "127.0.0.1", "http://127.0.0.1:8000"),
    ({**HEADERS, "Origin": "null"}, "127.0.0.1", "http://127.0.0.1:8000"),
    (HEADERS, "192.0.2.10", "http://127.0.0.1:8000"),
    (HEADERS, "127.0.0.1", "http://example.com:8000"),
    (HEADERS, "127.0.0.1", "http://localhost:9000"),
    ({"X-NoticeBridge-Local-OCR": "1", "Sec-Fetch-Site": "cross-site"},
     "127.0.0.1", "http://127.0.0.1:8000"),
])
def test_local_boundary_rejects_before_buffering(monkeypatch, enabled, headers, peer, base_url):
    monkeypatch.setattr(body_limit, "SpooledTemporaryFile",
                        lambda **_: pytest.fail("untrusted upload was buffered"))
    response = post(headers=headers, peer=peer, base_url=base_url)
    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"
    assert enabled == []


def test_canonical_report_round_trip_and_explicit_page_selection(enabled):
    response = post()
    assert response.status_code == 200
    assert enabled == [(b"fixture-pdf", "original", [1, 3])]
    report = response.json()
    assert response.content == encode_report(report)
    assert report["source_sha256"] == hashlib.sha256(b"fixture-pdf").hexdigest()
    assert [row["page"] for row in report["pages"]] == [1, 3]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("data", [
    {"consent": "false"}, {"role": "unknown"}, {"pages": ""},
    {"pages": "0"}, {"pages": "81"}, {"pages": "3-1"},
    {"pages": "1-20"}, {"pages": "invalid"},
])
def test_invalid_consent_or_page_selection_never_invokes_worker(enabled, data):
    response = post(data=data)
    assert response.status_code == 422
    assert enabled == []


def test_filename_and_empty_payload_rejected(enabled):
    assert post(filename="notice.txt").status_code == 415
    assert post(pdf=b"").status_code == 422
    assert enabled == []


def test_ocr_specific_upload_limit_is_enforced_before_parsing(monkeypatch, enabled):
    monkeypatch.setattr(body_limit, "MAX_CHAT_OCR_BODY_BYTES", 16)
    response = post()
    assert response.status_code == 413
    assert response.json()["detail"] == "OCR upload is too large"
    assert enabled == []


def test_worker_failure_does_not_disclose_private_text(monkeypatch, enabled):
    def worker(*_):
        raise OcrReviewError("sensitive source quotation")

    monkeypatch.setattr(api, "run_ocr_review", worker)
    response = post()
    assert response.status_code == 503
    assert "sensitive" not in response.text
    assert response.json()["detail"] == "Local OCR did not produce a valid report"


def test_native_loopback_client_with_explicit_header(enabled):
    response = post(headers={"X-NoticeBridge-Local-OCR": "1"})
    assert response.status_code == 200
    assert json.loads(response.content)["role"] == "original"
