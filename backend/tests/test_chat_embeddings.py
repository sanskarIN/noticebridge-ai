"""No model download or external network required for these contract tests."""

import asyncio
import json

import httpx
import pytest

from noticebridge import chat_embeddings as emb

MODEL = "example-embedding:latest"
DIGEST = "a" * 64
ROWS = [
    {"id": "original:1:1", "text": "Application fee: Rs. 500"},
    {"id": "original:2:1", "text": "Eligibility: Class 12"},
    {"id": "revised:1:1", "text": "Application fee: Rs. 350"},
]


def raw(rows=None, **changes):
    return json.dumps({
        "format": emb.FORMAT, "version": 1, "question": "What is the fee?",
        "passages": ROWS if rows is None else rows, **changes,
    }).encode()


class Stream(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        yield self.data


def response(value, status=200, headers=None):
    return httpx.Response(
        status, stream=Stream(json.dumps(value).encode()), headers=headers,
    )


def run(handler, *, request=None, consent=True, model=MODEL, digest=DIGEST):
    return asyncio.run(emb.retrieve_local(
        request or emb.parse_request(raw()), model=model, digest=digest,
        consent=consent, _transport=httpx.MockTransport(handler),
    ))


def inventory(digest=DIGEST):
    return {"models": [{"name": MODEL, "model": MODEL, "digest": digest}]}


def good(request):
    if request.url.path == "/api/tags":
        return response(inventory())
    inputs = json.loads(request.content)["input"]
    return response({"model": MODEL, "embeddings": [[1, 0] for _ in inputs]})


def test_rank_and_protocol():
    seen = []

    def handler(request):
        assert request.url.host == "127.0.0.1"
        assert request.url.port == 11434
        assert request.headers["accept-encoding"] == "identity"
        seen.append(request.url.path)
        if request.url.path == "/api/tags":
            return response(inventory())
        payload = json.loads(request.content)
        assert payload["truncate"] is False
        assert payload["model"] == MODEL
        values = [[1, 0]] if len(payload["input"]) == 1 else [[1, 0], [0, 1], [1, 0]]
        return response({"model": MODEL, "embeddings": values})

    parsed = emb.parse_request(raw())
    result = run(handler, request=parsed)
    assert seen == ["/api/tags", "/api/embed", "/api/embed", "/api/tags"]
    assert result["request_sha256"] == parsed.sha256
    assert result["ranks"] == {"original": ["original:1:1", "original:2:1"],
                               "revised": ["revised:1:1"]}
    assert result["dimension"] == 2
    assert result["authority_verified"] is False
    assert "Rs." not in json.dumps(result)
    assert "What is" not in json.dumps(result)


@pytest.mark.parametrize("changes", [
    {"version": True}, {"version": 2}, {"format": "invalid"},
    {"question": ""}, {"question": "x" * 401}, {"unknown": "field"},
])
def test_request_schema(changes):
    with pytest.raises(emb.EmbeddingError):
        emb.parse_request(raw(**changes))


@pytest.mark.parametrize("rows", [
    [], [ROWS[0], ROWS[0]], [{"id": "other:1:1", "text": "text"}],
    [{"id": "original:81:1", "text": "text"}],
    [{"id": "original:1:0", "text": "text"}],
    [{"id": "original:1:1", "text": "x" * 901}],
    [{"id": "original:1:1", "text": "text", "page": 1}],
    [{"id": "original:1:1", "text": "\ud800"}],
    [{"id": "original:1:1", "text": ""}],
])
def test_invalid_passages(rows):
    with pytest.raises(emb.EmbeddingError):
        emb.parse_request(raw(rows))


def test_duplicate_json_keys_and_input_size():
    with pytest.raises(emb.EmbeddingError):
        emb.parse_request(raw().replace(b'"version": 1', b'"version": 1, "version": 1'))
    with pytest.raises(emb.EmbeddingError):
        emb.parse_request(b" " * (emb.MAX_INPUT_BYTES + 1))


@pytest.mark.parametrize("kwargs", [
    {"consent": False}, {"model": "https://example.com/model"},
    {"model": "example-cloud:latest"}, {"digest": "bad"},
])
def test_consent_and_model_validation_precede_network(kwargs):
    def handler(_request):
        pytest.fail("Unexpected network call")

    with pytest.raises(emb.EmbeddingError):
        run(handler, **kwargs)


def test_model_pin_must_match_before_sending_text():
    def handler(request):
        assert request.url.path == "/api/tags"
        return response(inventory("b" * 64))

    with pytest.raises(emb.EmbeddingError, match="digest"):
        run(handler)


def test_model_pin_is_rechecked_after_inference():
    count = 0

    def handler(request):
        nonlocal count
        if request.url.path == "/api/tags":
            count += 1
            return response(inventory(DIGEST if count == 1 else "b" * 64))
        return good(request)

    with pytest.raises(emb.EmbeddingError, match="digest"):
        run(handler)
    assert count == 2


@pytest.mark.parametrize("payload", [
    {"model": "other", "embeddings": [[1, 0]]},
    {"model": MODEL, "embeddings": []},
    {"model": MODEL, "embeddings": [[0, 0]]},
    {"model": MODEL, "embeddings": [[True, 1]]},
    {"model": MODEL, "embeddings": [[float("nan"), 1]]},
    {"model": MODEL, "embeddings": [[float("inf"), 1]]},
    {"model": MODEL, "embeddings": [["1", 1]]},
    {"model": MODEL, "embeddings": [[1] * 2049]},
])
def test_invalid_embeddings(payload):
    def handler(request):
        if request.url.path == "/api/tags":
            return response(inventory())
        return response(payload)

    with pytest.raises(emb.EmbeddingError):
        run(handler)


def test_batch_dimension_change():
    def handler(request):
        if request.url.path == "/api/tags":
            return response(inventory())
        inputs = json.loads(request.content)["input"]
        values = [[1, 0]] if len(inputs) == 1 else [[1, 0, 0]] * len(inputs)
        return response({"model": MODEL, "embeddings": values})

    with pytest.raises(emb.EmbeddingError, match="dimensions changed"):
        run(handler)


def test_response_limit_and_redirect():
    def huge(_request):
        return httpx.Response(200, stream=Stream(b"x" * (emb.MAX_RESPONSE_BYTES + 1)))

    with pytest.raises(emb.EmbeddingError, match="size budget"):
        run(huge)

    def redirect(request):
        assert request.url.host == "127.0.0.1"
        return httpx.Response(302, headers={"Location": "https://example.com/"})

    with pytest.raises(emb.EmbeddingError):
        run(redirect)


def test_response_compression_rejected():
    with pytest.raises(emb.EmbeddingError, match="compressed"):
        run(lambda _: response(inventory(), headers={"Content-Encoding": "gzip"}))


def test_timeout_cancels_request(monkeypatch):
    monkeypatch.setattr(emb, "TIMEOUT_SECONDS", 0.01)

    async def handler(_request):
        await asyncio.sleep(1)
        return response(inventory())

    with pytest.raises(emb.EmbeddingError, match="timed out"):
        run(handler)


def test_per_role_limits_and_batch_bounds():
    rows = [{"id": f"{role}:1:{i}", "text": f"Fragment {i}"}
            for role in ("original", "revised") for i in range(1, 20)]
    sizes = []

    def handler(request):
        if request.url.path == "/api/embed":
            sizes.append(len(json.loads(request.content)["input"]))
        return good(request)

    result = run(handler, request=emb.parse_request(raw(rows)))
    assert sizes == [1, 16, 16, 6]
    assert result["candidate_count"] == 38
    for role, ids in result["ranks"].items():
        assert ids == [f"{role}:1:{i}" for i in range(1, 9)]


def test_vector_normalization_handles_extreme_values():
    vector = emb._unit_vector([1e308, 1e308], 2)
    assert vector[0] == pytest.approx(2 ** -0.5)


@pytest.mark.parametrize("question", ["😀" * 201, "a" + "😀" * 200, "\ud800"])
def test_question_budget_matches_browser_utf16(question):
    with pytest.raises(emb.EmbeddingError):
        emb.parse_request(raw(question=question))


@pytest.mark.parametrize("text", ["😀" * 451, "a" + "😀" * 450, "\udfff"])
def test_passage_budget_matches_browser_utf16(text):
    with pytest.raises(emb.EmbeddingError):
        emb.parse_request(raw([{"id": "original:1:1", "text": text}]))


def test_exact_utf16_boundary_preserves_literal_text_and_unicode():
    question = "😀" * 200
    text = "😀" * 450
    result = emb.parse_request(raw([{"id": "original:1:1", "text": text}], question=question))
    assert result.question == question
    assert result.passages[0].text == text


@pytest.mark.parametrize("kwargs", [
    {"model": None}, {"model": 123}, {"model": ["fixture:latest"]},
    {"digest": None}, {"digest": 123}, {"digest": b"a" * 64},
])
def test_invalid_model_metadata_fails_with_fixed_error_before_network(kwargs):
    with pytest.raises(emb.EmbeddingError):
        run(lambda _: pytest.fail("Unexpected network call"), **kwargs)


@pytest.mark.parametrize("duplicate", [
    {"name": MODEL, "model": "other:latest", "digest": DIGEST},
    {"name": MODEL, "digest": DIGEST},
    {"name": MODEL, "model": MODEL, "digest": "b" * 64},
    {"name": MODEL, "model": MODEL, "digest": DIGEST, "remote_host": "example.invalid"},
])
def test_any_duplicate_tag_prevents_inference(duplicate):
    def handler(req):
        assert req.url.path == "/api/tags"
        value = inventory()
        value["models"].append(duplicate)
        return response(value)
    with pytest.raises(emb.EmbeddingError, match="digest"):
        run(handler)


def test_duplicate_tag_after_inference_discards_entire_result():
    calls = []
    def handler(req):
        calls.append(req.url.path)
        if req.url.path == "/api/tags" and calls.count("/api/tags") == 2:
            value = inventory()
            value["models"].append({"name": MODEL, "model": "conflict:latest"})
            return response(value)
        return good(req)
    with pytest.raises(emb.EmbeddingError, match="digest"):
        run(handler)
    assert calls == ["/api/tags", "/api/embed", "/api/embed", "/api/tags"]


@pytest.mark.parametrize("headers", [
    {"Content-Type": "text/html"}, {"Content-Type": "application/jsonx"},
    {"Content-Length": "-1"}, {"Content-Length": "1, 2"},
    {"Content-Length": "1e2"}, {"Content-Length": "99999999999"},
    {"Content-Length": str(emb.MAX_RESPONSE_BYTES + 1)},
])
def test_rejects_invalid_response_headers_before_streaming(headers):
    class NeverRead(httpx.AsyncByteStream):
        async def __aiter__(self):
            pytest.fail("Invalid response body was consumed")
            yield b""
    with pytest.raises(emb.EmbeddingError):
        run(lambda _: httpx.Response(200, stream=NeverRead(), headers=headers))


def test_explicit_json_type_with_charset_is_supported():
    def handler(req):
        result = good(req)
        result.headers["Content-Type"] = "Application/JSON; charset=utf-8"
        return result
    assert run(handler)["candidate_count"] == len(ROWS)
