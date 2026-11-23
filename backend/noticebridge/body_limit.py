"""Bound POST /api/compare before invoking the multipart parser.

Declared lengths are checked immediately. Chunked requests are buffered in a
bounded, request-scoped spooled file, so multipart libraries cannot swallow a
size exception and turn it into a misleading HTTP 400 response. A public
deployment still needs upstream limits, connection timeouts and rate limiting.
"""

from tempfile import SpooledTemporaryFile

from starlette.responses import JSONResponse

from .extract import MAX_UPLOAD_BYTES

# Two 10 MiB PDF files plus at most 1 MiB multipart framing and form fields.
MAX_COMPARE_BODY_BYTES = 2 * MAX_UPLOAD_BYTES + 1024 * 1024
IN_MEMORY_SPOOL_BYTES = 1024 * 1024
REPLAY_CHUNK_BYTES = 64 * 1024


class CompareBodyLimit:
    """Pure ASGI body-size guard; only changes POST /api/compare."""

    def __init__(self, app):
        self.app = app

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

        # A size exception from inside the multipart parser can be converted
        # to 400 by Starlette. Validate all received bytes *before* invoking
        # the parser, using a capped temp file instead of unbounded RAM.
        with SpooledTemporaryFile(mode="w+b", max_size=IN_MEMORY_SPOOL_BYTES) as spool:
            total = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                if message["type"] != "http.request":
                    await self._reject(
                        scope, receive, send, status=400, detail="Invalid request stream"
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
                spool.write(body)
                if not message.get("more_body", False):
                    break

            spool.seek(0)
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
                # Once replayed, preserve the server's disconnect behavior.
                return await receive()

            await self.app(scope, bounded_receive, send)
