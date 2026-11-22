"""Stateless FastAPI service. Uploaded documents are held in memory for one request."""

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .compare import compare_documents
from .extract import MAX_UPLOAD_BYTES, InvalidDocument, extract_pdf
from .models import ComparisonReport

app = FastAPI(
    title="NoticeBridge AI", version="0.1.0", description="Evidence-first PDF comparisons"
)
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
    original: UploadFile = File(...), revised: UploadFile = File(...)
) -> ComparisonReport:
    try:
        a = await _read_pdf(original)
        b = await _read_pdf(revised)
        original_doc = extract_pdf(
            a, document_id="original", filename=original.filename or "original.pdf"
        )
        revised_doc = extract_pdf(
            b, document_id="revised", filename=revised.filename or "revised.pdf"
        )
        return compare_documents(original_doc, revised_doc)
    except InvalidDocument as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        await original.close()
        await revised.close()
