# NoticeBridge AI

**Understand what changed. Know what to do. Verify the evidence.**

NoticeBridge AI is an open-source, multilingual document comparison prototype for official notices. The first working milestone accepts two PDFs and produces **evidence-linked wording differences** rather than unverifiable AI summaries.

> **Prototype, not an official verification service.** Document upload order is not proof of authority. Check deadlines, eligibility, and requirements against the issuing organization's official website. A report may miss changes and must not be used as the sole basis for an important decision.

## What works now

- Two-PDF upload with file-size, file-type, encryption, and page-count checks.
- Line-level PDF text extraction with **actual 1-based page references and coordinates** from PyMuPDF.
- Deterministic matching of contextual passages and changed wording; missing statements are labeled uncertain.
- Bilingual English/Hindi **templated** explanations. No LLM is used yet; neither AI accuracy nor authoritative conflict resolution is claimed.
- Human-verification checklist for changed deadlines, fees, eligibility, and instructions.
- React/TypeScript comparison workspace with side-by-side evidence and accessible controls.
- Stateless FastAPI endpoint, Pytest regression tests, and CI configuration.

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

`POST /api/compare` accepts multipart fields `original` and `revised` (PDFs, maximum 10 MiB each, 80 pages each). Returns `documents`, `findings`, `checklist`, `warnings`, and `verification_policy`.

All evidence references point to source text actually extracted from the uploaded PDFs. Both source locations are included when a passage is matched. The service does **not** store uploads as files or intentionally log document contents; deployments must still secure server logs, networking, reverse proxies, and crash dumps.

## Explicit limitations

- **No OCR**: image-only PDFs produce warnings, not fabricated extracted text.
- **No LLM yet**: bilingual explanations are rule-based templates.
- **No verified authority resolution**: a revised filename or upload position cannot establish official precedence.
- **No robust semantic matching yet**: the initial similarity matcher can misalign duplicate headings or rephrased statements. Check every important finding against both sources.
- **No canonical date parsing**: dates and amounts are masked only for contextual line alignment; correct real-world date interpretation and cross-lingual matching are upcoming work.
- **No PDF.js highlight viewer yet**: the UI displays quoted evidence and page references, not rendered-document overlays.
- **No persistent checklist**: selections reset when the page reloads.
- **Security**: the prototype is not hardened for hostile internet uploads; production deployments need isolation, request limits, authentication, rate-limiting, and malware controls.

## Roadmap

1. Reliable conflicting-statement and amendment relationship analysis with temporal authority provenance.
2. OCR with confidence and conservative fallback for Hindi/English scanned notices.
3. Semantic matching with structured LLM proposals and independent deterministic verification.
4. PDF.js original-document page viewer, highlights, and structured exports.
5. Stronger adversarial testing, privacy/security hardening, and an accessible deployed demo.

## Hackathon

Planned for **GenHacks 2026**, AI/Agentic Systems/Cybersecurity/Dev Tools track. Eligibility is student-only, ages 13+. Devpost currently shows **conflicting deadline statements**, so we use **25 December 2026** as an internal safe submission target; confirm the organizer's actual submission cutoff. Required: public code, project description, up-to-3-minute embedded video, team and technology disclosures. See `docs/devpost-draft.md`.

## License

Apache-2.0. Contributions welcome through issues and pull requests.
