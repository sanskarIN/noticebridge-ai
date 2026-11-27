"""Bound compare uploads before invoking Starlette's multipart parser.

The cap is enforced on actual ASGI bytes, not just Content-Length. A private
bounded spool prevents multipart from hiding the correct 413 response. A
per-process concurrency ceiling and aggregate receive deadline limit simultaneous
temporary storage and stalled uploads. Public deployments still need upstream
network quotas, operating-system isolation, and reverse-proxy protections.
"""

import asyncio
import os
from tempfile import SpooledTemporaryFile
from threading import Lock

from starlette.responses import JSONResponse

from .extract import MAX_UPLOAD_BYTES

MAX_COMPARE_BODY_BYTES = 2 * MAX_UPLOAD_BYTES + 1024 * 1024
MAX_CHAT_OCR_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024
CHAT_OCR_PATH = "/api/chat/ocr"
CHAT_PIPELINE_PATH = "/api/chat/pipeline"
CHAT_MODELS_PATH = "/api/chat/models"
MAX_CHAT_PIPELINE_BODY_BYTES = 3 * 1024 * 1024
IN_MEMORY_SPOOL_BYTES = 1024 * 1024
REPLAY_CHUNK_BYTES = 64 * 1024
MAX_RECEIVE_SECONDS = 90
MAX_ACTIVE_COMPARE_REQUESTS = 8

# Keep the API's CORS policy and the upload guard aligned. CORS alone does
# not prevent an attacker-controlled page from submitting a simple multipart
# request to a developer's locally running PDF parser.
FRONTEND_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
COMPARE_BROWSER_ORIGINS = frozenset(
    origin.encode("ascii") for origin in (
        *FRONTEND_ORIGINS, "http://localhost:8000", "http://127.0.0.1:8000",
    )
)
SAME_SITE_FETCH_CONTEXTS = frozenset({b"same-origin", b"same-site", b"none"})


def _permitted_browser_context(scope: dict) -> bool:
    """Reject untrusted browser-originated uploads before spooling any bytes.

    A missing Origin remains valid for curl and other native clients. Modern
    browsers send Origin on POST requests; Sec-Fetch-Site covers the common
    fallback where Origin is omitted. This is a browser boundary, *not*
    authentication: non-browser clients can set arbitrary request headers.
    """
    headers = scope.get("headers", [])
    origins = [value for key, value in headers if key.lower() == b"origin"]
    sites = [value for key, value in headers if key.lower() == b"sec-fetch-site"]
    if len(origins) > 1 or len(sites) > 1:
        return False
    if origins:
        # Exact canonical browser origins only. Do not trust suffix matching,
        # wildcards, opaque/null origins, credentials, or arbitrary loopback ports.
        return origins[0] in COMPARE_BROWSER_ORIGINS
    return not sites or sites[0].lower() in SAME_SITE_FETCH_CONTEXTS


def local_chat_ocr_enabled() -> bool:
    """Opt-in only; never enable this worker endpoint on a public server."""
    return os.environ.get("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_OCR") == "1"


def local_chat_ai_enabled() -> bool:
    return os.environ.get("NOTICEBRIDGE_ENABLE_LOCAL_CHAT_AI") == "1"


def _permitted_local_context(scope: dict, approval_header: bytes) -> bool:
    """Additional local boundary; not authentication against local clients.

    Reject unexpected Host, non-loopback peers, untrusted browser origins
    and simple cross-site multipart submissions before body buffering.
    """
    client = scope.get("client")
    if not client or client[0] not in ("127.0.0.1", "::1"):
        return False
    headers = scope.get("headers", [])
    hosts = [value for key, value in headers if key.lower() == b"host"]
    approvals = [value for key, value in headers if key.lower() == approval_header]
    return (
        len(hosts) == 1
        and hosts[0] in (
            b"localhost:5173", b"127.0.0.1:5173",
            b"localhost:8000", b"127.0.0.1:8000",
        )
        and approvals == [b"1"]
        and _permitted_browser_context(scope)
    )


