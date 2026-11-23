# NoticeBridge AI — December 2026 completion and release gates

**Planning baseline:** 23 November 2026  
**Engineering freeze target:** 20 December 2026  
**Final review / GenHacks preparation window:** 21–25 December 2026  
**Status:** working engineering plan, no published release. The organizer's schedule and rules were checked on 23 November; a conflicting deadline remains in the overview text.

> This document is a target schedule, not a guarantee. GenHacks schedule/rules list
> 26 December 2026 at 5 PM EST, while the event overview still states midnight
> Eastern. Use 25 December as the internal safe completion/submission target,
> and verify the live form with the organizer before any approved submission.
> The tool never certifies official notices or applicants' eligibility.

## Current verified capabilities

- FastAPI comparison, document byte hashes, page-linked PDF evidence, English/Hindi interface.
- Conservative structured deadline and fee extraction; ambiguous values stay uncertain.
- Opt-in English/Hindi OCR with provenance, page/pixel budgets and warnings.
- PDF.js source inspection and limited highlight overlay, review checklist, JSON export.
- Disposable worker process with timeout, restricted environment and best-effort
  POSIX resource ceilings; these are **not** a complete hostile-input sandbox.
- Page-by-page visibility of gaps in extractable text.
- Experimental local-model passage pairing, opt-in only and restricted to the
  fixed loopback Ollama endpoint; all proposals remain possible, unverified changes.
- Synthetic regression benchmark and automated backend/frontend/browser testing.

## Planned milestones and acceptance gates

### 23–29 November — Source integrity and experimental AI review

- [x] Extracted source evidence and byte fingerprinting.
- [x] Per-page text coverage and partial/inconclusive disclosures.
- [x] Bounded worker timeouts and best-effort POSIX resource limits.
- [x] Opt-in, local-only experimental semantic proposal path.
- [ ] Finish comprehensive adversarial test review for model output and PDF parsing.
- [x] Add a Windows CI job for backend integration, lint and subprocess behavior.
- [ ] Confirm Windows 11 native launch and termination behavior with a local desktop tester; CI alone is not equivalent.

**Gate:** Every accepted AI pairing must point to two existing, noninvented
source passages. No model output may mark a change or source as official.

### 30 November–6 December — Quality evaluation

- [x] Implement a local, labeled evidence-pair evaluation runner and tests (no representative dataset yet).
- [ ] Build a separately tracked, permission-safe evaluation set with documented
  sources, golden page references, original/revised pairing ground truth and labels.
- [ ] Include native-text and scanned PDFs; English, Hindi and mixed-script examples.
- [ ] Include amendments, duplicate headings, tables, missing pages, OCR failures,
  ambiguous numeric dates and reworded but semantically equivalent notices.
- [ ] Measure precision/recall and false-confidence rates on this set. Report
  numerator, denominator, confidence limitations and failure examples.
- [ ] Add a reproducible evaluation command and CI regression baseline.

**Gate:** Do not substitute the fictional 12-case benchmark for real-world accuracy
claims. If the independent set is insufficient, publish the limitation prominently.

### 7–13 December — Product and privacy review

- [ ] Audit keyboard navigation, screen reader labels, Hindi copy, color contrast,
  mobile widths and error/failure recovery.
- [ ] Validate rotated and cropped PDF highlights or retain a prominent manual-only
  fallback until geometry is correct.
- [x] Write an initial security threat model and P0/P1 risk register (docs/security-threat-model.md).
- [ ] Remediate public-hosting P0 threats and test Windows process-tree termination and temp-file cleanup.
- [ ] Implement or document production deployment isolation, rate limiting,
  resource budgets and authentication; no unaudited public hostile upload service.
- [ ] Check dependencies and security advisories; pin reproducible builds.

**Gate:** No hidden external LLM calls; opt-in text transfer and data retention must
be accurately documented and apparent in the UI.

### 14–19 December — Release-candidate verification

- [ ] Freeze feature additions unless necessary for correctness or security.
- [ ] Run backend tests, Ruff, frontend production build and browser E2E tests.
- [ ] Validate Windows and Linux setup paths with an independent tester.
- [ ] Run manual review on realistic notices and record errors without editing
  the reference labels after seeing results.
- [ ] Reproduce fictional demo PDF generation and benchmark evaluation.
- [ ] Prepare architecture diagram, short walkthrough, threat model and evidence
  provenance examples without claiming independent issuer verification.

**Gate:** A release candidate requires all critical checks green on the exact
candidate commit, with known limitations and no unresolved P0 safety defects.

### 20–25 December — Completion checkpoint and submission material

- [ ] On **20 December**, review the candidate against each acceptance gate.
- [ ] By **21–24 December**, prepare the up-to-3-minute demonstration recording
  and Devpost project narrative, including AI usage and limitations.
- [x] Check GenHacks rules and schedule; document the conflicting official deadline texts (docs/genhacks-submission-checklist.md).
- [ ] Reconfirm the live Devpost cutoff and entrant eligibility with the organizer before the approved submission.
- [ ] Final documentation, license, installation, privacy and attribution review.
- [ ] Request explicit approval before merging, tagging, releasing, deploying,
  or submitting on Devpost.

**Completion definition:** The project is a demonstrable, reproducible prototype
with reliable source evidence, clearly qualified uncertainty, accessible bilingual
flows, passing CI and a credible evaluation. "Complete" does not mean legally
authoritative notice interpretation or production-secure arbitrary PDF uploads.

## Non-negotiable integrity rules

1. Upload order or filename never establishes official document precedence.
2. Never invent page numbers, bounding boxes, quotations or source links.
3. OCR evidence is visibly labeled; uncertain values are not confirmed.
4. Local AI suggestions are optional and cannot produce verified changes.
5. Inconclusive/partial comparisons must expose missing text coverage.
6. Test and evaluation results are stated with their actual scope and commit.
7. No stable release, merge, deployment or hackathon submission without approval.
