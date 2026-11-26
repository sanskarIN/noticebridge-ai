"""Single opt-in local retrieval and extractive proposal workflow.

The browser independently replays the candidate selection contract and
checks all result identities and offsets. Nothing here establishes truth.
"""

import asyncio
import hashlib
import json
from dataclasses import dataclass

import httpx

from . import chat_embeddings, chat_extractive, chat_selection
from .chat_embeddings import EmbeddingError, _decode, _object, validate_model

FORMAT = "noticebridge-chat-pipeline-request"
RESULT = "noticebridge-chat-pipeline-result"
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_BASELINE_PER_ROLE = 6
TIMEOUT_SECONDS = 80


def encode(value: dict) -> bytes:
    try:
        return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    except (UnicodeError, ValueError, RecursionError):
        raise EmbeddingError("Invalid pipeline encoding.") from None


@dataclass(frozen=True)
class PipelineRequest:
    embedding: chat_embeddings.Request
    baseline: tuple[str, ...]
    sha256: str


def parse_request(raw: bytes) -> PipelineRequest:
    value = _object(_decode(raw, MAX_REQUEST_BYTES), {
        "format", "version", "question", "passages", "baseline",
    })
    if value["format"] != FORMAT or type(value["version"]) is not int or value["version"] != 1:
        raise EmbeddingError("Unsupported pipeline request.")
    # Reuse the existing validation for every source identity and text.
    embedding = chat_embeddings.parse_request(encode({
        "format": chat_embeddings.FORMAT, "version": 1,
        "question": value["question"], "passages": value["passages"],
    }))
    baseline = value["baseline"]
    allowed = {row.id for row in embedding.passages}
    if not isinstance(baseline, list) or len(baseline) > 2 * MAX_BASELINE_PER_ROLE:
        raise EmbeddingError("Invalid baseline budget.")
    seen = set()
    counts = {"original": 0, "revised": 0}
    for key in baseline:
        if not isinstance(key, str) or key not in allowed or key in seen:
            raise EmbeddingError("Unknown or repeated baseline evidence.")
        seen.add(key)
        role = key.split(":", 1)[0]
        counts[role] += 1
        if counts[role] > MAX_BASELINE_PER_ROLE:
            raise EmbeddingError("Per-source baseline budget exceeded.")
    canonical = encode({
        "format": FORMAT, "version": 1, "question": embedding.question,
        "passages": [{"id": row.id, "text": row.text} for row in embedding.passages],
        "baseline": baseline,
    })
    if raw != canonical:
        raise EmbeddingError("Noncanonical pipeline request.")
    return PipelineRequest(embedding, tuple(baseline), hashlib.sha256(raw).hexdigest())


def selection_request(request: PipelineRequest, ranking: dict) -> chat_selection.SelectionRequest:
    """Baseline first, then validated dense ranks, independently per role."""
    sources = {row.id: row for row in request.embedding.passages}
    ranks = ranking["ranks"]
    chosen = []
    seen = set()
    counts = {"original": 0, "revised": 0}
    for key in [*request.baseline, *ranks.get("original", []), *ranks.get("revised", [])]:
        if key not in sources:
            raise EmbeddingError("Unknown ranked evidence.")
        if key in seen:
            continue
        seen.add(key)
        role = key.split(":", 1)[0]
        if counts[role] >= chat_selection.MAX_CANDIDATES // 2:
            continue
        counts[role] += 1
        chosen.append({"id": key, "text": sources[key].text})
    if not all(key in {row["id"] for row in chosen} for key in request.baseline):
        raise EmbeddingError("Baseline evidence omitted.")
    return chat_selection.parse_request(encode({
        "format": chat_selection.FORMAT, "version": 1,
        "question": request.embedding.question, "passages": chosen,
    }))


async def run_pipeline(
    request: PipelineRequest, *, embedding_model: str, embedding_digest: str,
    answer_model: str, answer_digest: str, consent: bool,
    _transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    if consent is not True:
        raise EmbeddingError("Explicit local-processing consent is required.")
    # Validate both configurations before sending any private source text.
    validate_model(embedding_model, embedding_digest)
    validate_model(answer_model, answer_digest)
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            ranking = await chat_embeddings.retrieve_local(
                request.embedding, model=embedding_model, digest=embedding_digest,
                consent=True, _transport=_transport,
            )
            selected = selection_request(request, ranking)
            proposal = await chat_extractive.extract_local(
                selected, model=answer_model, digest=answer_digest,
                consent=True, _transport=_transport,
            )
    except TimeoutError:
        raise EmbeddingError("Local pipeline timed out.") from None
    return {
        "format": RESULT, "version": 1, "request_sha256": request.sha256,
        "ranking": ranking, "extractive": proposal,
        "authority_verified": False,
    }
