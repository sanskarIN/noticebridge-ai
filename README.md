# NoticeBridge AI

**Understand what changed. Know what to do. Verify the evidence.**

NoticeBridge AI is an open-source, multilingual document comparison prototype for official notices. The current development milestone compares two PDFs and produces **evidence-linked wording differences, conservative date/fee checks, and optional bilingual OCR** rather than unverifiable AI summaries.

> **Prototype, not an official verification service.** Document upload order is not proof of authority. Check deadlines, eligibility, and requirements against the issuing organization's official website. A report may miss changes and must not be used as the sole basis for an important decision.

## What works now

- Two-PDF upload with per-file checks (10 MiB/PDF), **total ASGI request-body cap** (20 MiB plus 1 MiB framing), PDF type, encryption, and page-count checks. Upload reception is limited to **90 seconds** and **eight concurrent compare requests per API process**, before multipart parsing.
- Line-level PDF text extraction with **actual 1-based page references, source coordinates, and SHA-256 file fingerprints** from PyMuPDF. The API also reports per-document pages without extractable text and overall text-coverage status: all pages yielded text, partial, or inconclusive.
- **Optional local OCR** for image-only PDF pages (English + Hindi). OCR provenance is attached to each extracted line, and OCR-derived changes cannot be labeled as confirmed purely by a text match. A limit of 12 OCR pages per document and a render-pixel ceiling bound work.
- **PDF.js source preview with rotation/crop/UserUnit-aware evidence highlights**, rendered locally from the selected File without a CDN. The viewer transforms each source box through the PDF.js page viewport, verifies page dimensions and rotation, and suppresses highlights when geometry does not match. Browser regressions cover 0°, 90°, 180° and 270° pages, cropping and non-default units. Rendered bitmaps remain capped at 9 million physical pixels and 4096 pixels per dimension.
- Three-pass matching: identical-text reconciliation, anchored value comparison, and globally ranked fuzzy proposals. Unique masked context in native text supports a matched text change. Fuzzy, duplicated-context, and OCR pairings stay possible and every associated date or fee delta stays uncertain. Same-page, label-matched conflicting calendar dates can be flagged for review; different dates under a generic label on separate pages produce a warning rather than an asserted contradiction.
- **Structured date/fee deltas** alongside quoted evidence: canonical calendar dates and INR amounts only when syntax is unambiguous and valid. Deadline and fee matching preserves scope such as phase or paper numbers.
- Ambiguous dates like `01/02/2026` retain an `uncertain` outcome instead of assuming a date order. Supports English and Hindi written month names and Devanagari numerals.
- Bilingual English/Hindi **templated** explanations. With explicit opt-in, an **experimental local Ollama model** can propose related unmatched passages. Every accepted proposal must reference real extracted source IDs and match the same category; it is added **alongside—not instead of—the deterministic unmatched findings**, remains a `possible_change`, and the API checks its source evidence before accepting it. No model-generated citations are accepted. Without opt-in, no model request occurs.
- Human-verification checklist next to the quoted evidence, plus source-text search and finding category, status, and review filters. Long reports show 20 findings per page. Open pages with missing extracted text from the coverage panel.
- React/TypeScript comparison workspace with English/Hindi review controls, side-by-side evidence, and a local PDF.js viewer loaded on demand. **JSON and spreadsheet-safe CSV exports** include every finding and checklist selection regardless of the active filters. CSV carries source references, fingerprints, authority status and comparison coverage.
- Worker outputs undergo independent **structural provenance checks** in the API: the SHA-256 must match uploaded bytes, document roles and filenames cannot be swapped, evidence page references must be in range, and an AI suggestion cannot become a confirmed/official claim. This is not independent verification of the actual notice's authenticity.
- Stateless FastAPI endpoint with **disposable subprocess PDF/OCR workers**, 45-second native and 120-second OCR wall-clock deadlines, bounded per-process concurrency, Linux address-space ceilings (2 GiB), POSIX CPU/file/open-descriptor limits, no-cache responses, Pytest regression tests, and CI configuration. Worker stdout is captured in a private temporary file and read with a 64 MiB result limit. Opt-in local Ollama responses are streamed with a 64 KiB total byte cap.
- **Browser end-to-end tests** (Playwright/Chromium) verifying upload, evidence display, local PDF.js canvas/highlights, Hindi switching, and JSON export.
- A reproducible **14-case fictional-notice regression benchmark** that checks specific findings and evidence backing. It is a developer safety net, not an estimate of accuracy on real official documents.
- A local-only [labeled evaluation tool](docs/labeled-evaluation.md) for evidence-pair precision/recall on operator-supplied PDFs. **Version-2 pinned-source manifests** record exact PDF SHA-256 fingerprints and declared label provenance; a non-overwriting helper preserves human labels. An explicit `--enable-ocr` option can evaluate scanned documents using local Tesseract while leaving experimental AI disabled. The report exposes OCR usage and extraction gaps. A representative, independently labeled real-world corpus does **not** yet exist.

