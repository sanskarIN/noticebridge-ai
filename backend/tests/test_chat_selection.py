"""Test local LLM selection without model downloads or network access."""

import asyncio
import json

import httpx
import pytest

from noticebridge import chat_selection as sel
from noticebridge.chat_embeddings import EmbeddingError

MODEL = "example-local:latest"
DIGEST = "a" * 64
ROWS = [
    {"id": "original:1:1", "text": "Application fee: Rs. 500"},
    {"id": "original:2:1", "text": "Do not pay unless registered."},
    {"id": "revised:1:1", "text": "Application fee: Rs. 350"},
]


def raw(rows=None, **changes):
    return json.dumps({
        "format": sel.FORMAT, "version": 1, "question": "Application fee?",
        "passages": ROWS if rows is None else rows, **changes,
    }).encode()


class Stream(httpx.AsyncByteStream):
    def __init__(self, payload):
        self.payload = payload

    async def __aiter__(self):
        yield json.dumps(self.payload).encode()


def response(payload):
    return httpx.Response(200, stream=Stream(payload))


def inventory(digest=DIGEST):
    return {"models": [{"name": MODEL, "model": MODEL, "digest": digest}]}


def generated(value, **changes):
    return {
        "model": MODEL, "done": True, "done_reason": "stop",
        "response": json.dumps(value), **changes,
    }


def run(handler, consent=True):
    return asyncio.run(sel.select_local(
        sel.parse_request(raw()), model=MODEL, digest=DIGEST, consent=consent,
        _transport=httpx.MockTransport(handler),
    ))


def test_selection_contract_and_request_binding():
    paths = []

    def handler(request):
        assert request.url.host == "127.0.0.1"
        paths.append(request.url.path)
        if request.url.path == "/api/tags":
            return response(inventory())
        data = json.loads(request.content)
        assert data["stream"] is False
        assert data["format"]["additionalProperties"] is False
        assert data["format"]["properties"]["ids"]["items"]["enum"] == [
            row["id"] for row in ROWS
        ]
        assert "untrusted" in data["system"]
        assert json.loads(data["prompt"])["candidates"] == ROWS
        return response(generated({"status": "select", "ids": [
            "original:1:1", "original:2:1", "revised:1:1",
        ]}))

    result = run(handler)
    assert paths == ["/api/tags", "/api/generate", "/api/tags"]
    assert result["request_sha256"] == sel.parse_request(raw()).sha256
    assert result["authority_verified"] is False
    assert result["selection"]["ids"] == [row["id"] for row in ROWS]
    assert "Rs." not in json.dumps(result)


def test_abstention():
    def handler(request):
        if request.url.path == "/api/tags":
            return response(inventory())
        return response(generated({"status": "insufficient", "ids": []}))

    assert run(handler)["selection"] == {"status": "insufficient", "ids": []}


@pytest.mark.parametrize("value", [
    {"status": "select", "ids": []},
    {"status": "insufficient", "ids": ["original:1:1"]},
    {"status": "select", "ids": ["original:8:1"]},
    {"status": "select", "ids": ["original:1:1", "original:1:1"]},
    {"status": "select", "ids": [42]},
    {"status": "select", "ids": "original:1:1"},
    {"status": "select", "ids": ["original:1:1"], "answer": "Rs. 999"},
    {"status": "verified", "ids": ["original:1:1"]},
    {"status": "select", "ids": ["original:1:1"], "tool": "shell"},
])
def test_reject_invalid_proposals(value):
    with pytest.raises(EmbeddingError):
        sel.validate_selection(value, sel.parse_request(raw()))


@pytest.mark.parametrize("changes", [
    {"done": False}, {"done_reason": "length"}, {"model": "other"},
    {"response": "not JSON"}, {"response": '{"status":"select","status":"insufficient","ids":[]}'},
    {"response": " " * (sel.MAX_MODEL_TEXT + 1)}, {"response": None},
])
def test_reject_incomplete_or_invalid_model_response(changes):
    def handler(request):
        if request.url.path == "/api/tags":
            return response(inventory())
        return response(generated({"status": "insufficient", "ids": []}, **changes))

    with pytest.raises(EmbeddingError):
        run(handler)


def test_no_network_without_consent():
    with pytest.raises(EmbeddingError):
        run(lambda _: pytest.fail("unexpected request"), consent=False)


def test_changed_model_pin_blocks_result():
    calls = 0

    def handler(request):
        nonlocal calls
        if request.url.path == "/api/tags":
            calls += 1
            return response(inventory(DIGEST if calls == 1 else "b" * 64))
        return response(generated({"status": "insufficient", "ids": []}))

    with pytest.raises(EmbeddingError, match="digest"):
        run(handler)


def test_timeout(monkeypatch):
    monkeypatch.setattr(sel, "TIMEOUT_SECONDS", 0.01)

    async def handler(_request):
        await asyncio.sleep(1)
        return response(inventory())

    with pytest.raises(EmbeddingError, match="timed out"):
        run(handler)


@pytest.mark.parametrize("rows", [
    [], [ROWS[0], ROWS[0]], [{"id": "original:81:1", "text": "text"}],
    [{"id": "original:1:1", "text": "x" * 901}],
    [{"id": "original:1:1", "text": ""}],
    [{"id": "other:1:1", "text": "text"}],
    [{"id": f"original:1:{i}", "text": "text"} for i in range(1, 14)],
])
def test_invalid_request(rows):
    with pytest.raises(EmbeddingError):
        sel.parse_request(raw(rows))


def test_role_selection_cap():
    request = sel.parse_request(raw([
        {"id": f"original:1:{i}", "text": "text"} for i in range(1, 6)
    ]))
    with pytest.raises(EmbeddingError, match="Per-source"):
        sel.validate_selection({
            "status": "select", "ids": [row.id for row in request.passages],
        }, request)