class CompareBodyLimit:
    """Pure ASGI guard for comparison and explicitly enabled local OCR uploads."""

    def __init__(self, app):
        self.app = app
        self._active = 0
        self._active_lock = Lock()

    @staticmethod
    async def _reject(scope, receive, send, *, status: int, detail: str) -> None:
        response = JSONResponse(
            {"detail": detail},
            status_code=status,
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
        await response(scope, receive, send)

    async def __call__(self, scope, receive, send) -> None:
        # Read-only inventory has no upload body and must pass the same
        # local host/origin/peer/approval checks before contacting the runtime.
        if (
            scope["type"] == "http"
            and scope.get("path") == CHAT_MODELS_PATH
            and scope.get("method", "").upper() == "GET"
        ):
            if not local_chat_ai_enabled():
                await self._reject(scope, receive, send, status=404, detail="Local AI is disabled")
                return
            if not _permitted_local_context(scope, b"x-noticebridge-local-ai"):
                await self._reject(
                    scope, receive, send, status=403, detail="Local AI context denied",
                )
                return
            await self.app(scope, receive, send)
            return
        if (
            scope["type"] != "http"
            or scope.get("path") not in ("/api/compare", CHAT_OCR_PATH, CHAT_PIPELINE_PATH)
            or scope.get("method", "").upper() != "POST"
        ):
            await self.app(scope, receive, send)
            return

        local_ocr = scope.get("path") == CHAT_OCR_PATH
        if local_ocr and not local_chat_ocr_enabled():
            await self._reject(scope, receive, send, status=404, detail="Local OCR is disabled")
            return
        if local_ocr and not _permitted_local_context(scope, b"x-noticebridge-local-ocr"):
            await self._reject(scope, receive, send, status=403, detail="Local OCR context denied")
            return
        local_ai = scope.get("path") == CHAT_PIPELINE_PATH
        if local_ai and not local_chat_ai_enabled():
            await self._reject(scope, receive, send, status=404, detail="Local AI is disabled")
            return
        if local_ai and not _permitted_local_context(scope, b"x-noticebridge-local-ai"):
            await self._reject(scope, receive, send, status=403, detail="Local AI context denied")
            return
        if local_ai:
            max_body, label = MAX_CHAT_PIPELINE_BODY_BYTES, "AI"
        elif local_ocr:
            max_body, label = MAX_CHAT_OCR_BODY_BYTES, "OCR"
        else:
            max_body, label = MAX_COMPARE_BODY_BYTES, "Comparison"

        # This check precedes Content-Length checks, temporary-file spooling,
        # request-slot reservation and any native PDF/OCR parsing work.
        if not _permitted_browser_context(scope):
            await self._reject(
                scope, receive, send,
                status=403, detail="Browser origin is not permitted for PDF comparison",
            )
            return

        lengths = [
            value for key, value in scope.get("headers", [])
            if key.lower() == b"content-length"
        ]
        if len(lengths) > 1 or (
            lengths and (len(lengths[0]) > 20 or not lengths[0].isdigit())
        ):
            await self._reject(
                scope, receive, send, status=400, detail="Invalid Content-Length"
            )
            return
        declared_length = int(lengths[0]) if lengths else None
        if declared_length is not None and declared_length > max_body:
            await self._reject(
                scope, receive, send, status=413, detail=f"{label} upload is too large"
            )
            return

        # The lock spans only a fast counter update, never network or PDF I/O.
        # Requests above the per-process budget are rejected immediately,
        # rather than retaining another unbounded set of waiting upload bodies.
        with self._active_lock:
            accepted = self._active < MAX_ACTIVE_COMPARE_REQUESTS
            if accepted:
                self._active += 1
        if not accepted:
            await self._reject(
                scope, receive, send,
                status=503, detail="Too many simultaneous comparison uploads",
            )
            return
        try:
            await self._buffer_and_dispatch(
                scope, receive, send, declared_length=declared_length,
                max_body=max_body, label=label,
            )
        finally:
            with self._active_lock:
                self._active -= 1

    async def _buffer_and_dispatch(
        self, scope, receive, send, *, declared_length: int | None, max_body: int, label: str,
    ) -> None:
        try:
            upload_spool = SpooledTemporaryFile(
                mode="w+b", max_size=IN_MEMORY_SPOOL_BYTES
            )
        except OSError:
            await self._reject(
                scope, receive, send,
                status=503, detail="Temporary upload storage is unavailable",
            )
            return
        with upload_spool as spool:
            total = 0
            event_loop = asyncio.get_running_loop()
            deadline = event_loop.time() + MAX_RECEIVE_SECONDS

            while True:
                seconds_left = deadline - event_loop.time()
                if seconds_left <= 0:
                    await self._reject(
                        scope, receive, send,
                        status=408, detail=f"{label} upload took too long",
                    )
                    return
                try:
                    message = await asyncio.wait_for(receive(), timeout=seconds_left)
                except TimeoutError:
                    await self._reject(
                        scope, receive, send,
                        status=408, detail=f"{label} upload took too long",
                    )
                    return
                if message["type"] == "http.disconnect":
                    return
                if message["type"] != "http.request":
                    await self._reject(
                        scope, receive, send,
                        status=400, detail="Invalid request stream",
                    )
                    return
                body = message.get("body", b"")
                total += len(body)
                if total > max_body:
                    await self._reject(
                        scope, receive, send,
                        status=413, detail=f"{label} upload is too large",
                    )
                    return
                try:
                    # File-like objects can report a short write without raising.
                    # Never pass a truncated request to the multipart parser.
                    written = spool.write(body)
                    if written != len(body):
                        raise OSError("Incomplete temporary upload write")
                except OSError:
                    await self._reject(
                        scope, receive, send,
                        status=503, detail="Temporary upload storage is unavailable",
                    )
                    return
                if not message.get("more_body", False):
                    break

            # Reject framing mismatches before handing the body to Starlette.
            # This is an integrity check, not a substitute for the actual-byte cap.
            if declared_length is not None and declared_length != total:
                await self._reject(
                    scope, receive, send,
                    status=400, detail="Content-Length does not match received bytes",
                )
                return

            try:
                spool.seek(0)
            except OSError:
                await self._reject(
                    scope, receive, send,
                    status=503, detail="Temporary upload storage is unavailable",
                )
                return
            remaining = total
            sent_last = False

            async def bounded_receive():
                nonlocal remaining, sent_last
                if not sent_last:
                    chunk = spool.read(min(REPLAY_CHUNK_BYTES, remaining))
                    remaining -= len(chunk)
                    sent_last = remaining == 0
                    return {
                        "type": "http.request",
                        "body": chunk,
                        "more_body": not sent_last,
                    }
                # After replay, honor the original connection lifecycle.
                return await receive()

            await self.app(scope, bounded_receive, send)
