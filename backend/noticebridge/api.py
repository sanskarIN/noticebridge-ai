"""Request-scoped API. Multipart parsing may temporarily spool uploads to OS disk."""

import asyncio
import unicodedata
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from .body_limit import CompareBodyLimit
from .extract import MAX_UPLOAD_BYTES, InvalidDocument, parse_ocr_selection
from .isolation import ProcessingFailed, ProcessingTimedOut, run_isolated_comparison
from .models import ComparisonReport

app = FastAPI(
    title="NoticeBridge AI", version="0.1.0", description="Evidence-first PDF comparisons"
)
# Bound simultaneous disposable workers per API process. Public deployments
# still require authentication, rate limiting, and operating-system sandboxing.
parse_slots = asyncio.Semaphore(4)


@app.middleware("http")
async def disable_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


# The body guard runs before multipart parsing. CORS wraps it so allowed
# browser clients can inspect 400/413 responses rather than receiving opaque failures.
app.add_middleware(CompareBodyLimit)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


def safe_filename(filename: str | None, *, fallback: str) -> str:
    """Drop paths, controls and bidi-spoofing characters from display names.

    The resulting name is display metadata, never an authority assertion.
    """
    # Normalize before splitting path components: fullwidth solidus and
    # reverse-solidus characters become real separators under NFKC.
    normalized = unicodedata.normalize("NFKC", filename or fallback)
    basename = normalized.replace("\\", "/").split("/")[-1]
    # Preserve legitimate Indic combining marks and ZWJ while removing
    # explicit bidirectional display controls that can spoof extensions.
    bidi_controls = {"\u200e", "\u200f", "\u202a", "\u202b", "\u202c",
                     "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"}
    cleaned = "".join(c for c in basename if unicodedata.category(c) != "Cc"
                      and c not in bidi_controls).strip(" .")
    # Do not truncate the visible PDF suffix off a long accepted filename.
    # This name is display-only metadata, not a trusted filesystem path.
    if len(cleaned) > 200:
        if cleaned.casefold().endswith(".pdf"):
            cleaned = cleaned[:196].rstrip(" .") + ".pdf"
        else:
            cleaned = cleaned[:200].rstrip(" .")
    return cleaned or fallback


async def _read_pdf(upload: UploadFile) -> bytes:
    if not upload.filename or not upload.filename.casefold().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Only PDF filenames are supported")
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="PDF exceeds 10 MiB")
    return data


@app.post("/api/compare", response_model=ComparisonReport)
async def compare(
    original: Annotated[UploadFile, File()],
    revised: Annotated[UploadFile, File()],
    enable_ocr: Annotated[bool, Form()] = False,
    enable_semantic: Annotated[bool, Form()] = False,
    original_ocr_pages: Annotated[str, Form()] = "",
    revised_ocr_pages: Annotated[str, Form()] = "",
) -> ComparisonReport:
    try:
        try:
            old_pages = parse_ocr_selection(original_ocr_pages)
        except InvalidDocument as exc:
            raise InvalidDocument(f"Original notice: {exc}") from exc
        try:
            new_pages = parse_ocr_selection(revised_ocr_pages)
        except InvalidDocument as exc:
            raise InvalidDocument(f"Updated notice: {exc}") from exc
        a = await _read_pdf(original)
        b = await _read_pdf(revised)
        # Never display an upload-controlled path as a filename in evidence.
        old_name = safe_filename(original.filename, fallback="original.pdf")
        new_name = safe_filename(revised.filename, fallback="revised.pdf")
        async with parse_slots:
            # Isolate parser/OCR work in a disposable subprocess with a hard
            # wall-clock deadline; never block the ASGI event loop.
            return await run_in_threadpool(
                run_isolated_comparison,
                a, b, old_name=old_name, new_name=new_name,
                enable_ocr=enable_ocr, enable_semantic=enable_semantic,
                original_ocr_pages=old_pages, revised_ocr_pages=new_pages,
            )
    except InvalidDocument as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ProcessingTimedOut as exc:
        raise HTTPException(
            status_code=504, detail="PDF processing timed out; try smaller documents"
        ) from exc
    except ProcessingFailed as exc:
        raise HTTPException(
            status_code=503, detail="PDF processing failed; no evidence report was generated"
        ) from exc
    finally:
        await original.close()
        await revised.close()
