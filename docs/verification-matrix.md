# NoticeBridge AI — evidence and verification contract

This note documents the conservative behavior of the third engineering milestone. It does **not** certify notices, eligibility, official deadlines, or source precedence.

## Data integrity invariants

1. The parser never invents a page number or bounding box. `Evidence` comes from a PDF text line or an explicitly labeled OCR-transcribed page, with original page dimensions and rotation.
2. Each matched finding carries the original and revised source passage, both of which can be inspected by page.
3. Text equality is reconciled **before** variable masking. Reordering duplicate deadline statements therefore does not alone imply changed wording.
4. A `confirmed_change` status establishes a textual difference in a strongly matched passage, **not** that the updated document is authoritative.
5. Duplicated labels with potentially multiple different events reduce matching confidence rather than asserting exact relationships.
6. `field_changes[].outcome == "changed"` means two *syntactically parseable and unambiguous* field tokens differ. An uncertain numeric date is never converted to a definite calendar value.
7. Contradictions are emitted only for different valid calendar dates under the same deadline label **within a single PDF**, not simply because two uploaded files disagree.
8. A checklist is an optional user-facing review aid, not an official validation stamp.
9. Every document summary includes a SHA-256 of the submitted bytes, for reproducible source identification. No digital signature or issuer authenticity is inferred from the hash.
10. OCR is opt-in and used only for native-text-empty pages, with bounded page count and estimated rendering pixels. Its output is labeled `ocr`; it cannot alone produce a `confirmed_change` or a contradiction.
11. Browser PDF.js rendering uses a locally selected File and same-origin worker; highlights are omitted for rotated pages rather than guessed.

## How date and fee tokens are interpreted

| Input | Parser behavior |
| --- | --- |
| `13 December 2026`, `13 दिसंबर 2026` | Valid date, `2026-12-13` |
| `१३ दिसंबर २०२६` | Valid date, `2026-12-13` |
| `2026-12-13` | Valid ISO date, `2026-12-13` |
| `13/12/2026` | Unique day-month interpretation, `2026-12-13` |
| `01/02/2026` | **Ambiguous** (1 Feb or 2 Jan), no canonical value |
| `31 February 2026` | **Invalid** date, no canonical value |
| `Rs. 1,000`, `₹1,000`, `₹10,00,000` | Valid INR amounts, decimal canonical values |
| `Rs. 1,2,3` | Invalid grouping, no canonical value |

Unrecognized date and currency syntax is ignored rather than inferred. There is no automatic time-zone calculation or locale-specific deadline extension logic.

## Matching algorithm and uncertainty

1. Exact normalized text matches are resolved across the entire document pair.
2. Remaining lines are matched using category and masked date/amount/number anchors. Multiplicity marks these candidate pairings ambiguous.
3. Remaining potential matches are globally ranked using bounded token-index retrieval and context similarity. Close competitors reduce confidence.
4. Lines without defensible matches receive `missing_information` rather than claims of repeal or addition.

This is still **line-level**, not semantic paragraph/document understanding. Long paragraphs, table columns, hyphenated line breaks, mixed scripts, duplicate form fields, and scanned images can produce incomplete or misleading matches. Important cases require human review.

## Security and privacy scope

- API: two PDFs at most 10 MiB each; at most 80 pages and 12,000 extracted text lines per PDF; bounded text length; encrypted or malformed files rejected.
- Backend retains extracted content only in the request context and does not intentionally persist it. Starlette can spool multipart uploads temporarily to OS disk; operators must protect and clean temporary storage. No-cache headers discourage response caching but cannot control every intermediary.
- OCR uses Tesseract on the server, not a third-party API; it runs in a disposable worker with a restricted inherited environment with 120-second wall-clock timeout, but is not OS-sandboxed or reproducible across Tesseract versions. Native PDF comparisons have a 45-second deadline. On Linux, workers attempt a 2 GiB virtual address-space ceiling; on POSIX, workers also attempt CPU, file size, core dump and open-descriptor ceilings. These limits are best-effort and not a sandbox. Timed-out POSIX worker process groups are killed; Windows terminates the direct worker only.
- Browser source preview uses local PDF.js rendering with a same-origin bundled worker, while the open-in-new-tab fallback uses a local `File` object URL that is revoked after preview closure. JSON export remains local to the browser unless a user independently shares it.
- The service is **not hardened for arbitrary public internet exposure**: subprocess separation is not an OS sandbox; no authentication, rate limiting, OS-enforced memory/CPU quotas, malware isolation, or operational monitoring strategy exists yet.
- Uploaded source text is treated as data, never as instructions to change verification policy.

## Automated regression suites

- `backend/tests/test_extract.py`: source locations, SHA-256, malformed/scanned/password-protected/oversized-page PDFs, OCR gating/budgets/error paths, and English/Hindi OCR integration scans that skip if Tesseract language packs or fixture fonts are missing.
- `backend/tests/test_compare.py`: changed/unchanged statements, reordered lines, duplicated deadline labels, ambiguity handling, source location and lack of authority inference.
- `backend/tests/test_facts.py`: dates in English/Hindi, Devanagari digits, date ambiguity, invalid calendar dates, currency canonicalization and malformed grouping.
- `backend/tests/test_api.py`: health, live multipart comparisons, bad uploads, upload size, filename sanitization, response no-store headers.
- `backend/tests/test_isolation.py` and `backend/tests/test_worker_limits.py`: real worker roundtrips, malformed input, timeout/forced termination behavior, invalid worker output, API failure mapping, worker bootstrap and POSIX resource-ceiling behavior.

Run with `python -m pip install -e './backend[dev]'` then `pytest -q backend/tests` and `ruff check backend` from repository root. GitHub Actions also runs the React/TypeScript production build and a Playwright/Chromium browser job against a locally running FastAPI + Vite stack, using two generated fictional PDF notices. The browser suite checks rendering, highlighting, export and Hindi explanation switching. Browser coverage is intentionally small and does not certify all PDFs or platforms.

## Synthetic evaluation (not representative accuracy)

`PYTHONPATH=backend python backend/benchmarks/evaluate.py` checks 12 fictional, author-created notice pairs. It asserts status counts, syntactic field outcomes, evidence presence, and no claims of document authority. Results from this carefully scoped corpus are **not** real-world precision, recall, or benchmark quality, and must not be presented as hackathon performance evidence. OCR is evaluated separately in the integration tests.

## Still not implemented

Trustworthy amendment/issuer provenance resolution; LLM-powered semantic matching with independent verification; rotated/cropped-page coordinate-accurate highlights; calibrated OCR confidence; production-grade OS sandboxing, resource quotas and worker orchestration; persistent projects/checklists; calendar export; comprehensive browser E2E tests; independent real-world benchmark accuracy measurements.
