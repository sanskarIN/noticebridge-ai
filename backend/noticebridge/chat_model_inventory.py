"""Read-only inventory of explicitly approved, installed model metadata.

The inventory is a convenience for selecting exact tags and digests.
It does not prove offline execution, model capabilities, or authenticity.
No question, PDF, source excerpt, model pull, or inference request is sent.
"""

import asyncio
from collections import Counter

import httpx

from .chat_embeddings import EmbeddingError, _json_response, validate_model
from .chat_pipeline import encode

FORMAT = "noticebridge-local-model-inventory"
MAX_MODELS = 1024
MAX_INVENTORY_BYTES = 256 * 1024
TIMEOUT_SECONDS = 8


def sanitize_inventory(raw: object) -> dict:
    """Expose only validated names and digest pairs, never raw metadata.

    Duplicate tags are excluded entirely, even if their digests agree.
    A duplicate may conflict with the inference pin-check contract.
    """
    rows = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(rows, list) or len(rows) > MAX_MODELS:
        raise EmbeddingError("Invalid local model inventory.")
    counts = Counter(
        row["name"] for row in rows
        if isinstance(row, dict) and isinstance(row.get("name"), str)
    )
    models = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name, digest = row.get("name"), row.get("digest")
        if not isinstance(name, str) or not isinstance(digest, str):
            continue
        if (
            counts[name] != 1
            or row.get("model", name) != name
            or row.get("remote_model")
            or row.get("remote_host")
        ):
            continue
        try:
            validate_model(name, digest)
        except EmbeddingError:
            continue
        models.append({"name": name, "digest": digest})
    models.sort(key=lambda row: row["name"])
    report = {
        "format": FORMAT,
        "version": 1,
        "runtime_reported_only": True,
        "authority_verified": False,
        "reported_count": len(rows),
        "excluded_count": len(rows) - len(models),
        "models": models,
    }
    if len(encode(report)) > MAX_INVENTORY_BYTES:
        raise EmbeddingError("Local model inventory exceeds its size budget.")
    return report


async def list_local_models(
    *, consent: bool, _transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Use the same fixed loopback URL and bounded JSON reader as inference."""
    if consent is not True:
        raise EmbeddingError("Explicit inventory consent is required.")
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(5.0),
                trust_env=False,
                follow_redirects=False,
                headers={"Accept-Encoding": "identity"},
                transport=_transport,
            ) as client:
                raw = await _json_response(client, "GET", "/api/tags")
                return sanitize_inventory(raw)
    except (httpx.HTTPError, TimeoutError, OSError):
        raise EmbeddingError("Local model inventory unavailable.") from None
