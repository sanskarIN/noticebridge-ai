"""Run independent collection model requests from a canonical browser manifest.

All inputs are admitted before any model call. The manifest is an identity
and size contract, not an attestation of the underlying documents or models.
"""

import asyncio
import hashlib
from dataclasses import dataclass
from pathlib import Path

import httpx

from . import chat_pipeline
from .chat_embeddings import DIGEST, EmbeddingError, _decode, _object, _text, validate_model

MANIFEST_FORMAT = "noticebridge-collection-model-manifest"
RESULT_FORMAT = "noticebridge-collection-model-results"
POLICY = (
    "Independent optional extractive proposals; not verified answers "
    "or official notice authority."
)
MAX_MANIFEST_BYTES = 32 * 1024
MAX_COLLECTION_REQUESTS = 6
MAX_COLLECTION_BYTES = 6 * 1024 * 1024
MAX_RESULT_BYTES = 800 * 1024
TIMEOUT_SECONDS = 500


@dataclass(frozen=True)
class Entry:
    document_id: str
    request_sha256: str
    filename: str
    bytes: int


@dataclass(frozen=True)
class Manifest:
    question: str
    part: int
    mode: str
    requests: tuple[Entry, ...]
    skipped: tuple[str, ...]
    sha256: str


@dataclass(frozen=True)
class Admitted:
    entry: Entry
    request: chat_pipeline.PipelineRequest


def invalid() -> None:
    raise EmbeddingError("Invalid collection model manifest or request set.")


def hash_value(value: object) -> str:
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        invalid()
    return value


def entry_value(entry: Entry) -> dict:
    return {
        "document_id": entry.document_id,
        "request_sha256": entry.request_sha256,
        "filename": entry.filename,
        "bytes": entry.bytes,
    }


def parse_manifest(raw: bytes) -> Manifest:
    value = _object(_decode(raw, MAX_MANIFEST_BYTES), {
        "format", "version", "policy", "authority_verified", "question", "part",
        "mode", "requests", "skipped",
    })
    if (
        value["format"] != MANIFEST_FORMAT
        or type(value["version"]) is not int or value["version"] != 1
        or value["policy"] != POLICY or value["authority_verified"] is not False
        or value["mode"] not in ("full", "shortlist")
        or type(value["part"]) is not int or not 0 <= value["part"] <= 3
    ):
        invalid()
    question = _text(value["question"], 400)
    requests, skipped = value["requests"], value["skipped"]
    if (
        not isinstance(requests, list) or not isinstance(skipped, list)
        or not 1 <= len(requests) <= MAX_COLLECTION_REQUESTS
        or len(requests) + len(skipped) > MAX_COLLECTION_REQUESTS
    ):
        invalid()
    seen: set[str] = set()
    entries = []
    total = 0
    for item in requests:
        row = _object(item, {"document_id", "request_sha256", "filename", "bytes"})
        document_id = hash_value(row["document_id"])
        digest = hash_value(row["request_sha256"])
        filename = "noticebridge-collection-model-" + document_id + ".json"
        amount = row["bytes"]
        if (
            document_id in seen or row["filename"] != filename
            or type(amount) is not int or not 1 <= amount <= chat_pipeline.MAX_REQUEST_BYTES
        ):
            invalid()
        seen.add(document_id)
        total += amount
        entries.append(Entry(document_id, digest, filename, amount))
    if total > MAX_COLLECTION_BYTES:
        invalid()
    excluded = []
    for item in skipped:
        row = _object(item, {"document_id", "reason"})
        document_id = hash_value(row["document_id"])
        if document_id in seen or row["reason"] != "no_native_candidates":
            invalid()
        seen.add(document_id)
        excluded.append(document_id)
    canonical = chat_pipeline.encode({
        "format": MANIFEST_FORMAT, "version": 1, "policy": POLICY,
        "authority_verified": False, "question": question, "part": value["part"],
        "mode": value["mode"], "requests": [entry_value(entry) for entry in entries],
        "skipped": [{"document_id": item, "reason": "no_native_candidates"} for item in excluded],
    })
    if canonical != raw:
        invalid()
    return Manifest(question, value["part"], value["mode"], tuple(entries),
                    tuple(excluded), hashlib.sha256(raw).hexdigest())


def admit_request(manifest: Manifest, entry: Entry, raw: bytes) -> Admitted:
    if len(raw) != entry.bytes or hashlib.sha256(raw).hexdigest() != entry.request_sha256:
        invalid()
    request = chat_pipeline.parse_request(raw)
    if request.embedding.question != manifest.question or any(
        not row.id.startswith("original:") for row in request.embedding.passages
    ):
        invalid()
    return Admitted(entry, request)


def read_requests(manifest: Manifest, directory: Path) -> tuple[Admitted, ...]:
    """Only fixed manifest-derived leaf filenames can be read.

    Symlinks and nonregular files are refused. The exact byte length and hash
    are validated again after bounded reading, before the model is contacted.
    """
    if not directory.is_dir():
        invalid()
    root = directory.resolve()
    admitted = []
    for entry in manifest.requests:
        path = root / entry.filename
        if path.is_symlink() or not path.is_file() or path.resolve().parent != root:
            invalid()
        with path.open("rb") as stream:
            raw = stream.read(entry.bytes + 1)
        admitted.append(admit_request(manifest, entry, raw))
    return tuple(admitted)


def validate_admitted(manifest: Manifest, requests: tuple[Admitted, ...]) -> None:
    if tuple(item.entry for item in requests) != manifest.requests:
        invalid()
    for item in requests:
        if (
            item.request.sha256 != item.entry.request_sha256
            or item.request.embedding.question != manifest.question
            or any(not row.id.startswith("original:") for row in item.request.embedding.passages)
        ):
            invalid()


async def run_collection(
    manifest: Manifest, requests: tuple[Admitted, ...], *,
    embedding_model: str, embedding_digest: str,
    answer_model: str, answer_digest: str, consent: bool,
    _transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    """Bound total execution and return a complete canonical bundle or error."""
    if consent is not True:
        raise EmbeddingError("Explicit local-processing consent is required.")
    validate_model(embedding_model, embedding_digest)
    validate_model(answer_model, answer_digest)
    validate_admitted(manifest, requests)
    results = []
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            for item in requests:
                result = await chat_pipeline.run_pipeline(
                    item.request, embedding_model=embedding_model,
                    embedding_digest=embedding_digest, answer_model=answer_model,
                    answer_digest=answer_digest, consent=True, _transport=_transport,
                )
                if (
                    result.get("request_sha256") != item.entry.request_sha256
                    or result.get("authority_verified") is not False
                    or result.get("ranking", {}).get("model") != embedding_model
                    or result.get("ranking", {}).get("model_digest") != embedding_digest
                    or result.get("extractive", {}).get("model") != answer_model
                    or result.get("extractive", {}).get("model_digest") != answer_digest
                ):
                    invalid()
                results.append({
                    "document_id": item.entry.document_id,
                    "request_sha256": item.entry.request_sha256,
                    "result": result,
                })
    except TimeoutError:
        raise EmbeddingError("Collection local model workflow timed out.") from None
    output = chat_pipeline.encode({
        "format": RESULT_FORMAT, "version": 1, "policy": POLICY,
        "authority_verified": False, "manifest_sha256": manifest.sha256,
        "results": results,
    })
    if len(output) > MAX_RESULT_BYTES:
        raise EmbeddingError("Collection model bundle exceeds its output budget.")
    return output