## Local development

Requires Python 3.11+, Node 22+, and npm. CI uses the tested Python 3.12 constraint set in `backend/constraints-py312.txt` and npm's `frontend/package-lock.json`. The Python constraints pin versions, **not wheel hashes**, and do not claim reproducibility on every supported Python/OS combination. Local AI suggestions also require Ollama running on the **backend** at `127.0.0.1:11434` with `qwen2.5:3b` installed (or another installed model named by `NOTICEBRIDGE_LOCAL_MODEL`). The model feature sends only selected unmatched text passages to this loopback endpoint when explicitly enabled; keep the backend and Ollama instance trusted. Optional OCR requires Tesseract with English (`eng`) and Hindi (`hin`) language data available on the **backend** machine, and a supported PyMuPDF build. Check with `tesseract --list-langs`. Without it, leave OCR disabled: native PDF extraction and comparison still work.

```bash
python -m venv .venv
# Activate the environment (.venv/Scripts/activate on Windows; source .venv/bin/activate on macOS/Linux)
# For Python 3.12, reproduce the tested CI dependency set:
python -m pip install -c backend/constraints-py312.txt -e './backend[dev]'
python -m pip check
python backend/scripts/verify_python_constraints.py
uvicorn noticebridge.api:app --reload --port 8000
```

In a separate terminal:

