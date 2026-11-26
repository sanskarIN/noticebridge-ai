"""Pipeline protocol, mocked local model runtime, and atomic output regression tests."""

import asyncio
import hashlib
import json

import httpx
import pytest

from noticebridge import chat_pipeline as pipeline
from noticebridge import chat_pipeline_cli
from noticebridge.chat_embeddings import EmbeddingError

EMBED = "embedding:latest"
ANSWER = "answer:latest"
EMBED_DIGEST = "a" * 64
ANSWER_DIGEST = "b" * 64
ROWS = [
    {"id": "original:1:1", "text": "😀 Application fee: INR 500 unless exempt."},
    {"id": "original:2:1", "text": "Eligibility: Class 12"},
    {"id": "revised:1:1", "text": "Application fee: INR 350"},
]
BASELINE = ["original:1:1", "revised:1:1"]


def fixture(**changes):
    return pipeline.encode({
        "format": pipeline.FORMAT, "version": 1, "question": "Application fee?",
        "passages": ROWS, "baseline": BASELINE, **changes,
    })


def request(**changes):
    return pipeline.parse_request(fixture(**changes))


def test_request_reconstructs_embedding_bytes_and_hash():
    parsed = request()
    expected = pipeline.encode({
        "format": "noticebridge-chat-embedding-request", "version": 1,
        "question": "Application fee?", "passages": ROWS,
    })
    assert parsed.embedding.sha256 == hashlib.sha256(expected).hexdigest()
    assert parsed.sha256 == hashlib.sha256(fixture()).hexdigest()
    assert parsed.baseline == tuple(BASELINE)


@pytest.mark.parametrize("changes", [
    {"version": True},
    {"format": "unknown"},
    {"baseline": ["original:3:1"]},
    {"baseline": ["original:1:1", "original:1:1"]},
    {"baseline": ["revised:2:1"]},
    {"baseline": [1]},
    {"baseline": "original:1:1"},
    {"baseline": None},
    {"passages": []},
    {"passages": [ROWS[0], ROWS[0]]},
    {"extra": "untrusted"},
])
def test_bad_request_rejected(changes):
    with pytest.raises(EmbeddingError):
        request(**changes)


def test_request_duplicate_keys_and_surrogates_rejected():
    raw = fixture().replace(b'"version": 1,', b'"version": 1, "version": 1,')
    with pytest.raises(EmbeddingError):
        pipeline.parse_request(raw)
    raw = fixture().replace(b'Application fee?', b'\\ud800')
    with pytest.raises(EmbeddingError):
        pipeline.parse_request(raw)


def test_selection_preserves_every_baseline_and_independent_role_budget():
    rows = [
        {"id": f"{role}:1:{i}", "text": f"Printed text {i}"}
        for role in ("original", "revised") for i in range(1, 16)
    ]
    baseline = [
        f"{role}:1:{i}" for role in ("original", "revised") for i in range(10, 16)
    ]
    req = request(passages=rows, baseline=baseline)
    ranking = {"ranks": {
        role: [f"{role}:1:{i}" for i in range(1, 9)] for role in ("original", "revised")
    }}
    selection = pipeline.selection_request(req, ranking)
    ids = [row.id for row in selection.passages]
    assert ids[:12] == baseline
    assert len(ids) == 24
    assert set(baseline) <= set(ids)
    assert sum(key.startswith("original:") for key in ids) == 12


def test_baseline_budget_is_checked_per_role():
    rows = [{"id": f"original:1:{i}", "text": "Text"} for i in range(1, 8)]
    with pytest.raises(EmbeddingError):
        request(passages=rows, baseline=[row["id"] for row in rows])


class Stream(httpx.AsyncByteStream):
    def __init__(self, value):
        self.value = value

    async def __aiter__(self):
        yield json.dumps(self.value).encode()


def reply(value):
    return httpx.Response(200, stream=Stream(value))


def inventory():
    return {"models": [
        {"name": EMBED, "model": EMBED, "digest": EMBED_DIGEST},
        {"name": ANSWER, "model": ANSWER, "digest": ANSWER_DIGEST},
    ]}


