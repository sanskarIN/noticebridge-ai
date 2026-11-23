"""ASGI stream guard prevents excess multipart data from reaching the parser."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from noticebridge import body_limit
from noticebridge.api import app


def _exercise(*, chunks, headers=(), path="/api/compare", method="POST"):
    sent: list[dict] = []
    incoming = [
        {"type": "http.request", "body": payload, "more_body": i + 1 < len(chunks)}
        for i, payload in enumerate(chunks)
    ] or [{"type": "http.request", "body": b"", "more_body": False}]
    received_by_app: list[bytes] = []

    async def receive():
        return incoming.pop(0)

    async def send(message):
        sent.append(message)

    async def inner(scope, receive, send):
        while True:
            packet = await receive()
            received_by_app.append(packet.get("body", b""))
            if not packet.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    scope = {
        "type": "http",
        "path": path,
        "method": method,
        "headers": list(headers),
    }
    asyncio.run(body_limit.CompareBodyLimit(inner)(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body, received_by_app


def test_oversized_content_length_rejected_before_reading(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 10)
    status, body, received = _exercise(
        chunks=[b"small"], headers=[(b"content-length", b"11")]
    )
    assert status == 413
    assert json.loads(body)["detail"] == "Comparison upload is too large"
    assert not received


@pytest.mark.parametrize("header_values", [
    [b"not-an-integer"],
    [b"-1"],
    [b"1", b"1"],
    [b"12.5"],
])
def test_malformed_or_duplicate_lengths_rejected(header_values):
    status, body, received = _exercise(
        chunks=[b"tiny"],
        headers=[(b"content-length", value) for value in header_values],
    )
    assert status == 400
    assert json.loads(body)["detail"] == "Invalid Content-Length"
    assert not received


def test_missing_content_length_is_not_an_escape(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 10)
    status, body, received = _exercise(chunks=[b"1234", b"567890", b"X"])
    assert status == 413
    assert "too large" in json.loads(body)["detail"]
    assert received == [b"1234", b"567890"]


def test_falsely_small_content_length_cannot_bypass_limit(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 4)
    status, _, received = _exercise(
        chunks=[b"abc", b"def"], headers=[(b"content-length", b"2")]
    )
    assert status == 413
    assert received == [b"abc"]


def test_exact_body_limit_is_allowed(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 7)
    status, body, received = _exercise(
        chunks=[b"abc", b"defg"], headers=[(b"content-length", b"7")]
    )
    assert status == 200
    assert body == b"ok"
    assert received == [b"abc", b"defg"]


@pytest.mark.parametrize(("path", "method"), [
    ("/api/health", "POST"),
    ("/api/compare", "GET"),
    ("/unrelated", "POST"),
])
def test_other_routes_and_methods_not_modified(monkeypatch, path, method):
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 1)
    status, body, received = _exercise(
        chunks=[b"longer"], path=path, method=method
    )
    assert status == 200
    assert body == b"ok"
    assert received == [b"longer"]


def test_real_api_rejects_oversized_declared_request():
    response = TestClient(app).post(
        "/api/compare",
        content=b"placeholder",
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(body_limit.MAX_COMPARE_BODY_BYTES + 1),
        },
    )
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
