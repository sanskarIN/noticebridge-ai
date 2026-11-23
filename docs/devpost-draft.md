# GenHacks 2026 — NoticeBridge AI project draft

**Working draft only; not submitted.**

**Name:** NoticeBridge AI

**Tagline:** Understand what changed. Know what to do. Verify the evidence.

**Suggested track:** AI, Agentic Systems, Cybersecurity, and Dev Tools (verify available options before submission).

**Problem:** Applicants may have to compare several PDFs to find a shortened deadline, a changed fee, or a correction to eligibility. An unlinked summary leaves them searching through the documents again.

**Solution:** NoticeBridge compares two PDFs and puts consequential wording changes at the top of an English review queue. Each finding opens the quoted passage on the actual PDF page. The workflow keeps ambiguous values visible, tracks the review checklist, and exports a report with the source fingerprints and selections.

**Technical approach:** The comparison uses bounded text alignment, exact context anchors, and explicit amendment wording. A disposable worker parses the PDFs. The API checks page provenance and structured claims against the quotes before it returns them. Optional OCR recovers selected pages, and optional local AI proposes possible matches for manual review. The default demo runs with both options off.

**What makes it different:** Reviewers can inspect every important claim at the original page location. The downloadable report includes the source-file hashes, so a teammate can tie it back to the same inputs. The fictional showcase can also run as a static website with a recorded engine result and its exact PDFs.

**How built:** Python, FastAPI, PyMuPDF, Tesseract (optional for OCR), Pydantic, Pytest, React, TypeScript, Vite, PDF.js, Playwright. Explain which parts were AI-assisted at submission time and link the code repository.

**Demo flow (up to 3 minutes):** Open **Try a fictional notice**. Show that the stated application deadline moved six days earlier. Open the highlighted source and mark the item reviewed. Then inspect the ambiguous interview date and export the evidence report. The repository documents the static showcase build and the source-bound fixture generation.

**Code:** https://github.com/sanskarIN/noticebridge-ai

**Demo video:** Add the approved walkthrough to the Devpost draft.

**Live demo:** Not deployed.

**Team:** Individual (verify eligibility and information in Devpost).

**Submission:** NOT sent. Only user may approve final entry submission.

## Deadline discrepancy

The official site contains conflicting text: the event banner/schedule states December 26, 2026 at 5:00 PM EST, while some Rules/Requirements text says December 26 at 12:00 AM EST. The corresponding India times are December 27 at 3:30 AM IST versus December 26 at 10:30 AM IST. Use an internal December 25 submission target and request organizer confirmation if necessary.

## References

- https://genhacks-open.devpost.com/
- https://genhacks-open.devpost.com/rules
- https://genhacks-open.devpost.com/details/dates
