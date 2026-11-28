"""Opt-in local embedding experiment, not a public API or verified answer engine.

Only an explicitly approved local Ollama installation is supported.
An installed model digest is checked before and after inference. This is
a configuration check, not attestation of the runtime or its network policy.
"""

import asyncio
import hashlib
import math
import re
from dataclasses import dataclass

import httpx

from .semantic import _decode_model_json

BASE_URL = "http://127.0.0.1:11434"
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_PASSAGES = 512
MAX_DIMENSIONS = 2048
BATCH_SIZE = 16
MAX_RESULTS_PER_ROLE = 8
TIMEOUT_SECONDS = 30
MODEL_NAME = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?"
    r":[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"
)
DIGEST = re.compile(r"[a-f0-9]{64}")
PASSAGE_ID = re.compile(r"(original|revised):([1-9][0-9]?):([1-9][0-9]{0,5})")
FORMAT = "noticebridge-chat-embedding-request"


class EmbeddingError(ValueError):
    """Fixed-message error; never expose untrusted response or document text."""


@dataclass(frozen=True)
class Candidate:
    id: str
    text: str


@dataclass(frozen=True)
class Request:
    question: str
    passages: tuple[Candidate, ...]
    sha256: str


def _text(value: object, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise EmbeddingError("Invalid text length.")
    try:
        # Match browser String.length, which counts UTF-16 code units.
        if len(value.encode("utf-16-le", errors="strict")) // 2 > limit:
            raise EmbeddingError("Invalid text length.")
    except UnicodeError:
        raise EmbeddingError("Invalid text encoding.") from None
    return value


def _object(value: object, keys: set[str]) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        raise EmbeddingError("Unexpected request structure.")
    return value


def _decode(raw: bytes, limit: int) -> object:
    if not raw or len(raw) > limit:
        raise EmbeddingError("JSON exceeds its size budget.")
    try:
        return _decode_model_json(raw)
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        raise EmbeddingError("Invalid JSON.") from None


def parse_request(raw: bytes) -> Request:
    value = _object(_decode(raw, MAX_INPUT_BYTES), {
        "format", "version", "question", "passages",
    })
    if value["format"] != FORMAT or type(value["version"]) is not int or value["version"] != 1:
        raise EmbeddingError("Unsupported request format.")
    question = _text(value["question"], 400)
    rows = value["passages"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_PASSAGES:
        raise EmbeddingError("Candidate budget exceeded.")
    seen = set()
    passages = []
    for raw_row in rows:
        row = _object(raw_row, {"id", "text"})
        key = row["id"]
        match = PASSAGE_ID.fullmatch(key) if isinstance(key, str) else None
        if not match or int(match[2]) > 80 or key in seen:
            raise EmbeddingError("Invalid or duplicate candidate identity.")
        seen.add(key)
        passages.append(Candidate(key, _text(row["text"], 900)))
    return Request(question, tuple(passages), hashlib.sha256(raw).hexdigest())


def validate_model(model: str, digest: str) -> None:
    if (not isinstance(model, str) or len(model) > 96
            or not MODEL_NAME.fullmatch(model) or "cloud" in model.casefold()):
        raise EmbeddingError("Specify an installed local embedding model.")
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise EmbeddingError("Specify the installed model's exact SHA-256 digest.")


async def _json_response(client: httpx.AsyncClient, method: str, path: str, **kwargs) -> object:
    # No user-supplied URL; redirect responses and environment proxies are disabled.
    if (method, path) not in {
        ("GET", "/api/tags"), ("POST", "/api/embed"), ("POST", "/api/generate"),
    }:
        raise EmbeddingError("Invalid local endpoint.")
    async with client.stream(method, BASE_URL + path, **kwargs) as response:
        if response.status_code != 200:
            raise EmbeddingError("Local model service rejected the request.")
        content = bytearray()
        # Do not negotiate compressed data or accept compressed response bodies.
        if response.headers.get("content-encoding", "identity").lower() != "identity":
            raise EmbeddingError("Unexpected compressed response.")
        # Some local runtime versions omit Content-Type. Reject an explicitly
        # incompatible type, but continue validating bounded JSON itself.
        media_type = response.headers.get("content-type")
        if media_type is not None and media_type.split(";", 1)[0].strip().lower() != "application/json":
            raise EmbeddingError("Unexpected local response type.")
        declared = response.headers.get("content-length")
        if declared is not None and (
            not re.fullmatch(r"[0-9]{1,10}", declared) or int(declared) > MAX_RESPONSE_BYTES
        ):
            raise EmbeddingError("Local response exceeds its size budget.")
        async for part in response.aiter_raw(chunk_size=16384):
            if len(content) + len(part) > MAX_RESPONSE_BYTES:
                raise EmbeddingError("Local response exceeds its size budget.")
            content.extend(part)
    return _decode(bytes(content), MAX_RESPONSE_BYTES)


async def _check_pin(client: httpx.AsyncClient, model: str, digest: str) -> None:
    raw = await _json_response(client, "GET", "/api/tags")
    rows = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(rows, list) or len(rows) > 1024:
        raise EmbeddingError("Invalid local model inventory.")
    # Reject every duplicate name, even if a duplicate reports a mismatched
    # model field. Discovery already excludes all ambiguous tags.
    matches = [row for row in rows if isinstance(row, dict) and row.get("name") == model]
    if (len(matches) != 1 or matches[0].get("model", model) != model
            or matches[0].get("digest") != digest):
        raise EmbeddingError("Installed model does not match the requested digest.")
    # Remote models may have local manifests. Require local-only configuration
    # separately; inventory inspection cannot prove absence of cloud execution.
    if matches[0].get("remote_model") or matches[0].get("remote_host"):
        raise EmbeddingError("Remote model metadata is not allowed.")


def _unit_vector(raw: object, dimension: int | None) -> tuple[float, ...]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_DIMENSIONS:
        raise EmbeddingError("Invalid vector dimensions.")
    if dimension is not None and len(raw) != dimension:
        raise EmbeddingError("Embedding dimensions changed.")
    values = []
    for value in raw:
        if type(value) not in (int, float):
            raise EmbeddingError("Invalid vector number.")
        try:
            number = float(value)
        except (OverflowError, ValueError):
            raise EmbeddingError("Invalid vector number.") from None
        if not math.isfinite(number):
            raise EmbeddingError("Invalid vector number.")
        values.append(number)
    scale = max(abs(value) for value in values)
    if scale == 0:
        raise EmbeddingError("Zero embedding vector.")
    scaled = [value / scale for value in values]
    norm = math.sqrt(math.fsum(value * value for value in scaled))
    return tuple(value / norm for value in scaled)


async def _embed(
    client: httpx.AsyncClient, model: str, texts: list[str], dimension: int | None,
) -> list[tuple[float, ...]]:
    raw = await _json_response(client, "POST", "/api/embed", json={
        "model": model, "input": texts, "truncate": False,
    })
    rows = raw.get("embeddings") if isinstance(raw, dict) else None
    if not isinstance(raw, dict) or raw.get("model") != model:
        raise EmbeddingError("Unexpected embedding model.")
    if not isinstance(rows, list) or len(rows) != len(texts):
        raise EmbeddingError("Embedding response cardinality mismatch.")
    result = []
    for row in rows:
        vector = _unit_vector(row, dimension)
        dimension = len(vector)
        result.append(vector)
    return result


def _rank_key(row: tuple[str, float]) -> tuple:
    role, page, ordinal = row[0].split(":")
    return (-row[1], role, int(page), int(ordinal))


async def _retrieve(client: httpx.AsyncClient, request: Request, model: str, digest: str) -> dict:
    await _check_pin(client, model, digest)
    query = (await _embed(client, model, [request.question], None))[0]
    scores = []
    for start in range(0, len(request.passages), BATCH_SIZE):
        batch = request.passages[start:start + BATCH_SIZE]
        vectors = await _embed(client, model, [row.text for row in batch], len(query))
        for row, vector in zip(batch, vectors, strict=True):
            score = math.fsum(a * b for a, b in zip(query, vector, strict=True))
            scores.append((row.id, max(-1.0, min(1.0, score))))
    await _check_pin(client, model, digest)
    ranked = sorted(scores, key=_rank_key)
    # Reserve independent per-source budgets; never treat similarity as
    # confidence or output an answer. IDs are reconstructed from request data.
    roles = {}
    for role in ("original", "revised"):
        ids = [key for key, _ in ranked if key.startswith(role + ":")]
        if ids:
            roles[role] = ids[:MAX_RESULTS_PER_ROLE]
    return {
        "format": "noticebridge-chat-embedding-result",
        "version": 1,
        "request_sha256": request.sha256,
        "model": model,
        "model_digest": digest,
        "dimension": len(query),
        "candidate_count": len(request.passages),
        "ranks": roles,
        "authority_verified": False,
    }


async def retrieve_local(
    request: Request, *, model: str, digest: str, consent: bool,
    _transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Bound total wall time for local calls; no partial ranking on failure."""
    if consent is not True:
        raise EmbeddingError("Explicit local-processing consent is required.")
    validate_model(model, digest)
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(10.0), trust_env=False, follow_redirects=False,
                headers={"Accept-Encoding": "identity"}, transport=_transport,
            ) as client:
                return await _retrieve(client, request, model, digest)
    except (httpx.HTTPError, TimeoutError, OSError):
        raise EmbeddingError("Local embedding service failed or timed out.") from None
