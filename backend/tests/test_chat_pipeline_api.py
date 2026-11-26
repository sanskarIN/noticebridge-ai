"""Opt-in local AI endpoint boundary; no real model runtime required."""

import asyncio
import hashlib

import httpx
import pytest

from noticebridge import api, body_limit
from noticebridge.chat_embeddings import EmbeddingError
from noticebridge.chat_pipeline import encode, selection_request

PATH = "/api/chat/pipeline"
HEADERS = {"X-NoticeBridge-Local-AI": "1", "Origin": "http://127.0.0.1:5173"}
FIELDS = {
    "embedding_model": "embedding:latest", "embedding_digest": "a" * 64,
    "answer_model": "answer:latest", "answer_digest": "b" * 64,
    "consent": "true",
}
REQUEST = encode({
    "format": "noticebridge-chat-pipeline-request", "version": 1,
    "question": "Application fee?",
    "passages": [{"id": "original:1:1", "text": "Application fee: INR 500"}],
    "baseline": ["original:1:1"],
})


async def async_post(data=None, headers=None, peer="127.0.0.1",
                     base_url="http://127.0.0.1:8000", payload=REQUEST,
                     filename="request.json"):
    fields = {**FIELDS, **(data or {})}
    transport = httpx.ASGITransport(app=api.app, client=(peer, 1234))
    async with httpx.AsyncClient(transport=transport, base_url=base_url) as client:
        return await client.post(
            PATH, data=fields, headers=HEADERS if headers is None else headers,
            files={"request_file": (filename, payload, "application/json")},
        )


def post(**kwargs):
    return asyncio.run(async_post(**kwargs))


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_AI", "1")
    calls = []

    async def model(request, **kwargs):
        calls.append((request, kwargs))
        ranking = {
            "format": "noticebridge-chat-embedding-result", "version": 1,
            "request_sha256": request.embedding.sha256,
            "model": kwargs["embedding_model"], "model_digest": kwargs["embedding_digest"],
            "dimension": 2, "candidate_count": 1, "ranks": {"original": ["original:1:1"]},
            "authority_verified": False,
        }
        selection = selection_request(request, ranking)
        return {
            "format": "noticebridge-chat-pipeline-result", "version": 1,
            "request_sha256": request.sha256, "ranking": ranking,
            "extractive": {
                "format": "noticebridge-chat-extractive-result", "version": 1,
                "request_sha256": selection.sha256,
                "model": kwargs["answer_model"], "model_digest": kwargs["answer_digest"],
                "proposal": {"status": "extract", "spans": [
                    {"id": "original:1:1", "start": 17, "end": 24},
                ]},
                "authority_verified": False,
            },
            "authority_verified": False,
        }

    monkeypatch.setattr(api, "run_pipeline", model)
    return calls


def test_local_ai_disabled_before_body_buffer(monkeypatch, enabled):
    monkeypatch.delenv("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_AI", raising=False)
    monkeypatch.setattr(body_limit, "SpooledTemporaryFile",
                        lambda **_: pytest.fail("disabled body was buffered"))
    assert post().status_code == 404
    assert enabled == []


@pytest.mark.parametrize("kwargs", [
    {"headers": {}},
    {"headers": {"X-NoticeBridge-Local-OCR": "1"}},
    {"headers": {**HEADERS, "Origin": "https://example.com"}},
    {"headers": {**HEADERS, "Origin": "null"}},
    {"peer": "192.0.2.20"},
    {"base_url": "http://example.com:8000"},
    {"base_url": "http://localhost:9000"},
])
def test_local_ai_boundary_rejects_before_buffering(monkeypatch, enabled, kwargs):
    monkeypatch.setattr(body_limit, "SpooledTemporaryFile",
                        lambda **_: pytest.fail("untrusted body was buffered"))
    assert post(**kwargs).status_code == 403
    assert enabled == []


def test_local_pipeline_canonical_result_preserves_nested_hashes(enabled):
    response = post()
    assert response.status_code == 200
    assert len(enabled) == 1
    parsed, config = enabled[0]
    assert config["consent"] is True
    assert parsed.sha256 == hashlib.sha256(REQUEST).hexdigest()
    result = response.json()
    assert response.content == encode(result)
    assert result["request_sha256"] == parsed.sha256
    assert result["ranking"]["request_sha256"] == parsed.embedding.sha256
    assert b"INR 500" not in response.content
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("data", [
    {"consent": "false"},
    {"embedding_model": "model:cloud"},
    {"answer_model": "https://example.com"},
    {"embedding_digest": "bad"},
    {"answer_digest": "bad"},
])
def test_invalid_configuration_does_not_invoke_model(enabled, data):
    assert post(data=data).status_code == 422
    assert enabled == []


def test_invalid_file_and_specific_upload_budget(monkeypatch, enabled):
    assert post(filename="request.txt").status_code == 415
    assert post(payload=b"{}").status_code == 422
    monkeypatch.setattr(body_limit, "MAX_CHAT_PIPELINE_BODY_BYTES", 16)
    assert post().status_code == 413
    assert enabled == []


def test_model_failure_returns_fixed_error_and_releases_slot(monkeypatch, enabled):
    async def fail(*_, **kwargs):
        raise EmbeddingError("private source text")

    monkeypatch.setattr(api, "run_pipeline", fail)
    response = post()
    assert response.status_code == 503
    assert "private" not in response.text
    assert not api.model_slots.locked()


def test_concurrent_pipeline_is_rejected_without_queueing(monkeypatch, enabled):
    async def scenario():
        started = asyncio.Event()
        finish = asyncio.Event()

        async def slow(*_, **kwargs):
            started.set()
            await finish.wait()
            raise EmbeddingError("failure")

        monkeypatch.setattr(api, "run_pipeline", slow)
        task = asyncio.create_task(async_post())
        await asyncio.wait_for(started.wait(), timeout=3)
        try:
            response = await async_post()
            assert response.status_code == 503
            assert "already processing" in response.text
        finally:
            finish.set()
            assert (await task).status_code == 503

    asyncio.run(scenario())
    assert not api.model_slots.locked()
