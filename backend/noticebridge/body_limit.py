"""Bound compare uploads before invoking Starlette's multipart parser.

The cap is enforced on actual ASGI bytes, not just Content-Length. A private
bounded spool prevents multipart from hiding the correct 413 response. A
per-process concurrency ceiling and aggregate receive deadline limit simultaneous
temporary storage and stalled uploads. Public deployments still need upstream
network quotas, operating-system isolation, and reverse-proxy protections.
"""

import asyncio
from tempfile import SpooledTemporaryFile
from threading import Lock

from starlette.responses import JSONResponse

from .extract import MAX_UPLOAD_BYTES

MAX_COMPARE_BODY_BYTES = 2 * MAX_UPLOAD_BYTES + 1024 * 1024
IN_MEMORY_SPOOL_BYTES = 1024 * 1024
REPLAY_CHUNK_BYTES = 64 * 1024
MAX_RECEIVE_SECONDS = 90
MAX_ACTIVE_COMPARE_REQUESTS = 8


class CompareBodyLimit:
    """Pure ASGI guard for POST /api/compare, per application process."""

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
        if (
            scope["type"] != "http"
            or scope.get("path") != "/api/compare"
            or scope.get("method", "").upper() != "POST"
        ):
            await self.app(scope, receive, send)
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
        if lengths and int(lengths[0]) > MAX_COMPARE_BODY_BYTES:
            await self._reject(
                scope, receive, send, status=413, detail="Comparison upload is too large"
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
            await self._buffer_and_dispatch(scope, receive, send)
        finally:
            with self._active_lock:
                self._active -= 1

    async def _buffer_and_dispatch(self, scope, receive, send) -> None:
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
                        status=408, detail="Comparison upload took too long",
                    )
                    return
                try:
                    message = await asyncio.wait_for(receive(), timeout=seconds_left)
                except TimeoutError:
                    await self._reject(
                        scope, receive, send,
                        status=408, detail="Comparison upload took too long",
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
                if total > MAX_COMPARE_BODY_BYTES:
                    await self._reject(
                        scope, receive, send,
                        status=413, detail="Comparison upload is too large",
                    )
                    return
                try:
                    spool.write(body)
                except OSError:
                    await self._reject(
                        scope, receive, send,
                        status=503, detail="Temporary upload storage is unavailable",
                    )
                    return
                if not message.get("more_body", False):
                    break

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
