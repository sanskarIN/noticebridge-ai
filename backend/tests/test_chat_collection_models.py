"""Independent collection model protocol and CLI regression tests."""

import asyncio
import hashlib
import json

import httpx
import pytest

from noticebridge import chat_collection_models as collection
from noticebridge import chat_collection_models_cli as cli
from noticebridge import chat_pipeline
from noticebridge.chat_embeddings import EmbeddingError

CONFIG = {
    "embedding_model": "embedding:latest", "embedding_digest": "a" * 64,
    "answer_model": "answer:latest", "answer_digest": "b" * 64, "consent": True,
}
IDS = ["1" * 64, "2" * 64]


def request(text, question="Application fee?", role="original"):
    return chat_pipeline.encode({
        "format": chat_pipeline.FORMAT, "version": 1, "question": question,
        "passages": [{"id": role + ":1:1", "text": text}], "baseline": [role + ":1:1"],
    })


def manifest_value(requests):
    return {
        "format": collection.MANIFEST_FORMAT, "version": 1, "policy": collection.POLICY,
        "authority_verified": False, "question": "Application fee?", "part": 0, "mode": "full",
        "requests": [
            {"document_id": key, "request_sha256": hashlib.sha256(raw).hexdigest(),
             "filename": "noticebridge-collection-model-" + key + ".json", "bytes": len(raw)}
            for key, raw in zip(IDS, requests, strict=True)
        ],
        "skipped": [{"document_id": "3" * 64, "reason": "no_native_candidates"}],
    }


@pytest.fixture
def prepared(tmp_path):
    raw_requests = [request("Application fee: INR 500"), request("Application fee: INR 350")]
    value = manifest_value(raw_requests)
    raw = chat_pipeline.encode(value)
    manifest = collection.parse_manifest(raw)
    source = tmp_path / "manifest.json"
    source.write_bytes(raw)
    for entry, data in zip(manifest.requests, raw_requests, strict=True):
        (tmp_path / entry.filename).write_bytes(data)
    return manifest, source, raw_requests


def test_manifest_and_requests_are_admitted_in_exact_order(prepared, tmp_path):
    manifest, source, raw = prepared
    admitted = collection.read_requests(manifest, tmp_path)
    assert manifest.sha256 == hashlib.sha256(source.read_bytes()).hexdigest()
    assert [item.entry.document_id for item in admitted] == IDS
    assert [item.request.sha256 for item in admitted] == [
        hashlib.sha256(item).hexdigest() for item in raw
    ]
    assert manifest.skipped == ("3" * 64,)


@pytest.mark.parametrize("changes", [
    {"version": True}, {"authority_verified": True}, {"part": True}, {"part": 4},
    {"mode": "unknown"}, {"requests": []}, {"skipped": "bad"}, {"policy": "verified"},
    {"extra": "data"}, {"question": "\\ud800"}, {"question": ""},
])
def test_manifest_rejects_bad_outer_fields(changes):
    value = manifest_value([request("A"), request("B")])
    value.update(changes)
    with pytest.raises(EmbeddingError):
        collection.parse_manifest(chat_pipeline.encode(value))


@pytest.mark.parametrize("field,value", [
    ("filename", "../private.json"), ("filename", "/tmp/private.json"),
    ("document_id", "A" * 64), ("request_sha256", "bad"),
    ("bytes", True), ("bytes", 0), ("bytes", 3 * 1024 * 1024),
])
def test_manifest_rejects_bad_entry_fields(field, value):
    raw = manifest_value([request("A"), request("B")])
    raw["requests"][0][field] = value
    with pytest.raises(EmbeddingError):
        collection.parse_manifest(chat_pipeline.encode(raw))


def test_manifest_rejects_duplicate_id_and_noncanonical_encoding():
    raw = manifest_value([request("A"), request("B")])
    raw["skipped"][0]["document_id"] = IDS[0]
    with pytest.raises(EmbeddingError):
        collection.parse_manifest(chat_pipeline.encode(raw))
    raw = manifest_value([request("A"), request("B")])
    with pytest.raises(EmbeddingError):
        collection.parse_manifest(chat_pipeline.encode(raw).strip())
    with pytest.raises(EmbeddingError):
        collection.parse_manifest(chat_pipeline.encode(raw).replace(
            b'"version": 1,', b'"version": 1, "version": 1,',
        ))


