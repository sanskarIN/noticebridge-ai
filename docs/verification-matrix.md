# NoticeBridge AI — evidence and verification contract

This note documents the conservative behavior of the third engineering milestone. It does **not** certify notices, eligibility, official deadlines, or source precedence.

## Data integrity invariants

1. `Evidence` comes from native PDF text or an explicitly labeled OCR-transcribed page, with original page dimensions and rotation. In a supported ruled table, the quotation joins two native cell lines with a space and the source bounding box encloses both text boxes.
2. Each matched finding carries the original and revised source passage, both of which can be inspected by page.
3. Text equality is reconciled **before** variable masking. Reordering duplicate deadline statements therefore does not alone imply changed wording.
4. A `confirmed_change` status establishes a textual difference between native passages with a unique identical context anchor, **not** that the updated document is authoritative.
5. Duplicated labels with potentially multiple different events reduce matching confidence rather than asserting exact relationships.
6. `field_changes[].outcome == "changed"` means two *syntactically parseable and unambiguous* field tokens differ within a confirmed text pairing. All values associated with possible pairings have an uncertain outcome. An uncertain numeric date is never converted to a definite calendar value.
7. Contradictions are emitted only for distinct valid calendar dates under the same deadline label **on the same page of a single PDF**. The same generic label on different pages may refer to separate requirements; cross-page differences are review warnings, not certified contradictions. Neither upload order nor a cross-PDF difference proves authority.
8. A checklist is an optional user-facing review aid, not an official validation stamp.
9. Every document summary includes a SHA-256 of the submitted bytes, for reproducible source identification. No digital signature or issuer authenticity is inferred from the hash.
10. Automatic OCR targets native-text-empty pages. Explicit page selections may also transcribe pages with an embedded text layer. Both paths are opt-in, share page and render limits, and label transcribed passages as `ocr`. Selected pages with failed OCR appear as uncovered. OCR does not establish confirmed changes or contradictions.
11. Browser PDF.js rendering uses a locally selected File and same-origin worker. Rotated highlights are shown when page geometry can be reconciled.
12. Experimental local semantic proposals may only pair genuine original-only and revised-only evidence IDs with the same category. They are **additive**: the original deterministic missing-information findings and their review checklist remain visible. The parent API checks each proposed source against those unmatched passages, rejecting invented or reused source evidence. Proposals are always `possible_change`, never verified facts or model-generated citations. No model request happens without explicit opt-in.
13. Before returning a worker report, the API checks the actual uploaded SHA-256s, source roles, reported filenames, page counts, evidence locations, original verification policy and checklist references. Findings and review tasks must use fixed bilingual safety-preserving templates, match scores are recomputed from cited text, and warnings must match bounded, source-page-aware templates. The check rejects unsupported official-authority or AI-confirmed claims. It does **not** independently extract the PDF a second time.
14. Per-page text coverage is visible. Pages without extractable text are never silently treated as proven unchanged, even when the comparison found changes on other pages. `all_pages_have_text` means only that each page yielded some text, not that extraction was exhaustive.
15. An `explicit_amendment` links one original labeled deadline or fee to a revised passage that gives a matching prior value and a replacement. The worker requires a unique label and prior value in both documents. The API recalculates the field from both quotes and requires a possible change with an uncertain outcome. Conditions, ambiguous values, and duplicate candidates stay outside the explicit link.

## How date, time and fee tokens are interpreted

| Input | Parser behavior |
| --- | --- |
| `13 December 2026`, `13 दिसंबर 2026` | Valid date, `2026-12-13` |
| `१३ दिसंबर २०२६` | Valid date, `2026-12-13` |
| `2026-12-13` | Valid ISO date, `2026-12-13` |
| `December 13, 2026` or `13 December 2026` | Explicit month and valid calendar date, `2026-12-13` |
| `13th December 2026`, `Dec. 13th, 2026`, `13-Dec-2026` | Valid date, `2026-12-13`. The source format is kept in the quotation. |
| `11st December 2026` | Invalid ordinal suffix, no canonical value |
| `13–15 December 2026`, `29th November to 2nd December 2026` | Both endpoints stay in the quotation and the date value stays uncertain |
| `13/12/2026` | Unique day-month interpretation, `2026-12-13` |
| `01/02/2026` | **Ambiguous** (1 Feb or 2 Jan), no canonical value |
| `31 February 2026` | **Invalid** date, no canonical value |
| `17:30`, `5:30 p.m.`, `5:30 PM` | Equivalent clock time, `17:30` |
| `9:30` | **Ambiguous** single-digit hour without AM/PM |
| `24:00`, `17:99` | **Invalid** clock values, no canonical value |
| `09:00–17:00`, `5–7 PM` | Range remains visible in the quote without a structured time delta |
| `Rs. 1,000`, `₹1,000`, `₹10,00,000`, `१,२५० रुपये` | Valid INR amounts, decimal canonical values |
| `Rs. 1,2,3` | Invalid grouping, no canonical value |

