# NoticeBridge AI — evidence and verification contract

This note documents the conservative behavior of the second engineering milestone. It does **not** certify notices, eligibility, official deadlines, or source precedence.

## Data integrity invariants

1. The parser never invents a page number or bounding box. `Evidence` is constructed only from a real, extractable PDF text line.
2. Each matched finding carries the original and revised source passage, both of which can be inspected by page.
3. Text equality is reconciled **before** variable masking. Reordering duplicate deadline statements therefore does not alone imply changed wording.
4. A `confirmed_change` status establishes a textual difference in a strongly matched passage, **not** that the updated document is authoritative.
5. Duplicated labels with potentially multiple different events reduce matching confidence rather than asserting exact relationships.
6. `field_changes[].outcome == "changed"` means two *syntactically parseable and unambiguous* field tokens differ. An uncertain numeric date is never converted to a definite calendar value.
7. Contradictions are emitted only for different valid calendar dates under the same deadline label **within a single PDF**, not simply because two uploaded files disagree.
8. A checklist is an optional user-facing review aid, not an official validation stamp.

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
- Backend keeps input bytes and extracted content in a request-local context and does not intentionally persist documents to disk. No-cache headers discourage intermediaries from caching API responses but cannot control every infrastructure component.
- Browser source preview is generated from a local `File` object URL, with URL revocation after preview closure. JSON export remains local to the browser unless a user independently shares it.
- The service is **not hardened for arbitrary public internet exposure**: no authentication, rate limiting, malware isolation, sandbox worker pool, or operational monitoring strategy exists yet.
- Uploaded source text is treated as data, never as instructions to change verification policy.

## Automated regression suites

- `backend/tests/test_extract.py`: source locations, malformed/scanned/password-protected/oversized-page PDFs.
- `backend/tests/test_compare.py`: changed/unchanged statements, reordered lines, duplicated deadline labels, ambiguity handling, source location and lack of authority inference.
- `backend/tests/test_facts.py`: dates in English/Hindi, Devanagari digits, date ambiguity, invalid calendar dates, currency canonicalization and malformed grouping.
- `backend/tests/test_api.py`: health, live multipart comparisons, bad uploads, upload size, filename sanitization, response no-store headers.

Run with `python -m pip install -e './backend[dev]'` then `pytest -q backend/tests` and `ruff check backend` from repository root. GitHub Actions also runs the React/TypeScript production build.

## Still not implemented

OCR; trustworthy amendment/issuer provenance resolution; LLM-powered semantic matching with independent verification; page-level bbox highlights; production-grade secure PDF worker isolation; persistent projects/checklists; calendar export; comprehensive browser E2E tests; independent real-world benchmark accuracy measurements.
