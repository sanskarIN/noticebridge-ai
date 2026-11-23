# GenHacks 2026 — NoticeBridge AI project draft

**Working draft only; not submitted.**

**Name:** NoticeBridge AI

**Tagline:** Understand what changed. Know what to do. Verify the evidence.

**Suggested track:** AI, Agentic Systems, Cybersecurity, and Dev Tools (verify available options before submission).

**Problem:** Official educational notices can contain revised deadlines and important instructions spread across multiple PDFs. Applicants often struggle to see exactly what changed and why a summary should be trusted.

**Solution:** NoticeBridge AI compares two notices, identifies changed text, links findings to page-level passages from both files, and generates English/Hindi explanations plus a verification checklist. The current prototype relies on deterministic text matching, not yet on an LLM. It includes optional local English/Hindi OCR for scanned pages and a PDF.js evidence viewer with source highlights for unrotated pages. OCR findings remain uncertain, and neither file order nor SHA-256 fingerprints prove official authority. Future phases will add independently verified semantic AI matching, stronger document-issuer provenance checks, and production-grade parser isolation.

**How built:** Python, FastAPI, PyMuPDF, Tesseract (optional for OCR), Pydantic, Pytest, React, TypeScript, Vite, PDF.js, Playwright. Explain which parts were AI-assisted at submission time and link the code repository.

**Demo flow (up to 3 minutes):** Generate the clearly fictional sample PDFs with `PYTHONPATH=backend python backend/benchmarks/generate_demo.py --output demo-output`; show their deadline and fee differences; upload both; demonstrate evidence links, PDF.js highlights, and SHA-256 source fingerprints; switch to Hindi; show safety warnings and checklist; mention the lack of LLM verification, optional OCR and deployment limits honestly.

**Code:** https://github.com/sanskarIN/noticebridge-ai

**Demo video:** Not recorded.

**Live demo:** Not deployed.

**Team:** Individual (verify eligibility and information in Devpost).

**Submission:** NOT sent. Only user may approve final entry submission.

## Deadline discrepancy

The official site contains conflicting text: the event banner/schedule states December 26, 2026 at 5:00 PM EST, while some Rules/Requirements text says December 26 at 12:00 AM EST. The corresponding India times are December 27 at 3:30 AM IST versus December 26 at 10:30 AM IST. Use an internal December 25 submission target and request organizer confirmation if necessary.

## References

- https://genhacks-open.devpost.com/
- https://genhacks-open.devpost.com/rules
- https://genhacks-open.devpost.com/details/dates