A structured time delta requires one recognized clock expression in each quote. It describes the times as printed. Time-zone and offset text stays in the anchor, and a differing zone makes the pairing uncertain. The comparator does not convert time zones or interpret daylight saving time.

## Matching algorithm and uncertainty

1. Exact normalized text matches are resolved across the entire document pair.
2. Remaining lines are matched using category and masked value anchors. Deadlines mask calendar dates and single clock values. Scheduled events mask a single clock value while preserving their date and other scope. Fees mask currency amounts. Only unique native-text anchors support a matched text change.
3. Remaining potential matches are globally ranked using token-index retrieval and context similarity. All fuzzy pairings stay possible. Fuzzy matching examines contexts up to 512 characters, at most 64 entries per token or source passage, and at most 20,000 pairs and 20 million character products per comparison. The API independently caps rescoring work.
4. Lines without a matched counterpart in the extracted text receive `missing_information`. `fuzzy_matching_limited` exposes skipped candidate work independently of page text coverage. Exact text and exact context matching still run on all extracted lines.

Native extraction skips copying image streams. Text boxes that collapse after
coordinate rounding or lie wholly off-page are omitted with a page-specific
warning. Cross-page deadline warnings list up to 20 label groups per PDF and
report the count of additional groups.

Category detection uses Unicode-aware token boundaries instead of arbitrary substring
matches, so incidental words such as "coffee" and "repayment" do not create fee
findings. It still relies on a small English/Hindi keyword dictionary and can
miss synonyms or contextual labels. Every important category should be manually
checked against the quoted source.

## Ruled tables

The extractor joins a label and a standalone date or INR amount when both fit entirely in separate cells of one native-text row. The ruling must form at least two adjacent rows with the same two columns. The original page, quote words, and source hash remain the evidence. Matching uses the same anchors and review rules as ordinary lines.

Borderless tables, merged cells, three-column tables, wrapped cells, scanned tables, and pages beyond the layout work budget keep the original line-level extraction. Complex layouts can still produce incomplete matches. Inspect the PDF page when layout determines how a value applies.

## Security and privacy scope

- API: two PDFs at most 10 MiB each and a pre-parse ASGI body cap of 21 MiB including framing, checked against declared and received bytes. The per-process gate rejects more than eight simultaneous requests or uploads taking more than 90 seconds. Private body spooling starts in memory and rolls to OS temporary files; storage failures return a controlled 503 and close the spool, and client disconnects release the slot. Up to 80 pages and 12,000 extracted text lines per PDF; encrypted or malformed files rejected.
- Backend retains extracted content only in the request context and does not intentionally persist it. Starlette can spool multipart uploads temporarily to OS disk; operators must protect and clean temporary storage. No-cache headers discourage response caching but cannot control every intermediary.
- OCR uses Tesseract on the server, not a third-party API; it runs in a disposable worker with a restricted environment and 120-second wall-clock timeout, but is not OS-sandboxed or reproducible across Tesseract versions. Native PDF comparisons have a 45-second deadline. On Linux, workers attempt a 2 GiB virtual address-space ceiling; POSIX also attempts CPU/file/core/open-descriptor ceilings. On Windows, workers must be attached to a kill-on-close Job Object before PDF input is sent, with best-effort memory/process limits and process-tree termination. These controls are **not** equivalent to a production sandbox.
- Browser source preview caps canvas bitmaps at 9 million pixels and 4096 pixels per side, including high-DPI scaling. The PDF.js viewport transforms unrotated source coordinates to rotated/cropped/UserUnit pages and refuses markers when the source geometry is inconsistent. It renders with a same-origin bundled worker; local `File` URLs are revoked on preview closure. Both JSON and review CSV exports are browser-local. The CSV quotes fields, neutralizes leading formula syntax, includes document hashes and human-checklist state, and does **not** assert issuer authority. Treat exports as potentially sensitive.
- The service is **not hardened for arbitrary public internet exposure**: subprocess separation is not an OS sandbox; no authentication, rate limiting, OS-enforced memory/CPU quotas, malware isolation, or operational monitoring strategy exists yet.
- Uploaded source text is treated as data, never as instructions to change verification policy. With explicit opt-in, bounded unmatched passages are sent to loopback Ollama at `127.0.0.1:11434` with HTTP proxies disabled. The full HTTP response is limited to 64 KiB before JSON parsing, and worker stdout is file-backed with a capped 64 MiB parent read. Source IDs/categories are independently checked; the meaning of suggested pairings is not independently certified.