def test_request_set_rejects_missing_changed_and_swapped_files(prepared, tmp_path):
    manifest, _, raw = prepared
    first = tmp_path / manifest.requests[0].filename
    first.write_bytes(raw[1])
    with pytest.raises(EmbeddingError):
        collection.read_requests(manifest, tmp_path)
    first.unlink()
    with pytest.raises(EmbeddingError):
        collection.read_requests(manifest, tmp_path)


@pytest.mark.parametrize("question,role", [
    ("Different question?", "original"), ("Application fee?", "revised"),
])
def test_request_must_match_manifest_question_and_single_role(question, role):
    requests = [request("A", question, role), request("B")]
    manifest = collection.parse_manifest(chat_pipeline.encode(manifest_value(requests)))
    with pytest.raises(EmbeddingError):
        collection.admit_request(manifest, manifest.requests[0], requests[0])


class Stream(httpx.AsyncByteStream):
    def __init__(self, value):
        self.value = value

    async def __aiter__(self):
        yield json.dumps(self.value).encode()


def reply(value):
    return httpx.Response(200, stream=Stream(value))


def handler(req):
    assert req.url.host == "127.0.0.1"
    if req.url.path == "/api/tags":
        return reply({"models": [
            {"name": CONFIG["embedding_model"], "digest": CONFIG["embedding_digest"]},
            {"name": CONFIG["answer_model"], "digest": CONFIG["answer_digest"]},
        ]})
    payload = json.loads(req.content)
    if req.url.path == "/api/embed":
        return reply({"model": CONFIG["embedding_model"],
                      "embeddings": [[1, 0] for _ in payload["input"]]})
    assert req.url.path == "/api/generate"
    candidates = json.loads(payload["prompt"])["candidates"]
    assert len(candidates) == 1
    return reply({
        "model": CONFIG["answer_model"], "done": True, "done_reason": "stop",
        "response": json.dumps({"status": "extract", "quotes": [
            {"id": candidates[0]["id"], "quote": candidates[0]["text"]},
        ]}),
    })


def test_collection_pipeline_keeps_requests_separate(prepared, tmp_path):
    manifest, _, _ = prepared
    admitted = collection.read_requests(manifest, tmp_path)
    result = asyncio.run(collection.run_collection(
        manifest, admitted, **CONFIG, _transport=httpx.MockTransport(handler),
    ))
    value = json.loads(result)
    assert value["manifest_sha256"] == manifest.sha256
    assert [row["document_id"] for row in value["results"]] == IDS
    assert value["authority_verified"] is False
    assert b"INR 500" not in result
    assert b"INR 350" not in result


def test_invalid_config_or_incomplete_set_never_invokes_model(prepared, tmp_path):
    manifest, _, _ = prepared
    admitted = collection.read_requests(manifest, tmp_path)
    for items, changes in [
        (admitted, {"consent": False}),
        (admitted, {"answer_digest": "invalid"}),
        (admitted[:1], {}),
        (tuple(reversed(admitted)), {}),
    ]:
        with pytest.raises(EmbeddingError):
            asyncio.run(collection.run_collection(
                manifest, items, **{**CONFIG, **changes},
                _transport=httpx.MockTransport(lambda _: pytest.fail("unexpected model call")),
            ))


def test_collection_cli_preserves_existing_output_on_failure(
    prepared, tmp_path, monkeypatch, capsys,
):
    _, source, _ = prepared
    output = tmp_path / "result.json"
    output.write_bytes(b"existing")

    async def fail(*args, **kwargs):
        raise EmbeddingError("private source text")

    monkeypatch.setattr(cli, "run_collection", fail)
    args = [str(source), "--request-directory", str(tmp_path), "--output", str(output),
            "--embedding-model", CONFIG["embedding_model"],
            "--embedding-digest", CONFIG["embedding_digest"],
            "--answer-model", CONFIG["answer_model"], "--answer-digest", CONFIG["answer_digest"],
            "--allow-local-processing"]
    assert cli.main(args) == 2
    assert output.read_bytes() == b"existing"
    assert "private source text" not in capsys.readouterr().err



