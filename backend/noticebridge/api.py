"""Stateless FastAPI service. Uploaded documents are held in memory for one request."""

import asyncio
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from .compare import compare_documents
from .extract import MAX_UPLOAD_BYTES, InvalidDocument, extract_pdf
from .models import ComparisonReport

app = FastAPI(
    title="NoticeBridge AI", version="0.1.0", description="Evidence-first PDF comparisons"
)
# Extraction is CPU / memory intensive. Bound simultaneous document parsing
# inside one worker; production servers still need isolated upload workers.
parse_slots = asyncio.Semaphore(4)


@app.middleware("http")
async def disable_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
) -> ComparisonReport:
    try:
        a = await _read_pdf(original)
        b = await _read_pdf(revised)
        # Never display an upload-controlled path as a filename in evidence.
        old_name = (original.filename or "original.pdf").replace("\\", "/").split("/")[-1][:200]
        new_name = (revised.filename or "revised.pdf").replace("\\", "/").split("/")[-1][:200]
        async with parse_slots:
            # Move PDF extraction off the ASGI event loop. No uploads are
            # persisted; buffers are scoped to this request.
            old_doc = await run_in_threadpool(
                extract_pdf, a, document_id="original", filename=old_name, enable_ocr=enable_ocr
            )
            new_doc = await run_in_threadpool(
                extract_pdf, b, document_id="revised", filename=new_name, enable_ocr=enable_ocr
            )
            return await run_in_threadpool(compare_documents, old_doc, new_doc)
    except InvalidDocument as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        await original.close()
        await revised.close()
