# NoticeBridge AI

**Understand what changed. Know what to do. Verify the evidence.**

NoticeBridge AI is an open-source, multilingual document comparison prototype for official notices. The current development milestone compares two PDFs and produces **evidence-linked wording differences, conservative date/fee checks, and optional bilingual OCR** rather than unverifiable AI summaries.

> **Prototype, not an official verification service.** Document upload order is not proof of authority. Check deadlines, eligibility, and requirements against the issuing organization's official website. A report may miss changes and must not be used as the sole basis for an important decision.

## What works now

- Two-PDF upload with file-size, file-type, encryption, and page-count checks.
- Line-level PDF text extraction with **actual 1-based page references, source coordinates, and SHA-256 file fingerprints** from PyMuPDF.
- **Optional local OCR** for image-only PDF pages (English + Hindi). OCR provenance is attached to each extracted line, and OCR-derived changes cannot be labeled as confirmed purely by a text match. A limit of 12 OCR pages per document and a render-pixel ceiling bound work.
- **PDF.js page preview with highlighted evidence coordinates** for unrotated pages, rendered locally from the user-selected File without sending it to a CDN; rotated pages deliberately omit potentially inaccurate highlights.
- Three-pass matching: identical-text reconciliation, anchored value comparison, and globally ranked fuzzy proposals. Repeated headings are marked uncertain rather than overconfident.
- **Structured date/fee deltas** alongside quoted evidence: canonical calendar dates and INR amounts only when syntax is unambiguous and valid.
- Ambiguous dates like `01/02/2026` retain an `uncertain` outcome instead of assuming a date order. Supports English and Hindi written month names and Devanagari numerals.
- Bilingual English/Hindi **templated** explanations. No LLM is used yet; neither AI accuracy nor authoritative conflict resolution is claimed.
- Human-verification checklist for changed deadlines, fees, eligibility, and instructions.
- React/TypeScript comparison workspace with side-by-side evidence, locally rendered source pages, an explicit OCR opt-in, portable JSON evidence export, and review controls.
- Stateless FastAPI endpoint with **disposable subprocess PDF/OCR workers**, 45-second native and 120-second OCR wall-clock deadlines, bounded per-process concurrency, Linux address-space ceilings (2 GiB), POSIX CPU/file/open-descriptor limits, no-cache responses, Pytest regression tests, and CI configuration.
- **Browser end-to-end tests** (Playwright/Chromium) verifying upload, evidence display, local PDF.js canvas/highlights, Hindi switching, and JSON export.
- A reproducible **12-case fictional-notice regression benchmark** that checks specific findings and evidence backing. It is a developer safety net, not an estimate of accuracy on real official documents.

## Local development

Requires Python 3.11+, Node 22+, and npm. Optional OCR requires Tesseract with English (`eng`) and Hindi (`hin`) language data available on the **backend** machine, and a supported PyMuPDF build. Check with `tesseract --list-langs`. Without it, leave OCR disabled: native PDF extraction and comparison still work.

```bash
python -m venv .venv
# Activate the environment (.venv/Scripts/activate on Windows; source .venv/bin/activate on macOS/Linux)
python -m pip install -e './backend[dev]'
uvicorn noticebridge.api:app --reload --port 8000
```

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. API schema: **http://127.0.0.1:8000/docs**.

```bash
pytest -q backend/tests
ruff check backend
PYTHONPATH=backend python backend/benchmarks/evaluate.py
cd frontend && npm run build
# Optional live browser tests (after Tesseract setup if OCR is desired):
npx playwright install chromium
npm run test:e2e
```

## API

`POST /api/compare` accepts multipart fields `original` and `revised` (PDFs, maximum 10 MiB each, 80 pages each), plus optional `enable_ocr=true` (default is false). Returns `documents`, `findings`, `checklist`, `warnings`, and `verification_policy`. Matched findings may include `field_changes` containing `kind`, original and revised raw/canonical values, parser confidence, and an outcome of `changed`, `same_value`, or `uncertain`. This is syntactic interpretation, **not official source verification**.