## Automated regression suites

- `backend/tests/test_extract.py`: source locations, SHA-256, malformed/scanned/password-protected/oversized-page PDFs, OCR gating/budgets/error paths, and English/Hindi OCR integration scans that skip if Tesseract language packs or fixture fonts are missing.
- `backend/tests/test_table_rows.py`: native grid detection, rotated evidence, fallback for ambiguous layouts and budget limits, and actual deadline and fee changes through the comparison worker.
- `backend/tests/test_compare.py`: changed/unchanged statements, reordered lines, duplicated deadline labels, same-page versus cross-page ambiguity handling, source location and lack of authority inference.
- `backend/tests/test_facts.py`: dates in English/Hindi, Devanagari digits, ambiguous and invalid dates or clock times, unsupported time ranges, currency canonicalization and malformed grouping.
- `backend/tests/test_api.py` and `backend/tests/test_body_limit.py`: health, live multipart comparisons, multipart stream and header size enforcement, bad uploads, filename sanitization, response no-store headers.
- `backend/tests/test_provenance.py`: forged document hashes, swapped source roles, out-of-range evidence, false authority claims, malformed field values and AI promotion attempts.
- `backend/tests/test_isolation.py` and `backend/tests/test_worker_limits.py`: real worker roundtrips, malformed input, timeout/forced termination behavior, invalid worker output, API failure mapping, worker bootstrap and POSIX resource-ceiling behavior.

The independent-corpus evaluation workflow is documented in [labeled evaluation](labeled-evaluation.md). Its v2 manifest pins source hashes; optional `--enable-ocr` distinguishes scanned-PDF evaluation from native-text runs and reports extraction gaps. It measures exact page-and-quotation pair alignment only and does not establish semantic or official accuracy.

Run with `python -m pip install -e './backend[dev]'` then `pytest -q backend/tests` and `ruff check backend` from repository root. GitHub Actions also runs the React/TypeScript production build and a Playwright/Chromium browser job against a locally running FastAPI + Vite stack, using two generated fictional PDF notices. The browser suite checks rendering, highlighting, export and Hindi explanation switching. Browser coverage is intentionally small and does not certify all PDFs or platforms.

## Synthetic evaluation (not representative accuracy)

`PYTHONPATH=backend python backend/benchmarks/evaluate.py` checks fictional, author-created notice pairs. It asserts status counts, syntactic field outcomes, evidence presence, and no claims of document authority. Results from this carefully scoped corpus are **not** real-world precision, recall, or benchmark quality, and must not be presented as hackathon performance evidence. OCR is evaluated separately in the integration tests.

## Still not implemented

Trustworthy amendment/issuer provenance resolution; independently evaluated semantic matching; calibrated OCR confidence; comprehensive independent pixel-level highlight validation across exotic PDFs; production-grade OS sandboxing, disk quotas and deployment authentication; persistent projects/checklists; calendar export; broad browser E2E tests; independent real-world accuracy measurements.

## Consequential review-queue acceptance checks

The English-only review workspace should never bury **unmatched deadlines,
unparsed possible deadline wording, missing fees, or eligibility changes** just
because a syntactic date or amount delta cannot be calculated. These are
review priorities, not proof of an official amendment or cancellation.

- Known native-text earlier deadlines may be labeled with a calculated day
  difference, but only when the backend reports a confirmed text pairing and
  two unambiguous canonical dates.
- An explicit amendment is **possible**, not automatically official. A lone
  deadline in either PDF must be labeled **unmatched**, not removed or added.
- Possible deadline/fee wording differences without a parsed numeric field
  still require human inspection; OCR-derived passages require visible
  transcription checking before acting.
- Eligibility, reporting-time and instruction changes should enter the
  prioritized review queue. Existing evidence links, search filters and
  full-report exports remain the way to examine all findings; the short
  review queue is **not** an exhaustive result set.
- E2E UI-fixture tests for uncertain states verify rendering and prioritization,
  not extraction accuracy. Real PDF integration tests separately cover source
  passage matching.
