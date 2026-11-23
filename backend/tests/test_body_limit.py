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
    [b"9" * 10000],
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
    # No incomplete multipart body reaches FastAPI when the cap is exceeded.
    assert received == []


def test_falsely_small_content_length_cannot_bypass_limit(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 4)
    status, _, received = _exercise(
        chunks=[b"abc", b"def"], headers=[(b"content-length", b"2")]
    )
    assert status == 413
    assert received == []


def test_exact_body_limit_is_allowed(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 7)
    status, body, received = _exercise(
        chunks=[b"abc", b"defg"], headers=[(b"content-length", b"7")]
    )
    assert status == 200
    assert body == b"ok"
    assert received == [b"abcdefg"]


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


def test_body_limit_error_exposes_cors_to_permitted_origin():
    response = TestClient(app).post(
        "/api/compare",
        content=b"placeholder",
        headers={
            "Origin": "http://localhost:5173",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(body_limit.MAX_COMPARE_BODY_BYTES + 1),
        },
    )
    assert response.status_code == 413
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_real_api_stream_without_content_length_is_limited(monkeypatch):
    # httpx sends iterator bodies with transfer-encoding: chunked. The API
    # must not depend on a declared length to protect temporary disk storage.
    monkeypatch.setattr(body_limit, "MAX_COMPARE_BODY_BYTES", 100)
    pieces = iter([
        b'--x\r\nContent-Disposition: form-data; name="original"; filename="x.pdf"\r\n\r\n',
        b"%PDF-" + b"A" * 150,
    ])
    response = TestClient(app).post(
        "/api/compare",
        content=pieces,
        headers={"Content-Type": "multipart/form-data; boundary=x"},
    )
    assert response.status_code == 413
    assert response.json()["detail"] == "Comparison upload is too large"


def test_body_is_replayed_in_bounded_chunks(monkeypatch):
    monkeypatch.setattr(body_limit, "REPLAY_CHUNK_BYTES", 3)
    status, body, received = _exercise(chunks=[b"abcdef", b"g"])
    assert status == 200
    assert body == b"ok"
    assert received == [b"abc", b"def", b"g"]


def test_small_upload_stays_in_memory(monkeypatch):
    # A controlled spool threshold must not change the request semantics.
    monkeypatch.setattr(body_limit, "IN_MEMORY_SPOOL_BYTES", 3)
    status, body, received = _exercise(chunks=[b"ab", b"cdef"])
    assert status == 200
    assert body == b"ok"
    assert received == [b"abcdef"]


def test_empty_body_is_replayed_without_disconnection():
    status, body, received = _exercise(chunks=[])
    assert status == 200
    assert body == b"ok"
    assert received == [b""]