All evidence references point to source text extracted from the uploaded PDFs, including the extraction method (`native` or `ocr`) and page geometry. Both source locations are included when a passage is matched. The application has **no durable upload storage**, but FastAPI/Starlette multipart parsing **may temporarily spool uploads to local OS temporary files**. Deployments must secure temporary storage, server logs, networking, reverse proxies, and crash dumps. Do not upload private or confidential files to an untrusted hosted instance.

## Explicit limitations

- **OCR is optional and fallible**: by default image-only PDFs produce warnings. If enabled, OCR requires Tesseract, applies only to pages with no native text, and is limited to 12 pages per PDF. Machine transcription may hallucinate or omit characters; OCR provenance lowers downstream confidence. There is no calibrated OCR confidence score.
- **No LLM yet**: bilingual explanations are rule-based templates.
- **No verified authority resolution**: a revised filename or upload position cannot establish official precedence.
- **No robust semantic matching yet**: the initial similarity matcher can misalign duplicate headings or rephrased statements. Check every important finding against both sources.
- **Limited canonical value parsing**: unambiguous date/fee syntax is normalized for comparisons, but many real-world formats, time zones, and cross-lingual equivalents remain unsupported.
- **Limited PDF.js coordinate highlighting**: the UI renders a highlighted excerpt for unrotated pages using source coordinates. On rotated pages it intentionally shows the page without an overlay. Complex cropped/transformed PDFs may also need manual visual checking.
- **No persistent checklist**: selections reset when the page reloads. Reviewing a checklist item does not by itself verify official authority. You can export a JSON snapshot of findings and review state.
- **Ambiguous dates**: dates are parsed conservatively. A numeric date with both first and second parts ≤12 and different is not interpreted as DD/MM or MM/DD. Month-name and ISO formats are safer. Not all language/date/amount formats are recognized.
- **Security**: document processing uses a short-lived subprocess with a restricted inherited environment and hard wall-clock deadline, and application data is not durably persisted; multipart uploads may be spooled to OS temp storage before parsing. On POSIX, timed-out worker process groups are terminated; on Windows, only the direct worker is terminated. Worker POSIX limits are best-effort, not guaranteed isolation. This is **not an OS sandbox** and is **not yet hardened for hostile public internet uploads**. Deployments still need OS isolation and memory/CPU quotas, authentication, rate limiting, malware controls and operational safeguards. Encrypted PDFs and >80-page PDFs are rejected.

## Roadmap

1. True semantic relationship analysis with cross-notice provenance and explicit issuer authority metadata.
2. OS-level sandboxing and worker memory/CPU budgets, plus better OCR quality evaluation and calibrated confidence when supported.
3. Semantic matching with structured LLM proposals and independent deterministic verification.
4. PDF.js rotation/crop-aware coordinate transforms, visual regression tests, and optional reviewed CSV/calendar exports.
5. Stronger adversarial testing, privacy/security hardening, and an accessible deployed demo.

See [engineering verification notes](docs/verification-matrix.md) for design invariants, test coverage, and accepted limitations.

## Reproducible fictional demo

Generate two attractive **fictional** sample PDFs to demonstrate the changed-deadline/changed-fee workflow without using real applicants' documents or confusing anyone with an actual official notice:

```bash
PYTHONPATH=backend python backend/benchmarks/generate_demo.py --output demo-output
```

The generated documents have obvious "FICTIONAL" labeling and are deliberately not suitable for any actual application. Upload them in the UI, compare, click the source evidence and review the highlighted PDF source. The 12-case synthetic benchmark and Chromium browser tests are separate checks.

## Hackathon

Planned for **GenHacks 2026**, AI/Agentic Systems/Cybersecurity/Dev Tools track. Eligibility is student-only, ages 13+. Devpost currently shows **conflicting deadline statements**, so we use **25 December 2026** as an internal safe submission target; confirm the organizer's actual submission cutoff. Required: public code, project description, up-to-3-minute embedded video, team and technology disclosures. See `docs/devpost-draft.md`.

## License

Apache-2.0. Contributions welcome through issues and pull requests.
