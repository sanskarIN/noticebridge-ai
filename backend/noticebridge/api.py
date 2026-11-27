"""Request-scoped API. Multipart parsing may temporarily spool uploads to OS disk."""

import asyncio
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from .body_limit import FRONTEND_ORIGINS, CompareBodyLimit
from .chat_embeddings import EmbeddingError, validate_model
from .chat_model_inventory import MAX_INVENTORY_BYTES, list_local_models
from .chat_ocr_cli import run_ocr_review
from .chat_ocr_protocol import OcrReviewError, encode_report, validate_selection
from .chat_pipeline import MAX_REQUEST_BYTES as MAX_PIPELINE_REQUEST_BYTES
from .chat_pipeline import encode as encode_pipeline
from .chat_pipeline import parse_request as parse_pipeline_request
from .chat_pipeline import run_pipeline
from .extract import MAX_UPLOAD_BYTES, InvalidDocument, parse_ocr_selection
from .filenames import safe_filename
from .isolation import ProcessingFailed, ProcessingTimedOut, run_isolated_comparison
from .models import ComparisonReport

app = FastAPI(
    title="NoticeBridge AI", version="0.1.0", description="Evidence-first PDF comparisons"
)
# Bound simultaneous disposable workers per API process. Public deployments
# still require authentication, rate limiting, and operating-system sandboxing.
parse_slots = asyncio.Semaphore(4)
# Reject concurrent inference instead of queuing an unbounded model workload.
model_slots = asyncio.Semaphore(1)
MAX_PIPELINE_RESPONSE_BYTES = 100 * 1024


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
    allow_origins=FRONTEND_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


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


@app.post("/api/chat/ocr")
async def chat_ocr(
    source: Annotated[UploadFile, File()],
    role: Annotated[str, Form()],
    pages: Annotated[str, Form()],
    consent: Annotated[bool, Form()] = False,
) -> Response:
    """Explicitly enabled loopback-only OCR; the ASGI guard runs before parsing."""
    try:
        if consent is not True or role not in ("original", "revised"):
            raise HTTPException(
                status_code=422, detail="Explicit local OCR consent and role required",
            )
        try:
            selected = validate_selection(list(parse_ocr_selection(pages)))
        except (InvalidDocument, OcrReviewError) as exc:
            raise HTTPException(status_code=422, detail="Invalid OCR page selection") from exc
        data = await _read_pdf(source)
        if not data:
            raise HTTPException(status_code=422, detail="Empty PDF")
        async with parse_slots:
            report = await run_in_threadpool(run_ocr_review, data, role, selected)
        # Preserve the canonical protocol used by the local file CLI.
        return Response(content=encode_report(report), media_type="application/json")
    except OcrReviewError as exc:
        raise HTTPException(
            status_code=503, detail="Local OCR did not produce a valid report",
        ) from exc
    finally:
        await source.close()


@app.get("/api/chat/models")
async def chat_models(request: Request) -> Response:
    """Read-only local inventory; the ASGI guard requires explicit approval."""
    if request.url.query:
        raise HTTPException(status_code=400, detail="Inventory does not accept query parameters")
    if model_slots.locked():
        raise HTTPException(status_code=503, detail="Local AI is already processing a request")
    async with model_slots:
        try:
            result = await list_local_models(consent=True)
            encoded = encode_pipeline(result)
            if len(encoded) > MAX_INVENTORY_BYTES:
                raise EmbeddingError("Inventory response exceeds its size limit.")
        except EmbeddingError as exc:
            raise HTTPException(status_code=503, detail="Local model inventory failed") from exc
    return Response(content=encoded, media_type="application/json")


@app.post("/api/chat/pipeline")
async def chat_pipeline(
    request_file: Annotated[UploadFile, File()],
    embedding_model: Annotated[str, Form()],
    embedding_digest: Annotated[str, Form()],
    answer_model: Annotated[str, Form()],
    answer_digest: Annotated[str, Form()],
    consent: Annotated[bool, Form()] = False,
) -> Response:
    """Opt-in local-only pipeline; no uploaded PDF is parsed by this route."""
    try:
        if consent is not True:
            raise HTTPException(status_code=422, detail="Explicit local AI consent required")
        if not request_file.filename or not request_file.filename.casefold().endswith(".json"):
            raise HTTPException(status_code=415, detail="Only pipeline JSON requests are supported")
        data = await request_file.read(MAX_PIPELINE_REQUEST_BYTES + 1)
        if len(data) > MAX_PIPELINE_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Pipeline request exceeds its size limit")
        try:
            validate_model(embedding_model, embedding_digest)
            validate_model(answer_model, answer_digest)
            request = parse_pipeline_request(data)
        except EmbeddingError as exc:
            raise HTTPException(status_code=422, detail="Invalid local AI request") from exc
        # No await separates the locked check and a successful acquisition;
        # on this event loop an available slot is acquired immediately.
        if model_slots.locked():
            raise HTTPException(status_code=503, detail="Local AI is already processing a request")
        async with model_slots:
            try:
                result = await run_pipeline(
                    request, embedding_model=embedding_model, embedding_digest=embedding_digest,
                    answer_model=answer_model, answer_digest=answer_digest, consent=True,
                )
                encoded = encode_pipeline(result)
                if len(encoded) > MAX_PIPELINE_RESPONSE_BYTES:
                    raise EmbeddingError("Pipeline response exceeds its size limit.")
            except EmbeddingError as exc:
                raise HTTPException(status_code=503, detail="Local AI pipeline failed") from exc
        return Response(content=encoded, media_type="application/json")
    finally:
        await request_file.close()
