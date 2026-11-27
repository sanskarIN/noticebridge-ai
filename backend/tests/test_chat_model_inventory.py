"""Bounded local-only model inventory tests; no real runtime is required."""

import asyncio
import json

import httpx
import pytest

from noticebridge import api, body_limit, chat_model_inventory as inventory
from noticebridge.chat_embeddings import EmbeddingError

DIGEST = "a" * 64
OTHER = "b" * 64
PATH = "/api/chat/models"
HEADERS = {
    "Origin": "http://127.0.0.1:5173",
    "X-NoticeBridge-Local-AI": "1",
}


def row(name="embedding:latest", digest=DIGEST, **metadata):
    return {"name": name, "model": name, "digest": digest, **metadata}


def report(rows):
    return inventory.sanitize_inventory({"models": rows})


def test_inventory_retains_only_valid_unambiguous_local_pins():
    rows = [
        row("z-model:latest", OTHER, details={"secret": "private runtime details"}),
        row("a-model:latest"),
        row("a-cloud:latest"),
        row("remote:latest", remote_model="vendor/model"),
        row("remote-host:latest", remote_host="remote.invalid"),
        row("duplicate:latest"),
        row("duplicate:latest", OTHER),
        row("same:latest"),
        row("same:latest"),
        row("mismatch:latest", model="different:latest"),
        row("malformed:latest", "not-a-digest"),
        row("bad/tag/path:latest"),
        {"name": 5, "digest": DIGEST},
        {"name": "missing-digest:latest"},
        {"name": "missing-model:latest", "digest": DIGEST},
        None,
    ]
    result = report(rows)
    assert result == {
        "format": inventory.FORMAT,
        "version": 1,
        "runtime_reported_only": True,
        "authority_verified": False,
        "reported_count": len(rows),
        "excluded_count": len(rows) - 3,
        "models": [
            {"name": "a-model:latest", "digest": DIGEST},
            {"name": "missing-model:latest", "digest": DIGEST},
            {"name": "z-model:latest", "digest": OTHER},
        ],
    }
    assert "private runtime details" not in json.dumps(result)
    assert "remote.invalid" not in json.dumps(result)
    assert report(list(reversed(rows))) == result


@pytest.mark.parametrize("value", [
    None, [], {}, {"models": {}}, {"models": "not a list"},
    {"models": [None] * (inventory.MAX_MODELS + 1)},
])
def test_invalid_inventory_structure_fails_closed(value):
    with pytest.raises(EmbeddingError):
        inventory.sanitize_inventory(value)


def test_empty_inventory_is_valid_but_does_not_attest_availability():
    assert report([])["models"] == []
    assert report([])["reported_count"] == 0
    assert report([row("remote:latest", remote_host="example.invalid")])["excluded_count"] == 1


def test_maximum_inventory_has_bounded_canonical_ascii_response():
    rows = [row(f"namespace/{'x' * 54}{i:04d}:latest") for i in range(inventory.MAX_MODELS)]
    result = report(rows)
    assert len(result["models"]) == inventory.MAX_MODELS
    assert len(inventory.encode(result)) <= inventory.MAX_INVENTORY_BYTES
    assert all(set(model) == {"name", "digest"} for model in result["models"])