def test_preflight_has_candidate_counts_and_no_private_text(prepared, tmp_path):
    manifest, _, _ = prepared
    admitted = collection.read_requests(manifest, tmp_path)
    raw = collection.preflight_collection(manifest, admitted)
    result = json.loads(raw)
    assert result["authority_verified"] is False
    assert result["manifest_sha256"] == manifest.sha256
    assert result["total_candidate_fragments"] == 2
    assert result["total_baseline_fragments"] == 2
    assert result["total_request_bytes"] == sum(item.entry.bytes for item in admitted)
    assert result["skipped_document_ids"] == ["3" * 64]
    assert [row["document_id"] for row in result["requests"]] == IDS
    assert all(row["physical_pages"] == [{"page": 1, "candidate_fragments": 1}]
               for row in result["requests"])
    assert b"INR 500" not in raw
    assert b"INR 350" not in raw
    assert b"Application fee" not in raw
    assert raw == collection.preflight_collection(manifest, admitted)


def test_preflight_refuses_incomplete_or_reordered_admission(prepared, tmp_path):
    manifest, _, _ = prepared
    admitted = collection.read_requests(manifest, tmp_path)
    for items in ((), admitted[:1], tuple(reversed(admitted))):
        with pytest.raises(EmbeddingError):
            collection.preflight_collection(manifest, items)


def test_preflight_cli_never_invokes_model(prepared, tmp_path, monkeypatch, capsys):
    manifest, source, _ = prepared
    output = tmp_path / "preflight.json"

    async def forbidden(*args, **kwargs):
        pytest.fail("model processing was invoked during preflight")

    monkeypatch.setattr(cli, "run_collection", forbidden)
    args = [str(source), "--request-directory", str(tmp_path),
            "--output", str(output), "--preflight-only"]
    assert cli.main(args) == 0
    assert output.read_bytes() == collection.preflight_collection(
        manifest, collection.read_requests(manifest, tmp_path),
    )
    assert "No model was invoked" in capsys.readouterr().out
    # An existing result may never be overwritten.
    before = output.read_bytes()
    assert cli.main(args) == 2
    assert output.read_bytes() == before


@pytest.mark.parametrize("extra", [
    ["--allow-local-processing"],
    ["--embedding-model", "embedding:latest"],
    ["--answer-digest", "b" * 64],
])
def test_preflight_rejects_processing_options(prepared, tmp_path, extra):
    _, source, _ = prepared
    output = tmp_path / "invalid.json"
    assert cli.main([
        str(source), "--request-directory", str(tmp_path),
        "--output", str(output), "--preflight-only", *extra,
    ]) == 2
    assert not output.exists()


def test_cli_processing_requires_complete_config_and_consent(prepared, tmp_path):
    _, source, _ = prepared
    output = tmp_path / "invalid.json"
    common = [str(source), "--request-directory", str(tmp_path), "--output", str(output)]
    assert cli.main(common) == 2
    assert cli.main([*common, "--allow-local-processing"]) == 2
    assert not output.exists()


def test_processing_failure_after_first_model_never_returns_partial_bundle(
    prepared, tmp_path, monkeypatch,
):
    manifest, _, _ = prepared
    admitted = collection.read_requests(manifest, tmp_path)
    calls = []

    async def fail_second(request, **kwargs):
        calls.append(request.sha256)
        if len(calls) == 2:
            raise EmbeddingError("second request failed")
        return {
            "request_sha256": request.sha256,
            "authority_verified": False,
            "ranking": {"model": CONFIG["embedding_model"],
                        "model_digest": CONFIG["embedding_digest"]},
            "extractive": {"model": CONFIG["answer_model"],
                           "model_digest": CONFIG["answer_digest"]},
        }

    monkeypatch.setattr(chat_pipeline, "run_pipeline", fail_second)
    with pytest.raises(EmbeddingError):
        asyncio.run(collection.run_collection(manifest, admitted, **CONFIG))
    assert calls == [item.request.sha256 for item in admitted]


def test_total_timeout_discards_batch(prepared, tmp_path, monkeypatch):
    manifest, _, _ = prepared
    admitted = collection.read_requests(manifest, tmp_path)

    async def slow(*args, **kwargs):
        await asyncio.sleep(1)

    monkeypatch.setattr(chat_pipeline, "run_pipeline", slow)
    monkeypatch.setattr(collection, "TIMEOUT_SECONDS", 0.001)
    with pytest.raises(EmbeddingError, match="timed out"):
        asyncio.run(collection.run_collection(manifest, admitted, **CONFIG))
