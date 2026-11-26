"""Local extractive model protocol tests with mocked transport."""

import asyncio
import json

import httpx
import pytest

from noticebridge import chat_extractive as ext
from noticebridge.chat_embeddings import EmbeddingError
from noticebridge.chat_selection import FORMAT, parse_request

MODEL = "fixture:latest"
DIGEST = "a" * 64
ROWS = [
    {"id": "original:1:1", "text": "😀 Fee: Rs. 500 unless exempt."},
    {"id": "original:2:1", "text": "Do not pay twice."},
    {"id": "revised:1:1", "text": "Fee: Rs. 350"},
]


def request(rows=ROWS):
    return parse_request(json.dumps({
        "format": FORMAT, "version": 1, "question": "Fee?", "passages": rows,
    }).encode())


def proposal(key, quote):
    return {"status": "extract", "quotes": [{"id": key, "quote": quote}]}


def test_offsets_are_utf16_and_exact_source_text_is_not_returned():
    result = ext.validate_quotes(proposal("original:1:1", "Rs. 500"), request())
    assert result == {
        "status": "extract", "spans": [{"id": "original:1:1", "start": 8, "end": 15}],
    }
    assert "Rs." not in json.dumps(result)


@pytest.mark.parametrize("value", [
    proposal("original:1:1", "Rs. 999"),
    proposal("original:1:1", "rs. 500"),
    proposal("original:1:1", " Rs. 500"),
    proposal("revised:2:1", "Rs. 350"),
    proposal("original:1:1", ""),
    proposal("original:1:1", "x" * 301),
    {"status": "insufficient", "quotes": [{"id": "original:1:1", "quote": "Fee"}]},
    {"status": "extract", "quotes": []},
    {"status": "verified", "quotes": []},
    {"status": "extract", "quotes": [{"id": "original:1:1", "quote": "Fee", "page": 7}]},
    {"status": "extract", "quotes": [{"id": "original:1:1", "quote": "Fee"}], "answer": "yes"},
    {"status": "extract", "quotes": [
        {"id": "original:1:1", "quote": "Fee: Rs."},
        {"id": "original:1:1", "quote": "Rs. 500"},
    ]},
])
def test_invalid_quotes(value):
    with pytest.raises(EmbeddingError):
        ext.validate_quotes(value, request())


def test_ambiguous_substring_rejected():
    req = request([{"id": "original:1:1", "text": "fee fee"}])
    with pytest.raises(EmbeddingError, match="unique"):
        ext.validate_quotes(proposal("original:1:1", "fee"), req)


def test_surrogate_budget_and_qualified_text():
    text = "😀" * 151
    req = request([{"id": "original:1:1", "text": text}])
    with pytest.raises(EmbeddingError):
        ext.validate_quotes(proposal("original:1:1", text), req)
    result = ext.validate_quotes(proposal("original:1:1", "unless exempt."), request())
    assert result["spans"][0]["end"] > result["spans"][0]["start"]


def test_per_role_cap():
    rows = [{"id": f"original:1:{i}", "text": "Fee"} for i in range(1, 6)]
    with pytest.raises(EmbeddingError, match="Per-source"):
        ext.validate_quotes({
            "status": "extract", "quotes": [{"id": row["id"], "quote": "Fee"} for row in rows],
        }, request(rows))


class Stream(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        yield json.dumps(self.data).encode()


def response(data):
    return httpx.Response(200, stream=Stream(data))


def inventory(digest=DIGEST):
    return {"models": [{"name": MODEL, "model": MODEL, "digest": digest}]}


def generated(value, **changes):
    return {
        "model": MODEL, "done": True, "done_reason": "stop",
        "response": json.dumps(value), **changes,
    }


def run(handler, consent=True):
    return asyncio.run(ext.extract_local(
        request(), model=MODEL, digest=DIGEST, consent=consent,
        _transport=httpx.MockTransport(handler),
    ))


def test_local_generation_contract_and_pin_checks():
    calls = []

    def handler(req):
        assert req.url.host == "127.0.0.1"
        calls.append(req.url.path)
        if req.url.path == "/api/tags":
            return response(inventory())
        payload = json.loads(req.content)
        assert payload["stream"] is False
        assert "untrusted" in payload["system"]
        assert json.loads(payload["prompt"])["candidates"] == ROWS
        assert payload["format"]["additionalProperties"] is False
        return response(generated(proposal("revised:1:1", "Rs. 350")))

    result = run(handler)
    assert calls == ["/api/tags", "/api/generate", "/api/tags"]
    assert result["request_sha256"] == request().sha256
    assert result["authority_verified"] is False
    assert result["proposal"]["spans"] == [{"id": "revised:1:1", "start": 5, "end": 12}]
    assert "Rs." not in json.dumps(result)


@pytest.mark.parametrize("changes", [
    {"done": False}, {"done_reason": "length"}, {"model": "different"},
    {"response": None}, {"response": "not json"},
    {"response": '{"status":"extract","status":"insufficient","quotes":[]}'},
    {"response": "x" * (ext.MAX_MODEL_BYTES + 1)},
])
def test_malformed_runtime_output(changes):
    def handler(req):
        if req.url.path == "/api/tags":
            return response(inventory())
        return response(generated({"status": "insufficient", "quotes": []}, **changes))

    with pytest.raises(EmbeddingError):
        run(handler)


def test_abstention_and_no_consent():
    def handler(req):
        if req.url.path == "/api/tags":
            return response(inventory())
        return response(generated({"status": "insufficient", "quotes": []}))

    assert run(handler)["proposal"] == {"status": "insufficient", "spans": []}
    with pytest.raises(EmbeddingError):
        run(lambda _: pytest.fail("unexpected request"), consent=False)


def test_changed_model_digest():
    checks = 0

    def handler(req):
        nonlocal checks
        if req.url.path == "/api/tags":
            checks += 1
            return response(inventory(DIGEST if checks == 1 else "b" * 64))
        return response(generated({"status": "insufficient", "quotes": []}))

    with pytest.raises(EmbeddingError, match="digest"):
        run(handler)


def test_wall_clock_deadline(monkeypatch):
    monkeypatch.setattr(ext, "TIMEOUT_SECONDS", 0.01)

    async def handler(_):
        await asyncio.sleep(1)
        return response(inventory())

    with pytest.raises(EmbeddingError, match="timed out"):
        run(handler)
