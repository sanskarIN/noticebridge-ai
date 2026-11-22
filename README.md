# NoticeBridge AI

**Understand what changed. Know what to do. Verify the evidence.**

NoticeBridge AI is an open-source, multilingual document comparison prototype for official notices. The current development milestone compares two PDFs and produces **evidence-linked wording differences and conservative field-level date/fee checks** rather than unverifiable AI summaries.

> **Prototype, not an official verification service.** Document upload order is not proof of authority. Check deadlines, eligibility, and requirements against the issuing organization's official website. A report may miss changes and must not be used as the sole basis for an important decision.

## What works now

- Two-PDF upload with file-size, file-type, encryption, and page-count checks.
- Line-level PDF text extraction with **actual 1-based page references and coordinates** from PyMuPDF.
- Three-pass matching: identical-text reconciliation, anchored value comparison, and globally ranked fuzzy proposals. Repeated headings are marked uncertain rather than overconfident.
- **Structured date/fee deltas** alongside quoted evidence: canonical calendar dates and INR amounts only when syntax is unambiguous and valid.
- Ambiguous dates like `01/02/2026` retain an `uncertain` outcome instead of assuming a date order. Supports English and Hindi written month names and Devanagari numerals.
- Bilingual English/Hindi **templated** explanations. No LLM is used yet; neither AI accuracy nor authoritative conflict resolution is claimed.
- Human-verification checklist for changed deadlines, fees, eligibility, and instructions.
- React/TypeScript comparison workspace with side-by-side evidence, source-page opening in a local PDF viewer, portable JSON evidence export, and accessible review controls.
- Stateless FastAPI endpoint with bounded PDF parsing concurrency, no-cache responses, Pytest regression tests, and CI configuration.

## Local development

Requires Python 3.11+, Node 22+, and npm.

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
cd frontend && npm run build
```

## API

`POST /api/compare` accepts multipart fields `original` and `revised` (PDFs, maximum 10 MiB each, 80 pages each). Returns `documents`, `findings`, `checklist`, `warnings`, and `verification_policy`. Matched findings may include `field_changes` containing `kind`, original and revised raw/canonical values, parser confidence, and an outcome of `changed`, `same_value`, or `uncertain`. This is syntactic interpretation, **not official source verification**.

All evidence references point to source text actually extracted from the uploaded PDFs. Both source locations are included when a passage is matched. The service does **not** store uploads as files or intentionally log document contents; deployments must still secure server logs, networking, reverse proxies, and crash dumps.

## Explicit limitations

- **No OCR**: image-only PDFs produce warnings, not fabricated extracted text.
- **No LLM yet**: bilingual explanations are rule-based templates.
- **No verified authority resolution**: a revised filename or upload position cannot establish official precedence.
- **No robust semantic matching yet**: the initial similarity matcher can misalign duplicate headings or rephrased statements. Check every important finding against both sources.
- **No canonical date parsing**: dates and amounts are masked only for contextual line alignment; correct real-world date interpretation and cross-lingual matching are upcoming work.
- **No PDF.js highlight viewer yet**: the UI can open the corresponding page of the locally selected PDF via the browser PDF viewer, but it does not draw coordinate-accurate highlights.
- **No persistent checklist**: selections reset when the page reloads. Reviewing a checklist item does not by itself verify official authority. You can export a JSON snapshot of findings and review state.
- **Ambiguous dates**: dates are parsed conservatively. A numeric date with both first and second parts ≤12 and different is not interpreted as DD/MM or MM/DD. Month-name and ISO formats are safer. Not all language/date/amount formats are recognized.
- **Security**: source files are processed in-memory and browser previews use local object URLs, but this is not hardened for hostile public internet uploads. Production deployments need isolated parsers, request and memory limits, authentication, rate limiting, observability safeguards, and malware controls. Encrypted PDFs and >80-page PDFs are rejected.

## Roadmap

1. True semantic relationship analysis with cross-notice provenance and explicit issuer authority metadata.
2. OCR with confidence and conservative fallback for Hindi/English scanned notices.
3. Semantic matching with structured LLM proposals and independent deterministic verification.
4. PDF.js original-document rendering with coordinate-accurate highlights, and optional CSV/calendar exports.
5. Stronger adversarial testing, privacy/security hardening, and an accessible deployed demo.

See [engineering verification notes](docs/verification-matrix.md) for design invariants, test coverage, and accepted limitations.

## Hackathon

Planned for **GenHacks 2026**, AI/Agentic Systems/Cybersecurity/Dev Tools track. Eligibility is student-only, ages 13+. Devpost currently shows **conflicting deadline statements**, so we use **25 December 2026** as an internal safe submission target; confirm the organizer's actual submission cutoff. Required: public code, project description, up-to-3-minute embedded video, team and technology disclosures. See `docs/devpost-draft.md`.

## License

Apache-2.0. Contributions welcome through issues and pull requests.
