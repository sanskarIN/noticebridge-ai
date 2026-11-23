"""Cap multipart request bytes before Starlette can spool them to temporary files.

Both Content-Length and the actual ASGI receive stream are checked. A reverse
proxy must also enforce upload limits before forwarding untrusted traffic.
"""

from starlette.responses import JSONResponse

from .extract import MAX_UPLOAD_BYTES

# Two 10 MiB PDFs, plus a generous but finite multipart framing allowance.
MAX_COMPARE_BODY_BYTES = (2 * MAX_UPLOAD_BYTES) + (1024 * 1024)


class BodyTooLarge(Exception):
    """The actual incoming ASGI request body exceeded its byte budget."""


class CompareBodyLimit:
    """ASGI guard for POST /api/compare; unrelated paths are unchanged."""

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
            lengths and (not lengths[0].isdigit() or not lengths[0])
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

        received_bytes = 0
        response_started = False

        async def limited_receive():
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > MAX_COMPARE_BODY_BYTES:
                    raise BodyTooLarge
            return message

        async def track_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, track_send)
        except BodyTooLarge:
            # Routes must finish reading multipart input before sending output.
            if response_started:
                raise
            await self._reject(
                scope, receive, send, status=413, detail="Comparison upload is too large"
            )