def run(handler, **changes):
    args = dict(embedding_model=EMBED, embedding_digest=EMBED_DIGEST,
                answer_model=ANSWER, answer_digest=ANSWER_DIGEST, consent=True)
    args.update(changes)
    return asyncio.run(pipeline.run_pipeline(
        request(), _transport=httpx.MockTransport(handler), **args,
    ))


def model_handler(req, quote="INR 500", status="extract"):
    assert req.url.host == "127.0.0.1"
    if req.url.path == "/api/tags":
        return reply(inventory())
    payload = json.loads(req.content)
    if req.url.path == "/api/embed":
        assert payload["model"] == EMBED
        assert payload["truncate"] is False
        return reply({"model": EMBED, "embeddings": [[1, 0] for _ in payload["input"]]})
    assert req.url.path == "/api/generate"
    assert payload["model"] == ANSWER
    candidates = json.loads(payload["prompt"])["candidates"]
    assert [row["id"] for row in candidates][:2] == BASELINE
    quotes = [{"id": "original:1:1", "quote": quote}] if status == "extract" else []
    return reply({
        "model": ANSWER, "done": True, "done_reason": "stop",
        "response": json.dumps({"status": status, "quotes": quotes}),
    })


def test_full_pipeline_binds_nested_requests_and_offsets():
    calls = []

    def handler(req):
        calls.append(req.url.path)
        return model_handler(req)

    result = run(handler)
    assert calls == ["/api/tags", "/api/embed", "/api/embed", "/api/tags",
                     "/api/tags", "/api/generate", "/api/tags"]
    assert result["request_sha256"] == request().sha256
    assert result["ranking"]["request_sha256"] == request().embedding.sha256
    selection = pipeline.selection_request(request(), result["ranking"])
    assert result["extractive"]["request_sha256"] == selection.sha256
    span = result["extractive"]["proposal"]["spans"][0]
    assert span == {"id": "original:1:1", "start": 20, "end": 27}
    assert b"INR 500" not in pipeline.encode(result)
    assert result["authority_verified"] is False


def test_abstention_is_valid_and_fabricated_quote_fails_closed():
    result = run(lambda req: model_handler(req, status="insufficient"))
    assert result["extractive"]["proposal"] == {"status": "insufficient", "spans": []}
    with pytest.raises(EmbeddingError):
        run(lambda req: model_handler(req, quote="INR 999"))


@pytest.mark.parametrize("changes", [
    {"consent": False}, {"answer_model": "remote:cloud"}, {"answer_digest": "invalid"},
    {"embedding_model": "https://example.com"},
])
def test_invalid_configuration_never_calls_local_model(changes):
    with pytest.raises(EmbeddingError):
        run(lambda _: pytest.fail("unexpected model call"), **changes)


def test_first_stage_failure_never_invokes_generation():
    def handler(req):
        if req.url.path == "/api/tags":
            return reply(inventory())
        assert req.url.path == "/api/embed"
        return reply({"model": EMBED, "embeddings": [[0, 0]]})

    with pytest.raises(EmbeddingError):
        run(handler)


def test_outer_deadline(monkeypatch):
    monkeypatch.setattr(pipeline, "TIMEOUT_SECONDS", 0.01)

    async def handler(_):
        await asyncio.sleep(1)
        return reply(inventory())

    with pytest.raises(EmbeddingError, match="timed out"):
        run(handler)


def test_cli_does_not_publish_partial_result(tmp_path, monkeypatch, capsys):
    source = tmp_path / "private.json"
    source.write_bytes(fixture())
    output = tmp_path / "result.json"

    async def fail(*args, **kwargs):
        raise EmbeddingError("private source")

    monkeypatch.setattr(chat_pipeline_cli, "run_pipeline", fail)
    args = [str(source), "--output", str(output), "--embedding-model", EMBED,
            "--embedding-digest", EMBED_DIGEST, "--answer-model", ANSWER,
            "--answer-digest", ANSWER_DIGEST, "--allow-local-processing"]
    assert chat_pipeline_cli.main(args) == 2
    assert not output.exists()
    assert "private source" not in capsys.readouterr().err
    output.write_bytes(b"existing")
    assert chat_pipeline_cli.main(args) == 2
    assert output.read_bytes() == b"existing"
