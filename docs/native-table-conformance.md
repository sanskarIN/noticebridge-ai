# Native table evidence conformance matrix

NoticeBridge AI includes a **synthetic** cross-platform native-PDF regression
matrix in `backend/benchmarks/native_table_matrix.py`. It generates source
documents in memory, runs native extraction/comparison, and independently
verifies the resulting evidence report against the exact PDF bytes.

The tool is a **safety regression gate**, not a model benchmark, a human-labeled
dataset, a representation of actual issuers, or a certification that the
earlier/revised column is the legally governing one.

## How to run it

From the repository root, with backend development dependencies installed:

```bash
python backend/benchmarks/native_table_matrix.py
python backend/benchmarks/native_table_matrix.py --json
python backend/benchmarks/native_table_matrix.py --case date_iso
pytest -q backend/tests/test_native_table_matrix.py
```

Each scenario uses a single fictional native-text PDF page with a visible
"FICTIONAL TEST DATA" label and an explicit three-column source table.
The original and revised documents differ in one printed cell. No outside
network, local AI service, OCR language pack, real notice file or applicant
information is required. The runner does not save the generated PDFs.

The matrix covers stroked-grid and individually stroked rectangle tables,
0/90/180/270-degree page rotations, valid earlier/revised date, fee, time and
date-with-clock columns, and printed UTC offsets. It also includes misleading
or incomplete conditions: fill-only and borderless grids, a broken divider,
reversed/unspecified headings, malformed or ambiguous dates, clock ranges,
unsupported currencies and missing descriptive context.

## Invariants

For a recognized revision table, both printed values must survive as **one
review-only quote** with native page coordinates and exactly one bounded,
allowlisted page warning per source document. The report may suggest a
`possible_change` but cannot promote the row to `confirmed_change` or
promote a parsed value to `changed`.

For unsupported table structures, independent cell text must remain intact.
No typed table warning or synthetic review-only join may be invented. The
generic matcher must not confirm a bare date, amount, clock, currency value,
or range merely because its masked context is unique.

Every case additionally checks that both PDFs carry explicit fictional
marking, evidence retains its role, page number, rotation and finite bounding
box, no finding asserts official authority, and the independently validated
parent report accepts the output.

The CLI outputs the case ID, layout, expected table kind, finding-status
counts and bounded error codes. It deliberately does not echo source text or
claim precision/recall. A nonzero exit status means that a generated scenario
violated at least one invariant. CI runs this matrix in **both Linux and
Windows backend jobs** in addition to the regular Pytest suite.

## What it cannot measure

- Correctness on an actual government, university, or employer notice
- Correct source reconstruction for arbitrary fonts, merged cells, PDFs with
  complex vector graphics, OCR scans, multiline cells or non-English headings
- The issuer's intent, authority, effective-date precedence or authenticity
- Real-world false-positive/false-negative rates, semantic model performance,
  timezone conversion, or browser accessibility

The independent, permission-safe, human-labeled evaluation workflow in
`docs/labeled-evaluation.md` remains the appropriate basis for empirical
performance claims. Even successful independent evaluation does not substitute
for official issuer verification.