class Stream(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        yield self.data


def response(value, status=200, headers=None):
    return httpx.Response(
        status, stream=Stream(json.dumps(value).encode()), headers=headers,
    )


def read(handler, consent=True):
    return asyncio.run(inventory.list_local_models(
        consent=consent, _transport=httpx.MockTransport(handler),
    ))


def test_only_fixed_read_only_runtime_call_is_made():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        assert request.method == "GET"
        assert request.url.host == "127.0.0.1"
        assert request.url.port == 11434
        assert request.url.path == "/api/tags"
        assert request.url.query == b""
        assert request.content == b""
        assert request.headers["accept-encoding"] == "identity"
        return response({"models": [row()]})

    assert read(handler)["models"] == [{"name": "embedding:latest", "digest": DIGEST}]
    assert calls == ["http://127.0.0.1:11434/api/tags"]


def test_no_consent_no_network():
    def handler(_):
        pytest.fail("Inventory contacted without explicit consent")

    for consent in [False, None, 1, "true"]:
        with pytest.raises(EmbeddingError):
            read(handler, consent)


@pytest.mark.parametrize("status", [301, 302, 401, 403, 404, 429, 500, 503])
def test_runtime_error_and_redirect_are_rejected(status):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return response({}, status=status, headers={"Location": "https://example.invalid"})

    with pytest.raises(EmbeddingError):
        read(handler)
    assert calls == ["http://127.0.0.1:11434/api/tags"]


def test_compressed_oversized_duplicate_and_malformed_payloads():
    invalid = [
        lambda _: response({"models": []}, headers={"Content-Encoding": "gzip"}),
        lambda _: httpx.Response(200, stream=Stream(b"x" * (2 * 1024 * 1024 + 1))),
        lambda _: httpx.Response(200, stream=Stream(b'{"models":[],"models":[]}')),
        lambda _: httpx.Response(200, stream=Stream(b"\xff")),
    ]
    for handler in invalid:
        with pytest.raises(EmbeddingError):
            read(handler)


def test_timeout_is_bounded_and_does_not_expose_runtime_failure(monkeypatch):
    monkeypatch.setattr(inventory, "TIMEOUT_SECONDS", 0.01)

    async def handler(_):
        await asyncio.sleep(1)
        return response({"models": []})

    with pytest.raises(EmbeddingError, match="inventory unavailable"):
        read(handler)


async def async_get(headers=None, peer="127.0.0.1", base_url="http://127.0.0.1:8000",
                    path=PATH, method="GET"):
    transport = httpx.ASGITransport(app=api.app, client=(peer, 1234))
    async with httpx.AsyncClient(transport=transport, base_url=base_url) as client:
        return await client.request(
            method, path, headers=HEADERS if headers is None else headers,
        )


def get(**kwargs):
    return asyncio.run(async_get(**kwargs))


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_AI", "1")
    calls = []

    async def list_models(*, consent):
        calls.append(consent)
        return report([row()])

    monkeypatch.setattr(api, "list_local_models", list_models)
    return calls


def test_inventory_disabled_without_opt_in(monkeypatch, enabled):
    monkeypatch.delenv("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_AI", raising=False)
    assert get().status_code == 404
    assert enabled == []


@pytest.mark.parametrize("kwargs", [
    {"headers": {}},
    {"headers": {"X-NoticeBridge-Local-OCR": "1"}},
    {"headers": {**HEADERS, "Origin": "https://example.invalid"}},
    {"headers": {**HEADERS, "Origin": "null"}},
    {"headers": {"X-NoticeBridge-Local-AI": "1", "Sec-Fetch-Site": "cross-site"}},
    {"peer": "192.0.2.7"},
    {"base_url": "http://example.invalid:8000"},
    {"base_url": "http://127.0.0.1:9999"},
])
def test_inventory_boundary_rejects_before_runtime_call(enabled, kwargs):
    assert get(**kwargs).status_code == 403
    assert enabled == []


def test_inventory_has_no_upload_spool_and_returns_no_store(monkeypatch, enabled):
    monkeypatch.setattr(
        body_limit, "SpooledTemporaryFile",
        lambda **_: pytest.fail("Inventory buffered an upload"),
    )
    result = get()
    assert result.status_code == 200
    assert result.json() == report([row()])
    assert result.content == inventory.encode(result.json())
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["x-content-type-options"] == "nosniff"
    assert enabled == [True]


def test_inventory_does_not_accept_parameters_or_non_get_methods(enabled):
    assert get(path=PATH + "?model=remote").status_code == 400
    assert get(method="POST").status_code == 405
    assert enabled == []


def test_inventory_failure_releases_shared_model_slot(monkeypatch, enabled):
    async def fail(**_):
        raise EmbeddingError("Private runtime details")

    monkeypatch.setattr(api, "list_local_models", fail)
    result = get()
    assert result.status_code == 503
    assert "Private runtime details" not in result.text
    assert not api.model_slots.locked()


def test_inventory_rejects_while_inference_slot_held(enabled):
    async def scenario():
        async with api.model_slots:
            result = await async_get()
            assert result.status_code == 503

    asyncio.run(scenario())
    assert enabled == []
    assert not api.model_slots.locked()


def test_inventory_concurrency_is_bounded_without_queueing(monkeypatch, enabled):
    async def scenario():
        started = asyncio.Event()
        finish = asyncio.Event()

        async def slow(*, consent):
            assert consent is True
            started.set()
            await finish.wait()
            return report([row()])

        monkeypatch.setattr(api, "list_local_models", slow)
        first = asyncio.create_task(async_get())
        await asyncio.wait_for(started.wait(), timeout=3)
        try:
            assert (await async_get()).status_code == 503
        finally:
            finish.set()
            assert (await first).status_code == 200

    asyncio.run(scenario())
    assert not api.model_slots.locked()