```bash
cd frontend
npm ci
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

`POST /api/compare` accepts multipart fields `original` and `revised` (PDFs, maximum 10 MiB each, 80 pages each), plus optional `enable_ocr=true` and `enable_semantic=true` (both default to false). Returns `documents`, `findings`, `checklist`, `warnings`, `text_coverage`, `semantic_assistance`, and `verification_policy`. Each document reports `pages_with_text` and `pages_without_text`. Matched findings may include `field_changes` containing `kind`, original and revised raw/canonical values, parser confidence, and an outcome of `changed`, `same_value`, or `uncertain`. This is syntactic interpretation, **not official source verification**.

All evidence references point to source text extracted from the uploaded PDFs, including the extraction method (`native` or `ocr`) and page geometry. Both source locations are included when a passage is matched. The application has **no durable upload storage**, but FastAPI/Starlette multipart parsing **may temporarily spool uploads to local OS temporary files**. Deployments must secure temporary storage, server logs, networking, reverse proxies, and crash dumps. Do not upload private or confidential files to an untrusted hosted instance.

## Explicit limitations

- **OCR is optional and fallible**: by default image-only PDFs produce warnings. If enabled, OCR requires Tesseract, applies only to pages with no native text, and is limited to 12 pages per PDF. Machine transcription may hallucinate or omit characters; OCR provenance lowers downstream confidence. There is no calibrated OCR confidence score.
- **Experimental local AI only**: explanations are rule-based; opt-in model suggestions are not proofs of meaning, accuracy, authority or document precedence. Invalid outputs and unavailable Ollama are explicitly reported without changing deterministic findings.
- **No verified authority resolution**: a revised filename or upload position cannot establish official precedence.
- **No robust semantic matching yet**: the initial similarity matcher can misalign duplicate headings or rephrased statements. Check every important finding against both sources.
- **Limited canonical value parsing**: unambiguous date/fee syntax is normalized for comparisons, but many real-world formats, time zones, and cross-lingual equivalents remain unsupported.
- **PDF.js geometry limitations**: rotated and cropped pages are now supported when page dimensions, rotation and source coordinates can be reconciled. If the geometry disagrees, the viewer deliberately omits the marker. Complex PDF transformation matrices, unusual font placement and nonstandard pages still require manual inspection.
- **Local checklist sessions**: after reload, compare the same PDF pair and use **Restore checklist from JSON** to recover saved selections. Restore checks the source fingerprints and selected evidence before adding any selections. Protect [exports](docs/review-csv.md) that include sensitive source quotations.
- **Ambiguous dates**: dates are parsed conservatively. A numeric date with both first and second parts ≤12 and different is not interpreted as DD/MM or MM/DD. Month-name and ISO formats are safer. Not all language/date/amount formats are recognized.
- **Security**: frontend npm dependencies are pinned with an npm-generated package lock and CI runs `npm ci` for the production build and browser E2E. Python dependencies, advisories and the deployment environment still require separate review. Processing uses a disposable subprocess, restricted inherited environment, and hard wall-clock deadline. Unexpected worker input-pipe failures also terminate and reap the process tree; temporary upload storage failures produce explicit HTTP 503 errors, and disconnects release upload capacity. On POSIX, timeout kills the process group; on Windows, each real worker must be assigned to a kill-on-close **Job Object before any PDF bytes are supplied**, with a 2 GiB job/process memory ceiling and an eight-process limit. On timeout the job terminates its worker descendants; normal completion closes the job handle. Assignment failures abort processing rather than falling back to an uncontained worker. Temporary OS spooling is still used. These limits are **not an OS sandbox** and the app is **not hardened for hostile public internet uploads**. Deployments need OS isolation, disk/CPU quotas, authentication, proxy rate limits, monitoring and security review. Encrypted PDFs and >80-page PDFs are rejected.

## Roadmap

1. Independently evaluated semantic relationship analysis with provenance and issuer authority metadata; expand the experimental local proposals only after measured accuracy on a representative corpus.
2. OS-level sandboxing and worker memory/CPU budgets, plus better OCR quality evaluation and calibrated confidence when supported.
3. Semantic matching with structured LLM proposals and independent deterministic verification.
4. Broader source-highlight geometry regression and independent visual calibration; reviewed CSV export is implemented, while calendar export remains a future item.
5. Stronger adversarial testing, privacy/security hardening, and an accessible deployed demo.

See [engineering verification notes](docs/verification-matrix.md), the [security threat model](docs/security-threat-model.md), and the [Windows worker isolation guide](docs/windows-worker-isolation.md) for data boundaries, remaining P0 risks, test coverage and accepted limitations.

## Reproducible fictional demo

Generate two attractive **fictional** sample PDFs to demonstrate the changed-deadline/changed-fee workflow without using real applicants' documents or confusing anyone with an actual official notice:

```bash
PYTHONPATH=backend python backend/benchmarks/generate_demo.py --output demo-output
```

The generated documents have obvious "FICTIONAL" labeling and are deliberately not suitable for any actual application. Upload them in the UI, compare, click the source evidence and review the highlighted PDF source. The 14-case synthetic benchmark and Chromium browser tests are separate checks.

## Hackathon

Planned for **GenHacks 2026**, AI/Agentic Systems/Cybersecurity/Dev Tools track. Eligibility is student-only, ages 13+. Devpost currently shows **conflicting deadline statements**, so we use **25 December 2026** as an internal safe submission target; confirm the organizer's actual submission cutoff. Required: public code, project description, up-to-3-minute embedded video, team and technology disclosures. See `docs/devpost-draft.md`.

## License

Apache-2.0. Contributions welcome through issues and pull requests.