def test_stalled_upload_receives_408(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_RECEIVE_SECONDS", 0.01)
    scope = {"type": "http", "path": "/api/compare", "method": "POST", "headers": []}
    sent = []
    app_invocations = []

    async def receive():
        await asyncio.sleep(0.2)
        return {"type": "http.request", "body": b"hello", "more_body": False}

    async def send(message):
        sent.append(message)

    async def inner(scope, receive, send):
        app_invocations.append(True)

    async def run():
        guard = body_limit.CompareBodyLimit(inner)
        await guard(scope, receive, send)
        assert guard._active == 0

    asyncio.run(run())
    assert not app_invocations
    assert next(x["status"] for x in sent if x["type"] == "http.response.start") == 408
    payload = b"".join(x.get("body", b"") for x in sent)
    assert json.loads(payload)["detail"] == "Comparison upload took too long"


def test_concurrent_upload_ceiling_rejects_excess_and_releases_capacity(monkeypatch):
    monkeypatch.setattr(body_limit, "MAX_ACTIVE_COMPARE_REQUESTS", 1)
    scope = {"type": "http", "path": "/api/compare", "method": "POST", "headers": []}
    seen = []
    first_sent = []
    second_sent = []
    third_sent = []

    async def inner(scope, receive, send):
        packet = await receive()
        seen.append(packet.get("body"))
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()

        async def hanging_receive():
            entered.set()
            await release.wait()
            return {"type": "http.request", "body": b"first", "more_body": False}

        async def immediate_receive():
            return {"type": "http.request", "body": b"next", "more_body": False}

        async def first_send(message):
            first_sent.append(message)

        async def second_send(message):
            second_sent.append(message)

        async def third_send(message):
            third_sent.append(message)

        guard = body_limit.CompareBodyLimit(inner)
        waiting = asyncio.create_task(guard(scope, hanging_receive, first_send))
        await entered.wait()
        assert guard._active == 1
        await guard(scope, immediate_receive, second_send)
        assert guard._active == 1
        release.set()
        await waiting
        assert guard._active == 0
        await guard(scope, immediate_receive, third_send)
        assert guard._active == 0

    asyncio.run(run())
    statuses = [
        next(x["status"] for x in sent if x["type"] == "http.response.start")
        for sent in [first_sent, second_sent, third_sent]
    ]
    assert statuses == [200, 503, 200]
    assert seen == [b"first", b"next"]
    assert json.loads(b"".join(x.get("body", b"") for x in second_sent)) == {
        "detail": "Too many simultaneous comparison uploads"
    }


def test_actual_upload_limit_response_stays_cache_disabled():
    response = TestClient(app).post(
        "/api/compare", content=b"not multipart",
        headers={"Content-Length": str(body_limit.MAX_COMPARE_BODY_BYTES + 1)},
    )
    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("failure_at", ["open", "write", "seek"])
def test_temp_spool_failure_returns_503_and_releases_request_slot(
    monkeypatch, failure_at
):
    inner_invoked = []
    sent = []
    spool_states = []

    class FailingSpool:
        def __init__(self):
            self.closed = False
            spool_states.append(self)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            self.closed = True

        def write(self, content):
            if failure_at == "write":
                raise OSError("simulated full upload storage")
            return len(content)

        def seek(self, position):
            if failure_at == "seek":
                raise OSError("simulated unavailable upload storage")
            return position

    def create_spool(**kwargs):
        if failure_at == "open":
            raise OSError("simulated failed temporary directory")
        return FailingSpool()

    async def receive():
        return {"type": "http.request", "body": b"example", "more_body": False}

    async def send(message):
        sent.append(message)

    async def inner(scope, receive, send):
        inner_invoked.append(True)

    monkeypatch.setattr(body_limit, "SpooledTemporaryFile", create_spool)
    guard = body_limit.CompareBodyLimit(inner)
    asyncio.run(guard(
        {"type": "http", "path": "/api/compare", "method": "POST", "headers": []},
        receive, send,
    ))
    assert guard._active == 0
    assert not inner_invoked
    assert all(spool.closed for spool in spool_states)
    assert next(
        msg["status"] for msg in sent if msg["type"] == "http.response.start"
    ) == 503
    assert json.loads(b"".join(
        msg.get("body", b"") for msg in sent
        if msg["type"] == "http.response.body"
    ))["detail"] == "Temporary upload storage is unavailable"


def test_spooled_upload_is_closed_on_client_disconnect(monkeypatch):
    original_spool = body_limit.SpooledTemporaryFile
    spools = []
    sent = []

    class TrackedSpool:
        def __init__(self, **kwargs):
            self.inner = original_spool(**kwargs)
            self.closed = False
            spools.append(self)

        def __enter__(self):
            self.inner.__enter__()
            return self

        def __exit__(self, exc_type, exc, traceback):
            self.inner.__exit__(exc_type, exc, traceback)
            self.closed = True

        def write(self, data):
            return self.inner.write(data)

    incoming = iter([
        {"type": "http.request", "body": b"partial", "more_body": True},
        {"type": "http.disconnect"},
    ])
    async def receive():
        return next(incoming)

    async def send(message):
        sent.append(message)

    async def forbidden_inner(*args):
        pytest.fail("A disconnected upload must not reach the PDF parser")

    monkeypatch.setattr(body_limit, "SpooledTemporaryFile", TrackedSpool)
    guard = body_limit.CompareBodyLimit(forbidden_inner)
    asyncio.run(guard(
        {"type": "http", "path": "/api/compare", "method": "POST", "headers": []},
        receive, send,
    ))
    assert guard._active == 0
    assert len(spools) == 1 and spools[0].closed
    assert not sent

