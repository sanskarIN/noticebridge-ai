"""CLI-level contracts for the experimental embedding and selection flows."""

import hashlib
import json

import pytest

from noticebridge import chat_embedding_cli, chat_selection_cli
from noticebridge.chat_embeddings import EmbeddingError

MODEL = "fixture:latest"
DIGEST = "a" * 64
CASES = [
    (chat_embedding_cli, "retrieve_local", "noticebridge-chat-embedding-request"),
    (chat_selection_cli, "select_local", "noticebridge-chat-selection-request"),
]


def setup_request(tmp_path, request_format):
    source = tmp_path / "request.json"
    source.write_bytes(json.dumps({
        "format": request_format, "version": 1, "question": "Application fee?",
        "passages": [{"id": "original:1:1", "text": "Private source text"}],
    }, indent=2).encode() + b"\n")
    return source


def args(source, output, *, consent=True):
    result = [
        str(source), "--output", str(output), "--model", MODEL, "--digest", DIGEST,
    ]
    if consent:
        result.append("--allow-local-processing")
    return result


@pytest.mark.parametrize("module,operation,request_format", CASES)
def test_cli_writes_canonical_result_without_source_text(
    tmp_path, monkeypatch, capsys, module, operation, request_format,
):
    source = setup_request(tmp_path, request_format)
    output = tmp_path / "result.json"
    expected = {
        "request_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "authority_verified": False,
    }

    async def fake(request, *, model, digest, consent):
        assert model == MODEL
        assert digest == DIGEST
        assert consent is True
        assert request.sha256 == expected["request_sha256"]
        return expected

    monkeypatch.setattr(module, operation, fake)
    assert module.main(args(source, output)) == 0
    assert output.read_bytes() == (json.dumps(expected, indent=2) + "\n").encode()
    assert b"Private source text" not in output.read_bytes()
    captured = capsys.readouterr()
    assert "Private source text" not in captured.out + captured.err
    assert "Application fee?" not in captured.out + captured.err
    assert not list(tmp_path.glob(".noticebridge-*.tmp"))


@pytest.mark.parametrize("module,operation,request_format", CASES)
def test_cli_checks_consent_and_existing_destination_before_model(
    tmp_path, monkeypatch, module, operation, request_format,
):
    source = setup_request(tmp_path, request_format)
    output = tmp_path / "result.json"

    async def forbidden(*_args, **_kwargs):
        pytest.fail("Model operation must not run")

    monkeypatch.setattr(module, operation, forbidden)
    assert module.main(args(source, output, consent=False)) == 2
    assert not output.exists()
    output.write_text("preserve", encoding="utf-8")
    assert module.main(args(source, output)) == 2
    assert output.read_text(encoding="utf-8") == "preserve"


@pytest.mark.parametrize("module,operation,request_format", CASES)
def test_cli_invalid_request_and_model_failure_leave_no_output(
    tmp_path, monkeypatch, capsys, module, operation, request_format,
):
    source = setup_request(tmp_path, request_format)
    output = tmp_path / "result.json"

    async def broken(*_args, **_kwargs):
        raise EmbeddingError("private model response and document text")

    monkeypatch.setattr(module, operation, broken)
    assert module.main(args(source, output)) == 2
    assert not output.exists()
    source.write_bytes(b'{"version":1,"version":1}')
    assert module.main(args(source, output)) == 2
    assert not output.exists()
    captured = capsys.readouterr()
    assert "private model response" not in captured.err
    assert str(source) not in captured.err


@pytest.mark.parametrize("module,operation,request_format", CASES)
def test_cli_atomic_publish_refuses_racing_output(
    tmp_path, monkeypatch, module, operation, request_format,
):
    source = setup_request(tmp_path, request_format)
    output = tmp_path / "result.json"

    async def racing(*_args, **_kwargs):
        output.write_text("other writer", encoding="utf-8")
        return {"authority_verified": False}

    monkeypatch.setattr(module, operation, racing)
    assert module.main(args(source, output)) == 2
    assert output.read_text(encoding="utf-8") == "other writer"
    assert not list(tmp_path.glob(".noticebridge-*.tmp"))
